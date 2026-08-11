import { describe, expect, it } from 'vitest'
import { VITE_PAGE_PROTOCOL_VERSION } from '@dsh-external/dsh-browser-bridge-protocol'
import type { IncomingMessage } from 'node:http'
import { GrantStore } from '../src/bridge/grant-store.ts'
import { TargetCoordinator } from '../src/targets/coordinator.ts'
import { ProviderRegistry } from '../src/targets/provider-registry.ts'
import { ViteTargetBroker, type ViteSocket } from '../src/vite/broker.ts'
import { createViteRoutes, type HttpServerLike, type ViteRouteHandler } from '../src/vite/routes.ts'
import type { TargetBinding } from '../src/targets/types.ts'

const ORIGIN = 'http://127.0.0.1:5173'
const DSH_ORIGIN = 'http://127.0.0.1:3080'
const TARGET_ID = 't'.repeat(43)

class FakeSocket implements ViteSocket {
  sent: string[] = []
  closed = false
  private handlers: ((text: string) => void)[] = []
  private closeHandlers: (() => void)[] = []
  onMessage(handler: (text: string) => void): void { this.handlers.push(handler) }
  onClose(handler: () => void): void { this.closeHandlers.push(handler) }
  send(text: string): void { this.sent.push(text) }
  close(): void { if (this.closed) return; this.closed = true; for (const handler of this.closeHandlers) handler() }
  receive(text: string): void { for (const handler of this.handlers) handler(text) }
}

class FakeHttpServer implements HttpServerLike {
  readonly routes = new Map<string, ViteRouteHandler>()
  readonly upgrades = new Map<string, (req: IncomingMessage, socket: unknown, head: Buffer) => void>()

  register(route: { kind: 'exact'; path: string; handler: ViteRouteHandler }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }

  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: unknown, head: Buffer) => void }): () => void {
    this.upgrades.set(route.path, route.handler)
    return () => { this.upgrades.delete(route.path) }
  }
}

class FakeRes {
  status = 200
  headers: Record<string, string> = {}
  body = ''

  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value
    return this
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status
    // Mirror Node semantics: writeHead merges with prior setHeader state
    // and header names are lower-cased.
    if (headers !== undefined) {
      const normalized: Record<string, string> = {}
      for (const [name, value] of Object.entries(headers)) normalized[name.toLowerCase()] = value
      this.headers = { ...this.headers, ...normalized }
    }
    return this
  }

  end(payload?: string): void {
    if (payload !== undefined) this.body = payload
  }
}

interface Fixture {
  broker: ViteTargetBroker
  coordinator: TargetCoordinator
  httpServer: FakeHttpServer
  dispose: () => void
  call(method: string, path: string, options?: { origin?: string; host?: string; body?: unknown }): Promise<{ status: number; headers: Record<string, string>; body: unknown }>
  connectPage(targetId?: string): FakeSocket
}

function makeFixture(): Fixture {
  const grants = new GrantStore()
  const registry = new ProviderRegistry()
  const coordinator = new TargetCoordinator({ providers: registry, grants })
  const broker = new ViteTargetBroker({ coordinator })
  registry.register(broker)
  const httpServer = new FakeHttpServer()
  const dispose = createViteRoutes({ broker, coordinator, grantTtlMs: 60_000 }).register(httpServer)
  const call = async (method: string, path: string, options: { origin?: string; host?: string; body?: unknown } = {}): Promise<{ status: number; headers: Record<string, string>; body: unknown }> => {
    const handler = httpServer.routes.get(path)
    if (handler === undefined) throw new Error(`no route for ${path}`)
    const text = options.body === undefined ? '' : JSON.stringify(options.body)
    let offset = 0
    const req = {
      method,
      url: path,
      headers: {
        host: options.host ?? DSH_ORIGIN.slice('http://'.length),
        ...(options.origin !== undefined ? { origin: options.origin } : {}),
      },
      [Symbol.asyncIterator]: async function* () {
        while (offset < text.length) {
          yield Buffer.from(text.slice(offset, (offset += Math.max(1, text.length))))
        }
      },
    } as unknown as IncomingMessage
    const res = new FakeRes()
    await handler(req, res)
    return {
      status: res.status,
      headers: res.headers,
      body: res.body === '' ? undefined : JSON.parse(res.body) as unknown,
    }
  }
  const connectPage = (targetId = TARGET_ID): FakeSocket => {
    const socket = new FakeSocket()
    broker.attach(socket, ORIGIN)
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: {
        targetId,
        provider: 'vite',
        title: 'Vite Page',
        url: 'http://127.0.0.1:5173/',
        origin: ORIGIN,
        projectId: 'app',
        generation: 0,
        capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      },
    }))
    return socket
  }
  return { broker, coordinator, httpServer, dispose, call, connectPage }
}

describe('vite host routes', () => {
  it('exposes health to any HTTP(S) origin and returns no credentials', async () => {
    const { call } = makeFixture()
    const response = await call('GET', '/dsh-browser-bridge/vite/health', { origin: 'https://public.example' })
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe('https://public.example')
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    expect(response.headers.vary).toContain('Origin')
    expect(response.body).toEqual({ ok: true, protocol: 'vite-page', version: VITE_PAGE_PROTOCOL_VERSION })
  })

  it('rejects health without a valid HTTP(S) origin', async () => {
    const { call } = makeFixture()
    const missing = await call('GET', '/dsh-browser-bridge/vite/health')
    expect(missing.status).toBe(403)
    const bad = await call('GET', '/dsh-browser-bridge/vite/health', { origin: 'file:///etc/passwd' })
    expect(bad.status).toBe(403)
  })

  it('lists targets only for a same-origin local DSH request', async () => {
    const { call, connectPage } = makeFixture()
    connectPage()
    const foreign = await call('GET', '/dsh-browser-bridge/vite/targets', { origin: 'https://public.example' })
    expect(foreign.status).toBe(403)
    const sameOrigin = await call('GET', '/dsh-browser-bridge/vite/targets', { origin: DSH_ORIGIN })
    expect(sameOrigin.status).toBe(200)
    const targets = sameOrigin.body as Array<{ targetId: string; provider: string }>
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ targetId: TARGET_ID, provider: 'vite' })
  })

  it('rejects grant issuance from a non-DSH origin', async () => {
    const { call } = makeFixture()
    const response = await call('POST', '/dsh-browser-bridge/vite/grants', {
      origin: 'https://public.example',
      body: { sessionId: 's1', targetId: TARGET_ID },
    })
    expect(response.status).toBe(403)
  })

  it('issues one prompt-scoped grant for a live target and returns only the handle', async () => {
    const { call, connectPage, coordinator } = makeFixture()
    connectPage()
    const response = await call('POST', '/dsh-browser-bridge/vite/grants', {
      origin: DSH_ORIGIN,
      body: { sessionId: 'session-a', targetId: TARGET_ID },
    })
    expect(response.status).toBe(200)
    const body = response.body as { handle: string }
    expect(body.handle).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    expect(Object.keys(body)).toEqual(['handle'])
    const record = coordinator.consumeBatch([body.handle], { sessionId: 'session-a', turn: 1 })
    expect(record[0]!.target.descriptor.targetId).toBe(TARGET_ID)
  })

  it('refuses grants for unknown targets and invalid bodies', async () => {
    const { call } = makeFixture()
    const unknown = await call('POST', '/dsh-browser-bridge/vite/grants', {
      origin: DSH_ORIGIN,
      body: { sessionId: 's1', targetId: 'x'.repeat(43) },
    })
    expect(unknown.status).toBe(404)
    const malformed = await call('POST', '/dsh-browser-bridge/vite/grants', {
      origin: DSH_ORIGIN,
      body: { sessionId: 's1' },
    })
    expect(malformed.status).toBe(400)
  })

  it('registers the Vite WebSocket upgrade route', () => {
    const { httpServer } = makeFixture()
    expect(httpServer.upgrades.has('/dsh-browser-bridge/vite/ws')).toBe(true)
  })

  it('rejects non-loopback Host headers on same-origin routes', async () => {
    const { call } = makeFixture()
    const response = await call('GET', '/dsh-browser-bridge/vite/targets', {
      origin: DSH_ORIGIN,
      host: 'public.example',
    })
    expect(response.status).toBe(403)
  })
})
