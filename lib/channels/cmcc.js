/**
 * dsh-notify-hub「移动新消息」channel (中国移动 5G 消息 / cmcc-newmsg).
 *
 * The one channel neither reference plugin has. It ports the transport contract
 * of the `@openclaw/cmcc-newmsg-channel` reference into the hub:
 *
 *   * WebSocket long connection — `wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg`
 *     with an `{ type: 'auth', apiKey, version }` handshake and `auth_ok` ack;
 *   * a 15s ping / 10s pong heartbeat, exponential reconnect (3s → 60s, jittered);
 *   * text push `{ type: 'send', apiKey, to, content, messageId }`;
 *   * optional rich media — upload the binary to `{uploadUrl}/upload` as
 *     multipart (`file` + `apiKey`, `code === 10200`) and then push the returned
 *     `mediaUrl`.
 *
 * Transport differences from the reference: it prefers the `ws` package (which
 * can carry the `X-API-Key` handshake header) and falls back to Node ≥ 22's
 * built-in WebSocket client, which cannot set headers — the auth *message*
 * carries the key either way, so both paths authenticate.
 *
 * @module dsh-notify-hub/channels/cmcc
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { markdownToPlainText, truncate } from '../render.js'
import { CMCC_DEFAULTS } from '../types.js'
import { ChannelError, ERROR_CODES } from './http.js'

/**
 * Handshake / liveness timings, matching the reference channel. Overridable per
 * instance so tests can drive the heartbeat and the reconnect ladder quickly.
 */
const DEFAULT_TIMINGS = Object.freeze({
  connectTimeoutMs: 10_000,
  authTimeoutMs: 10_000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 10_000,
  baseReconnectDelayMs: 3_000,
  maxReconnectDelayMs: 60_000,
})
/** Server success code for the upload endpoint (`DataResult.code`). */
const UPLOAD_OK_CODE = 10200

/** Mask an API key for logs. */
export function maskApiKey(key) {
  const value = String(key ?? '')
  if (value.length < 8) return '***'
  return `${value.slice(0, 3)}***${value.slice(-3)}`
}

/**
 * Pick a WebSocket implementation: `ws` (header support) when resolvable,
 * otherwise the built-in client.
 * @returns {Promise<{ ctor: Function, supportsHeaders: boolean, callbackSend: boolean, kind: string }>} the implementation.
 * @throws {ChannelError} when neither is available.
 */
export async function resolveWebSocketImpl() {
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const mod = require('ws')
    const ctor = mod?.WebSocket ?? mod?.default?.WebSocket ?? mod?.default
    if (typeof ctor === 'function') {
      return { ctor, supportsHeaders: true, callbackSend: true, kind: 'ws' }
    }
  } catch {
    // `ws` is optional: the built-in client below is enough for Node >= 22.
  }
  if (typeof globalThis.WebSocket === 'function') {
    return { ctor: globalThis.WebSocket, supportsHeaders: false, callbackSend: false, kind: 'node-builtin' }
  }
  throw new ChannelError(
    '没有可用的 WebSocket 实现（需要 Node ≥ 22 内置 WebSocket，或安装 ws 包）',
    ERROR_CODES.NOT_CONFIGURED,
  )
}

/** Random message id in the reference channel's format. */
function newMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

/**
 * The WebSocket transport for one API key.
 *
 * Owns exactly one socket plus its heartbeat and reconnect timer. Every method
 * reads its configuration through the injected thunk, so a settings edit is
 * picked up on the next delivery without re-registering anything.
 */
export class CmccChannel {
  /**
   * @param {object} deps - dependencies.
   * @param {() => object} deps.getConfig - live `settings.cmcc`.
   * @param {{ warn(message: string, ...rest: unknown[]): void, info?(message: string): void }} [deps.logger] - logger.
   * @param {() => Promise<object>} [deps.resolveSocket] - WebSocket implementation resolver (test seam).
   * @param {Function} [deps.fetchImpl] - fetch implementation (test seam).
   */
  constructor(deps) {
    this.getConfig = deps.getConfig
    this.logger = deps.logger ?? console
    this.resolveSocket = deps.resolveSocket ?? resolveWebSocketImpl
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch
    this.timings = { ...DEFAULT_TIMINGS, ...(deps.timings ?? {}) }

    /** @type {object | null} */ this.socket = null
    /** @type {object | null} */ this.impl = null
    this.connected = false
    this.connecting = null
    this.authenticated = false
    this.connectionKey = ''
    this.reconnectAttempts = 0
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.pongTimer = null
    this.disposed = false
    this.lastError = ''
    this.lastConnectedAt = 0
    this.lastSentAt = 0
    this.sentCount = 0
  }

  /** The identity of the connection the current socket was opened for. */
  configKey(config = this.getConfig()) {
    return `${config.apiKey}@${config.serverUrl}#${config.version}`
  }

  /** Whether the channel has everything it needs to push. */
  configured(config = this.getConfig()) {
    return String(config.apiKey ?? '').trim().length > 0 && String(config.to ?? '').trim().length > 0
  }

  /** Live status for the settings section (never carries the key itself). */
  status() {
    const config = this.getConfig()
    return {
      enabled: config.enabled !== false,
      configured: this.configured(config),
      keyConfigured: String(config.apiKey ?? '').trim().length > 0,
      maskedKey: maskApiKey(config.apiKey),
      connected: this.connected && this.authenticated,
      connecting: this.connecting !== null,
      serverUrl: config.serverUrl ?? CMCC_DEFAULTS.serverUrl,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      lastSentAt: this.lastSentAt,
      sentCount: this.sentCount,
      transport: this.impl?.kind ?? null,
    }
  }

  /**
   * Open the connection when needed and wait until the server acknowledged the
   * handshake.
   * @param {number} [timeoutMs] - bounded wait for the handshake.
   * @returns {Promise<void>} resolves once authenticated.
   */
  async ensureConnected(timeoutMs = this.timings.connectTimeoutMs + this.timings.authTimeoutMs) {
    const config = this.getConfig()
    if (String(config.apiKey ?? '').trim().length === 0) {
      throw new ChannelError('移动新消息 API Key 未配置', ERROR_CODES.NOT_CONFIGURED)
    }
    if (this.connected && this.authenticated && this.connectionKey === this.configKey(config)) return
    if (this.connectionKey !== this.configKey(config)) this.#teardown()

    if (this.connecting === null) {
      this.connecting = this.#connect(config).finally(() => {
        this.connecting = null
      })
    }
    await withTimeout(this.connecting, timeoutMs, () => {
      throw new ChannelError(`移动新消息连接超时（${timeoutMs}ms）`, ERROR_CODES.TIMEOUT)
    })
  }

  /**
   * Push one text message.
   * @param {string} text - body; Markdown is flattened because the transport renders it literally.
   * @param {object} [options] - recipient override and cancellation.
   * @returns {Promise<{ messageId: string, to: string, text: string }>} the accepted message.
   * @throws {ChannelError} when unconfigured or the socket is down.
   */
  async sendText(text, options = {}) {
    const config = this.getConfig()
    const to = String(options.to ?? config.to ?? '').trim()
    if (to.length === 0) {
      throw new ChannelError('移动新消息接收号码未配置', ERROR_CODES.NOT_CONFIGURED)
    }
    const content = truncate(markdownToPlainText(String(text ?? '')), options.maxChars ?? 2_000)
    if (content.length === 0) throw new ChannelError('移动新消息内容为空', ERROR_CODES.PROTOCOL_ERROR)
    await this.ensureConnected()
    const messageId = newMessageId()
    await this.#send({
      type: 'send',
      apiKey: config.apiKey,
      to,
      content,
      messageId,
    })
    this.lastSentAt = Date.now()
    this.sentCount += 1
    this.lastError = ''
    return { messageId, to, text: content }
  }

  /**
   * Upload a local file to the 移动新消息 media gateway.
   * @param {string} localPath - absolute path to the file.
   * @param {object} [options] - mime override and cancellation.
   * @returns {Promise<{ mediaUrl: string, fileName: string, size: number }>} the stored media.
   * @throws {ChannelError} when unconfigured, unreadable, or rejected by the gateway.
   */
  async uploadMedia(localPath, options = {}) {
    const config = this.getConfig()
    if (String(config.apiKey ?? '').trim().length === 0) {
      throw new ChannelError('移动新消息 API Key 未配置', ERROR_CODES.NOT_CONFIGURED)
    }
    const path = String(localPath ?? '').trim()
    if (path.length === 0) throw new ChannelError('缺少本地文件路径', ERROR_CODES.NOT_CONFIGURED)
    let buffer
    try {
      buffer = readFileSync(path)
    } catch (error) {
      throw new ChannelError(
        `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
        ERROR_CODES.PROTOCOL_ERROR,
      )
    }
    const fileName = basename(path) || `file_${Date.now()}`
    const uploadBase = String(options.uploadUrl ?? config.uploadUrl ?? CMCC_DEFAULTS.uploadUrl).replace(/\/+$/, '')
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: options.mimeType ?? 'application/octet-stream' }), fileName)
    form.append('apiKey', config.apiKey)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('upload timed out')), options.timeoutMs ?? 60_000)
    let payload
    try {
      const response = await this.fetchImpl(`${uploadBase}/upload`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      })
      const text = await response.text().catch(() => '')
      try {
        payload = JSON.parse(text)
      } catch {
        throw new ChannelError(`上传响应不是 JSON：${text.slice(0, 120)}`, ERROR_CODES.PROTOCOL_ERROR)
      }
      if (!response.ok) {
        throw new ChannelError(`上传失败 HTTP ${response.status}`, ERROR_CODES.HTTP_ERROR)
      }
    } catch (error) {
      if (error instanceof ChannelError) throw error
      throw new ChannelError(
        `上传失败：${error instanceof Error ? error.message : String(error)}`,
        ERROR_CODES.NETWORK_ERROR,
      )
    } finally {
      clearTimeout(timer)
    }
    if (payload?.code !== UPLOAD_OK_CODE || typeof payload?.data !== 'string' || payload.data.length === 0) {
      throw new ChannelError(
        `上传被拒绝：${payload?.message ?? `code=${String(payload?.code)}`}`,
        ERROR_CODES.PROTOCOL_ERROR,
      )
    }
    return { mediaUrl: payload.data, fileName, size: buffer.length }
  }

  /**
   * Push one rich-media message. Text-only transports degrade to
   * {@link CmccChannel.sendText} when no media URL is available.
   * @param {object} message - media descriptor.
   * @returns {Promise<{ messageId: string, mediaUrl?: string }>} the accepted message.
   */
  async sendRichMedia(message) {
    const config = this.getConfig()
    const to = String(message?.to ?? config.to ?? '').trim()
    await this.ensureConnected()
    const messageId = message?.messageId ?? newMessageId()
    const payload = {
      type: 'send',
      apiKey: config.apiKey,
      mediaType: message?.mediaType ?? 'FILE',
      content: truncate(markdownToPlainText(String(message?.content ?? '')), 2_000),
      messageId,
    }
    if (to.length > 0) payload.to = to
    if (message?.mediaUrl) payload.mediaUrl = message.mediaUrl
    if (message?.thumbnailUrl) payload.thumbnailUrl = message.thumbnailUrl
    if (message?.mediaFileName) payload.mediaFileName = message.mediaFileName
    if (message?.mediaSize) payload.mediaSize = message.mediaSize
    if (message?.mediaMimeType) payload.mediaMimeType = message.mediaMimeType
    await this.#send(payload)
    this.lastSentAt = Date.now()
    this.sentCount += 1
    this.lastError = ''
    return { messageId, mediaUrl: message?.mediaUrl }
  }

  /**
   * Upload then push one local image/file — the settings section's rich-media test.
   * @param {string} localPath - file to send.
   * @param {object} [options] - caption, recipient, media type.
   * @returns {Promise<{ messageId: string, mediaUrl: string }>} the accepted message.
   */
  async sendMediaFile(localPath, options = {}) {
    const uploaded = await this.uploadMedia(localPath, options)
    const mediaType = options.mediaType ?? mediaTypeOf(uploaded.fileName)
    const result = await this.sendRichMedia({
      to: options.to,
      mediaType,
      content: options.caption ?? '',
      mediaUrl: uploaded.mediaUrl,
      mediaFileName: uploaded.fileName,
      mediaSize: uploaded.size,
      mediaMimeType: options.mimeType,
    })
    return { messageId: result.messageId, mediaUrl: uploaded.mediaUrl }
  }

  /**
   * Open the connection and report whether the handshake succeeded.
   * @param {number} [timeoutMs] - bounded wait.
   * @returns {Promise<object>} the status after the probe.
   */
  async probe(timeoutMs = this.timings.connectTimeoutMs + this.timings.authTimeoutMs) {
    const config = this.getConfig()
    if (String(config.apiKey ?? '').trim().length === 0) {
      return { ok: false, error: 'API Key 未配置', ...this.status() }
    }
    try {
      await this.ensureConnected(timeoutMs)
      return { ok: true, ...this.status() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      return { ok: false, error: message, ...this.status() }
    }
  }

  /** Close the socket and stop every timer. */
  dispose() {
    this.disposed = true
    this.#teardown()
  }

  /** Drop the current socket, its heartbeat, and any pending reconnect. */
  #teardown() {
    this.#clearTimers()
    this.authenticated = false
    this.connected = false
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.removeAllListeners?.()
        socket.onclose = null
        socket.onerror = null
        socket.onmessage = null
        socket.onopen = null
        socket.close()
      } catch {
        // Closing an already-dead socket is not an error worth reporting.
      }
    }
  }

  #clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  /** Open one socket and resolve after the server acknowledges the handshake. */
  async #connect(config) {
    const impl = this.impl ?? (this.impl = await this.resolveSocket())
    this.connectionKey = this.configKey(config)
    const url = String(config.serverUrl ?? CMCC_DEFAULTS.serverUrl)
    const version = String(config.version ?? CMCC_DEFAULTS.version)

    await new Promise((resolve, reject) => {
      let settled = false
      let socket
      try {
        socket = impl.supportsHeaders
          ? new impl.ctor(url, { rejectUnauthorized: true, headers: { 'X-API-Key': config.apiKey } })
          : new impl.ctor(url)
      } catch (error) {
        reject(new ChannelError(
          `无法创建 WebSocket：${error instanceof Error ? error.message : String(error)}`,
          ERROR_CODES.NETWORK_ERROR,
        ))
        return
      }
      this.socket = socket

      const timer = setTimeout(() => {
        fail(new ChannelError(`移动新消息连接超时（${this.timings.connectTimeoutMs}ms）`, ERROR_CODES.TIMEOUT))
      }, this.timings.connectTimeoutMs)

      let authTimer = setTimeout(() => {
        fail(new ChannelError(`移动新消息鉴权超时（${this.timings.authTimeoutMs}ms）`, ERROR_CODES.TIMEOUT))
      }, this.timings.authTimeoutMs)

      const cleanup = () => {
        clearTimeout(timer)
        clearTimeout(authTimer)
      }

      function fail(error) {
        if (settled) return
        settled = true
        cleanup()
        try {
          socket.close()
        } catch {
          // Ignore: the socket is being abandoned anyway.
        }
        reject(error)
      }

      const onOpen = () => {
        this.connected = true
        try {
          socket.send(JSON.stringify({ type: 'auth', apiKey: config.apiKey, version }))
        } catch (error) {
          fail(new ChannelError(
            `鉴权消息发送失败：${error instanceof Error ? error.message : String(error)}`,
            ERROR_CODES.NETWORK_ERROR,
          ))
        }
      }

      const onMessage = (data) => {
        const text = typeof data === 'string' ? data : String(data?.data ?? data)
        let message
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        if (message?.type === 'auth_ok') {
          if (settled) return
          settled = true
          cleanup()
          this.authenticated = true
          this.reconnectAttempts = 0
          this.lastConnectedAt = Date.now()
          this.lastError = ''
          this.#startHeartbeat()
          resolve()
          return
        }
        if (message?.type === 'auth_failed') {
          this.lastError = message.message ?? '鉴权失败'
          fail(new ChannelError(`移动新消息鉴权失败：${this.lastError}`, ERROR_CODES.HTTP_ERROR))
          return
        }
        if (message?.type === 'pong' && this.pongTimer) {
          clearTimeout(this.pongTimer)
          this.pongTimer = null
          return
        }
        if (message?.type === 'error') {
          this.lastError = message.message ?? '服务端错误'
          this.logger.warn(`[notify-hub] 移动新消息服务端错误：${this.lastError}`)
        }
      }

      const onClose = () => {
        this.connected = false
        this.authenticated = false
        this.#clearTimers()
        if (!settled) {
          fail(new ChannelError('移动新消息连接被关闭', ERROR_CODES.NETWORK_ERROR))
          return
        }
        this.#scheduleReconnect()
      }

      const onError = (error) => {
        const message = error?.message ?? String(error ?? 'unknown error')
        this.lastError = message
        if (!settled) {
          fail(new ChannelError(`移动新消息连接失败：${message}`, ERROR_CODES.NETWORK_ERROR))
        }
      }

      if (impl.kind === 'ws') {
        socket.on('open', onOpen)
        socket.on('message', onMessage)
        socket.on('close', onClose)
        socket.on('error', onError)
      } else {
        socket.onopen = onOpen
        socket.onmessage = (event) => onMessage(event?.data)
        socket.onclose = onClose
        socket.onerror = onError
      }
    })
  }

  /** Send one JSON frame, honoring whichever send() contract the socket has. */
  async #send(payload) {
    const socket = this.socket
    if (!socket || !this.connected) {
      throw new ChannelError('移动新消息 WebSocket 未连接', ERROR_CODES.NETWORK_ERROR)
    }
    const text = JSON.stringify(payload)
    const supportsCallback = this.impl?.callbackSend === true
    await new Promise((resolve, reject) => {
      let settled = false
      const done = (error) => {
        if (settled) return
        settled = true
        if (error) reject(new ChannelError(
          `移动新消息发送失败：${error?.message ?? String(error)}`,
          ERROR_CODES.NETWORK_ERROR,
        ))
        else resolve()
      }
      try {
        if (supportsCallback) socket.send(text, (error) => done(error ?? undefined))
        else {
          socket.send(text)
          done()
        }
      } catch (error) {
        done(error)
      }
    })
  }

  #startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.socket) return
      try {
        this.socket.send(JSON.stringify({ type: 'ping' }))
      } catch {
        return
      }
      if (this.pongTimer) clearTimeout(this.pongTimer)
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null
        this.lastError = '心跳超时'
        try {
          this.socket?.close()
        } catch {
          // The close handler schedules the reconnect.
        }
      }, this.timings.heartbeatTimeoutMs)
      if (typeof this.pongTimer.unref === 'function') this.pongTimer.unref()
    }, this.timings.heartbeatIntervalMs)
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
  }

  /** Exponential backoff with jitter, capped at one minute. */
  #scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return
    this.reconnectAttempts += 1
    const delay = Math.min(
      this.timings.baseReconnectDelayMs * (2 ** (this.reconnectAttempts - 1)),
      this.timings.maxReconnectDelayMs,
    )
    const jittered = Math.max(0, Math.round(delay + delay * 0.2 * (Math.random() - 0.5)))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disposed) return
      this.connecting = this.#connect(this.getConfig())
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error)
          this.#scheduleReconnect()
        })
        .finally(() => {
          this.connecting = null
        })
    }, jittered)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }
}

/** Best-effort media type from a file name (mirrors the reference mapping). */
export function mediaTypeOf(fileName) {
  const lower = String(fileName ?? '').toLowerCase()
  if (/\.(jpe?g|png|gif|webp|bmp)$/.test(lower)) return 'IMAGE'
  if (/\.(mp4|webm|3gp|mov|avi)$/.test(lower)) return 'VIDEO'
  if (/\.(mp3|wav|aac|m4a|ogg)$/.test(lower)) return 'AUDIO'
  if (/\.txt$/.test(lower)) return 'TEXT'
  return 'FILE'
}

/** Await a promise with a deadline. */
function withTimeout(promise, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout()
      } catch (error) {
        reject(error)
      }
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
