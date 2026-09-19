/**
 * dsh-notify-hub RPC contract.
 *
 * The browser talks to the Host exclusively through `/dsh-notify-hub`. No
 * credential value ever crosses the wire: the section reads masked status and
 * writes new values only, so a compromised page can overwrite a credential but
 * can never read one back.
 *
 * @module dsh-notify-hub/rpc-contract
 */

import {
  BARK_LEVELS,
  LOCALES,
  sanitizeBarkUrl,
  sanitizeEndpoint,
  webhookSecurityOf,
} from './settings.js'
import { EVENT_FLAGS, WEBHOOK_CHANNELS } from './types.js'

/** Logical RPC channel owned by this plugin. */
export const HUB_RPC_CHANNEL = '/dsh-notify-hub'

/** Endpoints on the channel. */
export const HUB_ENDPOINTS = Object.freeze(['get', 'set', 'test', 'probe', 'clearHistory'])

/** Top-level fields a `set` patch may carry. */
export const PATCH_FIELDS = Object.freeze([
  'enabled',
  'locale',
  'notifySubagents',
  'includeAssistantText',
  'maxBodyChars',
  'historyLimit',
  'migrateLegacyBark',
  'events',
  'bark',
  'local',
  'cmcc',
  'webhooks',
  'delivery',
  'rules',
  'routes',
])

/** Success branch helper. */
export function ok(value) {
  return { ok: true, value }
}

/** Error branch helper. */
export function err(message) {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate that every key of `value` is allowed and each has the right shape. */
function validateFields(value, spec, prefix) {
  if (!isPlainObject(value)) return `${prefix} must be an object`
  for (const [key, field] of Object.entries(value)) {
    const check = spec[key]
    if (check === undefined) return `${prefix}.${key} is not a recognized field`
    const message = check(field, `${prefix}.${key}`)
    if (message !== undefined) return message
  }
  return undefined
}

const checkBoolean = (value, path) => (typeof value === 'boolean' ? undefined : `${path} must be a boolean`)
const checkString = (value, path) => (typeof value === 'string' ? undefined : `${path} must be a string`)
const checkNumber = (value, path) => (typeof value === 'number' && Number.isFinite(value) ? undefined : `${path} must be a finite number`)
const checkArray = (value, path) => (Array.isArray(value) ? undefined : `${path} must be an array`)

/** Validate one rule/route entry, optionally with the route-only channel list. */
function validateMatcherEntry(entry, path, allowMode, extraSpec) {
  if (!isPlainObject(entry)) return `${path} must be an object`
  const spec = {
    pattern: (value, at) => (typeof value === 'string' && value.trim().length > 0 ? undefined : `${at} must be a non-empty string`),
    regex: checkBoolean,
    caseSensitive: checkBoolean,
    ...(extraSpec ?? {}),
  }
  if (allowMode) spec.mode = (value, at) => (value === 'include' || value === 'exclude' ? undefined : `${at} must be include or exclude`)
  return validateFields(entry, spec, path)
}

const EVENTS_SPEC = Object.fromEntries(EVENT_FLAGS.map((flag) => [flag, checkBoolean]))
const BARK_SPEC = {
  enabled: checkBoolean,
  url: checkString,
  group: checkString,
  sound: checkString,
  level: (value, path) => (BARK_LEVELS.includes(value) ? undefined : `${path} must be one of ${BARK_LEVELS.join('/')}`),
}
const LOCAL_SPEC = { enabled: checkBoolean, sound: checkBoolean }
const CMCC_SPEC = {
  enabled: checkBoolean,
  apiKey: checkString,
  to: checkString,
  serverUrl: checkString,
  uploadUrl: checkString,
  version: checkString,
  prefix: checkString,
  includeSummary: checkBoolean,
}
const DELIVERY_SPEC = { timeoutMs: checkNumber, retries: checkNumber, retryBaseMs: checkNumber }

/**
 * The accepted fields of one webhook channel, including the provider security
 * fields that channel supports (自定义关键词 / 签名校验).
 * @param {string} name - webhook channel id.
 * @returns {Record<string, (value: unknown, path: string) => string | undefined>} the field spec.
 */
function webhookSpec(name) {
  const security = webhookSecurityOf(name)
  return {
    enabled: checkBoolean,
    url: checkString,
    includeSummary: checkBoolean,
    ...(security.keyword === true ? { keyword: checkString } : {}),
    ...(security.signature === true ? { secret: checkString } : {}),
  }
}

/**
 * Validate one `set` patch, rejecting unknown fields and wrong types before
 * anything reaches the settings service.
 * @param {unknown} patch - the candidate patch.
 * @returns {{ message?: string }} the verdict; `message` is set on rejection.
 */
export function validatePatch(patch) {
  if (!isPlainObject(patch)) return { message: 'patch must be an object' }
  if (Object.keys(patch).length === 0) return { message: 'patch must not be empty' }
  return {
    message: validateFields(patch, {
      enabled: checkBoolean,
      locale: (value, path) => (LOCALES.includes(value) ? undefined : `${path} must be zh or en`),
      notifySubagents: checkBoolean,
      includeAssistantText: checkBoolean,
      maxBodyChars: checkNumber,
      historyLimit: checkNumber,
      migrateLegacyBark: checkBoolean,
      events: (value, path) => validateFields(value, EVENTS_SPEC, path),
      bark: (value, path) => validateFields(value, BARK_SPEC, path),
      local: (value, path) => validateFields(value, LOCAL_SPEC, path),
      cmcc: (value, path) => validateFields(value, CMCC_SPEC, path),
      delivery: (value, path) => validateFields(value, DELIVERY_SPEC, path),
      webhooks: (value, path) => {
        if (!isPlainObject(value)) return `${path} must be an object`
        for (const [name, channel] of Object.entries(value)) {
          if (!WEBHOOK_CHANNELS.includes(name)) return `${path}.${name} is not a supported webhook channel`
          const message = validateFields(channel, webhookSpec(name), `${path}.${name}`)
          if (message !== undefined) return message
        }
        return undefined
      },
      rules: (value, path) => {
        if (!Array.isArray(value)) return `${path} must be an array`
        for (const [index, entry] of value.entries()) {
          const message = validateMatcherEntry(entry, `${path}[${index}]`, true)
          if (message !== undefined) return message
        }
        return undefined
      },
      routes: (value, path) => {
        if (!Array.isArray(value)) return `${path} must be an array`
        for (const [index, entry] of value.entries()) {
          const message = validateMatcherEntry(entry, `${path}[${index}]`, false, {
            channels: (channels, at) => {
              if (!Array.isArray(channels)) return `${at} must be an array`
              for (const id of channels) {
                if (typeof id !== 'string') return `${at} must contain strings`
              }
              return undefined
            },
          })
          if (message !== undefined) return message
        }
        return undefined
      },
    }, 'patch'),
  }
}

/**
 * Normalize a validated patch before it is persisted: secrets and recipients are
 * trimmed, endpoints lose their trailing slash, and rules/routes collapse to the
 * documented fields (so the stored section stays exactly what the schema allows).
 * @param {object} patch - a patch that already passed {@link validatePatch}.
 * @returns {object} a fresh normalized patch.
 */
export function normalizePatch(patch) {
  const output = { ...patch }
  if (isPlainObject(output.bark)) {
    const bark = { ...output.bark }
    if (typeof bark.url === 'string') bark.url = sanitizeBarkUrl(bark.url)
    if (typeof bark.group === 'string') bark.group = bark.group.trim()
    if (typeof bark.sound === 'string') bark.sound = bark.sound.trim()
    output.bark = bark
  }
  if (isPlainObject(output.cmcc)) {
    const cmcc = { ...output.cmcc }
    if (typeof cmcc.apiKey === 'string') cmcc.apiKey = cmcc.apiKey.trim()
    if (typeof cmcc.to === 'string') cmcc.to = cmcc.to.trim()
    if (typeof cmcc.serverUrl === 'string') cmcc.serverUrl = sanitizeEndpoint(cmcc.serverUrl)
    if (typeof cmcc.uploadUrl === 'string') cmcc.uploadUrl = sanitizeEndpoint(cmcc.uploadUrl)
    if (typeof cmcc.version === 'string') cmcc.version = cmcc.version.trim()
    if (typeof cmcc.prefix === 'string') cmcc.prefix = cmcc.prefix.trim()
    output.cmcc = cmcc
  }
  if (isPlainObject(output.webhooks)) {
    output.webhooks = Object.fromEntries(Object.entries(output.webhooks).map(([name, channel]) => {
      const next = { ...channel }
      if (typeof next.url === 'string') next.url = next.url.trim()
      if (typeof next.keyword === 'string') next.keyword = next.keyword.trim()
      if (typeof next.secret === 'string') next.secret = next.secret.trim()
      return [name, next]
    }))
  }
  if (Array.isArray(output.rules)) {
    output.rules = output.rules.map((rule) => ({
      mode: rule.mode ?? 'include',
      pattern: String(rule.pattern).trim(),
      regex: rule.regex === true,
      caseSensitive: rule.caseSensitive === true,
    }))
  }
  if (Array.isArray(output.routes)) {
    output.routes = output.routes.map((route) => ({
      pattern: String(route.pattern).trim(),
      regex: route.regex === true,
      caseSensitive: route.caseSensitive === true,
      channels: Array.isArray(route.channels) ? [...route.channels] : [],
    }))
  }
  return output
}
