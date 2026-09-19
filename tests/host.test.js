/**
 * Host integration: `apply()` wired against a fake cordis context, driven
 * end-to-end through the real session listener, the real hub, and the real RPC
 * route handler. This is the closest thing to "a turn ended and my phone buzzed"
 * that runs without a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { DEFAULT_SETTINGS, deepMerge, hubSettingsSchema } from '../lib/settings.js'


/**
 * A fake agent registry: one root agent whose status the test can flip.
 * `roots()` must contain the *same object* `get()` returns — the plugin uses
 * identity to tell a root session from a subagent one.
 */
function createAgents(sessionId = 's1', status = 'idle') {
  const agent = { id: sessionId, status }
  return {
    agent,
    service: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => [agent],
    },
  }
}

/** A fake cordis context exposing exactly the seams the plugin uses. */
function fakeCtx(options = {}) {
  const handlers = new Map()
  const routes = []
  const effects = []
  const logs = []
  let userPatch = {}

  const settingsService = {
    register(namespace, schema, registerOptions) {
      const base = registerOptions?.base ?? {}
      return {
        get: () => schema(deepMerge(base, userPatch)),
        update: async (patch) => {
          userPatch = deepMerge(userPatch, patch)
        },
        watch: () => () => {},
      }
    },
  }

  const agents = options.agents ?? createAgents().service

  const connection = { requestRejection: () => undefined }
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }

  const services = { settings: settingsService, agents, connection, webServer }

  const ctx = {
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    effect(factory, label) {
      const dispose = factory()
      effects.push(label)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(required, callback) {
      const scope = { ...ctx }
      for (const name of required) scope[name] = services[name]
      scope.get = (name) => services[name]
      callback(scope)
    },
  }
  return { ctx, handlers, routes, effects, logs, writeUserSection: (patch) => { userPatch = deepMerge(userPatch, patch) } }
}

/** A fake IncomingMessage carrying one JSON body. */
function fakeReq(url, body, method = 'POST') {
  const chunks = [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A fake ServerResponse capturing the written payload. */
function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
    },
    end(payload) {
      this.body = payload ?? ''
    },
  }
}

/** Call one RPC endpoint through the registered route handler. */
async function rpc(routes, endpoint, payload) {
  const route = routes.find((entry) => entry.kind === 'prefix')
  assert.ok(route, 'the RPC route must be registered')
  const res = fakeRes()
  await route.handler(fakeReq(`${route.path}/${endpoint}`, {
    type: 'client-request',
    rpcId: 'r1',
    method: endpoint,
    payload: payload ?? {},
  }), res)
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.type, 'server-response')
  return parsed.result
}

/** Install a fake global fetch for one test, restoring the real one afterwards. */
function withFetch(implementation, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return implementation(url, init)
  }
  const restore = () => {
    globalThis.fetch = original
  }
  return Promise.resolve()
    .then(() => run(calls))
    .finally(restore)
}

const okResponse = { ok: true, status: 200, text: async () => '' }

test('apply() wires the listener, the hub, and the RPC route', async () => {
  const { ctx, handlers, routes, logs } = fakeCtx()
  apply(ctx, { bark: { url: 'https://api.day.app/TESTKEY123' }, local: { enabled: false } })

  assert.ok(handlers.has('session/event'), 'the listener subscribes to session/event')
  assert.ok(handlers.has('agent/status'))
  assert.ok(handlers.has('agent/disposed'))
  assert.ok(handlers.has('session/disposed'))
  assert.equal(routes.length, 1, 'the RPC route is registered once')
  assert.equal(routes[0].path, '/dsh-notify-hub')
  assert.equal(routes[0].kind, 'prefix')
  assert.ok(logs.some((line) => line.includes('[notify-hub] ready')))

  await withFetch(async () => okResponse, async (calls) => {
    const session = { id: 's1', header: { cwd: '/path/to/proj' } }
    const emit = (type, data, seq, time) => {
      for (const handler of handlers.get('session/event')) handler(session, { type, data, seq, time })
    }
    emit('session/title', { title: '修复登录' }, 1, 1_000)
    emit('turn/start', { turn: 1 }, 2, 2_000)
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '已完成' }] } }, 3, 2_500)
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4, 5_000)

    // The agent is idle, so the envelope goes out immediately.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 1, 'exactly one Bark POST')
    assert.equal(calls[0].url, 'https://api.day.app/TESTKEY123')
    const payload = JSON.parse(calls[0].init.body)
    assert.equal(payload.title, '✅ 任务完成')
    assert.ok(payload.body.includes('修复登录'))
    assert.ok(payload.body.includes('已完成'))

    const status = await rpc(routes, 'get')
    assert.equal(status.ok, true)
    assert.equal(status.value.settings.bark.configured, true)
    assert.equal(status.value.settings.bark.masked, '••••••••Y123')
    assert.equal(JSON.stringify(status.value).includes('TESTKEY123'), false, 'the secret never rides the wire')
    assert.equal(status.value.history.length, 1)
    assert.equal(status.value.history[0].ok, true)
    assert.equal(status.value.history[0].channel, 'bark')
    assert.ok(status.value.status.channels.some((entry) => entry.id === 'cmcc'))
  })
})

test('a settings patch round-trips through the RPC and applies live', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { bark: { url: 'https://api.day.app/KEY' }, local: { enabled: false } })

  const rejected = await rpc(routes, 'set', { patch: { nope: 1 } })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error.message, /not a recognized field/)

  const saved = await rpc(routes, 'set', {
    patch: {
      locale: 'en',
      events: { completed: false, planReview: true },
      cmcc: { apiKey: 'ak_livekey12345', to: '13800138000', prefix: '  DSH  ' },
      rules: [{ mode: 'exclude', pattern: '  noisy  ' }],
      webhooks: { slack: { enabled: true, url: '  https://hooks.slack.com/services/XXX  ' } },
    },
  })
  assert.equal(saved.ok, true)

  const status = await rpc(routes, 'get')
  const settings = status.value.settings
  assert.equal(settings.locale, 'en')
  assert.equal(settings.events.completed, false)
  assert.equal(settings.events.planReview, true)
  assert.equal(settings.cmcc.prefix, 'DSH', 'the patch is trimmed')
  assert.equal(settings.cmcc.configured, true)
  assert.equal(settings.cmcc.to, '138••••00', 'the recipient is masked')
  assert.equal(settings.rules[0].pattern, 'noisy')
  assert.equal(settings.webhooks.slack.enabled, true)
  assert.equal(settings.webhooks.slack.masked.includes('XXX'), true)
  assert.equal(JSON.stringify(settings).includes('ak_livekey12345'), false)
})

test('the completion gate holds a turn-end envelope until the agent is idle', async () => {
  const { agent, service: agents } = createAgents('s1', 'running')
  const { ctx, handlers, routes } = fakeCtx({ agents })
  apply(ctx, { bark: { url: 'https://api.day.app/KEY' }, local: { enabled: false } })

  await withFetch(async () => okResponse, async (calls) => {
    const session = { id: 's1', header: { cwd: '/path/to' } }
    const emit = (type, data, seq, time) => {
      for (const handler of handlers.get('session/event')) handler(session, { type, data, seq, time })
    }
    emit('turn/start', { turn: 1 }, 1, 1_000)
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 0, 'nothing is delivered while the agent is running')

    agent.status = 'idle'
    for (const handler of handlers.get('agent/status')) handler({ agent, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 1, 'the parked envelope goes out once the agent is idle')

    const statusView = await rpc(routes, 'get')
    assert.equal(statusView.value.status.inFlight, 0)
  })
})

test('a subagent session is silent unless the setting opts in', async () => {
  const subagent = { id: 'sub', status: 'idle' }
  const agents = {
    get: (id) => (id === 'sub' ? subagent : undefined),
    roots: () => [{ id: 'root-session', status: 'idle' }],
  }
  const { ctx, handlers } = fakeCtx({ agents })
  apply(ctx, { bark: { url: 'https://api.day.app/KEY' }, local: { enabled: false } })

  await withFetch(async () => okResponse, async (calls) => {
    const session = { id: 'sub', header: { cwd: '/path/to' } }
    const emit = (type, data, seq, time) => {
      for (const handler of handlers.get('session/event')) handler(session, { type, data, seq, time })
    }
    emit('turn/start', { turn: 1 }, 1, 1_000)
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 0, 'a subagent turn does not notify by default')
  })
})

test('notifySubagents switches a subagent session back on', async () => {
  const subagent = { id: 'sub', status: 'idle' }
  const agents = {
    get: (id) => (id === 'sub' ? subagent : undefined),
    roots: () => [{ id: 'root-session', status: 'idle' }],
  }
  const { ctx, handlers } = fakeCtx({ agents })
  apply(ctx, {
    bark: { url: 'https://api.day.app/KEY' },
    local: { enabled: false },
    notifySubagents: true,
  })

  await withFetch(async () => okResponse, async (calls) => {
    const session = { id: 'sub', header: { cwd: '/path/to' } }
    const emit = (type, data, seq, time) => {
      for (const handler of handlers.get('session/event')) handler(session, { type, data, seq, time })
    }
    emit('turn/start', { turn: 1 }, 1, 1_000)
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 1)
  })
})

test('an explicit test push reaches the channel and lands in the history', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { bark: { url: 'https://api.day.app/KEY' }, local: { enabled: false } })

  await withFetch(async () => okResponse, async (calls) => {
    const result = await rpc(routes, 'test', { channel: 'bark' })
    assert.equal(result.ok, true)
    assert.equal(result.value.results[0].ok, true)
    assert.equal(calls.length, 1)
    const body = JSON.parse(calls[0].init.body)
    assert.ok(body.body.includes('测试'))
    assert.equal(body.group, 'DeepSeek Harness')

    const status = await rpc(routes, 'get')
    assert.equal(status.value.history[0].source, 'test')

    const cleared = await rpc(routes, 'clearHistory')
    assert.equal(cleared.value.cleared, true)
    const after = await rpc(routes, 'get')
    assert.equal(after.value.history.length, 0)
  })
})

test('a delivery failure is recorded and reported without leaking the endpoint', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, {
    bark: { url: 'https://api.day.app/SUPERSECRETKEY' },
    local: { enabled: false },
    delivery: { retries: 0 },
  })

  await withFetch(async () => ({ ok: false, status: 401, text: async () => 'bad key' }), async () => {
    const result = await rpc(routes, 'test', { channel: 'bark' })
    assert.equal(result.value.results[0].ok, false)
    assert.equal(result.value.results[0].error.includes('SUPERSECRETKEY'), false)

    const status = await rpc(routes, 'get')
    const entry = status.value.history[0]
    assert.equal(entry.ok, false)
    assert.equal(JSON.stringify(status.value).includes('SUPERSECRETKEY'), false)
  })
})

test('the cmcc probe reports its state through the RPC', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { local: { enabled: false }, cmcc: { apiKey: '', to: '' } })
  const result = await rpc(routes, 'probe')
  assert.equal(result.ok, true)
  assert.equal(result.value.ok, false)
  assert.match(result.value.error, /API Key/)
})

test('the legacy Bark endpoint is adopted once from the settings document', async () => {
  const home = mkdtempSync(join(tmpdir(), 'notify-hub-home-'))
  const previousHome = process.env.DSH_HOME
  writeFileSync(join(home, 'settings.yaml'), [
    'bark:',
    '  barkUrl: https://api.day.app/LEGACYKEY9999',
    '  group: Example Group',
    '',
  ].join('\n'))
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = fakeCtx()
    apply(ctx, { local: { enabled: false } })
    // The migration is an async write; give it a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const status = await rpc(routes, 'get')
    assert.equal(status.value.settings.bark.configured, true)
    assert.equal(status.value.settings.bark.masked.endsWith('9999'), true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('an unusable stored rule never silences delivery', async () => {
  const { ctx, handlers, logs, writeUserSection } = fakeCtx()
  apply(ctx, { bark: { url: 'https://api.day.app/KEY' }, local: { enabled: false } })

  await withFetch(async () => okResponse, async (calls) => {
    const session = { id: 's1', header: { cwd: '/path/to' } }
    const emit = (type, data, seq, time) => {
      for (const handler of handlers.get('session/event')) handler(session, { type, data, seq, time })
    }
    emit('turn/start', { turn: 1 }, 1, 1_000)
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 1)

    // A hand-edited settings.yaml can store a pattern the schema accepts but the
    // matcher cannot compile; the last good configuration must stay in force.
    writeUserSection({ rules: [{ mode: 'include', pattern: '(unclosed', regex: true }] })
    emit('turn/start', { turn: 2 }, 3, 3_000)
    emit('turn/end', { turn: 2, reason: { kind: 'completed' } }, 4, 4_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 2, 'delivery continues on the last good configuration')
    assert.ok(logs.some((line) => line.includes('配置无效')))
    assert.equal(logs.filter((line) => line.includes('配置无效')).length, 1, 'the problem is reported once')
  })
})

test('an unusable settings service leaves the listener running on defaults', () => {
  const { ctx, handlers } = fakeCtx()
  // No settings seam at all: `ctx.inject(['settings'], …)` never calls back.
  const bare = {
    logger: { info: () => {}, warn: () => {} },
    on: ctx.on,
    effect: ctx.effect,
    inject: (required, callback) => {
      // Neither the settings seam nor the web server exists in this profile.
      if (required.includes('settings') || required.includes('webServer')) return
      callback({ ...bare, agents: undefined, get: () => undefined })
    },
  }
  apply(bare, {})
  assert.ok(handlers.has('session/event'))
})
