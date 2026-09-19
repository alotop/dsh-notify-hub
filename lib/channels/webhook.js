/**
 * dsh-notify-hub webhook channels.
 *
 * Six payload presets — 飞书 / 企业微信 / 钉钉 / Slack / Discord / 自定义 —
 * lifted from dsh-notify-center, plus the retry ladder and secret redaction
 * from the shared HTTP helper. `custom` posts the structured envelope so an
 * arbitrary receiver can build its own routing.
 *
 * @module dsh-notify-hub/channels/webhook
 */

import { WEBHOOK_CHANNELS } from '../types.js'
import { renderText } from '../render.js'
import { ChannelError, ERROR_CODES, redact, retryableStatus, sleep } from './http.js'

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

  const text = renderText(envelope, {
    locale: options.locale ?? 'zh',
    includeSummary: options.includeSummary !== false,
    includeSession: true,
  })
  const body = JSON.stringify(webhookPayload(channel, envelope, text))
  const timeoutMs = options.timeoutMs ?? 5_000
  const retries = options.retries ?? 2
  const retryBaseMs = options.retryBaseMs ?? 500
  const signal = options.signal
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const secrets = [target, ...(options.secrets ?? [])]
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
      lastError = `HTTP ${response.status}`
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
