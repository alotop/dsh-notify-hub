/**
 * dsh-notify-hub shared HTTP delivery.
 *
 * Every network channel (Bark, webhooks, 移动新消息 upload) posts JSON through
 * this helper so timeout handling, the retry ladder, and secret redaction are
 * identical everywhere. A credential is never printed: the error path scrubs
 * every configured secret out of the message before it is logged or sent to
 * the browser.
 *
 * @module dsh-notify-hub/channels/http
 */

/** Stable failure codes surfaced to the settings section. */
export const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  HTTP_ERROR: 'HTTP_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
})

/** A channel delivery failure with a stable machine code. */
export class ChannelError extends Error {
  /**
   * @param {string} message - human-readable, secret-free message.
   * @param {string} code - one of {@link ERROR_CODES}.
   * @param {object} [details] - optional structured detail.
   */
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'ChannelError'
    this.code = code
    Object.assign(this, details)
  }
}

/**
 * Replace every occurrence of each secret with a placeholder.
 * @param {string} text - candidate message.
 * @param {readonly string[]} secrets - configured secret values.
 * @returns {string} the scrubbed message.
 */
export function redact(text, secrets = []) {
  let output = String(text ?? '')
  for (const secret of secrets) {
    const value = String(secret ?? '').trim()
    if (value.length < 8) continue
    output = output.split(value).join('[redacted]')
  }
  return output
}

/** A retryable HTTP status: throttling or a transient server failure. */
export function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * Sleep that aborts with its signal.
 *
 * The timer is deliberately not unref'd: it is always awaited by an in-flight
 * delivery, and a delivery the caller is waiting on must keep the process alive
 * until it settles.
 * @param {number} ms - delay.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<void>} resolves after the delay.
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ChannelError('delivery cancelled', ERROR_CODES.CANCELLED))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new ChannelError('delivery cancelled', ERROR_CODES.CANCELLED))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Build a request signal that aborts on timeout or on parent cancellation. */
function requestSignal(parent, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)
  if (parent) parent.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs)
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * POST a JSON body with a bounded timeout and an exponential retry ladder.
 *
 * Retries only what is safe to retry (throttling, 5xx, network errors); a
 * 4xx other than 408/425/429 fails immediately so a misconfigured credential
 * reports itself instead of being hammered.
 *
 * @param {string} url - absolute endpoint.
 * @param {unknown} body - JSON-serializable payload.
 * @param {object} [options] - timeout, retries, signal, secrets, fetch impl.
 * @returns {Promise<{ attempts: number, status?: number, text?: string }>} delivery result.
 * @throws {ChannelError} on a non-retryable failure or an exhausted ladder.
 */
export async function postJson(url, body, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000
  const retries = options.retries ?? 2
  const retryBaseMs = options.retryBaseMs ?? 500
  const secrets = options.secrets ?? []
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const signal = options.signal
  const payload = JSON.stringify(body)
  let lastError = 'unknown error'

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new ChannelError('delivery cancelled', ERROR_CODES.CANCELLED)
    const request = requestSignal(signal, timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', ...(options.headers ?? {}) },
        body: payload,
        signal: request.signal,
      })
      if (response.ok) return { attempts: attempt + 1, status: response.status }
      const text = typeof response.text === 'function'
        ? (await response.text().catch(() => '')).slice(0, 200)
        : ''
      lastError = `HTTP ${response.status}${text.length > 0 ? `: ${text}` : ''}`
      if (!retryableStatus(response.status)) {
        throw new ChannelError(redact(lastError, secrets), ERROR_CODES.HTTP_ERROR, { status: response.status })
      }
    } catch (error) {
      if (error instanceof ChannelError) throw error
      const aborted = error instanceof Error && error.name === 'AbortError'
      lastError = aborted
        ? `request timed out after ${timeoutMs}ms`
        : (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      if (signal?.aborted) throw new ChannelError('delivery cancelled', ERROR_CODES.CANCELLED)
    } finally {
      request.cleanup()
    }
    if (attempt < retries) await sleep(retryBaseMs * (2 ** attempt), signal)
  }

  const code = /timed out/.test(lastError) ? ERROR_CODES.TIMEOUT : ERROR_CODES.NETWORK_ERROR
  throw new ChannelError(
    `${redact(lastError, secrets)} (after ${retries + 1} attempt(s))`,
    code,
  )
}
