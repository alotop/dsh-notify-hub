/**
 * dsh-notify-hub webhook channels.
 *
 * Six payload presets — 飞书 / 企业微信 / 钉钉 / Slack / Discord / 自定义 —
 * lifted from dsh-notify-center, plus the retry ladder and secret redaction
 * from the shared HTTP helper. `custom` posts the structured envelope so an
 * arbitrary receiver can build its own routing.
 *
 * Two of the provider-side security switches are the caller's responsibility and
 * are implemented here:
 *   * 自定义关键词 — the message text must contain one of the bot's keywords, so
 *     a configured keyword is prepended to the body when it is not already there;
 *   * 签名校验 — the request body must carry `timestamp` + `sign`, where the sign
 *     is `Base64(HMAC-SHA256(key = "<timestamp>\n<secret>", message = ""))`
 *     (飞书 custom-bot rule; a wrong construction yields a different value, which
 *     is why the unit test pins an independently computed vector).
 *
 * @module dsh-notify-hub/channels/webhook
 */

import { createHmac } from 'node:crypto'
import { WEBHOOK_CHANNELS } from '../types.js'
import { renderText } from '../render.js'
import { ChannelError, ERROR_CODES, redact, retryableStatus, sleep } from './http.js'

/**
 * Compute a 飞书 custom-bot signature.
 *
 * The timestamp and secret are joined with a newline and used as the HMAC **key**
 * over an **empty** message — not the other way round.
 *
 * @param {string} secret - the bot's 签名校验 secret.
 * @param {number|string} timestamp - seconds since the epoch (within one hour).
 * @returns {string} the Base64 signature.
 */
export function feishuSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${String(secret ?? '')}`
  return createHmac('sha256', stringToSign).update('').digest('base64')
}

/**
 * Ensure the rendered body satisfies 自定义关键词.
 *
 * The provider only inspects text values, and it is a substring check, so a
 * bracketed prefix reads intentionally in the chat while still matching. A body
 * that already contains the keyword is left untouched.
 *
 * @param {string} text - rendered body.
 * @param {string} keyword - the configured keyword ('' disables the step).
 * @returns {string} the body to send.
 */
export function applyKeyword(text, keyword) {
  const trimmed = String(keyword ?? '').trim()
  if (trimmed.length === 0) return text
  if (String(text).includes(trimmed)) return text
  return `[${trimmed}] ${text}`
}

/**
 * Add the provider's signature fields to a payload.
 *
 * @param {string} channel - webhook channel id.
 * @param {unknown} payload - the JSON body about to be sent.
 * @param {string} secret - the signing secret ('' leaves the body untouched).
 * @param {number} [now] - epoch ms used for the timestamp.
 * @returns {unknown} the body to send.
 */
export function signPayload(channel, payload, secret, now = Date.now()) {
  const key = String(secret ?? '').trim()
  if (key.length === 0) return payload
  if (channel !== 'feishu') return payload
  const timestamp = String(Math.floor(now / 1_000))
  return { timestamp, sign: feishuSign(key, timestamp), ...payload }
}

/**
 * Build the channel-specific JSON body.
 * @param {string} channel - one of {@link WEBHOOK_CHANNELS}.
 * @param {object} envelope - notification envelope.
 * @param {string} text - rendered text body.
 * @returns {unknown} the request body.
 */
export function webhookPayload(channel, envelope, text) {
  switch (channel) {
    case 'feishu':
      return { msg_type: 'text', content: { text } }
    case 'wecom':
      return { msgtype: 'text', text: { content: text } }
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } }
    case 'slack':
      return { text }
    case 'discord':
      return { content: text }
    case 'custom':
    default:
      return {
        text,
        kind: envelope.kind,
        title: envelope.title,
        sessionId: envelope.sessionId,
        turn: envelope.turn,
        durationMs: envelope.durationMs,
        reason: envelope.reason,
        tools: envelope.tools,
        time: new Date(envelope.time).toISOString(),
      }
  }
}

/**
 * Deliver one envelope to one webhook.
 * @param {string} channel - channel id from {@link WEBHOOK_CHANNELS}.
 * @param {string} url - webhook URL (a credential).
 * @param {object} envelope - notification envelope.
 * @param {object} [options] - rendering/delivery options.
 * @returns {Promise<{ attempts: number }>} attempts used.
 * @throws {ChannelError} when unconfigured or delivery fails.
 */
export async function deliverWebhook(channel, url, envelope, options = {}) {
  const target = String(url ?? '').trim()
  if (target.length === 0) {
    throw new ChannelError(`${channel} webhook 未配置`, ERROR_CODES.NOT_CONFIGURED)
  }
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    throw new ChannelError(`${channel} webhook 不是合法的 URL`, ERROR_CODES.NOT_CONFIGURED)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ChannelError(`${channel} webhook 必须使用 http/https`, ERROR_CODES.NOT_CONFIGURED)
  }

  const text = applyKeyword(renderText(envelope, {
    locale: options.locale ?? 'zh',
    includeSummary: options.includeSummary !== false,
    includeSession: true,
  }), options.keyword)
  const body = JSON.stringify(signPayload(
    channel,
    webhookPayload(channel, envelope, text),
    options.secret,
    options.now,
  ))
  const timeoutMs = options.timeoutMs ?? 5_000
  const retries = options.retries ?? 2
  const retryBaseMs = options.retryBaseMs ?? 500
  const signal = options.signal
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const secrets = [target, options.secret, ...(options.secrets ?? [])]
  let lastError = 'unknown error'

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new ChannelError('delivery cancelled', ERROR_CODES.CANCELLED)
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('webhook request timed out')), timeoutMs)
    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      })
      if (response.ok) return { attempts: attempt + 1 }
      // Surface the provider's own diagnosis: 飞书 answers 19024 (keyword
      // missing) and 19021 (signature/time) as a JSON body on a 400, and that
      // body is the only thing that tells the user which switch to fix.
      const detail = typeof response.text === 'function'
        ? (await response.text().catch(() => '')).slice(0, 200)
        : ''
      lastError = `HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`
      if (!retryableStatus(response.status)) break
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      if (signal?.aborted) throw new ChannelError('delivery cancelled', ERROR_CODES.CANCELLED)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    if (attempt < retries) await sleep(retryBaseMs * (2 ** attempt), signal)
  }

  throw new ChannelError(
    redact(`${channel} webhook 投递失败（${retries + 1} 次尝试）：${lastError}`, secrets),
    ERROR_CODES.NETWORK_ERROR,
  )
}

/** Channel ids this module serves, re-exported for the hub registry. */
export { WEBHOOK_CHANNELS }
