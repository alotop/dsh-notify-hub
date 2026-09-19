/**
 * dsh-notify-hub delivery history.
 *
 * A bounded, in-memory ring of the last N delivery attempts per channel. It
 * exists so the settings section can answer "did that actually go out?" without
 * asking the user to open a terminal — the failure mode both reference plugins
 * left invisible.
 *
 * @module dsh-notify-hub/history
 */

/**
 * @typedef {object} DeliveryRecord
 * @property {number} time - epoch ms of the attempt.
 * @property {string} id - envelope id.
 * @property {string} kind - notification kind.
 * @property {string} channel - channel id.
 * @property {string} title - session/workspace title.
 * @property {boolean} ok - whether delivery succeeded.
 * @property {string} [error] - failure detail (secrets already redacted).
 * @property {number} [durationMs] - attempt wall time.
 * @property {string} [source] - 'event' | 'test'.
 */

/**
 * Create the bounded delivery history.
 * @param {() => number} limitOf - live history limit thunk (0 disables recording).
 * @returns {{ record(entry: DeliveryRecord): void, list(): DeliveryRecord[], clear(): void, size(): number }}
 */
export function createHistory(limitOf = () => 50) {
  /** @type {DeliveryRecord[]} */
  let entries = []

  function limit() {
    const value = Number(limitOf())
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }

  return {
    record(entry) {
      const bound = limit()
      if (bound === 0) return
      entries.push({ ...entry })
      if (entries.length > bound) entries = entries.slice(entries.length - bound)
    },
    /** Newest first — the order the settings section renders. */
    list() {
      return [...entries].reverse()
    },
    clear() {
      entries = []
    },
    size() {
      return entries.length
    },
  }
}
