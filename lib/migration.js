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

/** The settings document the file provider owns. */
export function settingsFilePath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'settings.yaml')
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
