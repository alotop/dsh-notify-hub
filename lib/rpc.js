/**
 * dsh-notify-hub loopback RPC.
 *
 * Mounts `/dsh-notify-hub` — the channel the settings section talks to.
 *
 * The channel is mounted as an ordinary `ctx.webServer` route rather than
 * through `ctx.connection.rpc.handle()`: HostConnectionService.register()
 * mounts a channel inside the *connection plugin's* fiber, so a plugin that is
 * not its child can never satisfy `webServer` (the route is never mounted and
 * the browser sees `HTTP 405` from the static fallback). Mounting on
 * `webServer` keeps the exact wire contract the browser transport expects — a
 * POSTed `client-request` envelope answered with a `server-response` envelope —
 * while the Host/Origin fence still applies through
 * `connection.requestRejection`. (Same reasoning as dsh-notify-bark.)
 *
 * @module dsh-notify-hub/rpc
 */

import { settingsView } from './settings.js'
import { describeStatus } from './status.js'
import {
  HUB_ENDPOINTS,
  HUB_RPC_CHANNEL,
  err,
  normalizePatch,
  ok,
  validatePatch,
} from './rpc-contract.js'

/** Request-body cap: every payload here is a settings patch or a test trigger. */
const MAX_BODY_BYTES = 256 * 1024

/** Write one JSON response (the shape the browser transport parses). */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Buffer the request body, returning undefined when it exceeds the cap. */
async function readBody(req) {
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.byteLength
    if (received > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** The endpoint segment of one request below the channel prefix, if any. */
function endpointFrom(url) {
  const pathname = new URL(url ?? '/', 'http://dsh.internal').pathname
  if (!pathname.startsWith(`${HUB_RPC_CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(HUB_RPC_CHANNEL.length + 1)
  return endpoint.includes('/') ? undefined : endpoint
}

/**
 * Answer one channel request: apply the connection fence, decode the
 * `client-request` envelope, dispatch, and encode the `server-response`.
 */
async function serve(req, res, handler, requestRejection) {
  const rejection = requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end('method not allowed')
    return
  }
  const endpoint = endpointFrom(req.url)
  if (endpoint === undefined || !HUB_ENDPOINTS.includes(endpoint)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const raw = await readBody(req)
  if (raw === undefined) {
    res.writeHead(413)
    res.end('request body too large')
    return
  }
  let envelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const message = envelope
  if (
    typeof message !== 'object' || message === null
    || message.type !== 'client-request' || typeof message.rpcId !== 'string'
  ) {
    res.writeHead(400)
    res.end('invalid client-request message')
    return
  }
  if (message.method !== endpoint) {
    writeJson(res, 200, {
      type: 'server-response',
      rpcId: message.rpcId,
      result: err(`method ${JSON.stringify(String(message.method))} does not match endpoint ${JSON.stringify(endpoint)}`),
    })
    return
  }
  const result = await handler(endpoint, message.payload)
  writeJson(res, 200, { type: 'server-response', rpcId: message.rpcId, result })
}

/**
 * Register the plugin's RPC channel. Injected through `ctx.inject` so a profile
 * without a web server (a headless CLI, say) still runs the notification
 * listener and every channel.
 *
 * @param {object} ctx - cordis plugin context.
 * @param {object} deps - live plugin state.
 * @param {() => object} deps.getSettings - resolved settings.
 * @param {(patch: object) => Promise<void>} deps.update - persist a patch.
 * @param {object} deps.hub - the delivery hub.
 * @param {object} deps.cmcc - 移动新消息 channel.
 * @param {object} deps.history - delivery history.
 * @param {{ warn(message: string): void }} [deps.logger] - logger.
 */
export function registerHubRpc(ctx, deps) {
  const logger = deps.logger ?? console

  async function handle(endpoint, payload) {
    try {
      switch (endpoint) {
        case 'get': {
          const settings = deps.getSettings()
          return ok({
            settings: settingsView(settings),
            status: describeStatus(settings, deps.cmcc, { inFlight: deps.hub.inFlightCount() }),
            history: deps.history.list(),
          })
        }
        case 'set': {
          const patch = payload?.patch
          const verdict = validatePatch(patch)
          if (verdict.message !== undefined) return err(verdict.message)
          await deps.update(normalizePatch(patch))
          return ok({ saved: true })
        }
        case 'test': {
          const channel = typeof payload?.channel === 'string' && payload.channel.length > 0
            ? payload.channel
            : 'all'
          if (channel === 'cmcc-media') {
            const mediaPath = typeof payload?.mediaPath === 'string' ? payload.mediaPath.trim() : ''
            if (mediaPath.length === 0) return err('请填写要发送的本地图片/文件路径')
            const result = await deps.cmcc.sendMediaFile(mediaPath, {
              caption: typeof payload?.caption === 'string' ? payload.caption : '',
              to: typeof payload?.recipient === 'string' && payload.recipient.trim().length > 0
                ? payload.recipient.trim()
                : undefined,
            })
            return ok({ results: [{ channel: 'cmcc-media', ok: true, detail: result.mediaUrl }] })
          }
          const result = await deps.hub.test(channel)
          return ok(result)
        }
        case 'probe': {
          const status = await deps.cmcc.probe()
          return ok(status)
        }
        case 'clearHistory': {
          deps.history.clear()
          return ok({ cleared: true })
        }
        default:
          return err(`unknown endpoint: ${String(endpoint)}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`[notify-hub] rpc ${String(endpoint)} failed: ${message}`)
      return err(message)
    }
  }

  ctx.inject(['connection', 'webServer'], (sctx) => {
    const webServer = sctx.webServer
    sctx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: HUB_RPC_CHANNEL,
        handler: (req, res) => serve(
          req,
          res,
          handle,
          (request) => sctx.connection.requestRejection(request),
        ),
      })
      return () => {
        dispose()
      }
    }, 'notify-hub: rpc route')
  })
}
