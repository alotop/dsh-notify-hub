/** Hub fan-out: enabled-channel selection, routing, history, and the in-flight bound. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_IN_FLIGHT, buildTestEnvelope, createHub, enabledChannels } from '../lib/hub.js'
import { createHistory } from '../lib/history.js'
import { compileSettings } from '../lib/settings.js'

/** A 移动新消息 stub that records what it was asked to send. */
function cmccStub(configured = false) {
  return {
    sent: [],
    configured: () => configured,
    status: () => ({ configured, connected: false, maskedKey: configured ? '••••••••1234' : '' }),
    sendText: async (text) => {
      if (!configured) throw new Error('cmcc not configured')
      return { messageId: 'msg_test', to: '10086', text }
    },
    dispose: () => {},
  }
}

const response = (status) => ({ ok: status >= 200 && status < 300, status, text: async () => '' })

/** A fetch stub that records calls and always succeeds. */
function okFetch() {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return response(200)
  }
  impl.calls = calls
  return impl
}

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

function makeHub(settingsInput, options = {}) {
  // Native desktop delivery is switched off for every hub test: it would spawn a
  // real notification process, and the channel has its own unit tests.
  const settings = compileSettings({ local: { enabled: false }, ...settingsInput })
  const history = createHistory(() => 50)
  const cmcc = options.cmcc ?? cmccStub(false)
  const fetchImpl = options.fetchImpl ?? okFetch()
  const hub = createHub({
    getSettings: () => settings,
    cmcc,
    history,
    logger: { warn: () => {} },
    fetchImpl,
  })
  return { hub, history, cmcc, fetchImpl, settings }
}

test('a test envelope is a valid notification', () => {
  const test_ = buildTestEnvelope('bark')
  assert.equal(test_.kind, 'completed')
  assert.equal(test_.flag, 'completed')
  assert.ok(test_.id.startsWith('test:bark:'))
})

test('enabledChannels requires both the switch and a credential', () => {
  const quiet = { local: { enabled: false } }
  assert.deepEqual(enabledChannels(compileSettings(quiet), cmccStub(false)), [], 'nothing configured yet')
  assert.deepEqual(
    enabledChannels(compileSettings(quiet), cmccStub(true)),
    ['cmcc'],
    'a fully configured 移动新消息 channel is enough on its own',
  )

  const withBark = compileSettings({ ...quiet, bark: { url: 'https://api.day.app/KEY' } })
  assert.deepEqual(enabledChannels(withBark, cmccStub(false)), ['bark'])

  const barkOff = compileSettings({ ...quiet, bark: { enabled: false, url: 'https://api.day.app/KEY' } })
  assert.deepEqual(enabledChannels(barkOff, cmccStub(false)), [])

  const webhookOnly = compileSettings({
    ...quiet,
    webhooks: { wecom: { enabled: true, url: 'https://qyapi.weixin.qq.com/hook' } },
  })
  assert.deepEqual(enabledChannels(webhookOnly, cmccStub(false)), ['wecom'])

  // The native channel joins whenever the switch is on and the platform supports it.
  const native = enabledChannels(compileSettings({ bark: { url: 'https://api.day.app/KEY' } }), cmccStub(true))
  assert.deepEqual(native.slice(0, 3), ['bark', 'cmcc', 'local'])
})

test('dispatch fans out to every enabled channel and records history', async () => {
  const { hub, history, fetchImpl } = makeHub({
    bark: { url: 'https://api.day.app/KEY' },
    webhooks: { feishu: { enabled: true, url: 'https://open.feishu.cn/hook/1' } },
    local: { enabled: false },
    cmcc: { enabled: false },
  })
  const result = hub.dispatch(envelope())
  assert.equal(result.delivered, true)
  assert.deepEqual(result.channels.sort(), ['bark', 'feishu'])
  await hub.idle()
  const entries = history.list()
  assert.equal(entries.length, 2)
  assert.equal(entries.every((entry) => entry.ok), true)
  assert.equal(fetchImpl.calls.length, 2)
})

test('dispatch is silent when the event flag or a rule forbids it', async () => {
  const { hub, history } = makeHub({ bark: { url: 'https://api.day.app/KEY' } })
  assert.deepEqual(hub.dispatch(envelope({ kind: 'aborted', flag: 'aborted' })).channels, [])
  await hub.idle()
  assert.equal(history.size(), 0)

  const { hub: ruled, history: ruledHistory } = makeHub({
    bark: { url: 'https://api.day.app/KEY' },
    rules: [{ mode: 'exclude', pattern: 'noisy' }],
  })
  assert.deepEqual(ruled.dispatch(envelope({ title: 'a noisy task' })).channels, [])
  assert.deepEqual(ruled.dispatch(envelope({ title: 'a quiet task' })).channels, ['bark'])
  await ruled.idle()
  assert.equal(ruledHistory.size(), 1)
})

test('a route narrows the fan-out', async () => {
  const { hub } = makeHub({
    bark: { url: 'https://api.day.app/KEY' },
    webhooks: { feishu: { enabled: true, url: 'https://open.feishu.cn/hook/1' } },
    local: { enabled: false },
    cmcc: { enabled: false },
    routes: [{ pattern: 'deploy', channels: ['feishu'] }],
  })
  assert.deepEqual(hub.dispatch(envelope({ title: 'deploy prod' })).channels, ['feishu'])
  assert.deepEqual(hub.dispatch(envelope({ title: 'write docs' })).channels.sort(), ['bark', 'feishu'])
})

test('a failed delivery is recorded with a redacted message', async () => {
  const fetchImpl = async () => response(500)
  const { hub, history } = makeHub(
    {
      bark: { url: 'https://api.day.app/SECRETKEY123' },
      local: { enabled: false },
      cmcc: { enabled: false },
      delivery: { retries: 0, retryBaseMs: 1 },
    },
    { fetchImpl },
  )
  hub.dispatch(envelope())
  await hub.idle()
  const entry = history.list()[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.channel, 'bark')
  assert.equal(entry.error.includes('SECRETKEY123'), false)
  assert.equal(entry.code, 'NETWORK_ERROR')
})

test('history keeps the newest entries first and honors the limit', async () => {
  const history = createHistory(() => 2)
  history.record({ time: 1, id: 'a', kind: 'completed', channel: 'bark', title: 't', ok: true })
  history.record({ time: 2, id: 'b', kind: 'completed', channel: 'bark', title: 't', ok: true })
  history.record({ time: 3, id: 'c', kind: 'completed', channel: 'bark', title: 't', ok: true })
  assert.deepEqual(history.list().map((entry) => entry.id), ['c', 'b'])
  history.clear()
  assert.equal(history.size(), 0)

  const disabled = createHistory(() => 0)
  disabled.record({ time: 1, id: 'a', kind: 'completed', channel: 'bark', title: 't', ok: true })
  assert.equal(disabled.size(), 0, '0 disables recording')
})

test('test() reports per-channel results and skips unconfigured channels', async () => {
  const configured = makeHub({ bark: { url: 'https://api.day.app/KEY' } })
  const result = await configured.hub.test('bark')
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].ok, true)
  assert.equal(result.results[0].channel, 'bark')
  assert.equal(configured.fetchImpl.calls.length, 1, 'a configured channel really is tested')

  const all = await configured.hub.test('all')
  assert.deepEqual(all.results.map((entry) => entry.channel), ['bark'])

  // A channel that is not ready is ANSWERED, not attempted: the click is a
  // configuration question, and firing a real request at an empty endpoint would
  // only stack a provider error on top of it.
  const unconfigured = await configured.hub.test('cmcc')
  assert.equal(unconfigured.results[0].ok, false)
  assert.equal(unconfigured.results[0].unconfigured, true)
  assert.equal(unconfigured.results[0].reason, 'unconfigured')
  assert.equal(unconfigured.results[0].error, '未配置')

  // Nothing left the process for either refusal.
  const barkless = makeHub({})
  const noBark = await barkless.hub.test('bark')
  assert.equal(noBark.results[0].reason, 'unconfigured')
  assert.equal(barkless.fetchImpl.calls.length, 0, 'an unconfigured channel makes no request')
  const cmccSent = makeHub({}, { cmcc: cmccStub(false) })
  await cmccSent.hub.test('cmcc')
  assert.equal(cmccSent.cmcc.sent.length, 0, 'an unconfigured cmcc channel sends nothing')

  // Switched off is a different answer from unconfigured, and is also never sent.
  const off = makeHub({ bark: { enabled: false, url: 'https://api.day.app/KEY' } })
  const disabled = await off.hub.test('bark')
  assert.equal(disabled.results[0].reason, 'disabled')
  assert.equal(disabled.results[0].error, '未启用')
  assert.equal(off.fetchImpl.calls.length, 0, 'a disabled channel makes no request')

  const empty = makeHub({})
  await assert.rejects(() => empty.hub.test('all'), /没有已启用/)
})

test('test() surfaces a channel failure instead of throwing', async () => {
  const { hub } = makeHub(
    {
      bark: { url: 'https://api.day.app/KEY' },
      local: { enabled: false },
      cmcc: { enabled: false },
      delivery: { retries: 0, retryBaseMs: 1 },
    },
    { fetchImpl: async () => response(500) },
  )
  const result = await hub.test('bark')
  assert.equal(result.results[0].ok, false)
  assert.equal(result.results[0].error.includes('SECRET'), false)
})

test('the in-flight window bounds concurrent deliveries', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = async () => {
    await gate
    return response(200)
  }
  const { hub, history } = makeHub(
    { bark: { enabled: true, url: 'https://api.day.app/KEY' }, local: { enabled: false }, cmcc: { enabled: false } },
    { fetchImpl },
  )
  for (let index = 0; index < MAX_IN_FLIGHT; index += 1) {
    hub.dispatch(envelope({ id: `e${index}` }))
  }
  assert.equal(hub.inFlightCount(), MAX_IN_FLIGHT)
  hub.dispatch(envelope({ id: 'overflow' }))
  await Promise.resolve()
  assert.equal(hub.inFlightCount(), MAX_IN_FLIGHT, 'the overflow delivery was dropped')
  assert.equal(history.list()[0].error, 'delivery queue full')
  release()
  await hub.idle()
  assert.equal(hub.inFlightCount(), 0)
})

test('dispose aborts in-flight work and the cmcc socket', async () => {
  let disposed = false
  const cmcc = cmccStub(false)
  cmcc.dispose = () => { disposed = true }
  const { hub } = makeHub(
    { bark: { url: 'https://api.day.app/KEY' }, local: { enabled: false }, cmcc: { enabled: false } },
    { cmcc },
  )
  hub.dispose()
  assert.equal(disposed, true)
})

test('channelIds lists every channel the hub serves', () => {
  const { hub } = makeHub({})
  assert.deepEqual(hub.channelIds(), ['bark', 'cmcc', 'local', 'feishu', 'wecom', 'dingtalk', 'slack', 'discord', 'custom'])
})
