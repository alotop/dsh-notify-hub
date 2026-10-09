/**
 * dsh-notify-hub legacy migration.
 *
 * The hub replaces dsh-notify-bark, so the first run adopts an existing Bark
 * endpoint from the old `bark:` section of the same settings document instead of
 * asking the user to paste a credential they already configured. The read is
 * read-only and the resulting value is written into the hub's own section
 * exactly once (see `index.js`); set `migrateLegacyBark: false` to opt out.
 *
 * The parser is deliberately tiny and dependency-free: it only understands the
 * shape the settings file provider writes for a top-level `bark:` block, and it
 * returns nothing rather than guessing when the document looks different.
 *
 * @module dsh-notify-hub/migration
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SETTINGS_NAMESPACE } from './types.js'

/** The settings document the file provider owns. */
export function settingsFilePath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'settings.yaml')
}

/**
 * Every file the hub's own legacy section may live in.
 *
 * DSH 0.2 stopped reading the global `settings.yaml` and, when it imported the
 * sections it could address, it **renamed the file** to `settings.yaml.imported`.
 * A section whose profile entry had no schema at the time — this plugin's, before
 * it declared a Config — was left behind in the renamed file, so the hub reads both.
 *
 * @param {object} [env] - environment (for `DSH_HOME`).
 * @returns {string[]} candidate paths, most current first.
 */
export function settingsFileCandidates(env = process.env) {
  const file = settingsFilePath(env)
  return [file, `${file}.imported`]
}

/**
 * Extract the raw text of one top-level block, including its key line.
 *
 * The result is a valid YAML document on its own (`parse()` yields `{ key: … }`),
 * which is what lets the runtime's own parser do the real work instead of a
 * hand-rolled reader guessing at nesting, quoting and flow styles.
 *
 * @param {string} yamlText - the document.
 * @param {string} key - the top-level key.
 * @returns {string | null} the block, or null when absent.
 */
export function extractSection(yamlText, key) {
  if (typeof yamlText !== 'string' || yamlText.length === 0) return null
  const lines = yamlText.split(/\r?\n/)
  const block = []
  let inside = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inside) {
      if (indentOf(line) === 0 && (trimmed === `${key}:` || trimmed.startsWith(`${key}: `))) {
        inside = true
        block.push(line)
      }
      continue
    }
    // A new top-level key ends the block; blank and indented lines belong to it.
    if (trimmed.length > 0 && indentOf(line) === 0) break
    block.push(line)
  }
  if (!inside) return null
  // Trailing blank lines are separators, not part of the block.
  while (block.length > 1 && block[block.length - 1].trim().length === 0) block.pop()
  return block.join('\n')
}

/**
 * Read the hub's own legacy settings section.
 *
 * The section is exactly what the 0.1.x `ctx.settings` namespace wrote, so its
 * field names match the schema the plugin registers today and can be adopted
 * as-is. Parsing is injected (`yaml` from the runtime) so this module keeps its
 * dependency-free shape and stays testable with a stub.
 *
 * @param {object} [options] - `parseYaml`, `files`, `env`, `logger`.
 * @returns {{ found: boolean, section: object | null, file: string }} the result.
 */
export function loadLegacyNamespace(options = {}) {
  const parse = options.parseYaml
  if (typeof parse !== 'function') return { found: false, section: null, file: '' }
  const files = options.files ?? settingsFileCandidates(options.env)
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const block = extractSection(text, SETTINGS_NAMESPACE)
    if (block === null) continue
    try {
      const parsed = parse(block)
      const section = parsed?.[SETTINGS_NAMESPACE]
      if (section !== null && typeof section === 'object' && !Array.isArray(section)) {
        return { found: true, section, file }
      }
    } catch (error) {
      if (options.logger) {
        options.logger.warn(`[notify-hub] 旧设置段解析失败（${file}）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { found: false, section: null, file: '' }
}

/** Strip a YAML scalar's surrounding quotes and a trailing comment. */
function scalar(raw) {
  let value = String(raw ?? '').trim()
  if (value.length === 0) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  } else {
    const comment = value.search(/\s#/)
    if (comment !== -1) value = value.slice(0, comment).trim()
  }
  return value
}

/** Leading space count of a line. */
function indentOf(line) {
  const match = /^(\s*)/.exec(line)
  return match === null ? 0 : match[1].length
}

/**
 * Pull `bark.barkUrl` out of a settings document.
 *
 * Only a top-level `bark:` block is considered, and the key is searched one
 * level in, which is exactly how the settings service serializes a registered
 * namespace. Anything else (a nested `bark:` under another key, an anchor, a
 * flow map) yields an empty string instead of a wrong value.
 *
 * @param {string} yamlText - the settings document.
 * @returns {string} the legacy Bark endpoint, or '' when absent.
 */
export function readLegacyBarkUrl(yamlText) {
  if (typeof yamlText !== 'string' || yamlText.length === 0) return ''
  const lines = yamlText.split(/\r?\n/)
  let inside = false
  let sectionIndent = 0
  for (const line of lines) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const indent = indentOf(line)
    const trimmed = line.trim()
    if (!inside) {
      if (indent === 0 && /^bark:\s*$/.test(trimmed)) {
        inside = true
        sectionIndent = indent
      } else if (indent === 0 && /^bark:\s+\{/.test(trimmed)) {
        // A flow mapping is not something we can read safely.
        return ''
      }
      continue
    }
    if (indent <= sectionIndent) {
      // The section ended without a barkUrl key.
      inside = false
      continue
    }
    const match = /^barkUrl:\s*(.*)$/.exec(trimmed)
    if (match !== null) return scalar(match[1])
  }
  return ''
}

/**
 * Read the legacy Bark endpoint from the settings document.
 * @param {object} [options] - file override and logger.
 * @returns {{ url: string, file: string, found: boolean }} the migration result.
 */
export function loadLegacyBarkEndpoint(options = {}) {
  const file = options.file ?? settingsFilePath(options.env)
  try {
    const text = readFileSync(file, 'utf8')
    const url = readLegacyBarkUrl(text)
    return { url, file, found: url.length > 0 }
  } catch (error) {
    if (options.logger && error?.code !== 'ENOENT') {
      options.logger.warn(`[notify-hub] 读取旧 Bark 配置失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return { url: '', file, found: false }
  }
}
