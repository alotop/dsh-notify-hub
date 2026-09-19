/**
 * dsh-notify-hub settings model: namespace, schema, defaults, and the
 * browser-safe view.
 *
 * The namespace is registered Host-side through `ctx.settings`, so values
 * persist to `$DSH_HOME/settings.yaml` and hot-apply. Every credential
 * (Bark endpoint, webhook URL, 移动新消息 API Key) is a schema-declared
 * `secret`, and the browser never receives a value: the settings section reads
 * a masked status and writes new values only.
 *
 * @module dsh-notify-hub/settings
 */

import Schema from '@deepseek-ai/schemastery'
import {
  CMCC_DEFAULTS,
  DEFAULT_HISTORY_LIMIT,
  EVENT_FLAGS,
  SETTINGS_NAMESPACE,
  WEBHOOK_CHANNELS,
  WEBHOOK_SECURITY,
} from './types.js'

export { SETTINGS_NAMESPACE }

/** A string field the settings wire redacts. */
function secretString(fallback = '') {
  return Schema.string().role('secret').default(fallback)
}

function bool(fallback) {
  return Schema.boolean().default(fallback)
}

/**
 * The provider security features a webhook channel supports (empty for most).
 * @param {string} name - webhook channel id.
 * @returns {{ keyword?: boolean, signature?: boolean }} the capability flags.
 */
export function webhookSecurityOf(name) {
  return WEBHOOK_SECURITY[name] ?? {}
}

/**
 * Composition defaults for one webhook channel, extended with the security
 * fields that channel's provider actually supports.
 * @param {string} name - webhook channel id.
 * @returns {object} the frozen defaults.
 */
export function webhookDefaults(name) {
  const security = webhookSecurityOf(name)
  return Object.freeze({
    enabled: false,
    url: '',
    includeSummary: false,
    ...(security.keyword === true ? { keyword: '' } : {}),
    ...(security.signature === true ? { secret: '' } : {}),
  })
}

/**
 * Schema for one webhook channel. The 自定义关键词 sits in plain text (the user
 * must be able to read back what the provider will match on); the 签名校验 secret
 * is a credential and is redacted.
 * @param {string} name - webhook channel id.
 * @returns {object} the schemastery object schema.
 */
function webhookChannelSchema(name) {
  const security = webhookSecurityOf(name)
  return Schema.object({
    enabled: bool(false),
    url: secretString(''),
    includeSummary: bool(false),
    ...(security.keyword === true ? { keyword: Schema.string().default('') } : {}),
    ...(security.signature === true ? { secret: secretString('') } : {}),
  })
}

/**
 * Composition defaults — what a fresh install ships with. Every channel except
 * the native desktop one starts unconfigured; a channel with no credential is
 * simply skipped at delivery time and reported as「未配置」in the section.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  locale: 'zh',
  notifySubagents: false,
  includeAssistantText: true,
  maxBodyChars: 600,
  historyLimit: DEFAULT_HISTORY_LIMIT,
  migrateLegacyBark: true,
  events: Object.freeze({
    completed: true,
    error: true,
    blocked: true,
    aborted: false,
    maxTokens: true,
    interrupted: true,
    question: true,
    approval: true,
    planReview: false,
  }),
  bark: Object.freeze({
    enabled: true,
    url: '',
    group: 'DeepSeek Harness',
    level: 'active',
    sound: '',
  }),
  local: Object.freeze({
    enabled: true,
    sound: true,
  }),
  cmcc: Object.freeze({
    enabled: true,
    apiKey: '',
    to: '',
    serverUrl: CMCC_DEFAULTS.serverUrl,
    uploadUrl: CMCC_DEFAULTS.uploadUrl,
    version: CMCC_DEFAULTS.version,
    prefix: 'DSH',
    includeSummary: true,
  }),
  webhooks: Object.freeze(
    Object.fromEntries(WEBHOOK_CHANNELS.map((name) => [name, webhookDefaults(name)])),
  ),
  delivery: Object.freeze({
    timeoutMs: 5_000,
    retries: 2,
    retryBaseMs: 500,
  }),
  rules: Object.freeze([]),
  routes: Object.freeze([]),
})

/** Bark push levels accepted by the API. */
export const BARK_LEVELS = Object.freeze(['active', 'timeSensitive', 'passive', 'critical'])

/** Notification locales. */
export const LOCALES = Object.freeze(['zh', 'en'])

/**
 * Settings schema: what the settings surface edits and how the stored section
 * resolves. Secret roles are what make the Host redact these fields from any
 * wire describe of the namespace.
 */
export const hubSettingsSchema = Schema.object({
  enabled: bool(true),
  locale: Schema.union([Schema.const('zh'), Schema.const('en')]).default('zh'),
  notifySubagents: bool(false),
  includeAssistantText: bool(true),
  maxBodyChars: Schema.number().min(40).max(4_000).default(600),
  historyLimit: Schema.number().min(0).max(500).default(DEFAULT_HISTORY_LIMIT),
  migrateLegacyBark: bool(true),
  events: Schema.object(Object.fromEntries(
    EVENT_FLAGS.map((flag) => [flag, bool(DEFAULT_SETTINGS.events[flag])]),
  )),
  bark: Schema.object({
    enabled: bool(true),
    url: secretString(''),
    group: Schema.string().default('DeepSeek Harness'),
    level: Schema.union(BARK_LEVELS.map((level) => Schema.const(level))).default('active'),
    sound: Schema.string().default(''),
  }),
  local: Schema.object({
    enabled: bool(true),
    sound: bool(true),
  }),
  cmcc: Schema.object({
    enabled: bool(true),
    apiKey: secretString(''),
    to: Schema.string().default(''),
    serverUrl: Schema.string().default(CMCC_DEFAULTS.serverUrl),
    uploadUrl: Schema.string().default(CMCC_DEFAULTS.uploadUrl),
    version: Schema.string().default(CMCC_DEFAULTS.version),
    prefix: Schema.string().default('DSH'),
    includeSummary: bool(true),
  }),
  webhooks: Schema.object(Object.fromEntries(WEBHOOK_CHANNELS.map((name) => [name, webhookChannelSchema(name)]))),
  delivery: Schema.object({
    timeoutMs: Schema.number().min(100).max(60_000).default(5_000),
    retries: Schema.number().min(0).max(5).default(2),
    retryBaseMs: Schema.number().min(50).max(30_000).default(500),
  }),
  rules: Schema.array(Schema.object({
    mode: Schema.union([Schema.const('include'), Schema.const('exclude')]).default('include'),
    pattern: Schema.string().required(),
    regex: bool(false),
    caseSensitive: bool(false),
  })),
  routes: Schema.array(Schema.object({
    pattern: Schema.string().required(),
    regex: bool(false),
    caseSensitive: bool(false),
    channels: Schema.array(Schema.string()),
  })),
})

/** A plain object (not an array, not null). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge a partial settings patch over defaults. Arrays and scalars replace
 * outright; objects merge key by key. Used for the composition-layer base and
 * as the resolved value whenever the settings seam is absent.
 * @param {object} base - defaults.
 * @param {object} patch - partial override.
 * @returns {object} a fresh merged object.
 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch
  const output = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = output[key]
    output[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value
  }
  return output
}

/** Compile one rule/route pattern into a matcher. */
function compileMatcher(entry, index, kind) {
  const pattern = typeof entry?.pattern === 'string' ? entry.pattern.trim() : ''
  if (pattern.length === 0) throw new Error(`${kind}[${index}].pattern must not be empty`)
  const regex = entry?.regex === true
  const caseSensitive = entry?.caseSensitive === true
  let expression
  if (regex) {
    try {
      expression = new RegExp(pattern, caseSensitive ? '' : 'i')
    } catch (error) {
      throw new Error(`${kind}[${index}] has an invalid regular expression: ${String(error)}`)
    }
  }
  return { mode: entry?.mode ?? 'include', pattern, regex, caseSensitive, expression }
}

/** Compile every policy rule and channel route. */
export function compileSettings(raw) {
  const settings = deepMerge(DEFAULT_SETTINGS, raw ?? {})
  return {
    ...settings,
    events: { ...DEFAULT_SETTINGS.events, ...(settings.events ?? {}) },
    bark: { ...DEFAULT_SETTINGS.bark, ...(settings.bark ?? {}) },
    local: { ...DEFAULT_SETTINGS.local, ...(settings.local ?? {}) },
    cmcc: { ...DEFAULT_SETTINGS.cmcc, ...(settings.cmcc ?? {}) },
    delivery: { ...DEFAULT_SETTINGS.delivery, ...(settings.delivery ?? {}) },
    webhooks: Object.fromEntries(WEBHOOK_CHANNELS.map((name) => [
      name,
      { ...DEFAULT_SETTINGS.webhooks[name], ...(settings.webhooks?.[name] ?? {}) },
    ])),
    rules: (settings.rules ?? []).map((rule, index) => compileMatcher(rule, index, 'rules')),
    routes: (settings.routes ?? []).map((route, index) => ({
      ...compileMatcher(route, index, 'routes'),
      channels: Array.isArray(route?.channels) ? route.channels.filter((id) => typeof id === 'string') : [],
    })),
  }
}

/**
 * Normalize a Bark endpoint: trim and strip trailing slashes so the JSON POST
 * lands on exactly the server root.
 * @param {string} input - raw endpoint.
 * @returns {string} the normalized endpoint.
 */
export function sanitizeBarkUrl(input) {
  return String(input ?? '').trim().replace(/\/+$/, '')
}

/** Normalize a WebSocket/HTTP endpoint the same way. */
export function sanitizeEndpoint(input) {
  return String(input ?? '').trim().replace(/\/+$/, '')
}

/**
 * Mask a secret for display: only the configured fact plus the last four
 * characters ever cross the wire.
 * @param {string} value - the raw secret.
 * @returns {{ configured: boolean, masked: string }}
 */
export function maskSecret(value) {
  const normalized = String(value ?? '').trim()
  if (normalized.length === 0) return { configured: false, masked: '' }
  const tail = normalized.length <= 4 ? normalized : normalized.slice(-4)
  return { configured: true, masked: `••••••••${tail}` }
}

/** Mask a recipient identifier (a phone number is a credential too). */
export function maskRecipient(value) {
  const normalized = String(value ?? '').trim()
  if (normalized.length === 0) return ''
  if (normalized.length <= 4) return normalized
  return `${normalized.slice(0, 3)}••••${normalized.slice(-2)}`
}

/**
 * The browser-safe settings view: every credential replaced by its masked
 * status. This is exactly what the section renders and edits around.
 * @param {object} settings - resolved settings.
 * @returns {object} the wire view.
 */
export function settingsView(settings) {
  const bark = maskSecret(sanitizeBarkUrl(settings.bark.url))
  const cmcc = maskSecret(settings.cmcc.apiKey)
  return {
    enabled: settings.enabled,
    locale: settings.locale,
    notifySubagents: settings.notifySubagents,
    includeAssistantText: settings.includeAssistantText,
    maxBodyChars: settings.maxBodyChars,
    historyLimit: settings.historyLimit,
    events: { ...settings.events },
    delivery: { ...settings.delivery },
    rules: settings.rules.map((rule) => ({
      mode: rule.mode,
      pattern: rule.pattern,
      regex: rule.regex,
      caseSensitive: rule.caseSensitive,
    })),
    routes: settings.routes.map((route) => ({
      pattern: route.pattern,
      regex: route.regex,
      caseSensitive: route.caseSensitive,
      channels: [...route.channels],
    })),
    bark: {
      enabled: settings.bark.enabled,
      group: settings.bark.group,
      level: settings.bark.level,
      sound: settings.bark.sound,
      configured: bark.configured,
      masked: bark.masked,
    },
    cmcc: {
      enabled: settings.cmcc.enabled,
      to: maskRecipient(settings.cmcc.to),
      serverUrl: settings.cmcc.serverUrl,
      uploadUrl: settings.cmcc.uploadUrl,
      version: settings.cmcc.version,
      prefix: settings.cmcc.prefix,
      includeSummary: settings.cmcc.includeSummary,
      configured: cmcc.configured && String(settings.cmcc.to).trim().length > 0,
      keyConfigured: cmcc.configured,
      masked: cmcc.masked,
    },
    local: { ...settings.local },
    webhooks: Object.fromEntries(WEBHOOK_CHANNELS.map((name) => {
      const channel = settings.webhooks[name]
      const security = webhookSecurityOf(name)
      const mask = maskSecret(channel.url)
      const secretMask = maskSecret(channel.secret)
      return [name, {
        enabled: channel.enabled,
        includeSummary: channel.includeSummary,
        configured: mask.configured,
        masked: mask.masked,
        // 自定义关键词 is not a credential — the section shows it back so the user
        // can compare it with what the bot console has. 签名校验 only ever
        // reports whether a key is set, never the key.
        ...(security.keyword === true ? { keyword: channel.keyword ?? '' } : {}),
        ...(security.signature === true
          ? { secretConfigured: secretMask.configured, secretMasked: secretMask.masked }
          : {}),
      }]
    })),
  }
}
