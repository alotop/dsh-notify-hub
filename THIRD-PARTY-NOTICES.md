# Third-party notices

This project is MIT-licensed (see `LICENSE`). Parts of it were written by
adapting MIT-licensed implementations, whose notices are reproduced below as
those licences require. The public-repository audit of this file's subject matter
is described at the end.

## Adapted from [dsh-notify-bark](https://github.com/pc439527/dsh-notify-bark)

**MIT License — Copyright (c) 2026 pc439527**

Used for: the Host-side `session/event` listener shape, the Bark V2 payload
(`title`/`body`/`group`/`level`/`sound`), the secret-masked settings section, and
the `/dsh-notify-*` loopback RPC route pattern (including its reasoning about
mounting on `ctx.webServer` rather than `ctx.connection.rpc.handle()`).

## Adapted from [dsh-notify-center](https://github.com/SingleOne/dsh-notify-center)

**MIT License — Copyright (c) 2026 SingleOne**

Used for: the live turn accumulator and completion gate, the dedupe cache, the
webhook payload presets (Feishu / WeCom / DingTalk / Slack / Discord / custom),
the Windows toast script including its AppUserModelId setter, and the
`osascript` / `notify-send` delivery paths.

## Protocol reference: `@openclaw/cmcc-newmsg-channel`

The 中国移动「移动新消息」(5G 消息) channel implements the wire protocol of that
package: the WebSocket endpoint, the `auth` / `auth_ok` handshake, the
`ping`/`pong` heartbeat intervals, the `{ type: 'send' }` frame, and the
`POST {uploadUrl}/upload` multipart contract with its `code === 10200` success
response. Those are interoperability facts about a third-party service.

**That package ships no licence file and declares no `license` field**, so it is
"all rights reserved" by default. This project therefore does not redistribute it
and does not depend on it: the channel is an independent implementation written
against its observable behaviour, and the Markdown-to-plain-text helper that was
initially adapted from it has since been rewritten in this project's own idiom
(its behaviour is pinned by `tests/channels.test.js`). If you are the rights
holder and want different treatment, please open an issue.

## Everything else

The remaining code — the notification hub and its routing/rule policy, the
delivery history, the settings schema and masking, the capacity table for
provider security features (自定义关键词 / 签名校验 including the HMAC construction),
the migration reader, the packaging and hygiene tooling, and the test suite — was
written for this project.

## Audit note

A public repository makes two classes of mistake permanent: a credential in git
history, and a missing attribution. Both are guarded or documented here:

* `npm run check:hygiene` fails on credential and personal-data shapes in tracked
  files (Bark device keys, 移动新消息 keys, phone numbers, API tokens, private
  keys, JWTs, concrete home paths, email addresses) and on any tracked
  `.env`-family file. Real values belong in `.env` (gitignored), with fake
  placeholders in `.env.example`.
* `npm run pack:check` additionally refuses to publish a `.env`, a `settings.yaml`
  or development material.
