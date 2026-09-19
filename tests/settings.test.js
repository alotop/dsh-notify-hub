/**
 * Settings model: schema resolution, compilation, and the browser-safe view.
 * Uses the real schemastery so a schema mistake fails here rather than in DSH.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  compileSettings,
  deepMerge,
  hubSettingsSchema,
  maskRecipient,
  maskSecret,
  sanitizeBarkUrl,
  sanitizeEndpoint,
  settingsView,
  webhookDefaults,
  webhookSecurityOf,
} from '../lib/settings.js'
import { CMCC_DEFAULTS } from '../lib/types.js'

test('schema materializes every nested default', () => {
  const parsed = hubSettingsSchema({})
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.locale, 'zh')
  assert.equal(parsed.bark.url, '')
  assert.equal(parsed.bark.group, 'DeepSeek Harness')
  assert.equal(parsed.bark.level, 'active')
  assert.equal(parsed.events.completed, true)
  assert.equal(parsed.events.planReview, false)
  assert.equal(parsed.webhooks.feishu.enabled, false)
  assert.equal(parsed.cmcc.serverUrl, CMCC_DEFAULTS.serverUrl)
  assert.equal(parsed.cmcc.uploadUrl, CMCC_DEFAULTS.uploadUrl)
  assert.equal(parsed.delivery.timeoutMs, 5_000)
  assert.deepEqual(parsed.rules, [])
  assert.deepEqual(parsed.routes, [])
})

test('schema fills nested field defaults for a partial patch', () => {
  const parsed = hubSettingsSchema({ events: { completed: false }, bark: { url: 'https://api.day.app/KEY' } })
  assert.equal(parsed.events.completed, false)
  assert.equal(parsed.events.error, true)
  assert.equal(parsed.bark.url, 'https://api.day.app/KEY')
  assert.equal(parsed.bark.group, 'DeepSeek Harness')
})

test('schema enforces numeric bounds and enum values', () => {
  assert.throws(() => hubSettingsSchema({ maxBodyChars: 5 }))
  assert.throws(() => hubSettingsSchema({ bark: { level: 'loud' } }))
  // Schemastery only checks that the field is a non-empty string *type*; the
  // matcher's own validity is enforced when the rules are compiled, which is
  // where an unusable pattern would otherwise reach the event listener.
  assert.doesNotThrow(() => hubSettingsSchema({ rules: [{ pattern: '' }] }))
  assert.throws(() => compileSettings({ rules: [{ pattern: '' }] }), /pattern must not be empty/)
  assert.deepEqual(
    hubSettingsSchema({ rules: [{ pattern: 'abc' }] }).rules,
    [{ mode: 'include', pattern: 'abc', regex: false, caseSensitive: false }],
  )
})

test('deepMerge replaces arrays and scalars, merging objects', () => {
  const merged = deepMerge(DEFAULT_SETTINGS, { events: { aborted: true }, rules: [{ pattern: 'x' }] })
  assert.equal(merged.events.aborted, true)
  assert.equal(merged.events.completed, true)
  assert.deepEqual(merged.rules, [{ pattern: 'x' }])
  assert.equal(DEFAULT_SETTINGS.events.aborted, false, 'defaults must not be mutated')
})

test('compileSettings compiles rules and routes with regex support', () => {
  const settings = compileSettings({
    locale: 'en',
    rules: [
      { mode: 'exclude', pattern: 'noisy' },
      { mode: 'include', pattern: '^deploy', regex: true },
    ],
    routes: [{ pattern: 'mobile', channels: ['cmcc', 'bark'] }],
  })
  assert.equal(settings.locale, 'en')
  assert.equal(settings.rules.length, 2)
  assert.ok(settings.rules[1].expression instanceof RegExp)
  assert.equal(settings.rules[1].expression.flags, 'i')
  assert.deepEqual(settings.routes[0].channels, ['cmcc', 'bark'])
  assert.throws(() => compileSettings({ rules: [{ pattern: '(' , regex: true }] }), /invalid regular expression/)
  assert.throws(() => compileSettings({ rules: [{ pattern: '   ' }] }), /pattern must not be empty/)
})

test('masking helpers never leak a full secret', () => {
  assert.deepEqual(maskSecret(''), { configured: false, masked: '' })
  assert.deepEqual(maskSecret('ab'), { configured: true, masked: '••••••••ab' })
  const masked = maskSecret('https://api.day.app/EXAMPLEKEY1234').masked
  assert.ok(masked.endsWith('gAk'))
  assert.ok(!masked.includes('z4Nrrc'))
  assert.equal(maskRecipient('13800138000'), '138••••00')
  assert.equal(maskRecipient(''), '')
  assert.equal(maskRecipient('1234'), '1234')
})

test('endpoint sanitizers trim trailing slashes', () => {
  assert.equal(sanitizeBarkUrl(' https://api.day.app/KEY/ '), 'https://api.day.app/KEY')
  assert.equal(sanitizeEndpoint('wss://host/ws/msg//'), 'wss://host/ws/msg')
})

test('settingsView strips every secret and reports masked status', () => {
  const view = settingsView(compileSettings({
    bark: { url: 'https://api.day.app/SECRETKEY' },
    cmcc: { apiKey: 'ak_abcdefghijkl', to: '13800138000' },
    webhooks: { feishu: { enabled: true, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/SECRET' } },
  }))
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('SECRETKEY'), false)
  assert.equal(serialized.includes('ak_abcdefghijkl'), false)
  assert.equal(serialized.includes('SECRET'), false)
  assert.equal(serialized.includes('13800138000'), false)
  assert.equal(view.bark.configured, true)
  assert.equal(view.bark.masked, '••••••••TKEY')
  assert.equal(view.cmcc.keyConfigured, true)
  assert.equal(view.cmcc.configured, true)
  assert.equal(view.webhooks.feishu.configured, true)
  assert.equal(view.webhooks.wecom.configured, false)
  assert.equal(view.rules.length, 0)
})

test('settingsView marks cmcc unconfigured without a recipient', () => {
  const view = settingsView(compileSettings({ cmcc: { apiKey: 'ak_abcdefghijkl' } }))
  assert.equal(view.cmcc.keyConfigured, true)
  assert.equal(view.cmcc.configured, false)
})

test('only 飞书 carries the bot security fields', () => {
  const parsed = hubSettingsSchema({})
  assert.deepEqual(parsed.webhooks.feishu, {
    enabled: false,
    url: '',
    includeSummary: false,
    keyword: '',
    secret: '',
  })
  assert.deepEqual(parsed.webhooks.wecom, { enabled: false, url: '', includeSummary: false }, 'other providers get no fields')
  assert.deepEqual(parsed.webhooks.dingtalk, { enabled: false, url: '', includeSummary: false })

  // The view echoes the (non-secret) keyword and masks the signing secret.
  const view = settingsView(compileSettings({
    webhooks: { feishu: { enabled: true, url: 'https://open.feishu.cn/hook/1', keyword: 'dsh-notify-hub', secret: 'SIGNINGSECRET123' } },
  }))
  assert.equal(view.webhooks.feishu.keyword, 'dsh-notify-hub')
  assert.equal(view.webhooks.feishu.secretConfigured, true)
  assert.equal(view.webhooks.feishu.secretMasked, '••••••••T123')
  assert.equal(JSON.stringify(view).includes('SIGNINGSECRET123'), false, 'the signing secret never rides the wire')
  assert.equal('keyword' in view.webhooks.wecom, false)
  assert.equal('secretConfigured' in view.webhooks.wecom, false)
})

test('webhookDefaults/webhookSecurityOf describe the capability table', () => {
  assert.deepEqual(webhookSecurityOf('feishu'), { keyword: true, signature: true })
  assert.deepEqual(webhookSecurityOf('slack'), {})
  assert.deepEqual(webhookDefaults('feishu'), { enabled: false, url: '', includeSummary: false, keyword: '', secret: '' })
  assert.deepEqual(webhookDefaults('slack'), { enabled: false, url: '', includeSummary: false })
})
