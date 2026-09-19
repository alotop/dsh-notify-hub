/**
 * dsh-notify-hub — Host half.
 *
 * Mounts four pieces:
 *   1. a `notify-hub` settings namespace (`ctx.settings` → `$DSH_HOME/settings.yaml`,
 *      live-applied), so the section's values survive restarts and every
 *      credential stays on the Host;
 *   2. the event collector that folds `session/event` into notification
 *      envelopes — turn endings, questions, approvals, plan reviews — and gates
 *      a turn-end envelope until the agent is actually idle;
 *   3. the notification hub, which fans each envelope out to Bark,
 *      「移动新消息」(5G 消息), native desktop notifications, and the webhook
 *      presets, honoring the event flags, the content rules, and the channel
 *      routes;
 *   4. the `/dsh-notify-hub` loopback RPC the settings section reads and writes
 *      through (no credential ever crosses the wire — only a masked status).
 *
 * The browser half (the `./client` entry) registers the settings section.
 *
 * @module dsh-notify-hub
 */

import { CmccChannel } from './channels/cmcc.js'
import { createEventCollector } from './events.js'
import { createHistory } from './history.js'
import { createHub } from './hub.js'
import { loadLegacyBarkEndpoint } from './migration.js'
import { registerHubRpc } from './rpc.js'
import {
  DEFAULT_SETTINGS,
  SETTINGS_NAMESPACE,
  compileSettings,
  deepMerge,
  hubSettingsSchema,
  sanitizeBarkUrl,
} from './settings.js'

/** Stable cordis plugin name (matches the cordis.patch.yml insert id). */
export const name = 'notify-hub'

/**
 * Required services: none hard. The settings seam, the agent registry, and the
 * web server are each awaited through `ctx.inject` inside {@link apply}, so a
 * profile lacking any of them still runs the listener with composed defaults.
 */
export const inject = []

/**
 * Plugin entry.
 * @param {object} ctx - cordis plugin context.
 * @param {object} [config] - composition-layer overrides (entry config), merged over defaults.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const composition = deepMerge(DEFAULT_SETTINGS, config ?? {})
  const fallback = compileSettings(composition)

  /** Live resolved settings (the composition defaults until the seam mounts). */
  let current = () => fallback
  /** Persist handle; absent until the settings seam mounts. */
  let persist = null

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NAMESPACE, hubSettingsSchema, {
      base: composition,
      applies: 'live',
    })
    // `scope.get()` returns a fresh frozen object per committed change, so its
    // identity is a sound cache key: rules/routes are only recompiled when the
    // stored section actually changed. A section that fails to compile (a
    // hand-edited settings.yaml with an unusable regex, say) must not silence
    // every later notification, so the last good compile stays in force and the
    // problem is reported once.
    let cachedRaw = null
    let cached = null
    let degraded = false
    current = () => {
      const raw = scope.get()
      if (raw === cachedRaw && cached !== null) return cached
      try {
        cached = compileSettings(raw)
        cachedRaw = raw
        degraded = false
      } catch (error) {
        if (!degraded) {
          degraded = true
          logger.warn(
            `[notify-hub] 通知配置无效，继续沿用上一次可用配置：${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return cached ?? fallback
      }
      return cached
    }
    persist = (patch) => scope.update(patch)

    // One-shot adoption of an existing dsh-notify-bark endpoint so the upgrade
    // needs no re-typed credential (see lib/migration.js).
    if (composition.migrateLegacyBark !== false && sanitizeBarkUrl(fallback.bark.url).length === 0) {
      const legacy = loadLegacyBarkEndpoint({ logger })
      if (legacy.found) {
        void scope.update({ bark: { url: sanitizeBarkUrl(legacy.url) } })
          .then(() => logger.info('[notify-hub] 已从旧 bark 配置迁移 Bark 推送地址'))
          .catch((error) => logger.warn(
            `[notify-hub] 旧 Bark 配置迁移失败：${error instanceof Error ? error.message : String(error)}`,
          ))
      }
    }

    // When the registration fiber tears down (settings service disposal), fall
    // back to the composition defaults.
    sctx.effect(() => () => {
      current = () => fallback
      persist = null
    }, 'notify-hub: settings fallback')
  })

  // The agent registry is optional: without it every session notifies and a
  // turn-end envelope is delivered immediately instead of waiting for idle.
  let agents = null
  ctx.inject(['agents'], (actx) => {
    agents = actx.agents
    actx.effect(() => () => {
      agents = null
    }, 'notify-hub: agents fallback')
  })

  function isRootSession(sessionId) {
    if (current().notifySubagents === true) return true
    if (agents === null) return true
    try {
      const agent = agents.get(sessionId)
      if (!agent) return true
      return agents.roots().includes(agent)
    } catch {
      return true
    }
  }

  function isIdle(sessionId) {
    if (agents === null) return undefined
    try {
      const agent = agents.get(sessionId)
      if (!agent) return undefined
      return agent.status === 'idle'
    } catch {
      return undefined
    }
  }

  const history = createHistory(() => current().historyLimit)
  const cmcc = new CmccChannel({ getConfig: () => current().cmcc, logger })
  const hub = createHub({ getSettings: () => current(), cmcc, history, logger })
  const collector = createEventCollector({
    getSettings: () => current(),
    emit: (envelope) => {
      hub.dispatch(envelope)
    },
    isRootSession,
    isIdle,
    logger,
  })

  ctx.on('session/event', (session, event) => {
    collector.handle(session, event)
  })

  ctx.on('agent/status', (payload) => {
    const agent = payload?.agent
    if (payload?.status !== 'idle' || !agent) return
    const sessionId = String(agent.id)
    for (const envelope of collector.flush(sessionId)) hub.dispatch(envelope)
  })

  ctx.on('agent/disposed', (payload) => {
    if (payload?.agent) collector.forget(String(payload.agent.id))
  })

  ctx.on('session/disposed', (session) => {
    if (session) collector.forget(String(session.id))
  })

  registerHubRpc(ctx, {
    getSettings: () => current(),
    update: async (patch) => {
      if (persist === null) throw new Error('设置服务不可用')
      await persist(patch)
    },
    hub,
    cmcc,
    history,
    logger,
  })

  ctx.effect(() => () => hub.dispose(), 'notify-hub: delivery lifetime')

  const initial = current()
  logger.info(
    `[notify-hub] ready (bark=${sanitizeBarkUrl(initial.bark.url).length > 0}, `
    + `cmcc=${cmcc.configured(initial.cmcc)}, local=${initial.local.enabled}, `
    + `webhooks=${Object.entries(initial.webhooks).filter(([, c]) => c.enabled && c.url).map(([n]) => n).join(',') || 'none'})`,
  )
}

export { DEFAULT_SETTINGS, SETTINGS_NAMESPACE }
