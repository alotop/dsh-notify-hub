#!/usr/bin/env node
/**
 * Client-bundle guard.
 *
 * The browser half (`lib/client.js`) is authored directly in the module-loader
 * bundle format this deployment serves under `/plugins`, so no bundler owns it
 * and nothing else would notice if it went missing, lost its registration call,
 * or drifted away from the package's own name. This check fails the build
 * loudly instead: a package that ships like that would install cleanly and
 * simply have no settings section.
 *
 * The registry install is also the browser install, so the same invariants are
 * re-checked against the packed tarball by `scripts/inspect-tarball.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const bundle = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const problems = []

if (!existsSync(bundle)) {
  problems.push('lib/client.js is missing — the settings section would never load')
} else {
  const source = readFileSync(bundle, 'utf8')
  if (!source.includes('window.__ModuleLoader__.load')) {
    problems.push('lib/client.js is not a module-loader bundle (no window.__ModuleLoader__.load call)')
  }
  // The registration key is the package row: it must be the package name,
  // scope included, or the host has a row nothing ever answers.
  if (!source.includes(`id: "${pkg.name}"`) && !source.includes(`id: '${pkg.name}'`)) {
    problems.push(`lib/client.js must register the package name as its id (expected "${pkg.name}")`)
  }
  if (!source.includes('settings.section')) {
    problems.push('lib/client.js does not register a settings.section slot')
  }
  if (!source.includes('/dsh-notify-hub')) {
    problems.push('lib/client.js does not talk to the /dsh-notify-hub RPC channel')
  }

  const clientExport = pkg.exports?.['./client']
  const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default
  if (clientPath !== './lib/client.js') {
    problems.push(`package.json exports["./client"] must point at ./lib/client.js (got ${String(clientPath)})`)
  }
  if (pkg.dsh?.client?.platform !== 'web') {
    problems.push('package.json dsh.client.platform must be "web"')
  }
  if (!pkg.dsh?.bundle?.patch) {
    problems.push('package.json dsh.bundle.patch must point at cordis.patch.yml')
  }

  // The bundle patch's `name` is the specifier the loader imports, so it has to
  // be the package name too.
  const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
  if (!patch.includes(pkg.name)) {
    problems.push(`cordis.patch.yml must name the package "${pkg.name}" so the loader can import it`)
  }
}

if (problems.length > 0) {
  console.error('check-client: FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`check-client: OK (${pkg.name}@${pkg.version}, ${readFileSync(bundle, 'utf8').length} bytes)`)
