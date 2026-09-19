/**
 * dsh-notify-hub text rendering.
 *
 * One envelope is rendered per channel flavor: a plain multi-line body for
 * webhooks and 移动新消息, a title/body pair for desktop notifications, and a
 * Bark payload. Locale controls the headline language; every other line is
 * user/agent content and stays verbatim.
 *
 * @module dsh-notify-hub/render
 */

import { EVENT_META } from './types.js'

/** Headline for one kind in the requested locale. */
export function headlineOf(kind, locale = 'zh') {
  const meta = EVENT_META[kind] ?? { headline: '🔔 通知', headlineEn: '🔔 Notification' }
  return locale === 'en' ? meta.headlineEn : meta.headline
}

/** Bark push level for one kind (settings override wins). */
export function levelOf(kind, fallback = 'active') {
  return EVENT_META[kind]?.level ?? fallback
}

/** Human-readable duration. */
export function formatDuration(durationMs, locale = 'zh') {
  const seconds = Math.max(0, Math.round(Number(durationMs) / 1_000))
  if (seconds < 60) return locale === 'en' ? `${seconds}s` : `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (locale === 'en') return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
}

/**
 * Truncate on a character bound, appending an ellipsis only when it cut.
 * @param {string} text - input.
 * @param {number} max - maximum characters.
 * @returns {string} the bounded text.
 */
export function truncate(text, max) {
  const value = String(text ?? '')
  const bound = Number.isFinite(max) && max > 0 ? Math.floor(max) : value.length
  return value.length > bound ? `${value.slice(0, Math.max(0, bound - 1))}…` : value
}

/**
 * Append a trimmed block to an accumulating summary, honoring a character
 * bound. Empty input and an already-full buffer are no-ops, so repeated
 * assistant messages keep the earliest content.
 * @param {string} current - accumulated text.
 * @param {string} value - new block.
 * @param {number} maxChars - character bound.
 * @returns {string} the updated accumulation.
 */
export function appendBounded(current, value, maxChars) {
  const normalized = String(value ?? '').trim()
  if (normalized.length === 0 || current.length >= maxChars) return current
  const combined = current.length > 0 ? `${current}\n${normalized}` : normalized
  return combined.length <= maxChars ? combined : `${combined.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Flatten model message content blocks into plain text.
 * @param {unknown} content - a content block array (or a plain string).
 * @returns {string} concatenated text blocks.
 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let output = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text === 'string') output += block.text
  }
  return output
}

/**
 * Markdown constructs that survive as literal noise on an SMS-like transport
 * (移动新消息 prints the markers verbatim), as `[search, replacement]` pairs.
 *
 * Two tables rather than one list: block rules are anchored to line starts and
 * must run after the inline rules have flattened their contents, which is also
 * what keeps the ordering obvious to a reader.
 */
const INLINE_MARKDOWN_RULES = [
  [/`([^`]+)`/g, '$1'],
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  [/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1'],
  [/(?<!_)_([^_]+)_(?!_)/g, '$1'],
  [/\[([^\]]+)\]\([^)]+\)/g, '$1'],
  [/!\[([^\]]*)\]\([^)]+\)/g, '$1'],
  [/~~([^~]+)~~/g, '$1'],
]

const BLOCK_MARKDOWN_RULES = [
  [/^#{1,6}\s+/gm, ''],
  [/^#{3,6}(.?)/gm, '$1'],
  [/^\[[^\]]+\]\s*/gm, ''],
  [/^[ \t]*[-*]\s+/gm, '• '],
  [/^[ \t]*\d+\.\s+/gm, '• '],
  [/^>\s*/gm, ''],
  [/^(-{3,}|\*{3,}|_{3,})\s*$/gm, ''],
]

/**
 * Replace a fenced code block with its bare contents.
 *
 * The fence line is dropped together with its info string, so “```ts” cannot
 * reach a phone as a stray “ts” line above the code.
 */
function unwrapCodeFence(markdown) {
  return markdown.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code) => code.trim())
}

/**
 * Reduce Markdown to plain text for SMS-like transports.
 *
 * Written for this project against the Markdown constructs a model actually
 * emits; the exposed behaviour is pinned by `tests/channels.test.js`.
 *
 * @param {string} markdown - source text.
 * @returns {string} plain text.
 */
export function markdownToPlainText(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return ''
  let text = unwrapCodeFence(markdown)
  for (const [pattern, replacement] of INLINE_MARKDOWN_RULES) text = text.replace(pattern, replacement)
  for (const [pattern, replacement] of BLOCK_MARKDOWN_RULES) text = text.replace(pattern, replacement)
  // Collapse the runs of blank lines the removals above leave behind.
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The shared detail lines of one envelope (everything below the headline).
 * @param {object} envelope - notification envelope.
 * @param {object} [options] - rendering options.
 * @returns {string[]} detail lines, empty strings removed.
 */
export function detailLines(envelope, options = {}) {
  const locale = options.locale ?? 'zh'
  const includeSummary = options.includeSummary !== false
  const includeReason = options.includeReason !== false
  const includeDuration = options.includeDuration !== false
  const lines = [envelope.title]
  if (includeSummary && envelope.summary) lines.push(envelope.summary)
  if (includeReason && envelope.reason) {
    lines.push(locale === 'en' ? `Reason: ${envelope.reason}` : `原因：${envelope.reason}`)
  }
  if (includeDuration && envelope.durationMs !== undefined && envelope.durationMs !== null) {
    lines.push(locale === 'en'
      ? `Duration: ${formatDuration(envelope.durationMs, locale)}`
      : `耗时：${formatDuration(envelope.durationMs, locale)}`)
  }
  if (includeSummary && Array.isArray(envelope.tools) && envelope.tools.length > 0) {
    lines.push(locale === 'en' ? `Tools: ${envelope.tools.join(', ')}` : `工具：${envelope.tools.join('、')}`)
  }
  return lines.filter((line) => typeof line === 'string' && line.trim().length > 0)
}

/**
 * Plain multi-line text for webhook and 移动新消息 delivery.
 * @param {object} envelope - notification envelope.
 * @param {object} [options] - locale, includeSummary, prefix, includeSession.
 * @returns {string} the rendered body.
 */
export function renderText(envelope, options = {}) {
  const locale = options.locale ?? 'zh'
  const headline = headlineOf(envelope.kind, locale)
  const prefix = typeof options.prefix === 'string' && options.prefix.trim().length > 0
    ? `[${options.prefix.trim()}] `
    : ''
  const lines = [`${prefix}【${headline}】`]
  lines.push(...detailLines(envelope, options))
  if (options.includeSession) {
    lines.push(locale === 'en' ? `Session: ${envelope.sessionId}` : `会话：${envelope.sessionId}`)
  }
  const body = lines.join('\n')
  return options.plain === true ? markdownToPlainText(body) : body
}

/**
 * Title/body pair for native desktop notifications.
 * @param {object} envelope - notification envelope.
 * @param {object} [options] - locale and summary toggle.
 * @returns {{ title: string, body: string }}
 */
export function renderLocal(envelope, options = {}) {
  const locale = options.locale ?? 'zh'
  return {
    title: headlineOf(envelope.kind, locale),
    body: detailLines(envelope, options).join('\n'),
  }
}

/**
 * Bark V2 payload for one envelope.
 * @param {object} envelope - notification envelope.
 * @param {object} settings - resolved hub settings.
 * @param {object} [options] - locale/summary override.
 * @returns {{ title: string, body: string, group: string, level: string, sound?: string }}
 */
export function renderBarkPayload(envelope, settings, options = {}) {
  const locale = options.locale ?? settings.locale ?? 'zh'
  const headline = headlineOf(envelope.kind, locale)
  const lines = detailLines(envelope, {
    locale,
    includeSummary: options.includeSummary ?? true,
  })
  const body = truncate(lines.join('\n'), settings.maxBodyChars)
  const payload = {
    title: headline,
    body,
    group: settings.bark.group,
    level: settings.bark.level && settings.bark.level !== 'active'
      ? settings.bark.level
      : levelOf(envelope.kind, settings.bark.level || 'active'),
  }
  const sound = String(settings.bark.sound ?? '').trim()
  if (sound.length > 0) payload.sound = sound
  return payload
}
