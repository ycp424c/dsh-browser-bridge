/**
 * Runtime integration tests: the real startPageRuntime wiring (Activator,
 * probe, PageSocket) with only the network faces stubbed — fetch answers
 * the exact host health JSON and WebSocket is a controllable fake. These
 * cover the acceptance contract that activation must NOT reach "connected"
 * before the exact target.registered frame, that a failed activation
 * releases the socket so an explicit Retry reconnects fresh (instead of
 * "succeeding" because a stale socket is still non-null), and that dispose
 * settles a pending activation without leaks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VITE_PAGE_PROTOCOL_VERSION } from '@dsh-external/dsh-browser-bridge-protocol'
import { startPageRuntime, type PageRuntime } from '../src/runtime.ts'
import type { PageRuntimeConfig } from '../src/config.ts'

const ORIGIN = 'http://127.0.0.1:3080'
const TARGET_ID = 'r'.repeat(43)

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }

  open(): void {
    this.onopen?.()
  }

  receive(text: string): void {
    this.onmessage?.({ data: text } as MessageEvent)
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map(text => JSON.parse(text) as Record<string, unknown>)
  }

  sentOf<T extends string>(type: T): Extract<Record<string, unknown>, { type: T }> | undefined {
    return this.frames().find(frame => frame.type === type) as never
  }
}

function runtimeConfig(overrides: Partial<PageRuntimeConfig> = {}): PageRuntimeConfig {
  return {
    dshOrigin: ORIGIN,
    mode: 'production',
    bridge: { enabled: true, autoConnectInBuild: false },
    panel: { enabled: true, visible: false, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' },
    ...overrides,
  }
}

const healthResponse = (): Response => new Response(
  JSON.stringify({ ok: true, protocol: 'vite-page', version: VITE_PAGE_PROTOCOL_VERSION }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)

function registeredFrame(): string {
  return JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'target.registered', targetId: TARGET_ID })
}

/** Wait for the runtime to open its first WebSocket. */
async function waitForSocket(count: number): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(count))
  return FakeWebSocket.instances[count - 1]!
}

describe('page runtime activation readiness', () => {
  let runtime: PageRuntime | null = null

  beforeEach(() => {
    FakeWebSocket.instances = []
    globalThis.fetch = (async () => healthResponse()) as typeof fetch
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    runtime?.dispose()
    runtime = null
    delete (globalThis as { fetch?: unknown }).fetch
    delete (globalThis as { WebSocket?: unknown }).WebSocket
  })

  it('does not settle activation before the exact target.registered frame', async () => {
    runtime = startPageRuntime(runtimeConfig())
    const activation = runtime.activate({ openPanel: true })
    const ws = await waitForSocket(1)
    ws.open()
    expect(ws.sentOf('target.register')).toBeDefined()
    let settled = false
    void activation.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    // hello + register are out, but the Activator must not be "connected"
    // yet: the promise only settles on the exact registration ack.
    expect(settled).toBe(false)
    ws.receive(registeredFrame())
    await activation
    expect(settled).toBe(true)
  })

  it('a malformed registration ack keeps activation pending', async () => {
    runtime = startPageRuntime(runtimeConfig())
    const activation = runtime.activate({ openPanel: true })
    const ws = await waitForSocket(1)
    ws.open()
    ws.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'target.registered' }))
    let settled = false
    void activation.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    ws.receive(registeredFrame())
    await activation
  })

  it('a handshake close before registration fails activation; an explicit retry reconnects with a fresh socket', async () => {
    runtime = startPageRuntime(runtimeConfig())
    const first = runtime.activate({ openPanel: true })
    const ws1 = await waitForSocket(1)
    ws1.open()
    // The WebSocket handshake fails before any registration: activation
    // must leave "connecting" (the Activator settles as failed).
    ws1.close()
    await first
    expect(ws1.closed).toBe(true)

    // Explicit Retry: a brand-new socket must be created and register.
    // (Before the fix, the stale non-null socket made connect() return
    // immediately and the retry "succeeded" with no live connection.)
    const retry = runtime.activate({ openPanel: true })
    const ws2 = await waitForSocket(2)
    expect(ws2.closed).toBe(false)
    let retrySettled = false
    void retry.then(() => { retrySettled = true }, () => { retrySettled = true })
    ws2.open()
    await Promise.resolve()
    await Promise.resolve()
    expect(retrySettled).toBe(false)
    ws2.receive(registeredFrame())
    await retry
    expect(retrySettled).toBe(true)
    expect(ws2.sentOf('target.register')).toBeDefined()
  })

  it('dispose settles a pending activation instead of leaking it', async () => {
    runtime = startPageRuntime(runtimeConfig())
    const activation = runtime.activate({ openPanel: true })
    const ws = await waitForSocket(1)
    ws.open()
    runtime.dispose()
    runtime = null
    const outcome = await Promise.race([
      activation.then(() => 'settled', () => 'settled'),
      new Promise<string>(resolve => setTimeout(() => resolve('hung'), 300)),
    ])
    expect(outcome).toBe('settled')
  })

  it('keeps the bridge across reconnects after a successful registration', async () => {
    runtime = startPageRuntime(runtimeConfig())
    const first = runtime.activate({ openPanel: true })
    const ws1 = await waitForSocket(1)
    ws1.open()
    ws1.receive(registeredFrame())
    await first
    // A registered bridge drops and reconnects transparently.
    ws1.close()
    const ws2 = await waitForSocket(2)
    ws2.open()
    expect(ws2.sentOf('target.register')).toBeDefined()
    // A later activation while the bridge is (re)connected needs no new
    // socket: it resolves immediately without another registration wait.
    const again = runtime.activate({ openPanel: true })
    await again
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
