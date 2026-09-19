/** Transport channels: shared HTTP, Bark, webhooks, and native desktop. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChannelError, ERROR_CODES, postJson, redact, retryableStatus, sleep } from '../lib/channels/http.js'
import { buildBarkTestPayload, sendBark } from '../lib/channels/bark.js'
import { deliverWebhook, webhookPayload } from '../lib/channels/webhook.js'
import {
  appleScriptQuote,
  buildWindowsScript,
  commandForPlatform,
  localSupport,
  sendLocalNotification,
} from '../lib/channels/local.js'
import { renderBarkPayload, renderLocal, renderText, markdownToPlainText, truncate } from '../lib/render.js'
import { compileSettings } from '../lib/settings.js'

/** Build a recording fetch stub from a list of responses (or a factory). */
function fakeFetch(script) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = typeof script === 'function' ? script(calls.length, url, init) : script[Math.min(calls.length - 1, script.length - 1)]
    if (next instanceof Error) throw next
    return next
  }
  impl.calls = calls
  return impl
}

const response = (status, body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
})

function envelope(overrides = {}) {
  return {
    id: 's1:turn:1',
    kind: 'completed',
    flag: 'completed',
    sessionId: 's1',
    title: 'proj',
    summary: 'done',
    tools: [],
    time: Date.now(),
    ...overrides,
  }
}

test('postJson retries a retryable status then succeeds', async () => {
  const fetchImpl = fakeFetch([response(500), response(200)])
  const result = await postJson('https://example.test/hook', { a: 1 }, {
    fetchImpl,
    retries: 2,
    retryBaseMs: 1,
    timeoutMs: 500,
  })
  assert.equal(result.attempts, 2)
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(fetchImpl.calls[0].init.method, 'POST')
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).a, 1)
  assert.equal(fetchImpl.calls[0].init.headers['content-type'].startsWith('application/json'), true)
})

test('postJson fails fast on a non-retryable status', async () => {
  const fetchImpl = fakeFetch([response(401, 'nope')])
  await assert.rejects(
    () => postJson('https://example.test/hook', {}, { fetchImpl, retries: 3, retryBaseMs: 1 }),
    (error) => {
      assert.ok(error instanceof ChannelError)
      assert.equal(error.code, ERROR_CODES.HTTP_ERROR)
      return true
    },
  )
  assert.equal(fetchImpl.calls.length, 1, 'a 401 must not be retried')
})

test('postJson exhausts the ladder and reports the last error', async () => {
  const fetchImpl = fakeFetch([response(503, 'unavailable')])
  await assert.rejects(
    () => postJson('https://example.test/hook', {}, { fetchImpl, retries: 2, retryBaseMs: 1 }),
    /after 3 attempt\(s\)/,
  )
  assert.equal(fetchImpl.calls.length, 3)
})

test('postJson redacts a secret echoed by the server', async () => {
  const secret = 'https://api.day.app/SECRETKEY123'
  const fetchImpl = fakeFetch([response(400, `bad endpoint ${secret}`)])
  await assert.rejects(
    () => postJson(secret, {}, { fetchImpl, retries: 0, secrets: [secret] }),
    (error) => {
      assert.equal(error.message.includes('SECRETKEY123'), false)
      assert.ok(error.message.includes('[redacted]'))
      return true
    },
  )
})

test('postJson reports a network failure as NETWORK_ERROR', async () => {
  const fetchImpl = fakeFetch([new Error('boom')])
  await assert.rejects(
    () => postJson('https://example.test/hook', {}, { fetchImpl, retries: 0 }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.NETWORK_ERROR)
      return true
    },
  )
})

test('postJson honors a pre-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => postJson('https://example.test/hook', {}, { fetchImpl: fakeFetch([response(200)]), signal: controller.signal }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.CANCELLED)
      return true
    },
  )
})

test('helpers: retryableStatus, redact, sleep cancellation', async () => {
  assert.equal(retryableStatus(429), true)
  assert.equal(retryableStatus(500), true)
  assert.equal(retryableStatus(408), true)
  assert.equal(retryableStatus(400), false)
  assert.equal(redact('key is abcdefghijkl', ['abcdefghijkl']), 'key is [redacted]')
  assert.equal(redact('short abc', ['abc']), 'short abc', 'short values are not treated as secrets')

  const controller = new AbortController()
  const pending = sleep(10_000, controller.signal)
  controller.abort()
  await assert.rejects(() => pending, (error) => error.code === ERROR_CODES.CANCELLED)
})

test('sendBark refuses an unconfigured or invalid endpoint', async () => {
  await assert.rejects(() => sendBark('', { title: 't', body: 'b' }), (error) => error.code === ERROR_CODES.NOT_CONFIGURED)
  await assert.rejects(() => sendBark('not-a-url', { title: 't', body: 'b' }), (error) => error.code === ERROR_CODES.NOT_CONFIGURED)
  await assert.rejects(() => sendBark('ftp://host/key', { title: 't', body: 'b' }), (error) => error.code === ERROR_CODES.NOT_CONFIGURED)
})

test('sendBark posts the Bark V2 payload to the normalized endpoint', async () => {
  const fetchImpl = fakeFetch([response(200)])
  const result = await sendBark('https://api.day.app/KEY/', {
    title: '✅ 任务完成',
    body: 'proj\ndone',
    group: 'DSH',
    level: 'active',
  }, { fetchImpl, retries: 0 })
  assert.equal(result.attempts, 1)
  assert.equal(fetchImpl.calls[0].url, 'https://api.day.app/KEY')
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.group, 'DSH')
  assert.equal(body.level, 'active')
  assert.ok(body.body.includes('done'))
})

test('buildBarkTestPayload is a valid Bark payload', () => {
  const payload = buildBarkTestPayload('DSH')
  assert.equal(payload.group, 'DSH')
  assert.equal(typeof payload.title, 'string')
  assert.ok(payload.body.length > 0)
})

test('webhookPayload matches each preset', () => {
  const env = envelope({ turn: 3, durationMs: 1_000 })
  assert.deepEqual(webhookPayload('feishu', env, 'T'), { msg_type: 'text', content: { text: 'T' } })
  assert.deepEqual(webhookPayload('wecom', env, 'T'), { msgtype: 'text', text: { content: 'T' } })
  assert.deepEqual(webhookPayload('dingtalk', env, 'T'), { msgtype: 'text', text: { content: 'T' } })
  assert.deepEqual(webhookPayload('slack', env, 'T'), { text: 'T' })
  assert.deepEqual(webhookPayload('discord', env, 'T'), { content: 'T' })
  const custom = webhookPayload('custom', env, 'T')
  assert.equal(custom.text, 'T')
  assert.equal(custom.kind, 'completed')
  assert.equal(custom.sessionId, 's1')
  assert.equal(custom.turn, 3)
  assert.equal(typeof custom.time, 'string')
})

test('deliverWebhook validates the URL and posts the preset body', async () => {
  await assert.rejects(
    () => deliverWebhook('feishu', '', envelope(), {}),
    (error) => error.code === ERROR_CODES.NOT_CONFIGURED,
  )
  await assert.rejects(
    () => deliverWebhook('feishu', 'nope', envelope(), {}),
    (error) => error.code === ERROR_CODES.NOT_CONFIGURED,
  )
  await assert.rejects(
    () => deliverWebhook('feishu', 'ftp://x', envelope(), {}),
    (error) => error.code === ERROR_CODES.NOT_CONFIGURED,
  )

  const fetchImpl = fakeFetch([response(200)])
  const result = await deliverWebhook('feishu', 'https://open.feishu.cn/hook/1', envelope(), {
    fetchImpl,
    retries: 0,
    locale: 'zh',
    includeSummary: true,
  })
  assert.equal(result.attempts, 1)
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.msg_type, 'text')
  assert.ok(body.content.text.includes('任务完成'))
  assert.ok(body.content.text.includes('会话：s1'))
})

test('deliverWebhook redacts a secret URL from its failure message', async () => {
  const url = 'https://open.feishu.cn/hook/SECRETHOOK123'
  const fetchImpl = fakeFetch([response(400, `rejected ${url}`)])
  await assert.rejects(
    () => deliverWebhook('feishu', url, envelope(), { fetchImpl, retries: 0 }),
    (error) => {
      assert.equal(error.message.includes('SECRETHOOK123'), false)
      return true
    },
  )
})

test('localSupport reports a backend per platform', () => {
  assert.deepEqual(localSupport('win32'), { supported: true, backend: 'windows-toast' })
  assert.deepEqual(localSupport('darwin'), { supported: true, backend: 'osascript' })
  assert.deepEqual(localSupport('linux'), { supported: true, backend: 'notify-send' })
  assert.equal(localSupport('freebsd').supported, false)
})

test('the Windows toast script never interpolates user content', () => {
  const title = "it's \"quoted\"\nnewline"
  const script = buildWindowsScript(title, 'body', 'id:with/odd?chars', true)
  assert.equal(script.includes("it's"), false, 'title must only travel base64-encoded')
  assert.equal(script.includes('newline'), false)
  assert.ok(script.includes(Buffer.from(title, 'utf8').toString('base64')))
  assert.ok(script.includes("$appId='DeepSeekHarness.NotifyHub'"))
  assert.ok(script.includes('ToastNotificationManager'))
  assert.ok(script.includes('ShowBalloonTip'))
  assert.equal(script.includes('id:with/odd?chars'), false, 'the toast tag is sanitized')
  assert.ok(script.includes("$toast.Tag='id-with-odd-chars'"))
})

test('the Windows script silences audio when sound is off', () => {
  const loud = buildWindowsScript('t', 'b', 'id', true)
  const silent = buildWindowsScript('t', 'b', 'id', false)
  assert.equal(loud.includes('<audio silent="true"/>'), false)
  assert.equal(silent.includes('<audio silent="true"/>'), true)
})

test('appleScriptQuote escapes backslashes and quotes', () => {
  assert.equal(appleScriptQuote('a"b\\c'), '"a\\"b\\\\c"')
})

test('commandForPlatform builds the right command per platform', () => {
  const settings = compileSettings({ locale: 'zh' })
  const env = envelope()

  const win = commandForPlatform('win32', env, settings)
  assert.equal(win.command, 'powershell.exe')
  assert.equal(typeof win.script, 'string')
  assert.ok(win.script.length > 0)
  assert.equal('stdin' in win, false, 'the script must never be piped into the child')
  assert.equal(win.args.includes('-Command'), false)
  assert.equal(win.args.includes('-File'), false, 'the runner appends -File with the temp path')

  const mac = commandForPlatform('darwin', env, settings)
  assert.equal(mac.command, 'osascript')
  assert.ok(mac.args[1].includes('display notification'))
  assert.ok(mac.args[1].includes('sound name "default"'))

  const quietMac = commandForPlatform('darwin', env, compileSettings({ local: { sound: false } }))
  assert.equal(quietMac.args[1].includes('sound name'), false)

  const linux = commandForPlatform('linux', env, settings)
  assert.equal(linux.command, 'notify-send')
  assert.ok(linux.args.includes('DeepSeek Harness'))

  const failed = commandForPlatform('linux', envelope({ kind: 'error', flag: 'error' }), settings)
  assert.ok(failed.args.includes('critical'))

  assert.equal(commandForPlatform('freebsd', env, settings), null)
})

test('sendLocalNotification refuses an unsupported platform', async () => {
  await assert.rejects(
    () => sendLocalNotification(envelope(), compileSettings({}), { platform: 'freebsd' }),
    (error) => error.code === ERROR_CODES.NOT_CONFIGURED,
  )
})

test('renderers produce bounded, localized bodies', () => {
  const env = envelope({ reason: 'boom', durationMs: 65_000 })
  const zh = renderText(env, { locale: 'zh', includeSummary: true, includeSession: true, prefix: 'DSH' })
  assert.ok(zh.startsWith('[DSH] 【✅ 任务完成】'))
  assert.ok(zh.includes('原因：boom'))
  assert.ok(zh.includes('耗时：1 分 5 秒'))
  assert.ok(zh.includes('会话：s1'))

  const en = renderText(env, { locale: 'en', includeSession: false })
  assert.ok(en.includes('✅ Task completed'))
  assert.ok(en.includes('Reason: boom'))
  assert.equal(en.includes('Session:'), false)

  const local = renderLocal(env, { locale: 'zh' })
  assert.equal(local.title, '✅ 任务完成')
  assert.ok(local.body.includes('proj'))

  const settings = compileSettings({ maxBodyChars: 60, bark: { group: 'G', url: 'https://x' } })
  const bark = renderBarkPayload(env, settings)
  assert.equal(bark.group, 'G')
  assert.equal(bark.level, 'active')
  assert.ok(bark.body.length <= 60)

  const urgent = renderBarkPayload(envelope({ kind: 'approval', flag: 'approval' }), settings)
  assert.equal(urgent.level, 'timeSensitive')

  assert.equal(truncate('abcdef', 4), 'abc…')
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(markdownToPlainText('# 标题\n**粗体** `code`\n- 项'), '标题\n粗体 code\n• 项')
})
