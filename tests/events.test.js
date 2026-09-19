/** The event collector: live folding, dedupe, the completion gate, and envelope shape. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDedupeLedger, createEventCollector, workspaceNameOf } from '../lib/events.js'
import { compileSettings } from '../lib/settings.js'

/** A session projection as `session/event` delivers it. */
function session(id = 's1', cwd = '/path/to/proj') {
  return { id, header: { cwd } }
}

/** One session event. */
function ev(type, data, seq, time) {
  return { type, data, seq, time }
}

/** Build a collector whose output lands in an array. */
function collectorFor(options = {}) {
  const emitted = []
  const collector = createEventCollector({
    getSettings: () => compileSettings(options.settings ?? {}),
    emit: (envelope) => emitted.push(envelope),
    isRootSession: options.isRootSession ?? (() => true),
    isIdle: options.isIdle ?? (() => true),
    logger: { warn: () => {} },
  })
  return { collector, emitted }
}

test('a completed turn folds title, summary, tools, and duration', () => {
  const { collector, emitted } = collectorFor()
  const s = session()
  collector.handle(s, ev('session/title', { title: '修复登录' }, 1, 1_000))
  collector.handle(s, ev('turn/start', { turn: 1 }, 2, 2_000))
  collector.handle(s, ev('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '第一段' }] } }, 3, 2_400))
  collector.handle(s, ev('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '第二段' }] } }, 4, 2_800))
  collector.handle(s, ev('tool/call', { turn: 1, name: 'read_file', callId: 'c1', arguments: '{}' }, 5, 3_000))
  collector.handle(s, ev('tool/call', { turn: 1, name: 'read_file', callId: 'c2', arguments: '{}' }, 6, 3_100))
  collector.handle(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7, 5_000))

  assert.equal(emitted.length, 1)
  const envelope = emitted[0]
  assert.equal(envelope.kind, 'completed')
  assert.equal(envelope.flag, 'completed')
  assert.equal(envelope.id, 's1:turn:1')
  assert.equal(envelope.title, '修复登录')
  assert.equal(envelope.summary, '第一段\n第二段')
  assert.deepEqual(envelope.tools, ['read_file'])
  assert.equal(envelope.durationMs, 3_000)
  assert.equal(envelope.reason, undefined)
})

test('a repeated event sequence never notifies twice', () => {
  const { collector, emitted } = collectorFor()
  const s = session()
  collector.handle(s, ev('turn/start', { turn: 1 }, 1, 1_000))
  const end = ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000)
  collector.handle(s, end)
  collector.handle(s, end)
  assert.equal(emitted.length, 1)
})

test('the first human prompt titles the session when no title event arrives', () => {
  const { collector, emitted } = collectorFor()
  const s = session('s9')
  collector.handle(s, ev('user/message', { content: [{ type: 'text', text: '把这个接口重构一下' }] }, 1, 1_000))
  collector.handle(s, ev('turn/start', { turn: 1 }, 2, 1_100))
  collector.handle(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3, 1_200))
  assert.equal(emitted[0].title, '把这个接口重构一下')
})

test('a synthetic user/message is never used as a title', () => {
  const { collector, emitted } = collectorFor()
  const s = session('s9', '/path/to/my-project')
  collector.handle(s, ev('user/message', {
    source: { kind: 'agent-inject' },
    content: [{ type: 'text', text: 'system reminder noise' }],
  }, 1, 1_000))
  collector.handle(s, ev('turn/start', { turn: 1 }, 2, 1_100))
  collector.handle(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3, 1_200))
  assert.equal(emitted[0].title, 'my-project', 'falls back to the workspace name')
})

test('a busy agent parks the turn-end envelope until it goes idle', () => {
  const { collector, emitted } = collectorFor({ isIdle: () => false })
  const s = session()
  collector.handle(s, ev('turn/start', { turn: 1 }, 1, 1_000))
  collector.handle(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000))
  assert.equal(emitted.length, 0)
  assert.equal(collector.pendingCount(), 1)
  const flushed = collector.flush('s1')
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].kind, 'completed')
  assert.equal(collector.pendingCount(), 0)
})

test('an unknown idleness source delivers immediately', () => {
  const { collector, emitted } = collectorFor({ isIdle: () => undefined })
  const s = session()
  collector.handle(s, ev('turn/start', { turn: 1 }, 1, 1_000))
  collector.handle(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000))
  assert.equal(emitted.length, 1)
})

test('every turn-end reason maps to its kind, or stays silent', () => {
  const cases = [
    ['completed', 'completed'],
    ['error', 'error'],
    ['blocked', 'blocked'],
    ['aborted', 'aborted'],
    ['max-tokens', 'max-tokens'],
    ['interrupted', 'interrupted'],
  ]
  for (const [reasonKind, expected] of cases) {
    const { collector, emitted } = collectorFor()
    const s = session(`s-${reasonKind}`)
    collector.handle(s, ev('turn/start', { turn: 1 }, 1, 1_000))
    collector.handle(s, ev('turn/end', { turn: 1, reason: { kind: reasonKind } }, 2, 2_000))
    assert.equal(emitted.length, 1, `${reasonKind} should notify`)
    assert.equal(emitted[0].kind, expected)
  }

  const { collector, emitted } = collectorFor()
  const s = session('s-custom')
  collector.handle(s, ev('turn/end', { turn: 1, reason: { kind: 'plugin-custom' } }, 1, 1_000))
  assert.equal(emitted.length, 0, 'an extended reason kind stays silent')
})

test('error and abort reasons carry their detail', () => {
  const failed = collectorFor()
  failed.collector.handle(session('s1'), ev('turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } },
  }, 1, 1_000))
  assert.equal(failed.emitted[0].reason, 'rate limited')

  const aborted = collectorFor()
  aborted.collector.handle(session('s1'), ev('turn/end', {
    turn: 1,
    reason: { kind: 'aborted', reason: { kind: 'user' } },
  }, 1, 1_000))
  assert.equal(aborted.emitted[0].reason, '用户主动中止')

  const english = collectorFor({ settings: { locale: 'en' } })
  english.collector.handle(session('s1'), ev('turn/end', {
    turn: 1,
    reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } },
  }, 1, 1_000))
  assert.equal(english.emitted[0].reason, 'cancelled by a hook')
})

test('approval, question, and plan events notify immediately', () => {
  const { collector, emitted } = collectorFor()
  const s = session()
  collector.handle(s, ev('approval/asked', { id: 'a1', toolName: 'bash', reason: 'runs a command' }, 1, 1_000))
  assert.equal(emitted[0].kind, 'approval')
  assert.equal(emitted[0].id, 's1:approval:a1')
  assert.ok(emitted[0].summary.includes('bash'))
  assert.equal(emitted[0].reason, 'runs a command')

  collector.handle(s, ev('tool/call', {
    turn: 1,
    name: 'ask_user_question',
    callId: 'c9',
    arguments: JSON.stringify({ questions: [{ question: '用哪个方案？' }] }),
  }, 2, 2_000))
  assert.equal(emitted[1].kind, 'question')
  assert.equal(emitted[1].summary, '用哪个方案？')

  collector.handle(s, ev('tool/call', { turn: 1, name: 'exit_plan_mode', callId: 'c10', arguments: '{}' }, 3, 3_000))
  assert.equal(emitted[2].kind, 'plan-review')
  assert.equal(emitted[2].id, 's1:plan:c10')
})

test('a malformed question argument never throws', () => {
  const { collector, emitted } = collectorFor()
  collector.handle(session(), ev('tool/call', {
    turn: 1,
    name: 'ask_user_question',
    callId: 'c1',
    arguments: 'not json',
  }, 1, 1_000))
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].summary, '')
})

test('subagent sessions stay silent unless the setting opts in', () => {
  const blocked = collectorFor({ isRootSession: () => false })
  blocked.collector.handle(session('sub'), ev('turn/start', { turn: 1 }, 1, 1_000))
  blocked.collector.handle(session('sub'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000))
  blocked.collector.handle(session('sub'), ev('approval/asked', { id: 'a', toolName: 'bash' }, 3, 3_000))
  assert.equal(blocked.emitted.length, 0)

  const allowed = collectorFor({ isRootSession: () => true })
  allowed.collector.handle(session('sub'), ev('turn/start', { turn: 1 }, 1, 1_000))
  allowed.collector.handle(session('sub'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000))
  assert.equal(allowed.emitted.length, 1)
})

test('assistant text is dropped when the setting is off', () => {
  const { collector, emitted } = collectorFor({ settings: { includeAssistantText: false } })
  collector.handle(session(), ev('turn/start', { turn: 1 }, 1, 1_000))
  collector.handle(session(), ev('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'hidden' }] } }, 2, 1_100))
  collector.handle(session(), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3, 1_200))
  assert.equal(emitted[0].summary, '')
})

test('assistant text is bounded by maxBodyChars', () => {
  const { collector, emitted } = collectorFor({ settings: { maxBodyChars: 40 } })
  collector.handle(session(), ev('turn/start', { turn: 1 }, 1, 1_000))
  collector.handle(session(), ev('assistant/message', {
    turn: 1,
    message: { content: [{ type: 'text', text: 'x'.repeat(500) }] },
  }, 2, 1_100))
  collector.handle(session(), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3, 1_200))
  assert.ok(emitted[0].summary.length <= 40)
})

test('the dedupe ledger expires and evicts', () => {
  let now = 1_000
  const ledger = createDedupeLedger({ maxEntries: 2, windowMs: 100, now: () => now })
  assert.equal(ledger.accept('a'), true)
  assert.equal(ledger.accept('a'), false)
  now += 101
  assert.equal(ledger.accept('a'), true, 'expired entries are accepted again')
  ledger.accept('b')
  ledger.accept('c')
  assert.equal(ledger.size() <= 2, true)
})

test('workspaceNameOf falls back to the session id', () => {
  assert.equal(workspaceNameOf(session('s1', '/path/to/proj')), 'proj')
  // A Windows path recorded in the header must resolve on any platform.
  assert.equal(workspaceNameOf(session('s1', 'D:\\path\\to\\proj')), 'proj')
  assert.equal(workspaceNameOf({ id: 's7' }), 's7')
})

test('forget clears both the gate and the session state', () => {
  const { collector, emitted } = collectorFor({ isIdle: () => false })
  collector.handle(session(), ev('turn/start', { turn: 1 }, 1, 1_000))
  collector.handle(session(), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000))
  assert.equal(collector.pendingCount(), 1)
  collector.forget('s1')
  assert.equal(collector.pendingCount(), 0)
  assert.equal(collector.flush('s1').length, 0)
  assert.equal(emitted.length, 0)
})
