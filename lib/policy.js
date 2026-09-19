/**
 * dsh-notify-hub delivery policy.
 *
 * Two independent filters run before anything leaves the machine:
 *   1. event flags + include/exclude content rules decide *whether* an event
 *      notifies at all (lifted from dsh-notify-center);
 *   2. channel routes decide *where* it goes — the first matching route
 *      narrows the fan-out to its channel list, so "session A → my phone only,
 *      session B → the team webhook" is one pattern instead of two plugins.
 *
 * @module dsh-notify-hub/policy
 */

/**
 * The text one rule matches against: everything a user could reasonably want
 * to filter on, joined into one haystack.
 * @param {object} envelope - notification envelope.
 * @returns {string} the rule subject.
 */
export function ruleSubject(envelope) {
  return [
    envelope.title,
    envelope.summary,
    envelope.reason ?? '',
    envelope.kind,
    Array.isArray(envelope.tools) ? envelope.tools.join(' ') : '',
  ].filter(Boolean).join('\n')
}

/**
 * Whether one compiled rule matches a subject.
 * @param {object} rule - compiled rule (with `expression` when regex).
 * @param {string} subject - haystack.
 * @returns {boolean} match result.
 */
export function ruleMatches(rule, subject) {
  if (rule.expression) return rule.expression.test(subject)
  const haystack = rule.caseSensitive ? subject : subject.toLowerCase()
  const needle = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase()
  return haystack.includes(needle)
}

/**
 * Apply the include/exclude rule list. Excludes always win; an empty include
 * list means "everything not excluded".
 * @param {readonly object[]} rules - compiled rules.
 * @param {string} subject - haystack.
 * @returns {boolean} whether delivery is allowed.
 */
export function rulesAllow(rules, subject) {
  const list = Array.isArray(rules) ? rules : []
  const includes = list.filter((rule) => rule.mode === 'include')
  const excludes = list.filter((rule) => rule.mode === 'exclude')
  if (excludes.some((rule) => ruleMatches(rule, subject))) return false
  return includes.length === 0 || includes.some((rule) => ruleMatches(rule, subject))
}

/**
 * Event-flag gate: does this notification kind notify at all?
 * @param {object} settings - resolved settings.
 * @param {object} envelope - notification envelope.
 * @returns {boolean} whether the enabled flags allow this kind.
 */
export function eventsAllow(settings, envelope) {
  const flag = envelope.flag
  if (typeof flag !== 'string') return false
  return settings.events?.[flag] === true
}

/**
 * The complete pre-delivery gate.
 * @param {object} settings - resolved settings.
 * @param {object} envelope - notification envelope.
 * @returns {boolean} whether the envelope should be delivered.
 */
export function shouldNotify(settings, envelope) {
  if (settings.enabled !== true) return false
  if (!eventsAllow(settings, envelope)) return false
  return rulesAllow(settings.rules, ruleSubject(envelope))
}

/**
 * Narrow the fan-out to the channels a route selects.
 *
 * The first matching route wins (routes are an ordered allow-list); when no
 * route matches, every candidate channel is delivered to. Channel ids a route
 * names but the hub does not serve are dropped rather than silently widening
 * the fan-out.
 *
 * @param {readonly object[]} routes - compiled routes.
 * @param {object} envelope - notification envelope.
 * @param {readonly string[]} candidates - channels enabled by settings.
 * @returns {string[]} the channels to deliver to.
 */
export function routeChannels(routes, envelope, candidates) {
  const allowed = new Set(candidates)
  if (!Array.isArray(routes) || routes.length === 0) return [...candidates]
  const subject = ruleSubject(envelope)
  for (const route of routes) {
    if (!ruleMatches(route, subject)) continue
    const selected = (route.channels ?? []).filter((id) => allowed.has(id))
    return selected
  }
  return [...candidates]
}
