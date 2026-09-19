#!/usr/bin/env node
/**
 * Published-tarball audit.
 *
 * What ships to npm IS the plugin: the loader imports `lib/` on the Host and the
 * browser fetches `lib/client.js` from the registry install. Two failure modes
 * are invisible locally and only surface for a user who installed from npm:
 *
 *   1. a package.json `files` entry that drops something the runtime needs, so
 *      the plugin installs cleanly and then cannot load its settings section;
 *   2. development material (tests, local caches, tarballs, a `.env`, a settings
 *      document with credentials) leaking into the published artifact.
 *
 * WHY THE MANIFEST SHAPE IS NORMALIZED
 * `npm pack --json` changed its output shape without a major-version signal in
 * the CLI:
 *
 *   npm <= 11   [ { name, entryCount, files: [{ path, size, mode }] } ]
 *   npm >= 12   { "<package-name>": { name, entryCount, files: [...] } }
 *
 * npm 12 passes `key: tar.name` to its logger, which wraps the record in an
 * object keyed by package name. An audit that only understood the array form
 * passed locally (npm 11) and failed on CI, which installs npm@latest — reporting
 * every required file as missing while the tarball was in fact fine.
 * {@link findPackRecord} accepts either shape, and the failure path prints the
 * keys it did see, so the next shape change is diagnosable from one CI log.
 *
 * Run it exactly like CI does:
 *
 *   npm pack --dry-run --json > pack.json && node scripts/inspect-tarball.mjs
 *
 * @module dsh-notify-hub/scripts/inspect-tarball
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/** Files the installed plugin cannot work without. */
export const REQUIRED_FILES = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/types.js',
  'lib/settings.js',
  'lib/events.js',
  'lib/policy.js',
  'lib/render.js',
  'lib/hub.js',
  'lib/history.js',
  'lib/status.js',
  'lib/migration.js',
  'lib/rpc.js',
  'lib/rpc-contract.js',
  'lib/channels/http.js',
  'lib/channels/bark.js',
  'lib/channels/webhook.js',
  'lib/channels/local.js',
  'lib/channels/cmcc.js',
  'README.md',
  'README.zh-CN.md',
  'THIRD-PARTY-NOTICES.md',
  'LICENSE',
]

/** Path prefixes that must never reach the registry (npm lists them without a `package/` prefix). */
const FORBIDDEN_PREFIXES = [
  'node_modules/',
  'tests/',
  '.npm-cache/',
  '.github/',
  '.git/',
  '.dsh-',
]

/** File names that must never reach the registry (local state, credentials, artifacts). */
const FORBIDDEN_NAMES = [
  '.env',
  'settings.yaml',
  'pack.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
]

/** Whether a value looks like the one pack record that carries a file list. */
function hasFileList(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value.files)
}

/**
 * Find the package record inside any `npm pack --json` shape.
 *
 * Accepts the npm ≤ 11 array, the npm ≥ 12 object keyed by package name, and a
 * bare record object.
 *
 * @param {unknown} pack - the parsed manifest.
 * @returns {object | undefined} the record, or undefined when none carries a file list.
 */
export function findPackRecord(pack) {
  if (Array.isArray(pack)) return pack.find(hasFileList) ?? pack[0]
  if (pack !== null && typeof pack === 'object') {
    if (hasFileList(pack)) return pack
    return Object.values(pack).find(hasFileList)
  }
  return undefined
}

/**
 * Describe what a manifest actually contained, for a diagnosable failure.
 * @param {unknown} pack - the parsed manifest.
 * @returns {string} a one-line description.
 */
export function describeManifest(pack) {
  if (Array.isArray(pack)) {
    const keys = Object.keys(pack[0] ?? {})
    return `top-level: array(${pack.length}); first keys: ${JSON.stringify(keys)}`
  }
  if (pack !== null && typeof pack === 'object') {
    const values = Object.values(pack)
    const keys = Object.keys(values.find(hasFileList) ?? values[0] ?? {})
    return `top-level: object; keys: ${JSON.stringify(Object.keys(pack))}; record keys: ${JSON.stringify(keys)}`
  }
  return `top-level: ${typeof pack}`
}

/** Read and parse the pack manifest, honouring the shell's possible UTF-16 output. */
function readManifest(packPath) {
  if (!existsSync(packPath)) {
    console.error('inspect-tarball: pack.json not found — run `npm pack --dry-run --json > pack.json` first')
    return undefined
  }
  const raw = readFileSync(packPath)
  // Windows PowerShell's `>` writes UTF-16LE with a BOM; the tar manifest is
  // plain JSON either way, so accept both rather than failing on the shell.
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    console.error(`inspect-tarball: pack.json is not valid JSON — ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Audit a parsed manifest.
 * @param {unknown} manifest - the parsed `npm pack --json` output.
 * @param {object} pkg - the package manifest this repository publishes.
 * @param {object} [options] - `clientBundle` is the text of lib/client.js.
 * @returns {string[]} problems; empty when the tarball is publishable.
 */
export function auditManifest(manifest, pkg, options = {}) {
  const problems = []
  const entry = findPackRecord(manifest)
  if (entry === undefined) {
    return [`no package record with a file list in pack.json (${describeManifest(manifest)})`]
  }

  // npm reports paths relative to the package root (`lib/index.js`), while a tar
  // listing would show `package/lib/index.js`. Normalize both spellings so the
  // audit cannot pass merely because the manifest format changed again.
  const paths = (entry.files ?? []).map((file) => String(typeof file === 'string' ? file : file.path).replace(/^package\//, ''))

  if (paths.length === 0) problems.push(`the tarball contains no files at all (${describeManifest(manifest)})`)
  if (entry.name !== undefined && entry.name !== pkg.name) {
    problems.push(`the tarball would be published as "${String(entry.name)}", not "${pkg.name}"`)
  }
  if (entry.version !== undefined && entry.version !== pkg.version) {
    problems.push(`the tarball carries version ${String(entry.version)}, not ${pkg.version}`)
  }

  for (const required of REQUIRED_FILES) {
    if (!paths.includes(required)) problems.push(`missing from the tarball: ${required}`)
  }

  for (const path of paths) {
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (path.startsWith(prefix)) problems.push(`development material would be published: ${path}`)
    }
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (FORBIDDEN_NAMES.includes(name)) problems.push(`local state would be published: ${path}`)
    if (name.endsWith('.tgz')) problems.push(`a packed tarball would be published: ${path}`)
  }

  // The registry install is also the browser install: the client half must be a
  // module-loader bundle and its registration id must match the package name (the
  // client module system keys factories by package row).
  if (!paths.includes('lib/client.js')) {
    problems.push('lib/client.js is absent — the settings section would never load')
  } else if (options.clientBundle !== undefined) {
    if (!options.clientBundle.includes('window.__ModuleLoader__.load')) {
      problems.push('lib/client.js is not a module-loader bundle')
    }
    if (!options.clientBundle.includes(`id: "${pkg.name}"`) && !options.clientBundle.includes(`id: '${pkg.name}'`)) {
      problems.push(`lib/client.js must register id "${pkg.name}" (the package row key)`)
    }
  }

  if (pkg.private === true) problems.push('package.json sets "private": true — npm refuses to publish it')

  return problems
}

/** Audit this repository's own tarball. */
function main() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = readManifest(`${root}pack.json`)
  if (manifest === undefined) return 1

  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
  const problems = auditManifest(manifest, pkg, {
    clientBundle: readFileSync(`${root}lib/client.js`, 'utf8'),
  })

  if (problems.length > 0) {
    console.error(`inspect-tarball: FAILED (${problems.length} problem(s))`)
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }

  const entry = findPackRecord(manifest)
  const count = (entry.files ?? []).length
  console.log(`inspect-tarball: OK (${count} files, ${pkg.name}@${pkg.version})`)
  return 0
}

// Importable as a module (the test suite does), executable as a script.
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main()
}
