#!/usr/bin/env node
/**
 * Client-bundle guard.
 *
 * The browser half (`lib/client.js`) is authored directly in the module-loader
 * bundle format this deployment serves at `/plugins/dsh-notify-hub/client.js`,
 * so no bundler owns it and nothing else would notice if it went missing or lost
 * its registration call. This check fails the build loudly instead: a package
 * that ships without a working client half would install cleanly and simply have
 * no settings section.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundle = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const problems = []

if (!existsSync(bundle)) {
  problems.push('lib/client.js is missing — the settings section would never load')
} else {
  const source = readFileSync(bundle, 'utf8')
  if (!source.includes('window.__ModuleLoader__.load')) {
    problems.push('lib/client.js is not a module-loader bundle (no window.__ModuleLoader__.load call)')
  }
  if (!source.includes('"dsh-notify-hub"') && !source.includes("'dsh-notify-hub'")) {
    problems.push('lib/client.js does not register the dsh-notify-hub id')
  }
  if (!source.includes('settings.section')) {
    problems.push('lib/client.js does not register a settings.section slot')
  }
  if (!source.includes('/dsh-notify-hub')) {
    problems.push('lib/client.js does not talk to the /dsh-notify-hub RPC channel')
  }

  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
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
}

if (problems.length > 0) {
  console.error('check-client: FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`check-client: OK (${readFileSync(bundle, 'utf8').length} bytes)`)
