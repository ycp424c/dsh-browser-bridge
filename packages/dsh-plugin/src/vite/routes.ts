/**
 * Vite host routes: one cross-origin health endpoint and same-origin-only
 * target listing and grant issuance, plus the page WebSocket route. Health
 * echoes the exact validated request origin and never sets credentials;
 * targets and grants require a loopback-local DSH request.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { VITE_PAGE_PROTOCOL_VERSION, type TargetId } from '@dsh-external/dsh-browser-bridge-protocol'
import { attachViteWebSocket, ViteTargetBroker } from './broker.ts'
import { isLoopbackDshOrigin } from './sanitize.ts'
import type { TargetCoordinator } from '../targets/coordinator.ts'

export const VITE_HEALTH_PATH = '/dsh-browser-bridge/vite/health'
export const VITE_TARGETS_PATH = '/dsh-browser-bridge/vite/targets'
export const VITE_GRANTS_PATH = '/dsh-browser-bridge/vite/grants'
export const VITE_WS_PATH = '/dsh-browser-bridge/vite/ws'

/** One HTTP handler of the DSH webserver surface. */
export interface ViteRouteHandler {
  (req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/** The minimal DSH webserver face the routes mount on. */
export interface HttpServerLike {
  register(route: { kind: 'exact'; path: string; handler: ViteRouteHandler }): () => void
  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: unknown, head: Buffer) => void }): () => void
}

export interface ViteRoutesOptions {
  broker: ViteTargetBroker
  coordinator: TargetCoordinator
  grantTtlMs?: number
  now?: () => number
}

interface GrantBody {
  sessionId?: unknown
  targetId?: unknown
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

/** Whether one Origin header is a plain HTTP(S) origin (any host). */
function isHttpOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

/**
 * The local DSH origin of one request, inferred from the Host header and
 * the transport encryption state, or '' when it is not loopback-local.
 */
function localDshOriginOf(req: IncomingMessage): string {
  const host = req.headers.host
  if (host === undefined || host === '') return ''
  const proto = (req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http'
  const origin = `${proto}://${host}`
  return isLoopbackDshOrigin(origin) ? origin : ''
}

/**
 * Same-origin guard for targets and grants: the request must arrive at a
 * loopback-local DSH origin, and any Origin header must match that exact
 * origin.
 */
function isSameOriginLocalDsh(req: IncomingMessage): boolean {
  const local = localDshOriginOf(req)
  if (local === '') return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== local) return false
  return true
}

export function createViteRoutes(options: ViteRoutesOptions): { register(httpServer: HttpServerLike): () => void } {
  const { broker, coordinator } = options
  const grantTtlMs = options.grantTtlMs ?? 600_000
  const now = options.now ?? Date.now
  const wss = new WebSocketServer({ noServer: true })

  const health: ViteRouteHandler = (req, res) => {
    const origin = req.headers.origin
    if (origin === undefined || !isHttpOrigin(origin)) {
      res.writeHead(403)
      res.end()
      return
    }
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    // Never allow credentials on the only cross-origin endpoint.
    sendJson(res, 200, {
      ok: true,
      protocol: 'vite-page',
      version: VITE_PAGE_PROTOCOL_VERSION,
    })
  }

  const targets: ViteRouteHandler = (req, res) => {
    if (!isSameOriginLocalDsh(req)) {
      res.writeHead(403)
      res.end()
      return
    }
    sendJson(res, 200, broker.liveTargets())
  }

  const grants: ViteRouteHandler = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    if (!isSameOriginLocalDsh(req)) {
      res.writeHead(403)
      res.end()
      return
    }
    let text = ''
    try {
      for await (const chunk of req) {
        text += chunk
        if (Buffer.byteLength(text, 'utf8') > 16_384) {
          res.writeHead(413)
          res.end()
          return
        }
      }
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    let body: GrantBody
    try {
      body = JSON.parse(text) as GrantBody
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    if (typeof body.sessionId !== 'string' || body.sessionId.length === 0 || body.sessionId.length > 200
      || typeof body.targetId !== 'string' || body.targetId.length < 32 || body.targetId.length > 64) {
      res.writeHead(400)
      res.end()
      return
    }
    const binding = broker.bindingFor(body.targetId as TargetId)
    if (binding === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    const record = coordinator.offer({
      sessionId: body.sessionId,
      expiresAt: now() + grantTtlMs,
      target: binding,
    })
    sendJson(res, 200, { handle: record.handle })
  }

  return {
    register(httpServer: HttpServerLike): () => void {
      const offHealth = httpServer.register({ kind: 'exact', path: VITE_HEALTH_PATH, handler: health })
      const offTargets = httpServer.register({ kind: 'exact', path: VITE_TARGETS_PATH, handler: targets })
      const offGrants = httpServer.register({ kind: 'exact', path: VITE_GRANTS_PATH, handler: grants })
      const offWs = httpServer.registerUpgrade({
        path: VITE_WS_PATH,
        handler: (req, socket, head) => {
          // DNS-rebinding guard, consistent with /targets and /grants: the
          // handshake must arrive at a loopback-local DSH origin. Without
          // it a page could reach this route through a rebound hostname.
          if (localDshOriginOf(req) === '') {
            ;(socket as { destroy(): void }).destroy()
            return
          }
          const origin = req.headers.origin ?? ''
          wss.handleUpgrade(req, socket as never, head, ws => {
            attachViteWebSocket(broker, ws, origin)
          })
        },
      })
      return () => {
        offHealth()
        offTargets()
        offGrants()
        offWs()
        wss.close()
      }
    },
  }
}
