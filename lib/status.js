/**
 * dsh-notify-hub channel status projection.
 *
 * The settings section shows one row per channel with the three facts a user
 * actually needs: is it switched on, is it fully configured, and — for
 * 移动新消息 — is the long connection up right now. Secrets never appear: only
 * the masked tail and a boolean ride the wire.
 *
 * @module dsh-notify-hub/status
 */

import { localSupport } from './channels/local.js'
import { sanitizeBarkUrl, maskSecret, webhookSecurityOf } from './settings.js'
import { CHANNEL_IDS, CHANNEL_LABELS, CHANNEL_LABELS_EN } from './types.js'

/**
 * One channel's browser-facing row.
 * @param {string} id - channel id.
 * @param {object} settings - resolved settings.
 * @param {object} cmcc - 移动新消息 channel instance.
 * @returns {object} the status row.
 */
export function channelStatus(id, settings, cmcc) {
  const locale = settings.locale === 'en' ? 'en' : 'zh'
  const labels = locale === 'en' ? CHANNEL_LABELS_EN : CHANNEL_LABELS
  const base = { id, label: labels[id] ?? id, enabled: false, configured: false, detail: '' }
  switch (id) {
    case 'bark': {
      const mask = maskSecret(sanitizeBarkUrl(settings.bark.url))
      return {
        ...base,
        enabled: settings.bark.enabled === true,
        configured: mask.configured,
        masked: mask.masked,
        detail: settings.bark.group,
      }
    }
    case 'cmcc': {
      const status = cmcc.status()
      return {
        ...base,
        enabled: settings.cmcc.enabled === true,
        configured: status.configured,
        masked: status.maskedKey,
        connected: status.connected,
        lastError: status.lastError,
        detail: status.connected ? '已连接' : (settings.cmcc.to ? `接收方 ${maskSecret(settings.cmcc.to).masked}` : '未配置接收号码'),
      }
    }
    case 'local': {
      const support = localSupport()
      return {
        ...base,
        enabled: settings.local.enabled === true,
        configured: support.supported,
        detail: support.backend,
      }
    }
    default: {
      const channel = settings.webhooks[id]
      if (channel === undefined) return base
      const mask = maskSecret(channel.url)
      const security = webhookSecurityOf(id)
      const detail = [channel.includeSummary ? '附带摘要' : '仅标题']
      if (security.keyword === true && String(channel.keyword ?? '').trim().length > 0) detail.push('关键词✓')
      if (security.signature === true && String(channel.secret ?? '').trim().length > 0) detail.push('签名✓')
      return {
        ...base,
        enabled: channel.enabled === true,
        configured: mask.configured,
        masked: mask.masked,
        detail: detail.join(' · '),
      }
    }
  }
}

/**
 * The whole status block for the section.
 * @param {object} settings - resolved settings.
 * @param {object} cmcc - 移动新消息 channel instance.
 * @param {object} [extra] - platform/queue detail.
 * @returns {object} the status view.
 */
export function describeStatus(settings, cmcc, extra = {}) {
  const support = localSupport()
  return {
    platform: process.platform,
    localBackend: support.backend,
    localSupported: support.supported,
    inFlight: extra.inFlight ?? 0,
    channels: CHANNEL_IDS.map((id) => channelStatus(id, settings, cmcc)),
    cmcc: cmcc.status(),
  }
}
