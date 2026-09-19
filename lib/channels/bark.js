/**
 * dsh-notify-hub Bark channel.
 *
 * One JSON POST to the configured Bark endpoint (`https://api.day.app/<key>` or
 * a self-hosted server). The endpoint is a credential: it is never logged, and
 * every error message passes through {@link redact}. Ported from
 * dsh-notify-bark, keeping its V2 payload shape (title/body/group/level/sound).
 *
 * @module dsh-notify-hub/channels/bark
 */

import { sanitizeBarkUrl } from '../settings.js'
import { ChannelError, ERROR_CODES, postJson } from './http.js'

/**
 * @typedef {object} BarkPayload
 * @property {string} title - notification title.
 * @property {string} body - notification body.
 * @property {string} [group] - Bark group the push joins.
 * @property {string} [level] - active | timeSensitive | passive | critical.
 * @property {string} [sound] - Bark sound name.
 * @property {string} [url] - tap-through URL.
 */

/**
 * POST one Bark notification.
 * @param {string} endpoint - full Bark endpoint.
 * @param {BarkPayload} payload - Bark V2 payload.
 * @param {object} [options] - timeout/retries/signal/fetch overrides.
 * @returns {Promise<{ attempts: number }>} attempts used.
 * @throws {ChannelError} when unconfigured or delivery fails.
 */
export async function sendBark(endpoint, payload, options = {}) {
  const base = sanitizeBarkUrl(endpoint)
  if (base.length === 0) throw new ChannelError('Bark 推送地址未配置', ERROR_CODES.NOT_CONFIGURED)
  let url
  try {
    url = new URL(base)
  } catch {
    throw new ChannelError('Bark 推送地址不是合法的 URL', ERROR_CODES.NOT_CONFIGURED)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ChannelError('Bark 推送地址必须使用 http/https', ERROR_CODES.NOT_CONFIGURED)
  }
  const result = await postJson(base, payload, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    retryBaseMs: options.retryBaseMs,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    secrets: [base, ...(options.secrets ?? [])],
  })
  return { attempts: result.attempts }
}

/**
 * The test push fired from the settings section.
 * @param {string} group - Bark group.
 * @returns {BarkPayload} the payload.
 */
export function buildBarkTestPayload(group) {
  return {
    title: 'DeepSeek Harness',
    body: '🔔 通知集合已连通\n这是一条来自 DSH 的测试推送。',
    group,
    level: 'active',
  }
}
