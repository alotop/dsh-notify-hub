/**
 * Repository hygiene: the credential-shape scanner, the `.env` policy, and the
 * live-check configuration reader.
 *
 * This repository is public, so these are the two rules that must not rot:
 * tracked files carry only obvious fakes, and real values live in `.env`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import {
  CREDENTIAL_PATTERNS,
  FICTIONAL_ALLOWLIST,
  isForbiddenEnvPath,
  maskExcerpt,
  scanText,
} from '../scripts/check-repo-hygiene.mjs'
import { configuredChannels, maskValue, readLiveTargets } from '../scripts/live-env.mjs'

/**
 * One sample per rule. A rule without a sample fails the first test, so adding a
 * pattern forces adding a case that proves it fires.
 *
 * Each sample is ASSEMBLED from fragments: this file is itself scanned by the
 * last test in this file, so a probe written out whole would make the repository
 * fail its own hygiene check. That is the same discipline the guard asks of
 * everyone — no complete credential shape in a tracked file, even a synthetic one.
 */
const probe = (...parts) => parts.join('')

const SAMPLES = {
  'bark-device-key': `const url = 'https://api.day.app/${probe('AbCdEfGhIjKl', 'MnOpQrStUv')}'`,
  'cmcc-api-key': `const key = 'ak_${probe('11111111-2222-', '3333-4444-555555555555')}'`,
  'cn-mobile-number': `const to = '${probe('139', '00000001')}'`,
  'model-or-service-token': `const token = '${probe('ghp_', 'abcdefghijklmnopqrstuvwx')}'`,
  'private-key-block': probe('-----BEGIN RSA ', 'PRIVATE KEY-----'),
  'jwt': probe('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxIn0', '.abcdefghij'),
  'windows-user-profile-path': `use ${probe('C:\\Users\\', 'probeuser\\notes.txt')}`,
  'macos-user-profile-path': `use ${probe('/Users/', 'probeuser/notes.txt')}`,
  'linux-home-path': `use ${probe('/home/', 'probeuser/notes.txt')}`,
  'email-address': `contact ${probe('probe@', 'example.com')} please`,
  'credential-assignment': ['apiKey', ':', " '", 'abcdefghijklmnopqrstuvwx', "'"].join(''),
}

test('every credential pattern has a sample and fires on it', () => {
  for (const { name } of CREDENTIAL_PATTERNS) {
    const sample = SAMPLES[name]
    assert.ok(sample !== undefined, `add a SAMPLES entry for the "${name}" rule`)
    const findings = scanText(sample)
    assert.ok(
      findings.some((finding) => finding.rule === name),
      `the "${name}" rule must fire on its sample`,
    )
  }
  assert.equal(
    Object.keys(SAMPLES).length,
    CREDENTIAL_PATTERNS.length,
    'no sample may be left over after a rule is removed',
  )
})

test('documented fakes are allowed, other values are not', () => {
  assert.deepEqual(scanText("to: '13800138000'"), [], 'the documented fake number is allowed')
  assert.equal(scanText(`to: '${probe('139', '00000001')}'`).length, 1, 'any other mobile number is not')
  assert.ok(FICTIONAL_ALLOWLIST.includes('13800138000'))
  // Short synthetic fixtures must stay legal, or the guard would fight the tests.
  for (const fixture of ['ak_testkey123456', 'ak_abcdefghijkl', 'ak_rotated99999999', 'EXAMPLEKEY1234', '/path/to/proj', 'D:\\path\\to\\proj', '%USERPROFILE%\\.dsh']) {
    assert.deepEqual(scanText(fixture), [], `${fixture} must not be flagged`)
  }
})

test('findings carry the line number and a masked value', () => {
  const key = `ak_${probe('11111111-2222-', '3333-4444-555555555555')}`
  const text = ['line one', 'line two', `const key = '${key}'`, ''].join('\n')
  const findings = scanText(text)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'cmcc-api-key')
  assert.equal(findings[0].line, 3)
  assert.ok(findings[0].masked.includes('•'))
  assert.equal(findings[0].masked.includes(key.slice(-12)), false, 'the report must not restate the value')
  assert.equal(findings[0].masked.startsWith('ak_1'), true)
})

test('maskExcerpt leaves only a locator', () => {
  assert.equal(maskExcerpt('abcdefghijklmnop').includes('defghijklmn'), false)
  assert.ok(maskExcerpt('abcdefghijklmnop').startsWith('abcd'))
  assert.ok(maskExcerpt('ab').length <= 2)
})

test('.env-family files are forbidden except the template', () => {
  for (const path of ['.env', '.env.local', '.env.production', 'nested/.env', 'nested/.env.test']) {
    assert.equal(isForbiddenEnvPath(path), true, `${path} must not be tracked`)
  }
  for (const path of ['.env.example', 'environment.md', 'docs/env.md', 'scripts/live-env.mjs']) {
    assert.equal(isForbiddenEnvPath(path), false, `${path} is allowed`)
  }
})

test('live-check reads only fully configured channels', () => {
  assert.deepEqual(readLiveTargets({ }), { bark: null, cmcc: null, feishu: null, custom: null, local: false })
  assert.deepEqual(configuredChannels(readLiveTargets({})), [])

  // Half-configured is the normal state while setting a channel up: skip it.
  const halfCmcc = readLiveTargets({ DSH_NOTIFY_HUB_CMCC_API_KEY: 'ak_testkey123456' })
  assert.equal(halfCmcc.cmcc, null, 'a key without a recipient must not be attempted')

  const full = readLiveTargets({
    DSH_NOTIFY_HUB_BARK_URL: ' https://api.day.app/EXAMPLEKEY1234 ',
    DSH_NOTIFY_HUB_CMCC_API_KEY: 'ak_testkey123456',
    DSH_NOTIFY_HUB_CMCC_TO: '13800138000',
    DSH_NOTIFY_HUB_FEISHU_URL: 'https://open.feishu.cn/hook/1',
    DSH_NOTIFY_HUB_FEISHU_KEYWORD: 'dsh-notify-hub',
    DSH_NOTIFY_HUB_LOCAL: '1',
  })
  assert.equal(full.bark.url, 'https://api.day.app/EXAMPLEKEY1234', 'values are trimmed')
  assert.equal(full.bark.group, 'DSH live check', 'the group has a default')
  assert.deepEqual(full.cmcc, { apiKey: 'ak_testkey123456', to: '13800138000' })
  assert.equal(full.feishu.keyword, 'dsh-notify-hub')
  assert.equal(full.feishu.secret, '', 'an unset secret stays empty rather than undefined')
  assert.equal(full.custom, null)
  assert.equal(full.local, true)
  assert.deepEqual(configuredChannels(full), ['bark', 'cmcc', 'feishu', 'local'])
})

test('the local switch accepts the usual spellings', () => {
  for (const value of ['1', 'true', 'YES', ' on ']) {
    assert.equal(readLiveTargets({ DSH_NOTIFY_HUB_LOCAL: value }).local, true, `${value} means on`)
  }
  for (const value of ['0', 'false', '', 'off', undefined]) {
    assert.equal(readLiveTargets({ DSH_NOTIFY_HUB_LOCAL: value }).local, false, `${value} means off`)
  }
})

test('maskValue never reveals more than the last four characters', () => {
  assert.equal(maskValue(''), '')
  assert.equal(maskValue('ab'), '••••')
  const masked = maskValue('https://open.feishu.cn/hook/EXAMPLEHOOK')
  assert.ok(masked.endsWith('HOOK'))
  assert.equal(masked.includes('feishu'), false)
})

test('the repository sources contain no credential shapes', () => {
  // Defence in depth: `npm test` catches a leak even where `git ls-files` is
  // unavailable, by scanning the source tree directly.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const skip = new Set(['.git', 'node_modules', '.npm-cache'])
  const findings = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (/\.(png|jpe?g|gif|webp|tgz|gz|zip|ico)$/i.test(entry.name)) continue
      if (entry.name === 'pack.json') continue
      const text = readFileSync(path, 'utf8')
      if (text.includes('\0')) continue
      for (const finding of scanText(text)) {
        findings.push(`${relative(root, path)}:${finding.line} ${finding.rule}`)
      }
    }
  }
  walk(root)
  assert.deepEqual(findings, [], `credential-shaped values in source:\n${findings.join('\n')}`)
})
