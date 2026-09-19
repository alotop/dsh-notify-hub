#!/usr/bin/env node
/**
 * Repository hygiene guard.
 *
 * This repository is public, which turns two mistakes into permanent ones:
 *
 *   1. a real credential or personal value committed into a tracked file — git
 *      history makes it effectively undeletable, and a leaked Bark device key or
 *      5G message key is a working credential for whoever finds it;
 *   2. a `.env`-family file reaching the repository or the npm tarball at all.
 *
 * The rule this enforces: **credentials live in `.env` (gitignored); tracked
 * files carry only obviously fake placeholders** (see `.env.example`). Tests and
 * documentation must never be handed a value copied from a real machine — that
 * is exactly how the first leak happened here.
 *
 * Failure output names the file, the line and the *masked* value, and says which
 * rule tripped, so the fix is mechanical: move the value into `.env` and leave a
 * placeholder behind.
 *
 * Usage:
 *   node scripts/check-repo-hygiene.mjs                 # scan `git ls-files`
 *   node scripts/check-repo-hygiene.mjs --list=names.txt # scan a supplied list (tests, restricted shells)
 *
 * @module dsh-notify-hub/scripts/check-repo-hygiene
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/** Root of the package (this file lives in scripts/). */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Values that are documented fakes and therefore allowed to appear in tracked
 * files. Anything else matching the patterns below is treated as real.
 */
export const FICTIONAL_ALLOWLIST = Object.freeze([
  // The canonical example mobile number used by the README and the fixtures.
  '13800138000',
])

/**
 * Credential and personal-data shapes that must never be committed.
 *
 * Each pattern is deliberately tight enough to accept the placeholders this
 * repository actually uses (`EXAMPLEKEY1234`, `ak_replace_me`, `13800138000`)
 * while catching the real thing.
 */
export const CREDENTIAL_PATTERNS = Object.freeze([
  {
    name: 'bark-device-key',
    // A real Bark key is 22 characters; the fixtures are 11–14.
    regex: /https:\/\/api\.day\.app\/[A-Za-z0-9]{20,}/g,
    hint: 'a Bark endpoint carries the device key — put it in .env as DSH_NOTIFY_HUB_BARK_URL',
  },
  {
    name: 'cmcc-api-key',
    regex: /\b(?:ak|app)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    hint: 'a 移动新消息 API key — put it in .env as DSH_NOTIFY_HUB_CMCC_API_KEY',
  },
  {
    name: 'cn-mobile-number',
    regex: /\b1[3-9]\d{9}\b/g,
    hint: 'a phone number — put it in .env as DSH_NOTIFY_HUB_CMCC_TO (13800138000 is the allowed fake)',
  },
  {
    name: 'model-or-service-token',
    regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g,
    hint: 'an API token — put it in .env, never in a tracked file',
  },
  {
    name: 'private-key-block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    hint: 'a private key must never be in the repository',
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
    hint: 'a JWT — put it in .env',
  },
  {
    name: 'windows-user-profile-path',
    // `C:\Users\<you>` / `%USERPROFILE%` are the documented placeholders.
    regex: /[A-Za-z]:\\+Users\\+(?!<)[A-Za-z0-9._-]{2,}/g,
    hint: 'a concrete user profile path — use %USERPROFILE% or /path/to/... in tracked files',
  },
  {
    name: 'macos-user-profile-path',
    regex: /(?:^|[^\w.])[/]Users[/](?!<)[A-Za-z0-9._-]{2,}/g,
    hint: 'a concrete user profile path — use /path/to/... in tracked files',
  },
  {
    name: 'linux-home-path',
    regex: /(?:^|[^\w.])[/]home[/](?!path\/)[a-z][a-z0-9_-]{2,}/g,
    hint: 'a concrete home path — use /path/to/... in tracked files',
  },
  {
    name: 'email-address',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    hint: 'a personal email address — use a noreply or project address, or keep it in .env',
  },
  {
    name: 'credential-assignment',
    // 20+ characters, so the short synthetic fixtures (`ak_testkey123456`) stay
    // legal while a real literal credential is caught.
    regex: /(?<![A-Za-z0-9_])["']?(?:password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+]{20,}["']/gi,
    hint: 'a literal credential assignment — the value belongs in .env',
  },
])

/** Binary-ish extensions the scanner skips (a byte scan of text is the point). */
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.tgz', '.gz', '.zip', '.woff', '.woff2', '.ttf']

/**
 * Whether a path is a `.env`-family file that must never be tracked.
 * `.env.example` is the committed template and is explicitly allowed.
 * @param {string} path - repository-relative path.
 * @returns {boolean} true when the path must not be tracked.
 */
export function isForbiddenEnvPath(path) {
  const name = String(path).split('/').pop() ?? ''
  if (name === '.env.example') return false
  return name === '.env' || name.startsWith('.env.')
}

/**
 * Scan one text for credential-shaped values.
 * @param {string} text - file content.
 * @param {object} [options] - `allow` overrides the fictional allowlist.
 * @returns {Array<{ rule: string, line: number, masked: string, hint: string }>} findings.
 */
export function scanText(text, options = {}) {
  const allow = options.allow ?? FICTIONAL_ALLOWLIST
  const findings = []
  const lines = String(text).split(/\r?\n/)
  for (const { name, regex, hint } of CREDENTIAL_PATTERNS) {
    lines.forEach((line, index) => {
      // A fresh regex per line keeps `lastIndex` from leaking between matches.
      const matcher = new RegExp(regex.source, regex.flags)
      for (const match of line.matchAll(matcher)) {
        const value = match[0]
        if (allow.some((allowed) => value.includes(allowed))) continue
        findings.push({
          rule: name,
          line: index + 1,
          masked: maskExcerpt(value),
          hint,
        })
      }
    })
  }
  return findings
}

/**
 * Mask a matched value for the failure output: enough to locate it, not enough
 * to reuse it. A short match is masked entirely, since revealing it would reveal
 * the whole value.
 * @param {string} value - the matched text.
 * @returns {string} the masked excerpt.
 */
export function maskExcerpt(value) {
  const text = String(value)
  if (text.length <= 2) return '•'.repeat(text.length)
  if (text.length <= 8) return `${text.slice(0, 2)}${'•'.repeat(text.length - 2)}`
  return `${text.slice(0, 4)}${'•'.repeat(6)}${text.slice(-3)}`
}

/** Read the tracked-file list from git (or from `--list=`). */
function trackedFiles() {
  const inline = process.argv.find((argument) => argument.startsWith('--list='))
  if (inline !== undefined) {
    const listPath = inline.slice('--list='.length)
    return readFileSync(listPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  }
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return output.split('\0').filter(Boolean)
}

/**
 * Run the audit.
 *
 * Everything above is pure and exported so the test suite can exercise the rules
 * without a git checkout; this wrapper is the CLI entry point only.
 * @returns {number} the process exit code.
 */
function main() {
  const problems = []

  let files = []
  try {
    files = trackedFiles()
  } catch (error) {
    console.error(`check-repo-hygiene: cannot list tracked files (${error instanceof Error ? error.message : String(error)})`)
    console.error('  run it from a git checkout, or pass --list=<file> with one path per line')
    return 1
  }

  for (const file of files) {
    if (isForbiddenEnvPath(file)) {
      problems.push(`${file}: a .env-family file must never be tracked (only .env.example is committed)`)
      continue
    }
    if (BINARY_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension))) continue
    let content
    try {
      content = readFileSync(`${ROOT}${file}`, 'utf8')
    } catch {
      continue
    }
    if (content.includes('\0')) continue
    for (const finding of scanText(content)) {
      problems.push(`${file}:${finding.line}: ${finding.rule} ${finding.masked} — ${finding.hint}`)
    }
  }

  // The convention itself must stay in place, or the guard silently stops
  // meaning anything.
  if (!files.includes('.env.example')) {
    problems.push('.env.example is missing — the credential convention needs its committed template')
  }
  const ignore = existsSync(`${ROOT}.gitignore`) ? readFileSync(`${ROOT}.gitignore`, 'utf8') : ''
  if (!/^\.env$/m.test(ignore)) {
    problems.push('.gitignore must ignore `.env` (a line reading exactly `.env`)')
  }

  if (problems.length > 0) {
    console.error(`check-repo-hygiene: FAILED (${problems.length} finding(s))`)
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('\n  Credentials belong in .env (gitignored); tracked files carry fake placeholders.')
    return 1
  }

  console.log(`check-repo-hygiene: OK (${files.length} tracked files, no credential shapes)`)
  return 0
}

// Importable as a module (the test suite does), executable as a script.
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main()
}
