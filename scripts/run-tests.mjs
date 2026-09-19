#!/usr/bin/env node
/**
 * Test runner.
 *
 * Runs every `tests/*.test.js` as its own `node <file>` process with **inherited**
 * stdio, instead of letting `node --test` spawn children with piped stdio. That
 * keeps `npm test` working in environments where a process may not open a pipe
 * to its own child — the DSH file sandbox is one such environment — while still
 * giving each file a fresh module registry (the isolation `node --test` gives).
 *
 * `node --test tests/` remains equivalent wherever child processes with pipes
 * are available.
 *
 * Exits non-zero when any file failed.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const directory = new URL('../tests/', import.meta.url)
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.test.js'))
  .sort()

if (files.length === 0) {
  console.error('run-tests: no tests/*.test.js files found')
  process.exit(1)
}

const failed = []
for (const file of files) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, directory))], {
    stdio: 'inherit',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  })
  if (result.error) {
    console.error(`run-tests: could not run ${file}: ${result.error.message}`)
    failed.push(file)
    continue
  }
  if (result.status !== 0) failed.push(file)
}

const passed = files.length - failed.length
console.log(`\n${passed}/${files.length} test files passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.join(', ')}`)
  process.exitCode = 1
}
