/** Legacy Bark adoption from the existing settings document. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readLegacyBarkUrl, settingsFilePath } from '../lib/migration.js'

// Fixture values are entirely synthetic: a test must never carry a real
// credential, even one that only ever existed on the author's machine.
const documented = [
  'ui-onboarding:',
  '  welcomeNoticeVersion: 2026-01-01.1',
  'bark:',
  '  barkUrl: https://api.day.app/EXAMPLEKEY1234',
  '  events:',
  '    completed: true',
  '  group: Example Group',
  'dsh-desktop:',
  '  mode: compatibility',
  '',
].join('\n')

test('reads the endpoint out of a top-level bark section', () => {
  assert.equal(readLegacyBarkUrl(documented), 'https://api.day.app/EXAMPLEKEY1234')
})

test('unquotes quoted scalars and strips trailing comments', () => {
  assert.equal(
    readLegacyBarkUrl('bark:\n  barkUrl: "https://api.day.app/QUOTED"\n'),
    'https://api.day.app/QUOTED',
  )
  assert.equal(
    readLegacyBarkUrl("bark:\n  barkUrl: 'https://api.day.app/SINGLE'\n"),
    'https://api.day.app/SINGLE',
  )
  assert.equal(
    readLegacyBarkUrl('bark:\n  barkUrl: https://api.day.app/PLAIN # my phone\n'),
    'https://api.day.app/PLAIN',
  )
})

test('returns nothing when the section or key is absent', () => {
  assert.equal(readLegacyBarkUrl(''), '')
  assert.equal(readLegacyBarkUrl('other:\n  barkUrl: nope\n'), '')
  assert.equal(readLegacyBarkUrl('bark:\n  group: only-group\n'), '')
  assert.equal(readLegacyBarkUrl('barkUrl: https://api.day.app/ORPHAN\n'), '')
})

test('ignores a nested bark key and refuses a flow mapping', () => {
  assert.equal(readLegacyBarkUrl('plugin:\n  bark:\n    barkUrl: https://api.day.app/NESTED\n'), '')
  assert.equal(readLegacyBarkUrl('bark: {barkUrl: https://api.day.app/FLOW}\n'), '')
})

test('the settings file path follows DSH_HOME', () => {
  // Built with the platform's own join so the assertion holds on Windows and
  // Linux alike (CI runs ubuntu-latest).
  assert.equal(settingsFilePath({ DSH_HOME: join('/srv', 'dsh') }), join('/srv', 'dsh', 'settings.yaml'))
  assert.equal(settingsFilePath({ DSH_HOME: '/path/to/.dsh' }), join('/path/to/.dsh', 'settings.yaml'))
  assert.ok(settingsFilePath({}).endsWith('settings.yaml'))
})
