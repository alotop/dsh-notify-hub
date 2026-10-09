/**
 * The 0.2 configuration seam: the schema projection and the live-reference reader.
 *
 * The runtime ships schemastery 3.18.4, whose `volatile()` turns a leaf into a
 * stable reference read with `.get()`. The local dev dependency can be older (the
 * projection then degrades to plain values, and the plugin still loads), so the
 * reference shape is exercised here with the same duck-typed tree the runtime
 * produces — verified against 3.18.4 itself before this shipped.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  VOLATILE_SUPPORTED,
  buildHubSchema,
  compileSettings,
  hubConfigSchema,
  hubSettingsSchema,
  isVolatileRef,
  readConfig,
} from '../lib/settings.js'

/** The shape a 0.1.x settings.yaml holds in its `notify-hub:` section. */
const LEGACY_SECTION = {
  bark: { url: 'https://api.day.app/EXAMPLEKEY1234', group: 'Example Group' },
  cmcc: { apiKey: 'ak_replace_me', to: '13800138000' },
  events: { completed: true, blocked: true, planReview: false },
  webhooks: { feishu: { url: 'https://open.feishu.cn/hook/EXAMPLE', enabled: true, includeSummary: true, secret: 'demo' } },
}

test('isVolatileRef recognises the reference shape and nothing else', () => {
  assert.equal(isVolatileRef({ get: () => 1 }), true)
  assert.equal(isVolatileRef('plain'), false)
  assert.equal(isVolatileRef(7), false)
  assert.equal(isVolatileRef(null), false)
  assert.equal(isVolatileRef([{ get: () => 1 }]), false, 'an array is not a reference')
  assert.equal(isVolatileRef({ url: 'x' }), false)
})

test('readConfig unwraps a live tree and passes a plain one through', () => {
  const live = {
    bark: { url: { get: () => 'https://api.day.app/EXAMPLEKEY1234' }, group: { get: () => 'G' } },
    rules: [{ pattern: 'deploy' }],
    historyLimit: { get: () => 42 },
  }
  assert.deepEqual(readConfig(live), {
    bark: { url: 'https://api.day.app/EXAMPLEKEY1234', group: 'G' },
    rules: [{ pattern: 'deploy' }],
    historyLimit: 42,
  })
  // The 0.1.x path is the identity, which is why one reader serves both seams.
  assert.deepEqual(readConfig(LEGACY_SECTION), LEGACY_SECTION)
  assert.equal(readConfig(undefined), undefined)
  assert.ok(!JSON.stringify(readConfig(live)).includes('get'), 'no reference survives')
})

test('unwrapping a live tree compiles exactly like the same data in plain form', () => {
  const live = {
    bark: { url: { get: () => 'https://api.day.app/EXAMPLEKEY1234' } },
    cmcc: { apiKey: { get: () => 'ak_replace_me' }, to: { get: () => '13800138000' } },
  }
  const plain = {
    bark: { url: 'https://api.day.app/EXAMPLEKEY1234' },
    cmcc: { apiKey: 'ak_replace_me', to: '13800138000' },
  }
  // compileSettings works on plain data — unwrapping first is the whole point of
  // readConfig, and the two forms must not compile differently.
  assert.deepEqual(compileSettings(readConfig(live)), compileSettings(plain))
  assert.equal(compileSettings(readConfig(live)).cmcc.apiKey, 'ak_replace_me')
})

test('the 0.1.x and 0.2 projections come from one field tree', () => {
  const legacy = hubSettingsSchema(LEGACY_SECTION)
  // The 0.1.x projection stores plain data: that is what the settings service
  // round-trips through settings.yaml.
  assert.equal(typeof legacy.bark.url, 'string')
  assert.equal(legacy.bark.url, 'https://api.day.app/EXAMPLEKEY1234')
  assert.equal(legacy.events.planReview, false)
  assert.equal(legacy.webhooks.feishu.secret, 'demo')

  const config = hubConfigSchema(LEGACY_SECTION)
  if (VOLATILE_SUPPORTED) {
    assert.ok(isVolatileRef(config.bark.url), 'the 0.2 projection is live')
    assert.equal(config.bark.url.get(), 'https://api.day.app/EXAMPLEKEY1234')
    assert.ok(isVolatileRef(config.events.completed))
    assert.equal(readConfig(config).bark.url, 'https://api.day.app/EXAMPLEKEY1234')
  } else {
    // An older schemastery has no volatile fields: the projection is plain, the
    // plugin still loads, and only live applies are lost.
    assert.equal(typeof config.bark.url, 'string')
  }
  // Containers and index-addressed arrays are never volatile, which is what
  // schemastery's "fixed object path" rule requires.
  assert.deepEqual(config.rules, [])
  assert.equal(readConfig(config).webhooks.feishu.keyword, '', 'a schema default reaches the reader')
})

test('a default is a value, not a missing field', () => {
  const config = hubConfigSchema(LEGACY_SECTION)
  const plain = readConfig(config)
  assert.equal(plain.local.enabled, DEFAULT_SETTINGS.local.enabled)
  assert.equal(plain.delivery.retries, DEFAULT_SETTINGS.delivery.retries)
  assert.equal(plain.migrateLegacyBark, true, 'the legacy recovery switch defaults on')
  assert.equal(plain.events.planReview, false, 'a stored false is not mistaken for absent')
  assert.deepEqual(buildHubSchema({ volatile: false })(LEGACY_SECTION).cmcc.to, '13800138000')
})
