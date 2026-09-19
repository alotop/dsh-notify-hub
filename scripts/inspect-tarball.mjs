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
 *   2. development material (tests, local caches, tarballs, a stray settings
 *      document with credentials) leaking into the published artifact.
 *
 * Run it exactly like CI does:
 *
 *   npm pack --dry-run --json > pack.json && node scripts/inspect-tarball.mjs
 *
 * @module dsh-notify-hub/scripts/inspect-tarball
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Files the installed plugin cannot work without. */
const REQUIRED = [
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

const problems = []

/** Read the pack manifest, failing with one actionable line when it is missing. */
function readManifest() {
  const packPath = fileURLToPath(new URL('../pack.json', import.meta.url))
  if (!existsSync(packPath)) {
    console.error('inspect-tarball: pack.json not found — run `npm pack --dry-run --json > pack.json` first')
    process.exit(1)
  }
  const raw = readFileSync(packPath)
  // Windows PowerShell's `>` writes UTF-16LE with a BOM; the tar manifest is
  // plain JSON either way, so accept both rather than failing on the shell.
  const text = raw[0] === 0xff && raw[1] === 0xfe
    ? raw.toString('utf16le')
    : raw.toString('utf8')
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    console.error(`inspect-tarball: pack.json is not valid JSON — ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

const manifest = (() => {
  const parsed = readManifest()
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (entry === undefined || entry === null || typeof entry !== 'object') {
    console.error('inspect-tarball: pack.json has no manifest entry')
    process.exit(1)
  }
  return entry
})()

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

// npm reports paths relative to the package root (`lib/index.js`), while a tar
// listing would show `package/lib/index.js`. Normalize both spellings so the
// audit cannot pass merely because the manifest format changed.
const paths = (manifest.files ?? []).map((entry) => String(entry.path).replace(/^package\//, ''))

if (paths.length === 0) problems.push('the tarball contains no files at all')
if (manifest.name !== pkg.name) problems.push(`the tarball would be published as "${String(manifest.name)}", not "${pkg.name}"`)
if (manifest.version !== pkg.version) problems.push(`the tarball carries version ${String(manifest.version)}, not ${pkg.version}`)

for (const required of REQUIRED) {
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
} else {
  const bundle = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  if (!bundle.includes('window.__ModuleLoader__.load')) {
    problems.push('lib/client.js is not a module-loader bundle')
  }
  if (!bundle.includes(`id: "${pkg.name}"`) && !bundle.includes(`id: '${pkg.name}'`)) {
    problems.push(`lib/client.js must register id "${pkg.name}" (the package row key)`)
  }
}

if (pkg.private === true) problems.push('package.json sets "private": true — npm refuses to publish it')

if (problems.length > 0) {
  console.error('inspect-tarball: FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`inspect-tarball: OK (${paths.length} files, ${pkg.name}@${pkg.version})`)
