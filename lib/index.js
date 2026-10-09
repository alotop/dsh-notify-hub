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
import { loadLegacyBarkEndpoint, loadLegacyNamespace } from './migration.js'
import { registerHubRpc } from './rpc.js'
import {
  DEFAULT_SETTINGS,
  SETTINGS_NAMESPACE,
  compileSettings,
  deepMerge,
  hubConfigSchema,
  hubSettingsSchema,
  isVolatileRef,
  readConfig,
  sanitizeBarkUrl,
} from './settings.js'

/** Stable cordis plugin name (matches the cordis.patch.yml insert id). */
export const name = 'notify-hub'

/**
 * The plugin's configuration schema.
 *
 * Declaring it is what makes this plugin configurable on DSH 0.2: the settings
 * service projects the *profile entry's* Config into a form, addresses it by the
 * entry id (`notify-hub`), and persists edits through the profile's Cordis patch.
 * Its editable leaves are volatile there, so a save is committed into the running
 * references without a restart. On 0.1.x the same tree is registered as a settings
 * namespace instead — see {@link apply}.
 */
export const Config = hubConfigSchema

/**
 * Required services: none hard. The settings seam, the agent registry, and the
 * web server are each awaited through `ctx.inject` inside {@link apply}, so a
 * profile lacking any of them still runs the listener with composed defaults.
 */
export const inject = []

/** Whether a resolved config still carries live (volatile) leaves — i.e. the 0.2 seam. */
function hasLiveLeaves(config) {
  if (typeof config !== 'object' || config === null) return false
  for (const value of Object.values(config)) {
    if (isVolatileRef(value)) return true
    if (Array.isArray(value)) {
      for (const entry of value) if (hasLiveLeaves(entry)) return true
    } else if (typeof value === 'object' && hasLiveLeaves(value)) {
      return true
    }
  }
  return false
}

/**
 * Resolve the runtime's YAML parser for the legacy settings reader.
 *
 * `yaml` is provided by the DSH runtime (its own settings service depends on it),
 * so it is loaded lazily and never becomes a hard dependency: without it the
 * legacy recovery is skipped and everything else still works.
 *
 * @returns {Promise<Function | null>} a `parse(text)` function, or null.
 */
async function loadYamlParser() {
  try {
    const module = await import('yaml')
    const parse = module.parse ?? module.default?.parse
    return typeof parse === 'function' ? parse : null
  } catch {
    return null
  }
}

/**
 * Plugin entry.
 * @param {object} ctx - cordis plugin context.
 * @param {object} [config] - the resolved entry config (volatile leaves on 0.2) or composition overrides.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const composition = deepMerge(DEFAULT_SETTINGS, readConfig(config) ?? {})
  const fallback = compileSettings(composition)

  /** Live resolved settings. */
  let current = () => fallback
  /** Persist handle; absent until a settings seam is reachable. */
  let persist = null
  /** Which configuration seam is in force, reported once at startup. */
  let seam = 'composition'
  /**
   * Settings recovered from a legacy document that could not be written back.
   *
   * The recovery must not depend on the write succeeding: a profile without a
   * config editor would otherwise leave the user exactly where the upgrade put
   * them —「未配置」, with their values sitting in a file. The overlay keeps them
   * live for this session, and the log says they were not saved.
   */
  let adopted = null

  // DSH 0.2 hands the plugin a config whose editable leaves are live references:
  // reading them through `readConfig` on every use is what makes an edit apply
  // without a restart. An older runtime without `volatile()` yields plain values,
  // in which case the composition snapshot above is already the whole truth.
  if (hasLiveLeaves(config)) {
    seam = 'entry-config'
    let signature = null
    let cached = fallback
    let degraded = false
    current = () => {
      const raw = deepMerge(readConfig(config) ?? {}, adopted ?? {})
      // Values are JSON data, so their serialization is a sound change key:
      // rules and routes are only recompiled when something actually changed.
      const key = JSON.stringify(raw)
      if (key === signature) return cached
      try {
        cached = compileSettings(raw)
        signature = key
        degraded = false
      } catch (error) {
        // A config that cannot compile (an unusable regex, say) must not silence
        // every later notification: keep the last good one and report once.
        if (!degraded) {
          degraded = true
          logger.warn(
            `[notify-hub] 通知配置无效，继续沿用上一次可用配置：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      return cached
    }
  }

  /**
   * One-shot recovery of settings an earlier DSH left behind.
   *
   * DSH 0.2 stopped reading the global `$DSH_HOME/settings.yaml`. The sections it
   * could address were imported into their profile entries and the file was
   * renamed to `settings.yaml.imported`; a section whose entry had no schema yet —
   * this plugin's, before it declared {@link Config} — was left in the renamed
   * file. Adopt it once, while nothing is configured, so an upgrade costs no
   * re-typed credentials. `migrateLegacyBark: false` opts out.
   */
  async function adoptLegacySettings() {
    if (persist === null || composition.migrateLegacyBark === false) return
    const effective = current()
    const configured = sanitizeBarkUrl(effective.bark.url).length > 0
      || String(effective.cmcc.apiKey ?? '').trim().length > 0
      || Object.values(effective.webhooks).some((channel) => String(channel?.url ?? '').trim().length > 0)
    if (configured) return

    const parseYaml = await loadYamlParser()
    if (parseYaml !== null) {
      const legacy = loadLegacyNamespace({ parseYaml, logger })
      if (legacy.found) {
        try {
          await persist(legacy.section)
          adopted = null
          logger.info(`[notify-hub] 已从 ${legacy.file} 恢复旧设置（${SETTINGS_NAMESPACE} 段）`)
          return
        } catch (error) {
          // Keep them working anyway, and say plainly that the save failed.
          adopted = legacy.section
          logger.warn(
            `[notify-hub] 旧设置未能写回 profile（${error instanceof Error ? error.message : String(error)}）；`
            + '本次运行已改用读取到的旧值，请到设置页保存一次以固化',
          )
          return
        }
      }
    }

    // Fall back to the pre-hub dsh-notify-bark endpoint (see lib/migration.js).
    const bark = loadLegacyBarkEndpoint({ logger })
    if (bark.found) {
      const patch = { bark: { url: sanitizeBarkUrl(bark.url) } }
      try {
        await persist(patch)
        adopted = null
        logger.info('[notify-hub] 已从旧 bark 配置迁移 Bark 推送地址')
      } catch (error) {
        adopted = patch
        logger.warn(
          `[notify-hub] 旧 Bark 地址未能写回 profile（${error instanceof Error ? error.message : String(error)}）；`
          + '本次运行已改用读取到的地址，请到设置页保存一次以固化',
        )
      }
    }
  }

  ctx.inject(['settings'], (sctx) => {
    // --- 0.1.x seam: a namespace registered with the settings service ---------
    if (typeof sctx.settings.register === 'function') {
      seam = 'settings-namespace'
      const scope = sctx.settings.register(SETTINGS_NAMESPACE, hubSettingsSchema, {
        base: composition,
        applies: 'live',
      })
      let cachedRaw = null
      let cached = null
      let degraded = false
      current = () => {
        const raw = deepMerge(scope.get() ?? {}, adopted ?? {})
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

      void adoptLegacySettings()

      // When the registration fiber tears down (settings service disposal), fall
      // back to the composition defaults.
      sctx.effect(() => () => {
        current = () => fallback
        persist = null
      }, 'notify-hub: settings fallback')
      return
    }

    // --- 0.2 seam: the profile entry's Config, persisted through the editor ----
    // The runtime keeps the live references current, so only the write path is
    // left: merge the patch over the values in force and hand the whole config to
    // the editor, which owns the profile patch and its revision checks.
    persist = async (patch) => {
      // Prefer the injected scope: it is the context that owns this plugin
      // instance, and `get` exists on any cordis context.
      const editor = sctx.get('configEditor') ?? ctx.get?.('configEditor')
      if (editor === undefined || typeof editor.edit !== 'function') {
        throw new Error('设置服务不可用：未挂载 configEditor')
      }
      const entry = ctx.fiber?.entry
      if (entry === undefined) {
        throw new Error('设置服务不可用：该插件没有 profile entry')
      }
      // Recovered legacy values ride along: a save after a failed recovery must
      // persist what the user is actually running with, not the empty config.
      const next = deepMerge(deepMerge(readConfig(config) ?? {}, adopted ?? {}), patch)
      await editor.edit(entry, () => next)
      adopted = null
    }

    void adoptLegacySettings()

    // This plugin ships its own settings section, so the generic schema-generated
    // page is switched off rather than shown twice for the same entry (the
    // platform's rule for a plugin that owns a page). Absent on 0.1.x.
    if (typeof sctx.settings.configure === 'function') {
      sctx.effect(
        () => sctx.settings.configure({ auto: false }, ctx.fiber),
        'notify-hub: own settings page',
      )
    }

    sctx.effect(() => () => {
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
    `[notify-hub] ready (config=${seam}, bark=${sanitizeBarkUrl(initial.bark.url).length > 0}, `
    + `cmcc=${cmcc.configured(initial.cmcc)}, local=${initial.local.enabled}, `
    + `webhooks=${Object.entries(initial.webhooks).filter(([, c]) => c.enabled && c.url).map(([n]) => n).join(',') || 'none'})`,
  )
}

export { DEFAULT_SETTINGS, SETTINGS_NAMESPACE }
