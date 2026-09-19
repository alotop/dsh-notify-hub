/**
 * dsh-notify-hub live-check configuration.
 *
 * Reads credentials from the environment so a real value never has to be typed
 * into a tracked file: copy `.env.example` to `.env` (gitignored), fill it in,
 * and `npm run live-check`.
 *
 * Deliberately pure: it takes an environment object and returns a plain
 * description, which is what makes the "skip an unconfigured channel" rule
 * unit-testable without touching the network.
 *
 * @module dsh-notify-hub/scripts/live-env
 */

/** Environment variable names, kept in one place so `.env.example` can be checked against them. */
export const LIVE_ENV_KEYS = Object.freeze({
  barkUrl: 'DSH_NOTIFY_HUB_BARK_URL',
  barkGroup: 'DSH_NOTIFY_HUB_BARK_GROUP',
  cmccApiKey: 'DSH_NOTIFY_HUB_CMCC_API_KEY',
  cmccTo: 'DSH_NOTIFY_HUB_CMCC_TO',
  feishuUrl: 'DSH_NOTIFY_HUB_FEISHU_URL',
  feishuKeyword: 'DSH_NOTIFY_HUB_FEISHU_KEYWORD',
  feishuSecret: 'DSH_NOTIFY_HUB_FEISHU_SECRET',
  customUrl: 'DSH_NOTIFY_HUB_CUSTOM_URL',
  local: 'DSH_NOTIFY_HUB_LOCAL',
})

/** Read one variable as a trimmed string ('' when unset). */
function text(env, key) {
  const value = env?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Truthy spellings accepted for the boolean switch. */
function flag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

/**
 * Mask a credential for output: never more than the last four characters.
 * @param {string} value - the raw value.
 * @returns {string} the masked form ('' when unset).
 */
export function maskValue(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed.length === 0) return ''
  if (trimmed.length <= 4) return '••••'
  return `••••••••${trimmed.slice(-4)}`
}

/**
 * Describe which channels the live check can exercise.
 *
 * A channel is included only when it is fully configured: a cmcc API key without
 * a recipient, or a Feishu URL, is treated as "not configured" rather than
 * attempted and failed — half-configured credentials are the normal state while
 * setting a channel up.
 *
 * @param {Record<string, string | undefined>} env - an environment (usually `process.env`).
 * @returns {{ bark: object | null, cmcc: object | null, feishu: object | null, custom: object | null, local: boolean }}
 *   the configured targets.
 */
export function readLiveTargets(env = {}) {
  const keys = LIVE_ENV_KEYS
  const barkUrl = text(env, keys.barkUrl)
  const cmccApiKey = text(env, keys.cmccApiKey)
  const cmccTo = text(env, keys.cmccTo)
  const feishuUrl = text(env, keys.feishuUrl)
  const customUrl = text(env, keys.customUrl)

  return {
    bark: barkUrl.length > 0
      ? { url: barkUrl, group: text(env, keys.barkGroup) || 'DSH live check' }
      : null,
    cmcc: cmccApiKey.length > 0 && cmccTo.length > 0
      ? { apiKey: cmccApiKey, to: cmccTo }
      : null,
    feishu: feishuUrl.length > 0
      ? {
        url: feishuUrl,
        keyword: text(env, keys.feishuKeyword),
        secret: text(env, keys.feishuSecret),
      }
      : null,
    custom: customUrl.length > 0 ? { url: customUrl } : null,
    local: flag(text(env, keys.local)),
  }
}

/**
 * The channel names this environment can exercise, for a "what will run" line.
 * @param {object} targets - the result of {@link readLiveTargets}.
 * @returns {string[]} configured channel names.
 */
export function configuredChannels(targets) {
  const names = []
  if (targets.bark) names.push('bark')
  if (targets.cmcc) names.push('cmcc')
  if (targets.feishu) names.push('feishu')
  if (targets.custom) names.push('custom')
  if (targets.local) names.push('local')
  return names
}
