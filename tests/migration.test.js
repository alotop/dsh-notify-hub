/** Legacy Bark adoption from the existing settings document. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractSection,
  loadLegacyNamespace,
  readLegacyBarkUrl,
  settingsFileCandidates,
  settingsFilePath,
} from '../lib/migration.js'

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

test('extractSection returns one top-level block and nothing else', () => {
  const document = [
    'ui-onboarding:',
    '  welcomeNoticeVersion: 2026-01-01.1',
    'notify-hub:',
    '  bark:',
    '    url: https://api.day.app/EXAMPLEKEY1234',
    '',
    '  events:',
    '    completed: true',
    'shell:',
    '  path: /path/to/shell',
    '',
  ].join('\n')
  assert.equal(extractSection(document, 'notify-hub'), [
    'notify-hub:',
    '  bark:',
    '    url: https://api.day.app/EXAMPLEKEY1234',
    '',
    '  events:',
    '    completed: true',
  ].join('\n'))
  // The extracted text is a document in its own right, so the runtime's real
  // YAML parser can read it instead of a hand-rolled reader guessing.
  assert.equal(extractSection(document, 'ui-onboarding'), 'ui-onboarding:\n  welcomeNoticeVersion: 2026-01-01.1')
  assert.equal(extractSection(document, 'shell'), 'shell:\n  path: /path/to/shell')
  assert.equal(extractSection(document, 'absent'), null)
  assert.equal(extractSection('', 'notify-hub'), null)
  assert.equal(extractSection('notify-hub:\n', 'notify-hub'), 'notify-hub:')
})

test('loadLegacyNamespace reads the hub section from either settings file', () => {
  const home = mkdtempSync(join(tmpdir(), 'notify-hub-legacy-'))
  try {
    // DSH 0.2 renamed the document after importing what it could address; the
    // hub's own section was left behind there.
    writeFileSync(join(home, 'settings.yaml.imported'), [
      'ui-onboarding:',
      '  welcomeNoticeVersion: 2026-01-01.1',
      'notify-hub:',
      '  bark:',
      '    url: https://api.day.app/EXAMPLEKEY1234',
      '    group: Example Group',
      '',
    ].join('\n'))

    const seen = []
    const parseYaml = (text) => {
      seen.push(text)
      assert.ok(text.startsWith('notify-hub:'), 'only the hub section is handed to the parser')
      return { 'notify-hub': { bark: { url: 'https://api.day.app/EXAMPLEKEY1234', group: 'Example Group' } } }
    }
    const result = loadLegacyNamespace({ env: { DSH_HOME: home }, parseYaml })
    assert.equal(result.found, true)
    assert.equal(result.section.bark.url, 'https://api.day.app/EXAMPLEKEY1234')
    assert.equal(result.file, join(home, 'settings.yaml.imported'))
    assert.equal(seen.length, 1, 'the current file is tried first and the renamed one second')

    // The live document, when it exists, wins over the renamed backup.
    writeFileSync(join(home, 'settings.yaml'), 'notify-hub:\n  bark:\n    url: https://api.day.app/SECONDKEY99\n')
    const live = loadLegacyNamespace({
      env: { DSH_HOME: home },
      parseYaml: () => ({ 'notify-hub': { bark: { url: 'https://api.day.app/SECONDKEY99' } } }),
    })
    assert.equal(live.file, join(home, 'settings.yaml'))

    // Nothing to read, nothing to guess.
    assert.deepEqual(loadLegacyNamespace({ env: { DSH_HOME: home }, files: [join(home, 'nope.yaml')], parseYaml: () => ({}) }), { found: false, section: null, file: '' })
    // Without a parser the recovery is skipped rather than attempted blindly.
    assert.equal(loadLegacyNamespace({ env: { DSH_HOME: home } }).found, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a malformed legacy section is reported and skipped, not thrown', () => {
  const home = mkdtempSync(join(tmpdir(), 'notify-hub-legacy-bad-'))
  const warnings = []
  try {
    writeFileSync(join(home, 'settings.yaml'), 'notify-hub:\n  bark: [unclosed\n')
    const result = loadLegacyNamespace({
      env: { DSH_HOME: home },
      parseYaml: () => {
        throw new Error('bad yaml')
      },
      logger: { warn: (message) => warnings.push(message) },
    })
    assert.equal(result.found, false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /bad yaml/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the candidate files cover both the live and the renamed document', () => {
  assert.deepEqual(settingsFileCandidates({ DSH_HOME: '/srv/dsh' }), [
    join('/srv/dsh', 'settings.yaml'),
    join('/srv/dsh', 'settings.yaml.imported'),
  ])
})
