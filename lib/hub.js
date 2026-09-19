/**
 * dsh-notify-hub dispatcher.
 *
 * The hub owns the fan-out: it asks the policy layer whether an envelope
 * notifies at all, narrows the channel set through the routes, and delivers
 * concurrently with a bounded in-flight window so a stuck endpoint can never
 * pile up unbounded work inside the DSH host.
 *
 * Every attempt — success or failure — lands in the delivery history the
 * settings section renders, and every failure message is redacted before it is
 * logged or sent to the browser.
 *
 * @module dsh-notify-hub/hub
 */

import { deliverWebhook } from './channels/webhook.js'
import { buildBarkTestPayload, sendBark } from './channels/bark.js'
import { localSupport, sendLocalNotification } from './channels/local.js'
import { ChannelError, redact } from './channels/http.js'
import { renderBarkPayload, renderText } from './render.js'
import { routeChannels, shouldNotify } from './policy.js'
import { sanitizeBarkUrl } from './settings.js'
import { CHANNEL_IDS, WEBHOOK_CHANNELS } from './types.js'

/** Delivery attempts allowed to be in flight at once. */
export const MAX_IN_FLIGHT = 100

/**
 * A synthetic envelope for the section's test buttons.
 * @param {string} [channel] - channel the test targets (affects copy only).
 * @returns {object} the test envelope.
 */
export function buildTestEnvelope(channel = 'all') {
  return {
    id: `test:${channel}:${Date.now()}`,
    kind: 'completed',
    flag: 'completed',
    sessionId: 'dsh-notify-hub',
    title: '通知集合自检',
    summary: '这是一条来自 DSH 通知集合的测试通知。',
    tools: [],
    time: Date.now(),
    durationMs: 1_000,
  }
}

/**
 * The channels that are both enabled and configured for the current settings.
 * @param {object} settings - resolved settings.
 * @param {object} cmcc - the 移动新消息 channel instance.
 * @returns {string[]} channel ids.
 */
export function enabledChannels(settings, cmcc) {
  const ids = []
  if (settings.bark.enabled && sanitizeBarkUrl(settings.bark.url).length > 0) ids.push('bark')
  if (settings.cmcc.enabled && cmcc.configured(settings.cmcc)) ids.push('cmcc')
  if (settings.local.enabled && localSupport().supported) ids.push('local')
  for (const name of WEBHOOK_CHANNELS) {
    const channel = settings.webhooks[name]
    if (channel.enabled && String(channel.url ?? '').trim().length > 0) ids.push(name)
  }
  return ids
}

/**
 * Create the hub.
 *
 * @param {object} deps - dependencies.
 * @param {() => object} deps.getSettings - live resolved settings.
 * @param {object} deps.cmcc - 移动新消息 channel instance.
 * @param {object} deps.history - delivery history from `createHistory`.
 * @param {{ warn(message: string): void, info?(message: string): void }} [deps.logger] - logger.
 * @returns {object} the hub.
 */
export function createHub(deps) {
  const { getSettings, cmcc, history } = deps
  const logger = deps.logger ?? console
  const fetchImpl = deps.fetchImpl
  const lifetime = new AbortController()
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set()

  /** Deliver one envelope through one channel. */
  async function deliver(channel, envelope, settings) {
    const delivery = settings.delivery
    const shared = {
      signal: lifetime.signal,
      timeoutMs: delivery.timeoutMs,
      retries: delivery.retries,
      retryBaseMs: delivery.retryBaseMs,
    }
    switch (channel) {
      case 'bark': {
        const payload = renderBarkPayload(envelope, settings)
        const result = await sendBark(settings.bark.url, payload, {
          ...shared,
          fetchImpl,
          secrets: [settings.bark.url],
        })
        return `attempt(s)=${result.attempts}`
      }
      case 'cmcc': {
        const text = renderText(envelope, {
          locale: settings.locale,
          includeSummary: settings.cmcc.includeSummary !== false,
          prefix: settings.cmcc.prefix,
          includeSession: false,
          plain: true,
        })
        const result = await cmcc.sendText(text)
        return `messageId=${result.messageId}`
      }
      case 'local': {
        const result = await sendLocalNotification(envelope, settings, { signal: lifetime.signal })
        return `backend=${result.backend}`
      }
      default: {
        const channelSettings = settings.webhooks[channel]
        if (channelSettings === undefined) {
          throw new ChannelError(`未知通知通道：${channel}`, 'NOT_CONFIGURED')
        }
        const result = await deliverWebhook(channel, channelSettings.url, envelope, {
          ...shared,
          fetchImpl,
          locale: settings.locale,
          includeSummary: channelSettings.includeSummary === true,
          secrets: [channelSettings.url],
        })
        return `attempt(s)=${result.attempts}`
      }
    }
  }

  /** Launch one delivery, bound the window, and record the outcome. */
  function launch(channel, envelope, settings, source) {
    if (inFlight.size >= MAX_IN_FLIGHT) {
      logger.warn(`[notify-hub] delivery queue full; dropped ${channel} ${envelope.id}`)
      history.record({
        time: Date.now(),
        id: envelope.id,
        kind: envelope.kind,
        channel,
        title: envelope.title,
        ok: false,
        error: 'delivery queue full',
        source,
      })
      return
    }
    const startedAt = Date.now()
    const task = deliver(channel, envelope, settings)
      .then((detail) => {
        history.record({
          time: startedAt,
          id: envelope.id,
          kind: envelope.kind,
          channel,
          title: envelope.title,
          ok: true,
          detail,
          durationMs: Date.now() - startedAt,
          source,
        })
      })
      .catch((error) => {
        const secrets = [
          settings.bark.url,
          settings.cmcc.apiKey,
          ...WEBHOOK_CHANNELS.map((name) => settings.webhooks[name]?.url),
        ]
        const code = error instanceof ChannelError ? error.code : 'UNKNOWN'
        const message = redact(error instanceof Error ? error.message : String(error), secrets)
        history.record({
          time: startedAt,
          id: envelope.id,
          kind: envelope.kind,
          channel,
          title: envelope.title,
          ok: false,
          error: message,
          code,
          durationMs: Date.now() - startedAt,
          source,
        })
        if (!lifetime.signal.aborted) {
          logger.warn(`[notify-hub] ${channel} delivery failed: ${message}`)
        }
      })
      .finally(() => {
        inFlight.delete(task)
      })
    inFlight.add(task)
  }

  return {
    /**
     * Fan one envelope out to the routed channels.
     * @param {object} envelope - notification envelope.
     * @param {object} [options] - `source` tags the history entry.
     * @returns {{ delivered: boolean, channels: string[] }} what happened.
     */
    dispatch(envelope, options = {}) {
      const settings = getSettings()
      if (!shouldNotify(settings, envelope)) return { delivered: false, channels: [] }
      const candidates = enabledChannels(settings, cmcc)
      const channels = routeChannels(settings.routes, envelope, candidates)
      for (const channel of channels) launch(channel, envelope, settings, options.source ?? 'event')
      return { delivered: channels.length > 0, channels }
    },

    /**
     * Send one test notification through one channel (or every enabled one).
     * @param {string} channel - channel id, or `all`.
     * @returns {Promise<{ results: Array<{ channel: string, ok: boolean, detail?: string, error?: string }> }>} per-channel results.
     */
    async test(channel) {
      const settings = getSettings()
      const targets = channel === 'all' || channel === undefined
        ? enabledChannels(settings, cmcc)
        : [channel]
      if (targets.length === 0) {
        throw new ChannelError('没有已启用且配置完整的通知通道', 'NOT_CONFIGURED')
      }
      const envelope = buildTestEnvelope(channel)
      const results = []
      for (const id of targets) {
        const startedAt = Date.now()
        try {
          const detail = await deliver(id, envelope, settings)
          results.push({ channel: id, ok: true, detail })
          history.record({
            time: startedAt,
            id: envelope.id,
            kind: envelope.kind,
            channel: id,
            title: envelope.title,
            ok: true,
            detail,
            durationMs: Date.now() - startedAt,
            source: 'test',
          })
        } catch (error) {
          const secrets = [
            settings.bark.url,
            settings.cmcc.apiKey,
            ...WEBHOOK_CHANNELS.map((name) => settings.webhooks[name]?.url),
          ]
          const message = redact(error instanceof Error ? error.message : String(error), secrets)
          results.push({ channel: id, ok: false, error: message })
          history.record({
            time: startedAt,
            id: envelope.id,
            kind: envelope.kind,
            channel: id,
            title: envelope.title,
            ok: false,
            error: message,
            durationMs: Date.now() - startedAt,
            source: 'test',
          })
        }
      }
      return { results }
    },

    /** The Bark-only test payload helper, reused by the RPC status probe. */
    buildBarkTestPayload,

    /** Abort every in-flight delivery and stop the 移动新消息 socket. */
    dispose() {
      lifetime.abort(new Error('dsh-notify-hub disposed'))
      cmcc.dispose()
    },

    /**
     * Wait until every launched delivery has settled. Used by tests and by a
     * graceful shutdown; the listener never awaits it, so a slow endpoint can
     * never stall the event firehose.
     * @returns {Promise<void>} resolves when the queue is empty.
     */
    async idle() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight])
      }
    },

    /** In-flight delivery count (tests + status read). */
    inFlightCount() {
      return inFlight.size
    },

    /** Every channel id the hub knows about. */
    channelIds() {
      return [...CHANNEL_IDS]
    },
  }
}
