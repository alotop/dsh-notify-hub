# dsh-notify-hub

**English** | [简体中文](README.zh-CN.md)

One notification hub for DeepSeek Harness: turn endings, questions, approvals and
plan reviews are pushed to **Bark**, **China Mobile 5G messages（移动新消息）**,
**native desktop notifications**, and **any number of webhooks** — at the same
time, from the Host, so closing the browser changes nothing.

It is a *combination* plugin: it merges the strengths of two reference plugins
and adds a channel neither of them has.

| Capability | Origin |
| --- | --- |
| Host-side `session/event` listener, nine events, Bark pushes (level/group), schema-declared secrets + loopback RPC + settings section | `dsh-notify-bark` |
| Live turn accumulation, completion gate, dedupe, include/exclude content rules, webhook presets (Feishu/WeCom/DingTalk/Slack/Discord/custom), native desktop delivery, timeouts with exponential retries, zh/en rendering | `dsh-notify-center` |
| **China Mobile 5G message channel** — WebSocket long connection, auth handshake, heartbeat, reconnect ladder, rich-media upload | ported from `@openclaw/cmcc-newmsg-channel` |
| **Delivery history**, **channel routes** (split by session/content), one-shot migration of an existing Bark endpoint | new in this plugin |

---

## Features

### Channels

| Channel | Notes |
| --- | --- |
| **Bark** | Official or self-hosted. Group aggregation, push level (active / timeSensitive / passive / critical), custom sound |
| **移动新消息** | China Mobile 5G message. Long-connection push of text and (optionally) rich media |
| **Desktop** | Windows toast (AppUserModelId registered on first use, NotifyIcon balloon fallback), macOS `osascript`, Linux `notify-send` |
| **Feishu / WeCom / DingTalk / Slack / Discord** | Each channel's native `text` payload — paste the group-bot webhook URL. **Feishu also supports the bot's security settings**: custom keyword and signature verification (below) |
| **Custom webhook** | Structured JSON: kind, title, sessionId, turn, durationMs, reason, tools, time |

Every channel is independent: it must be switched on **and** fully configured, or
the section reports it as unconfigured.

### Feishu bot security

A Feishu custom bot offers three security settings; the plugin implements the two
that need the caller's cooperation:

| Feishu console | Setting | Behaviour |
| --- | --- | --- |
| **自定义关键词** (custom keyword) | `Custom keyword` | The message text must contain the keyword or Feishu answers `19024 Key Words Not Found`. A configured keyword is prepended as `[keyword] ` (skipped when the body already contains it) |
| **签名校验** (signature) | `Signature secret` | Every request carries `timestamp` (seconds, string) and `sign`. Algorithm: `stringToSign = timestamp + "\n" + secret`, then `Base64(HMAC-SHA256(key = stringToSign, message = ""))` — the joined string is the **key**, over an **empty** message. The secret stays on the Host; the UI shows a masked status only |
| IP 白名单 (IP allowlist) | — | Needs nothing from the plugin (Feishu sees the source IP); add your proxy's egress IP in the console |

WeCom / DingTalk / Slack / Discord render neither field: those providers either
do not offer it or (DingTalk) sign in the URL query string, which is left for a
later change against the same capability table.

### Events

`completed`, `error`, `blocked`, `aborted`, `max-tokens`, `interrupted`,
`question` (`ask_user_question`), `approval` (`approval/asked`), `plan-review`
(`exit_plan_mode`).

* The body of a turn is **folded live** (assistant text + tool list + duration)
  instead of re-reading the session log — DSH 0.1.5 no longer exposes
  `session.events`.
* **Completion gate**: a `turn/end` notification waits until the agent is
  actually `idle`, so a finishing turn cannot outrun queued follow-up work.
* **Dedupe** keyed by `session:seq` (24 h window, 2000 entries): a reload or a
  repeated dispatch never doubles a push.
* Subagent sessions stay silent by default (switchable).

### Policy

* **Content rules** match title / summary / reason / kind / tool names in order.
  An `exclude` hit stays silent; when `include` rules exist, only hits notify.
  Literal or regex, case sensitivity per rule.
* **Channel routes** split notifications across channels, e.g. "title contains
  deploy → Feishu only", "contains mobile → 移动新消息 only". The first matching
  route wins; with no match every enabled channel is used.
* Locale, body length bound, and whether to append the model's last reply.

### Settings section

Everything is configured in **Settings → 通知集合**:

* live status (platform, desktop backend, delivery-queue occupancy);
* one card per channel — enable switch, write-only credential field with a masked
  status (`••••••••last4`), and a Test button;
* 移动新消息: connection probe (real connect + handshake) and a rich-media test
  (upload a local image, then push it);
* event checkboxes, content options, rule and route editors;
* **recent deliveries** — time, channel, success/failure with a redacted reason,
  plus a clear button.

### Security

* Every credential lives on the Host and is a schema-declared `secret`: the
  browser never receives a value, only a masked status, and can only write new
  ones.
* The section talks over the `/dsh-notify-hub` loopback RPC, reusing
  Connection's Host/Origin fence (401/403), with a 256 KiB body cap and
  allow-list + type validation on every patch.
* Logs and error messages are scrubbed: any configured secret is replaced with
  `[redacted]`, including in the delivery history.

---

## Install

Requires DSH ≥ 0.1.5-rc.2 (web profile). There is no build step: `lib/` holds the
runnable ESM host half and the browser bundle.

### Option A — from npm (recommended)

```powershell
dsh plugin --profile web add @alotop/dsh-notify-hub
```

### Option B — from a tarball (offline / pinned)

```powershell
npm pack                                        # produces alotop-dsh-notify-hub-0.3.0.tgz
dsh plugin --profile web add .\alotop-dsh-notify-hub-0.3.0.tgz
```

> Do not use `link:` to this checkout: Node resolves dependencies from the
> **linked real path**, so the repository's own `node_modules` is invisible to
> the profile and `@deepseek-ai/schemastery` would not resolve at runtime. An npm
> package or a tarball is copied into the profile by pnpm, which is what works.

### Option C — wire it into the web profile by hand

Edit `%USERPROFILE%\.dsh\profiles\web\package.json`:

```jsonc
{
  "dsh": { "profile": { "bundles": [ /* …existing… */ "@alotop/dsh-notify-hub" ] } },
  "dependencies": {
    "@alotop/dsh-notify-hub": "^0.3.0"
  }
}
```

then run `pnpm install` inside `%USERPROFILE%\.dsh\profiles\web`.

### Activate

A new bundle needs a **dsh web restart**; later installs/updates need
`pnpm install` plus a restart (changes to `cordis.patch.yml` itself hot-apply).

---

## Development and release

```powershell
npm ci             # dev/test dependency only (@deepseek-ai/schemastery); DSH supplies it at runtime
npm run check      # client-bundle guard + the whole test suite
npm run pack:check # audit what would be published to npm
```

Publishing is driven by a **tag push** (`.github/workflows/release.yml`):

```powershell
# bump package.json's version, commit, then
git tag v0.3.0 && git push origin v0.3.0
```

The run verifies `tag` ↔ `package.json`, installs with `npm ci`, runs
`npm run check` and `npm run pack:check`, publishes with OIDC Trusted Publishing
and provenance (no npm token is stored in the repository), and creates the GitHub
Release. `ci.yml` runs the same checks on every branch push and pull request and
never publishes.

One-time setup on npmjs.com (package → Settings → Trusted Publisher): repository
`alotop/dsh-notify-hub`, workflow `release.yml`, environment empty. To publish
with a token instead, add an `NPM_TOKEN` secret and pass `registry-url` +
`NODE_AUTH_TOKEN` to setup-node.

### Living with dsh-notify-bark

* On first run, if this plugin's Bark URL is empty, the endpoint is migrated
  **once** from the old `bark:` section of `$DSH_HOME/settings.yaml` (read-only on
  the old file) and a log line says so. Set `migrateLegacyBark: false` to opt out.
* After migrating, remove `dsh-notify-bark` — otherwise each turn pushes twice.

---

## Configuration

The settings section covers everything; the composition layer accepts the same
shape:

```yaml
- insert:
    - id: notify-hub
      name: dsh-notify-hub
      config:
        locale: zh
        notifySubagents: false
        events: { completed: true, error: true, aborted: false, planReview: false }
        bark: { enabled: true, url: 'https://api.day.app/yourKey', group: DSH, level: active }
        local: { enabled: true, sound: true }
        cmcc:
          enabled: true
          apiKey: ak_xxxx
          to: '13800138000'
          prefix: DSH
        webhooks:
          feishu: { enabled: true, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx' }
        delivery: { timeoutMs: 5000, retries: 2, retryBaseMs: 500 }
        rules:
          - { mode: exclude, pattern: 'heartbeat check' }
        routes:
          - { pattern: mobile, channels: [cmcc] }
```

Credential fields may equally live only in `$DSH_HOME/settings.yaml` (where the
section writes them): values resolve schema defaults → composition base → user
layer.

---

## 移动新消息 (China Mobile 5G message) protocol

Ported from the `@openclaw/cmcc-newmsg-channel` reference; endpoints default to
its `config.json`:

```
WebSocket : wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg
Upload    : https://5gvas01.cmicmaap.com/gtw-ai/openclaw/api/upload
Version   : 2.0
```

* **Connect** — the `ws` package is preferred (it can carry the `X-API-Key`
  handshake header); Node ≥ 22's built-in WebSocket is the fallback. Both paths
  send `{ type: 'auth', apiKey, version }` and wait up to 10 s for `auth_ok`.
* **Heartbeat** — `{ type: 'ping' }` every 15 s; a missing `pong` within 10 s
  drops the socket.
* **Reconnect** — exponential backoff 3 s → 60 s with ±10 % jitter.
* **Text** — `{ type: 'send', apiKey, to, content, messageId }`; the body is
  flattened from Markdown first (`**bold**`, `` `code` ``, list markers, …).
* **Rich media** — `POST {uploadUrl}/upload` (multipart: `file` + `apiKey`)
  returning `{ code: 10200, data: mediaUrl }`, then
  `{ type: 'send', apiKey, to, mediaType, mediaUrl, content, messageId, … }`.
  The section's "Send image" button exercises exactly this path.
* Outbound only: inbound messages are not consumed (a notification hub does not
  need them).

---

## Architecture

```
lib/
  index.js             host entry: settings namespace, agent integration, listener, hub, RPC
  types.js             event/channel vocabulary (kinds, flags, channel ids, cmcc defaults)
  settings.js          notify-hub schema, defaults, rule compilation, masked views
  events.js            live event folding + dedupe ledger + completion gate
  policy.js            event flags → content rules → channel routes
  render.js            local / text / Bark rendering + Markdown flattening
  hub.js               fan-out, in-flight bound, delivery accounting
  history.js           bounded delivery history for the section
  status.js            browser-safe channel status projection
  migration.js         one-shot adoption of the legacy `bark:` section
  rpc-contract.js      /dsh-notify-hub contract + patch validation/normalization
  rpc.js               loopback RPC route (client-request / server-response)
  channels/
    http.js            shared POST + timeout + retry ladder + secret redaction
    bark.js            Bark V2
    webhook.js         six webhook presets
    local.js           Windows toast / osascript / notify-send
    cmcc.js            移动新消息 long-connection channel
  client.js            browser half: module-loader bundle + settings section
```

The host half only imports Node builtins and `@deepseek-ai/schemastery` (peer);
the client bundle uses only the shell-seeded `react` and
`@deepseek-ai/dsh-client-store`.

---

## Tests

```powershell
npm test          # 10 files / 103 cases, run serially (sandbox-friendly)
npm run check     # client-bundle guard, then the suite
```

Covered: settings schema and masked views, event folding and the completion
gate, rules and routes, HTTP retries and redaction, Bark/webhook payloads,
Windows toast script escaping, 移动新消息 handshake/send/heartbeat/reconnect/upload,
hub fan-out and history, RPC validation, **real loading and rendering of the
client bundle**, and a set of `apply()`-level end-to-end cases (listener →
collector → hub → RPC read-back).

---

## Known limitations

* Windows desktop notifications run through `powershell.exe`. The script is written
  to a temp `.ps1` and launched with `-File`, so **nothing is piped into the
  child** — that form works even where a sandbox forbids pipes or extra process
  handles. A policy that blocks WinRT toasts falls back to a NotifyIcon balloon.
* Rich media needs a gateway that serves `/upload`; failures surface the server's
  own reason in the section.
* 移动新消息 is outbound-only; replies from the phone are not consumed.
* The section's image test needs an **absolute local path** (the host reads it).

## Credits

* [dsh-notify-bark](https://github.com/pc439527/dsh-notify-bark) (MIT) — host-side
  listener, Bark push, secret-masked section, and the loopback RPC shape.
* [dsh-notify-center](https://github.com/SingleOne/dsh-notify-center) (MIT) —
  event accumulation, completion gate, content rules, webhook presets, and
  cross-platform desktop delivery.
* `@openclaw/cmcc-newmsg-channel` — the China Mobile 5G message transport.

## License

MIT
