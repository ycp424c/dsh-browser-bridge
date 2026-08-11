/**
 * @dsh-external/dsh-browser-bridge — external DSH plugin, host half.
 * Owns the pairing endpoint, the authenticated WebSocket bridge, prompt
 * marker consumption, and turn-scoped browser tools.
 */
import type { Context } from 'cordis'
import z from 'schemastery'
import { WebSocketServer } from 'ws'
import { PairingStore, EXTENSION_ORIGIN_PATTERN } from './bridge/pairing-store.ts'
import { GrantStore } from './bridge/grant-store.ts'
import { attachWebSocket, BridgeServer } from './bridge/server.ts'
import { createPreStepHandler } from './pre-step.ts'
import { registerTurnTools } from './tools/register.ts'

export const name = '@dsh-external/dsh-browser-bridge'

export const inject = ['httpServer', 'attachments']

/** Input config shape; defaults are applied by the `Config` schema. */
export interface ConfigShape {
  pairingTtlMs?: number
  grantTtlMs?: number
  toolTimeoutMs?: number
  consoleBufferSize?: number
  networkBufferSize?: number
  rawCdpEnabled?: boolean
}

export const Config: z<ConfigShape> = z.object({
  pairingTtlMs: z.natural().min(1_000).default(30_000),
  grantTtlMs: z.natural().min(1_000).default(600_000),
  toolTimeoutMs: z.natural().min(1_000).default(60_000),
  consoleBufferSize: z.natural().min(1).default(200),
  networkBufferSize: z.natural().min(1).default(200),
  rawCdpEnabled: z.boolean().default(false),
})

export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = Config(config)
  const pairing = new PairingStore({ pairingTtlMs: resolved.pairingTtlMs })
  const grants = new GrantStore()
  const server = new BridgeServer({ pairing, grants, toolTimeoutMs: resolved.toolTimeoutMs })
  const wss = new WebSocketServer({ noServer: true })
  const preStep = createPreStepHandler({
    server,
    grants,
    registerTurnTools: (agent, turn) => registerTurnTools(agent, turn, { server }),
  })

  ctx.effect(() => {
    const offPair = ctx.httpServer.register({
      kind: 'exact',
      path: '/dsh-browser-bridge/pair',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        let body = ''
        for await (const chunk of req) body += chunk
        let origin = ''
        try {
          const parsed = JSON.parse(body) as { extensionOrigin?: unknown }
          if (typeof parsed.extensionOrigin === 'string') origin = parsed.extensionOrigin
        } catch {
          // Invalid body; rejected below.
        }
        res.setHeader('Cache-Control', 'no-store')
        if (!EXTENSION_ORIGIN_PATTERN.test(origin)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid extension origin' }))
          return
        }
        const nonce = pairing.issue(origin)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ nonce }))
      },
    })

    const offWs = ctx.httpServer.registerUpgrade({
      path: '/dsh-browser-bridge/ws',
      handler: (req, socket, head) => {
        const origin = req.headers.origin ?? ''
        wss.handleUpgrade(req, socket, head, ws => {
          attachWebSocket(server, ws, origin)
        })
      },
    })

    const offPreStep = ctx.on('agent/pre-step', (payload, next) => preStep(payload, next))
    const offTurnStopping = ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      preStep.onTurnStopping(agent, turn)
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      preStep.dispose(agent)
    })
    // A dropped socket is TRANSIENT: the extension reconnects with a fresh
    // pairing nonce and resumes the same logical session (the server
    // preserves the connection id per extension origin), so tools and
    // grants stay alive and one read retry remains possible. Only terminal
    // paths — this cleanup, connection takeover, turn end, expiry — revoke
    // grants and tools.

    return () => {
      offPair()
      offWs()
      offPreStep()
      offTurnStopping()
      offDisposed()
      // Terminal: remove turn-scoped tools, then revoke every remaining
      // grant of the live connection (consumed and pending offers) with
      // grant.revoke frames before the socket closes.
      preStep.disposeAll()
      server.dispose()
      wss.close()
    }
  }, 'dsh-browser-bridge: host plugin')
}

export default apply
