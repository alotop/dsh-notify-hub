/** Delivery policy: event flags, content rules, and channel routing. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { routeChannels, ruleMatches, ruleSubject, rulesAllow, shouldNotify } from '../lib/policy.js'
import { compileSettings } from '../lib/settings.js'

/** A minimal envelope. */
function envelope(overrides = {}) {
  return {
    id: 'e1',
    kind: 'completed',
    flag: 'completed',
    sessionId: 's1',
    title: '修复登录',
    summary: '已完成修改',
    tools: ['read_file'],
    time: Date.now(),
    ...overrides,
  }
}

test('ruleSubject joins every filterable field', () => {
  const subject = ruleSubject(envelope({ reason: 'boom' }))
  assert.ok(subject.includes('修复登录'))
  assert.ok(subject.includes('已完成修改'))
  assert.ok(subject.includes('boom'))
  assert.ok(subject.includes('completed'))
  assert.ok(subject.includes('read_file'))
})

test('literal rules ignore case unless asked otherwise', () => {
  const compiled = compileSettings({ rules: [{ pattern: 'DEPLOY' }] }).rules
  assert.equal(ruleMatches(compiled[0], 'deploying now'), true)
  const strict = compileSettings({ rules: [{ pattern: 'DEPLOY', caseSensitive: true }] }).rules
  assert.equal(ruleMatches(strict[0], 'deploying now'), false)
})

test('regex rules compile and match', () => {
  const compiled = compileSettings({ rules: [{ pattern: '^fix\\s', regex: true }] }).rules
  assert.equal(ruleMatches(compiled[0], 'fix the bug'), true)
  assert.equal(ruleMatches(compiled[0], 'prefix fix'), false)
})

test('excludes always win; includes restrict when present', () => {
  const exclude = compileSettings({ rules: [{ mode: 'exclude', pattern: 'noisy' }] }).rules
  assert.equal(rulesAllow(exclude, 'a noisy task'), false)
  assert.equal(rulesAllow(exclude, 'a quiet task'), true)

  const include = compileSettings({ rules: [{ mode: 'include', pattern: 'deploy' }] }).rules
  assert.equal(rulesAllow(include, 'deploy the app'), true)
  assert.equal(rulesAllow(include, 'write docs'), false)

  const both = compileSettings({
    rules: [{ mode: 'include', pattern: 'deploy' }, { mode: 'exclude', pattern: 'staging' }],
  }).rules
  assert.equal(rulesAllow(both, 'deploy production'), true)
  assert.equal(rulesAllow(both, 'deploy staging'), false)
  assert.equal(rulesAllow([], 'anything'), true)
})

test('shouldNotify gates on the master switch, event flags, and rules', () => {
  const settings = compileSettings({})
  assert.equal(shouldNotify(settings, envelope()), true)
  assert.equal(shouldNotify(settings, envelope({ kind: 'aborted', flag: 'aborted' })), false, 'aborted is off by default')
  assert.equal(shouldNotify(compileSettings({ enabled: false }), envelope()), false)
  assert.equal(shouldNotify(compileSettings({ rules: [{ mode: 'exclude', pattern: '修复' }] }), envelope()), false)
})

test('routeChannels narrows to the first matching route only', () => {
  const candidates = ['bark', 'local', 'feishu', 'cmcc']
  const routes = compileSettings({
    routes: [
      { pattern: '修复', channels: ['feishu'] },
      { pattern: '修复', channels: ['bark'] },
    ],
  }).routes
  assert.deepEqual(routeChannels(routes, envelope(), candidates), ['feishu'])

  const unmatched = compileSettings({ routes: [{ pattern: 'zzz', channels: ['bark'] }] }).routes
  assert.deepEqual(routeChannels(unmatched, envelope(), candidates), candidates)
  assert.deepEqual(routeChannels([], envelope(), candidates), candidates)
})

test('routeChannels drops channels the hub does not serve', () => {
  const routes = compileSettings({ routes: [{ pattern: '修复', channels: ['feishu', 'nope'] }] }).routes
  assert.deepEqual(routeChannels(routes, envelope(), ['bark', 'feishu']), ['feishu'])
})
