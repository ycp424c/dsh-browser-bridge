import { describe, expect, it } from 'vitest'
import { Context, Service } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, inject, name } from '../src/index.ts'
import { FakeAttachments } from './fake-attachments.ts'
import { FakeLlm } from './fake-llm.ts'

class FakeHttpServer extends Service {
  readonly routes = new Map<string, WebRoute>()
  readonly upgrades = new Map<string, WebUpgradeRoute>()

  constructor(ctx: Context) {
    super(ctx, 'httpServer')
  }

  register(route: WebRoute): () => void {
    this.routes.set(route.path, route)
    return () => { this.routes.delete(route.path) }
  }

  registerUpgrade(route: WebUpgradeRoute): () => void {
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }
}

class FakeRes {
  status = 200
  headers: Record<string, string> = {}
  body = ''

  setHeader(name: string, value: string): this {
    this.headers[name] = value
    return this
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status
    if (headers !== undefined) this.headers = headers
    return this
  }

  end(payload?: string): void {
    if (payload !== undefined) this.body = payload
  }
}

function jsonReq(body: unknown): IncomingMessage {
  const text = JSON.stringify(body)
  let offset = 0
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      while (offset < text.length) {
        yield Buffer.from(text.slice(offset, (offset += text.length)))
      }
    },
  } as unknown as IncomingMessage
}

async function readPairing(ctx: Context, origin: string): Promise<{ status: number; body: { nonce?: string } }> {
  const server = ctx.get('httpServer') as unknown as FakeHttpServer
  const route = server.routes.get('/dsh-browser-bridge/pair')
  expect(route).toBeDefined()
  const res = new FakeRes()
  await route!.handler(jsonReq({ extensionOrigin: origin }), res as unknown as ServerResponse)
  return { status: res.status, body: JSON.parse(res.body === '' ? '{}' : res.body) as { nonce?: string } }
}

async function mount(): Promise<{ ctx: Context; server: FakeHttpServer }> {
  const ctx = new Context()
  await ctx.plugin(FakeHttpServer)
  // The plugin's inject list requires routing, attachments, and model metadata.
  await ctx.plugin(FakeAttachments)
  await ctx.plugin(FakeLlm)
  // The loader assembles { apply, inject, Config } from the module exports.
  await ctx.plugin({ apply, inject, Config, name }, {})
  const server = ctx.get('httpServer') as unknown as FakeHttpServer
  return { ctx, server }
}

describe('browser bridge plugin apply', () => {
  it('registers the pairing and WebSocket upgrade routes', async () => {
    const { server } = await mount()
    expect(server.routes.has('/dsh-browser-bridge/pair')).toBe(true)
    expect(server.upgrades.has('/dsh-browser-bridge/ws')).toBe(true)
  })

  it('issues a short-lived single-use nonce for a valid extension origin', async () => {
    const { ctx } = await mount()
    const first = await readPairing(ctx, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')
    expect(first.status).toBe(200)
    expect(first.body.nonce).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    const second = await readPairing(ctx, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')
    expect(second.body.nonce).not.toBe(first.body.nonce)
  })

  it('rejects malformed or missing extension origins', async () => {
    const { ctx } = await mount()
    expect((await readPairing(ctx, 'https://example.com')).status).toBe(400)
    expect((await readPairing(ctx, 'not-an-origin')).status).toBe(400)
    expect((await readPairing(ctx, 'chrome-extension://SHORT')).status).toBe(400)
  })

  it('validates config at load and defaults raw CDP to false', () => {
    expect(Config).toBeDefined()
    expect(Config({})).toMatchObject({
      rawCdpEnabled: false,
      toolTimeoutMs: 60_000,
      pairingTtlMs: 30_000,
      grantTtlMs: 10 * 60_000,
    })
    expect(() => Config({ rawCdpEnabled: 'yes' as unknown as boolean })).toThrow()
    expect(() => Config({ consoleBufferSize: -1 })).toThrow()
  })

  it('disposes routes, listeners, and the server', async () => {
    const { ctx, server } = await mount()
    await ctx.fiber.dispose()
    expect(server.routes.has('/dsh-browser-bridge/pair')).toBe(false)
    expect(server.upgrades.has('/dsh-browser-bridge/ws')).toBe(false)
  })
})
