/**
 * The published-tarball audit must understand every `npm pack --json` shape.
 *
 * This is a regression test for a real CI failure: the audit originally handled
 * only npm ≤ 11's array form, so on CI — which installs npm@latest, i.e. npm 12's
 * object keyed by package name — it read no file list and reported every required
 * file as missing, failing the release while the tarball was in fact fine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { auditManifest, describeManifest, findPackRecord, REQUIRED_FILES } from '../scripts/inspect-tarball.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** A file list covering everything the runtime needs. */
const GOOD_PATHS = [...REQUIRED_FILES, 'scripts/run-tests.mjs', 'cordis.patch.yml'].filter((path, index, all) => all.indexOf(path) === index)

const record = { name: pkg.name, version: pkg.version, entryCount: GOOD_PATHS.length, files: GOOD_PATHS.map((path) => ({ path, size: 10, mode: 420 })) }

test('npm ≤ 11 array shape is understood', () => {
  const manifest = [record]
  assert.equal(findPackRecord(manifest), record)
  assert.deepEqual(auditManifest(manifest, pkg), [])
})

test('npm ≥ 12 object-keyed shape is understood', () => {
  const manifest = { [pkg.name]: record }
  assert.equal(findPackRecord(manifest), record)
  assert.deepEqual(auditManifest(manifest, pkg), [], 'the shape that broke CI must audit cleanly')
})

test('a bare record object is understood', () => {
  assert.equal(findPackRecord(record), record)
  assert.deepEqual(auditManifest(record, pkg), [])
})

test('file entries may be plain strings', () => {
  const manifest = { [pkg.name]: { ...record, files: GOOD_PATHS } }
  assert.deepEqual(auditManifest(manifest, pkg), [])
})

test('a package/-prefixed listing is normalized', () => {
  const manifest = [{ ...record, files: GOOD_PATHS.map((path) => ({ path: `package/${path}` })) }]
  assert.deepEqual(auditManifest(manifest, pkg), [])
})

test('a dropped required file is reported', () => {
  const manifest = [{ ...record, files: record.files.filter((file) => file.path !== 'lib/client.js') }]
  const problems = auditManifest(manifest, pkg)
  assert.ok(problems.some((problem) => problem.includes('missing from the tarball: lib/client.js')))
  assert.ok(problems.some((problem) => problem.includes('lib/client.js is absent')))
})

test('development material and local state are refused', () => {
  const manifest = [{
    ...record,
    files: [...record.files, { path: 'tests/host.test.js' }, { path: '.env' }, { path: 'settings.yaml' }, { path: 'node_modules/ws/index.js' }],
  }]
  const problems = auditManifest(manifest, pkg).join('\n')
  assert.match(problems, /development material would be published: tests\/host\.test\.js/)
  assert.match(problems, /local state would be published: \.env/)
  assert.match(problems, /local state would be published: settings\.yaml/)
  assert.match(problems, /development material would be published: node_modules\/ws\/index\.js/)
})

test('a mismatched name or version is refused', () => {
  assert.match(auditManifest([{ ...record, name: 'dsh-notify-hub' }], pkg).join('\n'), /would be published as "dsh-notify-hub"/)
  assert.match(auditManifest([{ ...record, version: '0.0.1' }], pkg).join('\n'), /carries version 0\.0\.1/)
})

test('a client bundle that lost its registration id is refused', () => {
  const manifest = [record]
  const renamed = auditManifest(manifest, pkg, { clientBundle: 'window.__ModuleLoader__.load({ id: "someone-else" })' })
  assert.match(renamed.join('\n'), /must register id/)
  const notABundle = auditManifest(manifest, pkg, { clientBundle: 'module.exports = {}' })
  assert.match(notABundle.join('\n'), /not a module-loader bundle/)
})

test('an unrecognizable manifest is reported with what was seen', () => {
  for (const manifest of [null, 42, {}, { error: { code: 'ENOENT' } }]) {
    const problems = auditManifest(manifest, pkg)
    assert.equal(problems.length, 1, `${JSON.stringify(manifest)} must produce exactly one problem`)
    assert.match(problems[0], /no package record with a file list/)
    assert.match(problems[0], /top-level:/, 'the message must name the shape seen')
  }
  assert.match(describeManifest({ error: { code: 'ENOENT' } }), /keys: \["error"\]/)
  assert.match(describeManifest([]), /array\(0\)/)
})

test('this repository passes its own audit', async () => {
  // Exercises the real client bundle against the real package name.
  const { execFileSync } = await import('node:child_process')
  let manifest
  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    manifest = JSON.parse(output)
  } catch (error) {
    // A restricted shell may forbid spawning npm (the DSH sandbox does), and on
    // Windows `npm` may only exist as npm.cmd. Those are environment limits, not
    // audit failures — the shape tests above still cover the logic. Anything else
    // (npm exited non-zero, or emitted something unparseable) must surface.
    if (['ENOENT', 'EPERM', 'EACCES'].includes(error?.code)) return
    throw error
  }
  const problems = auditManifest(manifest, pkg, { clientBundle: readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8') })
  assert.deepEqual(problems, [])
})
