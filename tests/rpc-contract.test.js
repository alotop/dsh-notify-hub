/** RPC patch validation and normalization. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePatch, validatePatch } from '../lib/rpc-contract.js'

test('accepts every documented field', () => {
  const verdict = validatePatch({
    enabled: false,
    locale: 'en',
    notifySubagents: true,
    includeAssistantText: false,
    maxBodyChars: 900,
    historyLimit: 10,
    migrateLegacyBark: false,
    events: { completed: false },
    bark: { enabled: true, url: 'https://x/y', group: 'g', level: 'passive', sound: 'bell' },
    local: { enabled: false, sound: false },
    cmcc: { enabled: true, apiKey: 'ak_1', to: '10086', serverUrl: 'wss://x', uploadUrl: 'https://y', version: '2.0', prefix: 'DSH', includeSummary: false },
    webhooks: { feishu: { enabled: true, url: 'https://h', includeSummary: true, keyword: 'dsh-notify-hub', secret: 'SIGNKEY' } },
    delivery: { timeoutMs: 1_000, retries: 1, retryBaseMs: 100 },
    rules: [{ mode: 'exclude', pattern: 'x', regex: true, caseSensitive: true }],
    routes: [{ pattern: 'y', regex: false, caseSensitive: false, channels: ['bark'] }],
  })
  assert.equal(verdict.message, undefined)
})

test('rejects unknown fields and wrong types', () => {
  assert.match(validatePatch(null).message, /must be an object/)
  assert.match(validatePatch({}).message, /must not be empty/)
  assert.match(validatePatch({ nope: 1 }).message, /not a recognized field/)
  assert.match(validatePatch({ enabled: 'yes' }).message, /must be a boolean/)
  assert.match(validatePatch({ locale: 'fr' }).message, /zh or en/)
  assert.match(validatePatch({ maxBodyChars: '600' }).message, /finite number/)
  assert.match(validatePatch({ bark: { level: 'loud' } }).message, /must be one of/)
  assert.match(validatePatch({ bark: { nope: 1 } }).message, /not a recognized field/)
  assert.match(validatePatch({ events: { nope: true } }).message, /not a recognized field/)
  assert.match(validatePatch({ webhooks: { teams: { enabled: true } } }).message, /not a supported webhook channel/)
  assert.match(validatePatch({ cmcc: { to: 123 } }).message, /must be a string/)
  assert.match(validatePatch({ rules: [{ pattern: '' }] }).message, /non-empty string/)
  assert.match(validatePatch({ rules: [{ pattern: 'x', mode: 'maybe' }] }).message, /include or exclude/)
  assert.match(validatePatch({ routes: [{ pattern: 'x', channels: 'bark' }] }).message, /must be an array/)
  assert.match(validatePatch({ routes: [{ pattern: 'x', channels: [1] }] }).message, /must contain strings/)
  assert.match(validatePatch({ delivery: { retries: 'two' } }).message, /finite number/)
  // The security fields exist for 飞书 only, so they are unknown elsewhere.
  assert.match(validatePatch({ webhooks: { wecom: { keyword: 'x' } } }).message, /not a recognized field/)
  assert.match(validatePatch({ webhooks: { slack: { secret: 'x' } } }).message, /not a recognized field/)
  assert.match(validatePatch({ webhooks: { feishu: { keyword: 1 } } }).message, /must be a string/)
  assert.match(validatePatch({ webhooks: { feishu: { secret: 1 } } }).message, /must be a string/)
})

test('normalizePatch trims credentials, endpoints, and matchers', () => {
  const normalized = normalizePatch({
    bark: { url: '  https://api.day.app/KEY/ ', group: '  g  ', sound: ' bell ' },
    cmcc: { apiKey: ' ak_x ', to: ' 10086 ', serverUrl: ' wss://host/ws/msg/ ', uploadUrl: 'https://up/api/', prefix: ' DSH ', version: ' 2.0 ' },
    webhooks: {
      wecom: { url: '  https://qy  ' },
      feishu: { keyword: '  dsh-notify-hub  ', secret: '  SIGNKEY  ' },
    },
    rules: [{ pattern: '  x  ', regex: 1, caseSensitive: undefined }],
    routes: [{ pattern: ' y ', channels: ['bark'] }],
  })
  assert.equal(normalized.bark.url, 'https://api.day.app/KEY')
  assert.equal(normalized.bark.group, 'g')
  assert.equal(normalized.bark.sound, 'bell')
  assert.equal(normalized.cmcc.apiKey, 'ak_x')
  assert.equal(normalized.cmcc.serverUrl, 'wss://host/ws/msg')
  assert.equal(normalized.cmcc.uploadUrl, 'https://up/api')
  assert.equal(normalized.cmcc.prefix, 'DSH')
  assert.equal(normalized.webhooks.wecom.url, 'https://qy')
  assert.equal(normalized.webhooks.feishu.keyword, 'dsh-notify-hub')
  assert.equal(normalized.webhooks.feishu.secret, 'SIGNKEY')
  assert.deepEqual(normalized.rules, [{ mode: 'include', pattern: 'x', regex: false, caseSensitive: false }])
  assert.deepEqual(normalized.routes, [{ pattern: 'y', regex: false, caseSensitive: false, channels: ['bark'] }])
})

test('normalizePatch leaves unrelated fields untouched', () => {
  const normalized = normalizePatch({ enabled: false, events: { completed: false } })
  assert.deepEqual(normalized, { enabled: false, events: { completed: false } })
})
