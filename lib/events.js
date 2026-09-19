/**
 * dsh-notify-hub event collector.
 *
 * Turns the `session/event` firehose into notification envelopes. Everything is
 * accumulated from the live stream rather than re-read from the session log:
 * DSH 0.1.5 does not expose `session.events`, and a live fold is also the only
 * way to know how long a turn actually ran.
 *
 * Three concerns live here:
 *   * {@link createEventCollector} — the fold: turn summary, tool list, session
 *     title, and the "the human is being waited on" events;
 *   * {@link createDedupeLedger} — one push per logical event, even across
 *     reloads or a repeated dispatch;
 *   * the completion gate — a turn/end envelope waits for the agent to actually
 *     go idle, so a turn that finishes while a follow-up is still queued does
 *     not fire two banners out of order.
 *
 * @module dsh-notify-hub/events
 */

import { appendBounded, textOfContent, truncate } from './render.js'
import {
  FLAG_BY_KIND,
  FLAG_BY_TURN_END_KIND,
  KIND_BY_FLAG,
  PLAN_TOOL,
  QUESTION_TOOL,
} from './types.js'

/**
 * Last path segment of a session's cwd — the workspace name.
 *
 * Both separators are honoured on every platform: a session header records the
 * path in the form the session was created with, so a Windows path can be read
 * by a Host running on Linux (and vice versa) without the name degrading into
 * the whole path.
 */
export function workspaceNameOf(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.')
    const last = segments.at(-1)
    if (last !== undefined) return last
    return cwd
  }
  return String(session?.id ?? '?')
}

/**
 * Whether a `user/message` is a direct human prompt rather than a synthetic
 * context injection. Unknown shapes are treated as injections so a system
 * reminder never becomes a session title.
 */
function isHumanPrompt(data) {
  const source = data?.source
  if (source === undefined || source === null) return true
  if (typeof source === 'string') return source === 'user'
  if (typeof source === 'object' && typeof source.kind === 'string') return source.kind === 'user'
  return false
}

/** Collapse whitespace so a title stays one line. */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Detail line explaining a non-completed turn reason. */
function reasonDetailOf(reason, locale) {
  if (!reason || typeof reason !== 'object') return undefined
  switch (reason.kind) {
    case 'error': {
      const error = reason.error
      if (error && typeof error === 'object') {
        if (typeof error.message === 'string' && error.message.length > 0) return error.message
        if (typeof error.code === 'string' && error.code.length > 0) return error.code
      }
      return locale === 'en' ? 'the model call failed' : '模型调用失败'
    }
    case 'aborted': {
      const cause = reason.reason?.kind
      const labels = {
        user: 'user cancelled',
        parent: 'parent agent cancelled',
        hook: 'cancelled by a hook',
        disposed: 'session disposed',
        legacy: 'cancelled',
      }
      const label = labels[cause] ?? cause
      if (typeof label !== 'string') return undefined
      return locale === 'en' ? label : {
        'user cancelled': '用户主动中止',
        'parent agent cancelled': '父级 Agent 中止',
        'cancelled by a hook': 'Hook 中止',
        'session disposed': '会话已释放',
        cancelled: '已取消',
      }[label] ?? label
    }
    case 'blocked':
      return locale === 'en' ? 'waiting on something the agent cannot do alone' : '等待你处理后继续'
    case 'max-tokens':
      return locale === 'en' ? 'a step hit its output-token ceiling' : '某一步达到输出 Token 上限'
    case 'interrupted':
      return locale === 'en' ? 'the turn was closed after a crash or reload' : '崩溃或重载后回合被补记结束'
    default:
      return undefined
  }
}

/**
 * Bounded dedup ledger: one entry per notification id, expiring after a window
 * and evicting the oldest beyond a cap.
 * @param {object} [options] - cap, window, clock.
 * @returns {{ accept(key: string): boolean, size(): number, clear(): void }}
 */
export function createDedupeLedger(options = {}) {
  const maxEntries = options.maxEntries ?? 2_000
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1_000
  const now = options.now ?? (() => Date.now())
  /** @type {Map<string, number>} */
  const seen = new Map()

  function prune(timestamp) {
    for (const [key, time] of seen) {
      if (timestamp - time > windowMs) seen.delete(key)
    }
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
  }

  return {
    accept(key) {
      const timestamp = now()
      const previous = seen.get(key)
      if (previous !== undefined && timestamp - previous <= windowMs) return false
      seen.set(key, timestamp)
      prune(timestamp)
      return true
    },
    size: () => seen.size,
    clear: () => seen.clear(),
  }
}

/**
 * Create the collector.
 *
 * @param {object} deps - dependencies.
 * @param {() => object} deps.getSettings - live resolved settings.
 * @param {(envelope: object) => void} deps.emit - hand one envelope to the hub.
 * @param {(sessionId: string) => boolean} [deps.isRootSession] - false for a subagent session that must stay silent.
 * @param {(sessionId: string) => boolean | undefined} [deps.isIdle] - agent idleness; `undefined` when unknown.
 * @param {{ warn(message: string): void }} [deps.logger] - logger.
 * @param {() => number} [deps.now] - clock.
 * @returns {{ handle(session: object, event: object): void, flush(sessionId: string): object[], forget(sessionId: string): void, pendingCount(): number }}
 */
export function createEventCollector(deps) {
  const { getSettings, emit } = deps
  const isRootSession = deps.isRootSession ?? (() => true)
  const isIdle = deps.isIdle ?? (() => undefined)
  const logger = deps.logger ?? console
  const dedupe = createDedupeLedger()

  /** @type {Map<string, { title: string, fallbackTitle: string, active: object | null }>} */
  const sessions = new Map()
  /** @type {Map<string, object[]>} */
  const gate = new Map()

  function stateOf(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { title: '', fallbackTitle: '', active: null }
      sessions.set(sessionId, state)
    }
    return state
  }

  function titleOf(state, sessionId, session) {
    return state.title || state.fallbackTitle || workspaceNameOf(session) || sessionId
  }

  /** Deliver now, or park behind the completion gate until the agent is idle. */
  function dispatch(envelope, sessionId) {
    const idle = isIdle(sessionId)
    if (idle === undefined || idle === true) {
      emit(envelope)
      return
    }
    const queue = gate.get(sessionId) ?? []
    queue.push(envelope)
    if (queue.length > MAX_QUEUED_PER_SESSION) queue.shift()
    gate.set(sessionId, queue)
  }

  function build(kind, sessionId, state, session, extra = {}) {
    return {
      id: extra.id,
      kind,
      flag: FLAG_BY_KIND[kind],
      sessionId,
      turn: extra.turn,
      title: titleOf(state, sessionId, session),
      summary: extra.summary ?? '',
      tools: extra.tools ?? [],
      reason: extra.reason,
      durationMs: extra.durationMs,
      time: extra.time ?? Date.now(),
    }
  }

  function handle(session, event) {
    try {
      if (!session || !event || typeof event.type !== 'string') return
      const sessionId = String(session.id ?? '?')
      if (event.seq !== undefined && !dedupe.accept(`${sessionId}:${event.seq}`)) return
      const state = stateOf(sessionId)
      const settings = getSettings()

      switch (event.type) {
        case 'session/title': {
          const title = oneLine(event.data?.title)
          if (title.length > 0) state.title = title
          return
        }
        case 'user/message': {
          if (state.title.length === 0 && state.fallbackTitle.length === 0 && isHumanPrompt(event.data)) {
            const text = oneLine(textOfContent(event.data?.content))
            if (text.length > 0) state.fallbackTitle = truncate(text, 60)
          }
          return
        }
        case 'turn/start': {
          state.active = {
            turn: event.data?.turn,
            startedAt: Number(event.time) || Date.now(),
            summary: '',
            tools: [],
          }
          return
        }
        case 'assistant/message': {
          const active = state.active
          if (!active || active.turn !== event.data?.turn) return
          if (settings.includeAssistantText === false) return
          active.summary = appendBounded(
            active.summary,
            textOfContent(event.data?.message?.content),
            settings.maxBodyChars,
          )
          return
        }
        case 'tool/call': {
          const active = state.active
          const name = typeof event.data?.name === 'string' ? event.data.name : ''
          if (active && active.turn === event.data?.turn && name.length > 0 && !active.tools.includes(name)) {
            active.tools.push(name)
          }
          if (name === QUESTION_TOOL) {
            const question = parseQuestion(event.data?.arguments)
            if (!isRootSession(sessionId)) return
            emit(build('question', sessionId, state, session, {
              id: `${sessionId}:question:${event.data?.callId ?? event.seq}`,
              summary: question,
              tools: [name],
              turn: event.data?.turn,
              time: event.time,
            }))
          } else if (name === PLAN_TOOL) {
            if (!isRootSession(sessionId)) return
            emit(build('plan-review', sessionId, state, session, {
              id: `${sessionId}:plan:${event.data?.callId ?? event.seq}`,
              summary: settings.locale === 'en'
                ? 'The agent submitted a plan and is waiting for your confirmation'
                : 'Agent 已提交计划，等待你的确认',
              tools: [name],
              turn: event.data?.turn,
              time: event.time,
            }))
          }
          return
        }
        case 'approval/asked': {
          if (!isRootSession(sessionId)) return
          const tool = typeof event.data?.toolName === 'string' && event.data.toolName.length > 0
            ? event.data.toolName
            : ''
          const reason = typeof event.data?.reason === 'string' && event.data.reason.trim().length > 0
            ? event.data.reason.trim()
            : undefined
          const subject = settings.locale === 'en'
            ? (tool ? `tool ${tool} needs authorization` : 'an operation needs authorization')
            : (tool ? `工具 ${tool} 需要授权` : '一个操作需要授权')
          emit(build('approval', sessionId, state, session, {
            id: `${sessionId}:approval:${event.data?.id ?? event.seq}`,
            summary: subject,
            reason,
            tools: tool ? [tool] : [],
            turn: event.data?.turn,
            time: event.time,
          }))
          return
        }
        case 'turn/end': {
          const turn = event.data?.turn
          const reason = event.data?.reason
          const kind = FLAG_BY_TURN_END_KIND[reason?.kind]
          const active = state.active
          const current = active && active.turn === turn ? active : null
          state.active = null
          if (kind === undefined || !isRootSession(sessionId)) return
          const summary = current ? current.summary.trim() : ''
          // Park it behind the completion gate: the agent may still be running
          // (a queued follow-up, a trailing status flip), and firing now would
          // order the banner before the work it describes.
          dispatch(build(KIND_BY_FLAG[kind], sessionId, state, session, {
            id: `${sessionId}:turn:${turn}`,
            turn,
            summary,
            tools: current ? [...current.tools] : [],
            reason: reasonDetailOf(reason, settings.locale),
            durationMs: current && current.startedAt > 0
              ? Math.max(0, (Number(event.time) || Date.now()) - current.startedAt)
              : undefined,
            time: event.time,
          }), sessionId)
          return
        }
        default:
      }
    } catch (error) {
      // A listener throw would surface as a loud event-dispatch failure and no
      // notification at all, so the collector contains its own failures.
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`[notify-hub] collector failed on ${String(event?.type ?? '?')}: ${message}`)
    }
  }

  return {
    handle,
    flush(sessionId) {
      const queue = gate.get(sessionId) ?? []
      gate.delete(sessionId)
      return queue
    },
    forget(sessionId) {
      gate.delete(sessionId)
      sessions.delete(sessionId)
    },
    pendingCount() {
      let total = 0
      for (const queue of gate.values()) total += queue.length
      return total
    },
  }
}

/** Best-effort read of the first question text out of an `ask_user_question` call. */
function parseQuestion(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments.length === 0) return ''
  try {
    const parsed = JSON.parse(rawArguments)
    const first = Array.isArray(parsed?.questions) ? parsed.questions[0] : undefined
    return oneLine(first?.question ?? first?.header ?? '')
  } catch {
    return ''
  }
}

/** The completion gate's queue is private; this exposes the per-session cap for tests. */
export const MAX_QUEUED_PER_SESSION = 20
