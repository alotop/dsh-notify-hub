/**
 * 移动新消息 transport: handshake, framing, heartbeat, markdown flattening,
 * reconnect, and the rich-media upload contract.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CmccChannel, maskApiKey, mediaTypeOf, resolveWebSocketImpl } from '../lib/channels/cmcc.js'
import { ChannelError, ERROR_CODES } from '../lib/channels/http.js'
import { CMCC_DEFAULTS } from '../lib/types.js'

/** Real files for the upload path, in a temp directory the test owns. */
const workDir = mkdtempSync(join(tmpdir(), 'notify-hub-cmcc-'))
const pixelPath = join(workDir, 'pixel.png')
const textPath = join(workDir, 'tiny.txt')
writeFileSync(pixelPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
writeFileSync(textPath, 'hello')
test.after(() => rmSync(workDir, { recursive: true, force: true }))

/** A `ws`-shaped socket the test drives by hand. */
class FakeSocket {
  static instances = []

  constructor(url, options) {
    this.url = url
    this.options = options
    this.sent = []
    this.listeners = new Map()
    this.closed = false
    FakeSocket.instances.push(this)
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event).push(handler)
  }

  removeAllListeners() {
    this.listeners.clear()
  }

  send(data, callback) {
    this.sent.push(data)
    if (typeof callback === 'function') callback()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close', 1000, 'closed')
  }

  emit(event, ...args) {
    for (const handler of this.listeners.get(event) ?? []) handler(...args)
  }

  /** Every frame the channel sent, parsed. */
  frames() {
    return this.sent.map((entry) => JSON.parse(entry))
  }
}

const fakeImpl = async () => ({ ctor: FakeSocket, supportsHeaders: true, callbackSend: true, kind: 'ws' })

function config(overrides = {}) {
  return {
    enabled: true,
    apiKey: 'ak_testkey123456',
    to: '13800138000',
    serverUrl: CMCC_DEFAULTS.serverUrl,
    uploadUrl: CMCC_DEFAULTS.uploadUrl,
    version: '2.0',
    prefix: 'DSH',
    ...overrides,
  }
}

function makeChannel(options = {}) {
  FakeSocket.instances = []
  const channel = new CmccChannel({
    getConfig: () => options.config ?? config(),
    logger: { warn: () => {}, info: () => {} },
    resolveSocket: fakeImpl,
    fetchImpl: options.fetchImpl,
    timings: {
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 5,
      baseReconnectDelayMs: options.baseReconnectDelayMs ?? 60_000,
      ...(options.timings ?? {}),
    },
  })
  return channel
}

/** Drive the channel through open → auth_ok. */
async function authenticated(channel) {
  const pending = channel.ensureConnected(1_000)
  await Promise.resolve()
  const socket = FakeSocket.instances.at(-1)
  assert.ok(socket, 'a socket must be created')
  socket.emit('open')
  assert.deepEqual(socket.frames()[0], { type: 'auth', apiKey: 'ak_testkey123456', version: '2.0' })
  socket.emit('message', JSON.stringify({ type: 'auth_ok' }))
  await pending
  return socket
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('maskApiKey hides the middle of a key', () => {
  assert.equal(maskApiKey(''), '***')
  assert.equal(maskApiKey('short'), '***')
  assert.equal(maskApiKey('ak_testkey123456'), 'ak_***456')
})

test('mediaTypeOf maps extensions the way the gateway expects', () => {
  assert.equal(mediaTypeOf('a.png'), 'IMAGE')
  assert.equal(mediaTypeOf('a.JPEG'), 'IMAGE')
  assert.equal(mediaTypeOf('a.mp4'), 'VIDEO')
  assert.equal(mediaTypeOf('a.mp3'), 'AUDIO')
  assert.equal(mediaTypeOf('a.txt'), 'TEXT')
  assert.equal(mediaTypeOf('a.zip'), 'FILE')
  assert.equal(mediaTypeOf(undefined), 'FILE')
})

test('resolveWebSocketImpl always yields a usable constructor', async () => {
  const impl = await resolveWebSocketImpl()
  assert.equal(typeof impl.ctor, 'function')
  assert.ok(['ws', 'node-builtin'].includes(impl.kind))
})

test('the handshake sends the header and the auth frame', async () => {
  const channel = makeChannel()
  const socket = await authenticated(channel)
  assert.equal(socket.url, CMCC_DEFAULTS.serverUrl)
  assert.equal(socket.options.headers['X-API-Key'], 'ak_testkey123456')
  assert.equal(socket.options.rejectUnauthorized, true)
  const status = channel.status()
  assert.equal(status.connected, true)
  assert.equal(status.configured, true)
  assert.equal(status.transport, 'ws')
  channel.dispose()
})

test('sendText frames the message exactly as the gateway expects', async () => {
  const channel = makeChannel()
  const socket = await authenticated(channel)
  const result = await channel.sendText('**完成**了 `修复`')

  const frame = socket.frames().at(-1)
  assert.equal(frame.type, 'send')
  assert.equal(frame.apiKey, 'ak_testkey123456')
  assert.equal(frame.to, '13800138000')
  assert.equal(frame.content, '完成了 修复', 'markdown is flattened')
  assert.ok(frame.messageId.startsWith('msg_'))
  assert.equal(result.messageId, frame.messageId)
  assert.equal(channel.status().sentCount, 1)
  channel.dispose()
})

test('sendText refuses to run without a recipient or a key', async () => {
  const noRecipient = makeChannel({ config: config({ to: '' }) })
  await assert.rejects(
    () => noRecipient.sendText('hi'),
    (error) => error.code === ERROR_CODES.NOT_CONFIGURED,
  )
  assert.equal(FakeSocket.instances.length, 0, 'no socket is opened without a recipient')
  noRecipient.dispose()

  const noKey = makeChannel({ config: config({ apiKey: '' }) })
  await assert.rejects(
    () => noKey.sendText('hi'),
    (error) => error.code === ERROR_CODES.NOT_CONFIGURED,
  )
  assert.equal(noKey.status().configured, false)
  noKey.dispose()
})

test('an auth failure surfaces as a rejected connection', async () => {
  const channel = makeChannel()
  const pending = channel.ensureConnected(500)
  await Promise.resolve()
  const socket = FakeSocket.instances.at(-1)
  socket.emit('open')
  socket.emit('message', JSON.stringify({ type: 'auth_failed', message: 'bad key' }))
  await assert.rejects(() => pending, /bad key/)
  assert.equal(channel.status().connected, false)
  assert.equal(channel.status().lastError, 'bad key')
  channel.dispose()
})

test('a missing auth ack times out', async () => {
  const channel = makeChannel({ timings: { authTimeoutMs: 20, connectTimeoutMs: 20 } })
  const pending = channel.ensureConnected(200)
  await Promise.resolve()
  const socket = FakeSocket.instances.at(-1)
  socket.emit('open')
  await assert.rejects(() => pending, /鉴权超时|连接被关闭|连接超时/)
  channel.dispose()
})

test('probe reports a connection failure instead of throwing', async () => {
  const channel = makeChannel({ config: config({ apiKey: '' }) })
  const result = await channel.probe()
  assert.equal(result.ok, false)
  assert.match(result.error, /API Key/)

  const good = makeChannel()
  const pending = good.probe(500)
  await Promise.resolve()
  const socket = FakeSocket.instances.at(-1)
  socket.emit('open')
  socket.emit('message', JSON.stringify({ type: 'auth_ok' }))
  const status = await pending
  assert.equal(status.ok, true)
  assert.equal(status.connected, true)
  good.dispose()
})

test('the heartbeat pings and a pong keeps the socket open', async () => {
  // A generous pong window keeps the socket open while the ping is observed.
  const channel = makeChannel({ heartbeatTimeoutMs: 2_000 })
  const socket = await authenticated(channel)
  await wait(35)
  const pings = socket.frames().filter((frame) => frame.type === 'ping')
  assert.ok(pings.length >= 1, 'the heartbeat must ping')
  socket.emit('message', JSON.stringify({ type: 'pong' }))
  assert.equal(channel.reconnectTimer, null)
  assert.equal(socket.closed, false)
  assert.equal(channel.status().connected, true)
  channel.dispose()
})

test('a missed pong closes the socket and schedules a reconnect', async () => {
  const channel = makeChannel()
  const socket = await authenticated(channel)
  await wait(45)
  assert.equal(socket.closed, true, 'the heartbeat timeout closes the socket')
  assert.equal(channel.reconnectAttempts, 1)
  assert.notEqual(channel.reconnectTimer, null, 'a reconnect is scheduled')
  channel.dispose()
  assert.equal(channel.reconnectTimer, null, 'dispose clears the reconnect timer')
})

test('uploadMedia follows the DataResult contract', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 10200, message: '成功', data: 'http://cdn.example/file.png' }),
    }
  }
  const channel = makeChannel({ fetchImpl })
  const uploaded = await channel.uploadMedia(pixelPath)
  assert.equal(uploaded.mediaUrl, 'http://cdn.example/file.png')
  assert.equal(uploaded.fileName, 'pixel.png')
  assert.equal(calls[0].url, `${CMCC_DEFAULTS.uploadUrl}/upload`)
  assert.ok(calls[0].init.body instanceof FormData)
  assert.equal(calls[0].init.body.get('apiKey'), 'ak_testkey123456')
  assert.ok(calls[0].init.body.get('file') instanceof Blob)
  channel.dispose()
})

test('uploadMedia rejects an unreadable file and a refused upload', async () => {
  const channel = makeChannel({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) })
  await assert.rejects(
    () => channel.uploadMedia(join(workDir, 'definitely-missing.png')),
    (error) => error.code === ERROR_CODES.PROTOCOL_ERROR,
  )

  const refusing = makeChannel({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 10500, message: '文件过大' }),
    }),
  })
  await assert.rejects(
    () => refusing.uploadMedia(textPath),
    /文件过大/,
  )
  channel.dispose()
  refusing.dispose()
})

test('sendMediaFile uploads then frames the rich-media message', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 10200, data: 'http://cdn.example/pixel.png' }),
  })
  const channel = makeChannel({ fetchImpl })
  const socket = await authenticated(channel)
  const result = await channel.sendMediaFile(pixelPath, { caption: '**截图**' })

  const frame = socket.frames().at(-1)
  assert.equal(frame.type, 'send')
  assert.equal(frame.mediaType, 'IMAGE')
  assert.equal(frame.mediaUrl, 'http://cdn.example/pixel.png')
  assert.equal(frame.content, '截图')
  assert.equal(frame.to, '13800138000')
  assert.equal(result.mediaUrl, 'http://cdn.example/pixel.png')
  channel.dispose()
})

test('sending without a live socket fails instead of silently dropping', async () => {
  const channel = makeChannel()
  await assert.rejects(
    () => channel.sendRichMedia({ mediaType: 'IMAGE', mediaUrl: 'http://x/y.png' }),
    (error) => error instanceof ChannelError,
  )
  channel.dispose()
})

test('a config change reconnects instead of reusing the old socket', async () => {
  let current = config()
  FakeSocket.instances = []
  const channel = new CmccChannel({
    getConfig: () => current,
    logger: { warn: () => {} },
    resolveSocket: fakeImpl,
    timings: { heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 10_000 },
  })
  const first = await authenticated(channel)
  current = config({ apiKey: 'ak_rotated99999999' })
  const pending = channel.ensureConnected(500)
  await Promise.resolve()
  const second = FakeSocket.instances.at(-1)
  assert.notEqual(second, first, 'a new socket is opened')
  assert.equal(first.closed, true, 'the old socket is closed')
  second.emit('open')
  second.emit('message', JSON.stringify({ type: 'auth_ok' }))
  await pending
  assert.equal(second.frames()[0].apiKey, 'ak_rotated99999999')
  channel.dispose()
})
