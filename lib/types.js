/**
 * dsh-notify-hub — shared vocabulary.
 *
 * One place for the notification kinds, the settings event flags, the channel
 * identifiers, and the China Mobile「移动新消息」(5G 消息) endpoints. Every other
 * module reads its vocabulary from here so a new event or channel is added
 * once.
 *
 * @module dsh-notify-hub/types
 */

/**
 * Settings flag → notification kind. The settings surface edits camelCase
 * flags; an envelope carries the kebab-case kind the renderers switch on.
 * @type {Readonly<Record<string, string>>}
 */
export const KIND_BY_FLAG = Object.freeze({
  completed: 'completed',
  error: 'error',
  blocked: 'blocked',
  aborted: 'aborted',
  maxTokens: 'max-tokens',
  interrupted: 'interrupted',
  question: 'question',
  approval: 'approval',
  planReview: 'plan-review',
})

/**
 * The settings event flags, in display order (the settings section iterates
 * this list).
 * @type {readonly string[]}
 */
export const EVENT_FLAGS = Object.freeze(Object.keys(KIND_BY_FLAG))

/**
 * Notification kind → settings flag (the inverse of {@link KIND_BY_FLAG}).
 * @type {Readonly<Record<string, string>>}
 */
export const FLAG_BY_KIND = Object.freeze(Object.fromEntries(
  Object.entries(KIND_BY_FLAG).map(([flag, kind]) => [kind, flag]),
))

/**
 * `turn/end` reason kind → settings flag. Reason kinds outside this table
 * (plugin extensions) stay silent rather than guessing an event.
 * @type {Readonly<Record<string, string>>}
 */
export const FLAG_BY_TURN_END_KIND = Object.freeze({
  completed: 'completed',
  error: 'error',
  blocked: 'blocked',
  aborted: 'aborted',
  'max-tokens': 'maxTokens',
  interrupted: 'interrupted',
})

/** Every notification kind, derived from {@link KIND_BY_FLAG}. */
export const NOTIFICATION_KINDS = Object.freeze([...new Set(Object.values(KIND_BY_FLAG))])

/**
 * Presentational metadata per notification kind.
 *
 * `level` is the Bark push level: task completion stays `active`, anything
 * waiting on the human is `timeSensitive`, and a user-initiated abort is
 * `passive` so it does not raise a banner.
 *
 * @type {Readonly<Record<string, { headline: string, headlineEn: string, level: string, urgent: boolean }>>}
 */
export const EVENT_META = Object.freeze({
  completed: { headline: '✅ 任务完成', headlineEn: '✅ Task completed', level: 'active', urgent: false },
  error: { headline: '❌ 执行失败', headlineEn: '❌ Task failed', level: 'timeSensitive', urgent: true },
  blocked: { headline: '🚫 执行被阻塞', headlineEn: '🚫 Task blocked', level: 'timeSensitive', urgent: true },
  aborted: { headline: '⏹ 已中止', headlineEn: '⏹ Task aborted', level: 'passive', urgent: false },
  'max-tokens': { headline: '⚠️ Token 达到上限', headlineEn: '⚠️ Token limit reached', level: 'timeSensitive', urgent: true },
  interrupted: { headline: '⏸ 异常中断', headlineEn: '⏸ Task interrupted', level: 'timeSensitive', urgent: true },
  question: { headline: '❓ 等待你的回答', headlineEn: '❓ Waiting for your answer', level: 'timeSensitive', urgent: true },
  approval: { headline: '🔐 等待你的授权', headlineEn: '🔐 Waiting for approval', level: 'timeSensitive', urgent: true },
  'plan-review': { headline: '📋 计划待确认', headlineEn: '📋 Plan awaiting review', level: 'timeSensitive', urgent: true },
})

/** Tools whose invocation counts as "the agent is waiting on the human". */
export const QUESTION_TOOL = 'ask_user_question'
/** Plan-review tool name. */
export const PLAN_TOOL = 'exit_plan_mode'

/** Webhook channel ids with a first-class payload preset. */
export const WEBHOOK_CHANNELS = Object.freeze([
  'feishu',
  'wecom',
  'dingtalk',
  'slack',
  'discord',
  'custom',
])

/** Every delivery channel the hub can fan out to, in display order. */
export const CHANNEL_IDS = Object.freeze(['bark', 'cmcc', 'local', ...WEBHOOK_CHANNELS])

/** Human labels (zh) for the channel status list. */
export const CHANNEL_LABELS = Object.freeze({
  bark: 'Bark 推送',
  cmcc: '移动新消息',
  local: '桌面通知',
  feishu: '飞书',
  wecom: '企业微信',
  dingtalk: '钉钉',
  slack: 'Slack',
  discord: 'Discord',
  custom: '自定义 Webhook',
})

/** English labels for the same list. */
export const CHANNEL_LABELS_EN = Object.freeze({
  bark: 'Bark',
  cmcc: 'China Mobile 5G message',
  local: 'Desktop notification',
  feishu: 'Feishu',
  wecom: 'WeCom',
  dingtalk: 'DingTalk',
  slack: 'Slack',
  discord: 'Discord',
  custom: 'Custom webhook',
})

/**
 * China Mobile「移动新消息」transport defaults, taken from the reference
 * `cmcc-newmsg` channel's config.json. Both URLs are overridable in settings so
 * a self-hosted gateway works unchanged.
 */
export const CMCC_DEFAULTS = Object.freeze({
  serverUrl: 'wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg',
  uploadUrl: 'https://5gvas01.cmicmaap.com/gtw-ai/openclaw/api',
  version: '2.0',
})

/** Settings namespace owned by this plugin. */
export const SETTINGS_NAMESPACE = 'notify-hub'

/** Loopback RPC channel owned by this plugin. */
export const RPC_CHANNEL = '/dsh-notify-hub'

/** Notification kinds whose body should carry the model's last reply. */
export const TEXT_BEARING_KINDS = Object.freeze(['completed', 'blocked', 'max-tokens'])

/** Bounded default for the delivery history kept in memory for the settings UI. */
export const DEFAULT_HISTORY_LIMIT = 50
