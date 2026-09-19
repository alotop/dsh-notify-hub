#!/usr/bin/env node
/**
 * Opt-in live check: send ONE real notification per configured channel, using
 * credentials from the environment only.
 *
 *   cp .env.example .env   # fill in what you want to verify
 *   npm run live-check
 *
 * Why this exists: verifying a channel against its real provider needs real
 * credentials, and the tempting shortcut — pasting them into a test file — is
 * exactly how a device key ends up in git history. Here the values live in
 * `.env` (gitignored) and the tracked fixtures stay synthetic.
 *
 * Behaviour:
 *   * a channel whose variables are unset is SKIPPED, so configuring one channel
 *     is enough;
 *   * every secret is masked in the output;
 *   * the exit code is non-zero only when a *configured* channel failed.
 *
 * @module dsh-notify-hub/scripts/live-check
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configuredChannels, maskValue, readLiveTargets } from './live-env.mjs'
import { renderBarkPayload, renderText } from '../lib/render.js'
import { compileSettings } from '../lib/settings.js'
import { sendBark } from '../lib/channels/bark.js'
import { deliverWebhook, feishuSign } from '../lib/channels/webhook.js'
import { localSupport, sendLocalNotification } from '../lib/channels/local.js'
import { CmccChannel } from '../lib/channels/cmcc.js'
import { CMCC_DEFAULTS } from '../lib/types.js'

const envPath = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath)
}

const targets = readLiveTargets(process.env)
const channels = configuredChannels(targets)

const envelope = {
  id: `live-check:${Date.now()}`,
  kind: 'completed',
  flag: 'completed',
  sessionId: 'dsh-notify-hub/live-check',
  title: '通知集合自检',
  summary: '这是一条来自 npm run live-check 的真实投递测试。',
  tools: ['live-check'],
  time: Date.now(),
  durationMs: 1_000,
}
const settings = compileSettings({})
const results = []

function report(channel, ok, detail) {
  results.push({ channel, ok, detail })
  console.log(`${ok ? 'ok    ' : 'FAILED'}  ${channel.padEnd(7)} ${detail}`)
}

console.log(`live-check: ${existsSync(envPath) ? '.env loaded' : 'no .env (copy .env.example)'}`)
console.log(`configured: ${channels.length > 0 ? channels.join(', ') : '(none — every channel will be skipped)'}\n`)

if (targets.bark) {
  try {
    const result = await sendBark(targets.bark.url, renderBarkPayload(envelope, {
      ...settings,
      bark: { ...settings.bark, url: targets.bark.url, group: targets.bark.group },
    }), { retries: 0, timeoutMs: 15_000 })
    report('bark', true, `${maskValue(targets.bark.url)} · attempt(s)=${result.attempts}`)
  } catch (error) {
    report('bark', false, `${maskValue(targets.bark.url)} · ${error.code ?? error.name}: ${error.message}`)
  }
} else {
  console.log('skip    bark    DSH_NOTIFY_HUB_BARK_URL not set')
}

if (targets.cmcc) {
  const channel = new CmccChannel({
    getConfig: () => ({
      enabled: true,
      apiKey: targets.cmcc.apiKey,
      to: targets.cmcc.to,
      serverUrl: CMCC_DEFAULTS.serverUrl,
      uploadUrl: CMCC_DEFAULTS.uploadUrl,
      version: CMCC_DEFAULTS.version,
      prefix: 'DSH',
      includeSummary: true,
    }),
    logger: { warn: () => {} },
    timings: { connectTimeoutMs: 15_000, authTimeoutMs: 15_000 },
  })
  try {
    const probe = await channel.probe(30_000)
    if (!probe.ok) throw new Error(probe.error ?? 'probe failed')
    const sent = await channel.sendText(renderText(envelope, { locale: 'zh', includeSummary: true, prefix: 'DSH', plain: true }))
    report('cmcc', true, `connected via ${probe.transport} · messageId=${sent.messageId} · to=${maskValue(sent.to)}`)
  } catch (error) {
    report('cmcc', false, `${maskValue(targets.cmcc.apiKey)} · ${error.code ?? error.name}: ${error.message}`)
  } finally {
    channel.dispose()
  }
} else {
  console.log('skip    cmcc    DSH_NOTIFY_HUB_CMCC_API_KEY / DSH_NOTIFY_HUB_CMCC_TO not both set')
}

if (targets.feishu) {
  try {
    const result = await deliverWebhook('feishu', targets.feishu.url, envelope, {
      retries: 0,
      timeoutMs: 15_000,
      includeSummary: true,
      keyword: targets.feishu.keyword,
      secret: targets.feishu.secret,
    })
    const signed = targets.feishu.secret.length > 0
      ? ` · signed (${feishuSign(targets.feishu.secret, Math.floor(Date.now() / 1_000)).slice(0, 8)}…)`
      : ''
    const keyword = targets.feishu.keyword.length > 0 ? ` · keyword=${targets.feishu.keyword}` : ''
    report('feishu', true, `${maskValue(targets.feishu.url)} · attempt(s)=${result.attempts}${keyword}${signed}`)
  } catch (error) {
    report('feishu', false, `${maskValue(targets.feishu.url)} · ${error.code ?? error.name}: ${error.message}`)
  }
} else {
  console.log('skip    feishu  DSH_NOTIFY_HUB_FEISHU_URL not set')
}

if (targets.custom) {
  try {
    const result = await deliverWebhook('custom', targets.custom.url, envelope, { retries: 0, timeoutMs: 15_000 })
    report('custom', true, `${maskValue(targets.custom.url)} · attempt(s)=${result.attempts}`)
  } catch (error) {
    report('custom', false, `${maskValue(targets.custom.url)} · ${error.code ?? error.name}: ${error.message}`)
  }
} else {
  console.log('skip    custom  DSH_NOTIFY_HUB_CUSTOM_URL not set')
}

if (targets.local) {
  const support = localSupport()
  if (!support.supported) {
    report('local', false, `unsupported on ${process.platform}`)
  } else {
    try {
      const result = await sendLocalNotification(envelope, settings, {})
      report('local', true, result.backend)
    } catch (error) {
      report('local', false, `${error.code ?? error.name}: ${error.message}`)
    }
  }
} else {
  console.log('skip    local   DSH_NOTIFY_HUB_LOCAL is not 1')
}

const attempted = results.length
const failed = results.filter((entry) => !entry.ok)
console.log(`\n${attempted - failed.length}/${attempted} configured channel(s) delivered`)
if (attempted === 0) console.log('nothing was attempted — fill .env and re-run')
process.exitCode = failed.length > 0 ? 1 : 0
