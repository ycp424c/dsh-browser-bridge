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
import { ProviderRegistry } from './targets/provider-registry.ts'
import { TargetCoordinator } from './targets/coordinator.ts'
import { ViteTargetBroker } from './vite/broker.ts'
import { createViteRoutes } from './vite/routes.ts'

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
  viteMaxTargets?: number
  viteMaxTargetsPerOrigin?: number
  viteMaxFrameBytes?: number
  viteMaxConcurrentCalls?: number
  viteMaxFramesPerSecond?: number
  viteHeartbeatMs?: number
  viteDisconnectMs?: number
  viteReconnectWindowMs?: number
}

export const Config: z<ConfigShape> = z.object({
  pairingTtlMs: z.natural().min(1_000).default(30_000),
  grantTtlMs: z.natural().min(1_000).default(600_000),
  toolTimeoutMs: z.natural().min(1_000).default(60_000),
  consoleBufferSize: z.natural().min(1).default(200),
  networkBufferSize: z.natural().min(1).default(200),
  rawCdpEnabled: z.boolean().default(false),
  viteMaxTargets: z.natural().min(1).default(32),
  viteMaxTargetsPerOrigin: z.natural().min(1).default(8),
  viteMaxFrameBytes: z.natural().min(1_024).default(1_048_576),
  viteMaxConcurrentCalls: z.natural().min(1).default(4),
  viteMaxFramesPerSecond: z.natural().min(1).default(16),
  viteHeartbeatMs: z.natural().min(1_000).default(15_000),
  viteDisconnectMs: z.natural().min(1_000).default(45_000),
  viteReconnectWindowMs: z.natural().min(1_000).default(45_000),
})

export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = Config(config)
  const pairing = new PairingStore({ pairingTtlMs: resolved.pairingTtlMs })
  const grants = new GrantStore()
  const registry = new ProviderRegistry()
  const coordinator = new TargetCoordinator({ providers: registry, grants })
  const server = new BridgeServer({ pairing, coordinator, toolTimeoutMs: resolved.toolTimeoutMs })
  const broker = new ViteTargetBroker({
    coordinator,
    maxTargets: resolved.viteMaxTargets,
    maxTargetsPerOrigin: resolved.viteMaxTargetsPerOrigin,
    maxFrameBytes: resolved.viteMaxFrameBytes,
    maxConcurrentCalls: resolved.viteMaxConcurrentCalls,
    maxFramesPerSecond: resolved.viteMaxFramesPerSecond,
    heartbeatMs: resolved.viteHeartbeatMs,
    disconnectMs: resolved.viteDisconnectMs,
    reconnectWindowMs: resolved.viteReconnectWindowMs,
  })
  registry.register(server)
  registry.register(broker)
  const wss = new WebSocketServer({ noServer: true })
  const preStep = createPreStepHandler({
    server,
    grants,
    registerTurnTools: (agent, turn) => registerTurnTools(agent, turn, {
      server,
      // The bridge plugin owns the attachment store: it is injected here on
      // the plugin's own dependency surface and passed down explicitly, so
      // the agent scope (DSH 0810: tools/systemPrompt) never needs it.
      attachments: ctx.attachments,
    }),
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

    // Vite page broker: low-authority multi-target routes and WebSocket.
    const offViteRoutes = createViteRoutes({
      broker,
      coordinator,
      grantTtlMs: resolved.grantTtlMs,
    }).register(ctx.httpServer)

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
      offViteRoutes()
      offPreStep()
      offTurnStopping()
      offDisposed()
      // Terminal: remove turn-scoped tools, then revoke every remaining
      // grant of the live connection (consumed and pending offers) with
      // grant.revoke frames before the socket closes. The Vite broker is
      // disposed before the coordinator-owned server so its grants are
      // revoked and its pending calls settled while the coordinator is
      // still intact.
      preStep.disposeAll()
      broker.dispose()
      server.dispose()
      wss.close()
    }
  }, 'dsh-browser-bridge: host plugin')
}

export default apply
