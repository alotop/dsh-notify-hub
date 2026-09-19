/**
 * Client bundle: load lib/client.js the way the browser shell does, then drive
 * the registered section with a fake Host transport. This catches bundle-shape
 * and render errors without a browser: a broken settings section is the one
 * failure mode that only shows up in the GUI.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** The package manifest — the single source of truth for the registration id. */
function packageJson() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
}

/** Minimal React stand-in: element records plus inert hooks. */
const react = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }
  },
  useState(initial) {
    return [initial, () => {}]
  },
  useEffect() {},
}

const store = { createSnapshotStore }

/** An immer-style snapshot store good enough for the section's draft mutations. */
function createSnapshotStore(initial) {
  let state = clone(initial)
  return {
    update(mutate) {
      const draft = clone(state)
      mutate(draft)
      state = draft
    },
    get: () => state,
    subscribe: () => () => {},
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Load the bundle through a fake module-loader, exactly once per call. */
function loadBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'the client half must be a module-loader bundle')
  let registration = null
  const window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }
  const document = {
    head: { appendChild: () => {} },
    querySelector: () => ({}),
    createElement: () => ({ dataset: {}, style: {} }),
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(window, document)
  assert.ok(registration, 'the bundle must register a factory')
  assert.equal(registration.id, packageJson().name, 'the registration id must be the package name (the package row key)')
  return registration.factory((specifier) => {
    if (specifier === 'react') return react
    if (specifier === '@deepseek-ai/dsh-client-store') return store
    throw new Error(`unexpected require(${specifier})`)
  })
}

/** A Host `get` payload shaped exactly like rpc.js returns it. */
function hostPayload() {
  return {
    settings: {
      enabled: true,
      locale: 'zh',
      notifySubagents: false,
      includeAssistantText: true,
      maxBodyChars: 600,
      historyLimit: 50,
      events: {
        completed: true, error: true, blocked: true, aborted: false,
        maxTokens: true, interrupted: true, question: true, approval: true, planReview: false,
      },
      delivery: { timeoutMs: 5_000, retries: 2, retryBaseMs: 500 },
      rules: [{ mode: 'include', pattern: 'deploy', regex: false, caseSensitive: false }],
      routes: [{ pattern: 'mobile', regex: false, caseSensitive: false, channels: ['cmcc'] }],
      bark: { enabled: true, group: 'DSH', level: 'active', sound: '', configured: true, masked: '••••••••TKEY' },
      cmcc: {
        enabled: true,
        to: '138••••00',
        serverUrl: 'wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg',
        uploadUrl: 'https://5gvas01.cmicmaap.com/gtw-ai/openclaw/api',
        version: '2.0',
        prefix: 'DSH',
        includeSummary: true,
        configured: true,
        keyConfigured: true,
        masked: '••••••••3456',
      },
      local: { enabled: true, sound: true },
      webhooks: {
        feishu: {
          enabled: true,
          includeSummary: true,
          configured: true,
          masked: '••••••••HOOK',
          keyword: 'dsh-notify-hub',
          secretConfigured: true,
          secretMasked: '••••••••T123',
        },
        wecom: { enabled: false, includeSummary: false, configured: false, masked: '' },
        dingtalk: { enabled: false, includeSummary: false, configured: false, masked: '' },
        slack: { enabled: false, includeSummary: false, configured: false, masked: '' },
        discord: { enabled: false, includeSummary: false, configured: false, masked: '' },
        custom: { enabled: false, includeSummary: false, configured: false, masked: '' },
      },
    },
    status: {
      platform: 'win32',
      localBackend: 'windows-toast',
      localSupported: true,
      inFlight: 0,
      channels: [
        { id: 'bark', label: 'Bark 推送', enabled: true, configured: true, masked: '••••••••TKEY' },
        { id: 'cmcc', label: '移动新消息', enabled: true, configured: true, connected: true, masked: '••••••••3456' },
        { id: 'local', label: '桌面通知', enabled: true, configured: true, detail: 'windows-toast' },
      ],
      cmcc: { configured: true, connected: true, maskedKey: '••••••••3456' },
    },
    history: [
      { time: 1_700_000_000_000, id: 'e1', kind: 'completed', channel: 'bark', title: 'proj', ok: true, durationMs: 120, source: 'event' },
      { time: 1_700_000_001_000, id: 'e2', kind: 'error', channel: 'cmcc', title: 'proj', ok: false, error: 'WebSocket 未连接', source: 'event' },
    ],
  }
}

/** A connection stub that answers every endpoint from a payload. */
function fakeConnection(payload = hostPayload()) {
  const calls = []
  return {
    calls,
    rpc: {
      async call(channel, endpoint, request) {
        calls.push({ channel, endpoint, request })
        if (endpoint === 'get') return { ok: true, value: payload }
        if (endpoint === 'set') return { ok: true, value: { saved: true } }
        if (endpoint === 'test') return { ok: true, value: { results: [{ channel: request.channel, ok: true, detail: 'sent' }] } }
        if (endpoint === 'probe') return { ok: true, value: { ok: true, connected: true } }
        if (endpoint === 'clearHistory') return { ok: true, value: { cleared: true } }
        return { ok: false, error: { message: `unknown endpoint ${endpoint}` } }
      },
    },
  }
}

/** Walk an element tree and collect every string node (and string prop). */
function textOf(node, output = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    output.push(String(node))
    return output
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, output)
    return output
  }
  if (node && typeof node === 'object') {
    if (node.props) {
      for (const value of Object.values(node.props)) {
        if (typeof value === 'string' || typeof value === 'number') output.push(String(value))
      }
    }
    if (node.children) textOf(node.children, output)
  }
  return output
}

/** Count the elements of one type in a tree. */
function countType(node, type, total = 0) {
  if (Array.isArray(node)) {
    for (const child of node) total = countType(child, type, total)
    return total
  }
  if (node && typeof node === 'object') {
    let next = node.type === type ? total + 1 : total
    if (node.children) next = countType(node.children, type, next)
    return next
  }
  return total
}

/** Interpolating `t` over the bundle's own zh dictionary. */
function makeT(dictionaries) {
  return (key, params) => {
    let text = dictionaries[0]?.dicts?.zh?.[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.split(`{${name}}`).join(String(value))
    }
    return text
  }
}

/**
 * Load the bundle and register it against a fake client context, returning the
 * registered section exactly as the settings shell would hold it.
 */
function setup(options = {}) {
  const bundle = loadBundle()
  const registered = []
  const dictionaries = []
  const connection = options.connection ?? fakeConnection(options.payload ?? hostPayload())
  const ctx = {
    effect(factory) {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
      bind() {
        return makeT(dictionaries)
      },
    },
    inject(services, callback) {
      callback({
        get: (name) => (name === 'connection' ? connection : undefined),
        locale: ctx.locale,
        effect: ctx.effect,
        slots: {
          inject(slot, factory) { factory() },
          register(definition, component) {
            registered.push({ definition, component })
            return () => {}
          },
        },
      })
    },
  }
  bundle.apply(ctx)
  assert.equal(registered.length, 1, 'the section must register exactly once')
  return {
    bundle,
    connection,
    dictionaries,
    t: makeT(dictionaries),
    definition: registered[0].definition,
    component: registered[0].component,
  }
}

test('the bundle registers a settings section for the notify-hub id', () => {
  const { bundle, dictionaries, definition } = setup()
  assert.equal(typeof bundle.apply, 'function')
  assert.deepEqual(bundle.inject, ['slots', 'locale', 'connection'])
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'notify-hub')
  assert.ok(dictionaries[0].dicts.zh.title.length > 0)
  assert.ok(dictionaries[0].dicts.en.title.length > 0)
  assert.equal(
    Object.keys(dictionaries[0].dicts.zh).length,
    Object.keys(dictionaries[0].dicts.en).length,
    'both locales stay in step',
  )
  assert.equal(definition.name, 'settings.section')
  assert.equal(definition.id, 'notify-hub')
  assert.equal(definition.order, 45)
  assert.equal(typeof definition.label, 'function')
  assert.equal(definition.label(), '通知集合')
})

test('the section renders every channel, event, and the delivery log', async () => {
  const { bundle, connection, t, component } = setup()
  const controller = new bundle.HubSectionController(connection)
  await controller.load()
  assert.equal(controller.store.get().phase, 'ready')

  const tree = component({
    t,
    controller,
    useSnapshot: (selector) => selector(controller.store.get()),
  })
  const text = textOf(tree).join('\u0000')

  for (const id of ['bark', 'cmcc', 'local', 'feishu', 'wecom', 'dingtalk', 'slack', 'discord', 'custom']) {
    assert.ok(text.includes(id), `the ${id} card must render`)
  }
  for (const label of ['任务完成', '执行错误', '执行被阻塞', '手动中止', 'Token 达到上限', '异常中断', '等待我回答', '等待授权', '等待计划确认']) {
    assert.ok(text.includes(label), `the ${label} event row must render`)
  }
  assert.ok(text.includes('••••••••TKEY'), 'the masked Bark endpoint renders')
  assert.ok(text.includes('138••••00'), 'the masked 移动新消息 recipient renders')
  // 飞书 bot security (自定义关键词 / 签名校验): the keyword is echoed, the secret is masked only.
  assert.ok(text.includes('机器人安全设置'), 'the 飞书 security block renders')
  assert.ok(text.includes('dsh-notify-hub'), 'the configured keyword is echoed back')
  assert.ok(text.includes('••••••••T123'), 'the signing secret renders as a mask only')
  assert.ok(text.includes('deploy'), 'the configured rule renders')
  assert.ok(text.includes('mobile'), 'the configured route renders')
  assert.ok(text.includes('proj'), 'history rows render')
  assert.ok(text.includes('WebSocket 未连接'), 'a failed delivery shows its error')
  assert.ok(text.includes('windows-toast'))
  assert.ok(countType(tree, 'input') > 10, 'the section is editable')
  assert.ok(countType(tree, 'button') > 5, 'the section has its action buttons')

  const serialized = JSON.stringify(text)
  for (const secret of ['ak_abcdefghijkl', 'SECRETKEY', 'EXAMPLEKEY1234']) {
    assert.equal(serialized.includes(secret), false, `${secret} must never be rendered`)
  }
})

test('the section survives an unconfigured, empty host payload', async () => {
  const bundle = loadBundle()
  const payload = hostPayload()
  payload.settings.bark = { enabled: false, group: '', level: 'active', sound: '', configured: false, masked: '' }
  payload.settings.webhooks = Object.fromEntries(
    Object.keys(payload.settings.webhooks).map((name) => [name, { enabled: false, includeSummary: false, configured: false, masked: '' }]),
  )
  payload.settings.rules = []
  payload.settings.routes = []
  payload.settings.cmcc = {
    enabled: false, to: '', serverUrl: 'wss://x', uploadUrl: 'https://y', version: '2.0',
    prefix: 'DSH', includeSummary: true, configured: false, keyConfigured: false, masked: '',
  }
  payload.history = []
  payload.status.channels = []
  const { connection, t, component } = setup({ payload })
  const controller = new bundle.HubSectionController(connection)
  await controller.load()
  const tree = component({
    t,
    controller,
    useSnapshot: (selector) => selector(controller.store.get()),
  })
  const text = textOf(tree).join('\u0000')
  assert.ok(text.length > 0)
  assert.ok(text.includes('暂无投递记录。'), 'an empty log renders its placeholder')
  assert.ok(text.includes('未配置'), 'an unconfigured channel says so')
})

test('the controller reports a load failure and round-trips every endpoint', async () => {
  const { bundle, connection } = setup()
  const failing = {
    rpc: { async call() { return { ok: false, error: { message: 'boom' } } } },
  }
  const broken = new bundle.HubSectionController(failing)
  await broken.load()
  assert.equal(broken.store.get().phase, 'error')
  assert.match(broken.store.get().saveError, /boom/)

  const controller = new bundle.HubSectionController(connection)
  await controller.load()
  assert.equal(connection.calls[0].channel, '/dsh-notify-hub')
  assert.equal(connection.calls[0].endpoint, 'get')

  await controller.save({ enabled: false }, true)
  const setCall = connection.calls.find((entry) => entry.endpoint === 'set')
  assert.deepEqual(setCall.request, { patch: { enabled: false } })

  await controller.test('bark')
  const testCall = connection.calls.find((entry) => entry.endpoint === 'test')
  assert.equal(testCall.request.channel, 'bark')
  assert.equal(controller.store.get().testResult.ok, true)

  await controller.test('cmcc-media', { mediaPath: '/path/to/shot.png', caption: 'hi' })
  const mediaCall = connection.calls.filter((entry) => entry.endpoint === 'test').at(-1)
  assert.equal(mediaCall.request.channel, 'cmcc-media')
  assert.equal(mediaCall.request.mediaPath, '/path/to/shot.png')

  await controller.probe()
  assert.ok(connection.calls.some((entry) => entry.endpoint === 'probe'))

  await controller.clearHistory()
  assert.ok(connection.calls.some((entry) => entry.endpoint === 'clearHistory'))
})
