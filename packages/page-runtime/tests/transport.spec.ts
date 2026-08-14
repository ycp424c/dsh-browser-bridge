import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VITE_PAGE_PROTOCOL_VERSION,
  type ViteBrowserTargetDescriptor,
} from '@ycp424c/dsh-browser-bridge-protocol'
import { PageSocket, type PageDispatcher, type PageWebSocket } from '../src/transport/socket.ts'
import { probeLocalDsh } from '../src/probe.ts'

const URL_WS = 'ws://127.0.0.1:3080/dsh-browser-bridge/vite/ws'

/** Every PageSocket created by makeSocket, closed after each test. */
const createdSockets = new Set<PageSocket>()

const DESCRIPTOR: ViteBrowserTargetDescriptor = {
  targetId: 't'.repeat(43) as never,
  provider: 'vite',
  title: 'Fixture',
  url: 'http://127.0.0.1:5173/',
  origin: 'http://127.0.0.1:5173',
  projectId: 'app',
  generation: 1,
  capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
}

class FakeWebSocket implements PageWebSocket {
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {}

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

function makeDispatcher(calls: Array<{ operation: string; args: unknown; signal: AbortSignal }>): PageDispatcher {
  return {
    execute: (operation, args, signal) => {
      calls.push({ operation, args: args as unknown, signal })
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        setTimeout(() => resolve({ ok: true }), 10)
      })
    },
  }
}

function makeSocket(
  calls: Array<{ operation: string; args: unknown; signal: AbortSignal }>,
  options: { heartbeatMs?: number; backoffBaseMs?: number; backoffMaxMs?: number; registerTimeoutMs?: number } = {},
): { socket: PageSocket; sockets: FakeWebSocket[]; dispatcher: PageDispatcher; ready: Promise<void> } {
  const sockets: FakeWebSocket[] = []
  const dispatcher = makeDispatcher(calls)
  const socket = new PageSocket({
    url: URL_WS,
    descriptor: () => DESCRIPTOR,
    dispatcher,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    backoffBaseMs: options.backoffBaseMs ?? 250,
    backoffMaxMs: options.backoffMaxMs ?? 5_000,
    ...(options.registerTimeoutMs !== undefined ? { registerTimeoutMs: options.registerTimeoutMs } : {}),
    connectImpl: url => {
      const fake = new FakeWebSocket(url)
      sockets.push(fake)
      return fake
    },
  })
  const ready = socket.connect()
  // Harness-level guard: tests that close the socket before registration
  // assert the rejection explicitly; the guard keeps the pending promise
  // from surfacing as an unhandled rejection in unrelated tests.
  ready.catch(() => {})
  createdSockets.add(socket)
  return { socket, sockets, dispatcher, ready }
}

const TARGET_REGISTERED = JSON.stringify({
  v: VITE_PAGE_PROTOCOL_VERSION,
  type: 'target.registered',
  targetId: DESCRIPTOR.targetId,
})

const HEALTH_JSON = JSON.stringify({
  ok: true,
  protocol: 'vite-page',
  version: VITE_PAGE_PROTOCOL_VERSION,
})

/** The exact JSON body the real DSH host serves at /health. */
function healthResponse(options: {
  status?: number
  body?: string
  headers?: Record<string, string>
} = {}): Response {
  return new Response(options.body ?? HEALTH_JSON, {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json', ...options.headers },
  })
}

/** A response streaming its body in one chunk (no content-length). */
function streamedResponse(body: string, status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status })
}

describe('local DSH probe', () => {
  it('reaches only the exact health endpoint and accepts the exact host JSON', async () => {
    const urls: string[] = []
    let init: RequestInit | undefined
    const ok = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async (url: unknown, requestInit?: RequestInit) => {
        urls.push(String(url))
        init = requestInit
        return healthResponse()
      }) as typeof fetch,
    })
    expect(ok).toBe(true)
    expect(urls).toEqual(['http://127.0.0.1:3080/dsh-browser-bridge/vite/health'])
    expect(init!.redirect).toBe('manual')
    expect(init!.credentials).toBe('omit')
    expect(init!.signal).toBeDefined()
  })

  it('rejects a redirect before following it', async () => {
    const ok = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => ({ ok: false, type: 'opaqueredirect' }) as unknown as Response) as typeof fetch,
    })
    expect(ok).toBe(false)
  })

  it('fails closed on network errors and timeouts', async () => {
    const throwing = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => { throw new Error('network unreachable') }) as typeof fetch,
    })
    expect(throwing).toBe(false)
  })

  it('rejects a 200 HTML SPA fallback even though the status is ok', async () => {
    const ok = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => new Response(
        '<!doctype html><html><body><div id="app"></div><script src="/assets/index.js"></script></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      )) as typeof fetch,
    })
    expect(ok).toBe(false)
  })

  it('rejects an HTML body even without a content-type header', async () => {
    const ok = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => new Response('<!doctype html><html><body>DSH</body></html>', { status: 200 })) as typeof fetch,
    })
    expect(ok).toBe(false)
  })

  it('rejects a wrong protocol version', async () => {
    const wrongVersion = JSON.stringify({ ok: true, protocol: 'vite-page', version: 999 })
    expect(await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => healthResponse({ body: wrongVersion })) as typeof fetch,
    })).toBe(false)
    // A string version never equals the numeric protocol version.
    const stringVersion = JSON.stringify({ ok: true, protocol: 'vite-page', version: String(VITE_PAGE_PROTOCOL_VERSION) })
    expect(await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => healthResponse({ body: stringVersion })) as typeof fetch,
    })).toBe(false)
  })

  it('rejects a wrong or missing protocol field', async () => {
    const wrongProtocol = JSON.stringify({ ok: true, protocol: 'chrome-extension', version: VITE_PAGE_PROTOCOL_VERSION })
    expect(await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => healthResponse({ body: wrongProtocol })) as typeof fetch,
    })).toBe(false)
    const missing = JSON.stringify({ ok: true, version: VITE_PAGE_PROTOCOL_VERSION })
    expect(await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => healthResponse({ body: missing })) as typeof fetch,
    })).toBe(false)
  })

  it('rejects a missing or false ok field', async () => {
    const noOk = JSON.stringify({ protocol: 'vite-page', version: VITE_PAGE_PROTOCOL_VERSION })
    expect(await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => healthResponse({ body: noOk })) as typeof fetch,
    })).toBe(false)
    const notOk = JSON.stringify({ ok: false, protocol: 'vite-page', version: VITE_PAGE_PROTOCOL_VERSION })
    expect(await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => healthResponse({ body: notOk })) as typeof fetch,
    })).toBe(false)
  })

  it('rejects malformed JSON and non-object payloads', async () => {
    for (const body of ['{"ok": true', 'null', '"vite-page"', '42', '']) {
      const rejected = await probeLocalDsh({
        dshOrigin: 'http://127.0.0.1:3080',
        fetchImpl: (async () => healthResponse({ body })) as typeof fetch,
      })
      expect(rejected).toBe(false)
    }
  })

  it('rejects non-2xx responses even with a valid JSON body', async () => {
    for (const status of [301, 403, 404, 500, 503]) {
      const rejected = await probeLocalDsh({
        dshOrigin: 'http://127.0.0.1:3080',
        fetchImpl: (async () => healthResponse({ status, body: HEALTH_JSON })) as typeof fetch,
      })
      expect(rejected).toBe(false)
    }
  })

  it('rejects a non-JSON content type even when the body parses', async () => {
    const rejected = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => healthResponse({ headers: { 'content-type': 'text/plain' } })) as typeof fetch,
    })
    expect(rejected).toBe(false)
  })

  it('rejects a body larger than the bound declared in content-length', async () => {
    const big = 'x'.repeat(10_000)
    const rejected = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => healthResponse({ body: big, headers: { 'content-length': '10000' } })) as typeof fetch,
    })
    expect(rejected).toBe(false)
  })

  it('rejects a body that streams past the bound without a content-length', async () => {
    const rejected = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => streamedResponse('x'.repeat(10_000))) as typeof fetch,
    })
    expect(rejected).toBe(false)
  })

  it('accepts the exact host JSON with extra unknown fields', async () => {
    const body = JSON.stringify({ ok: true, protocol: 'vite-page', version: VITE_PAGE_PROTOCOL_VERSION, note: 'extra' })
    const ok = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async () => healthResponse({ body })) as typeof fetch,
    })
    expect(ok).toBe(true)
  })
})

describe('page socket', () => {
  afterEach(() => {
    for (const socket of createdSockets) socket.close()
    createdSockets.clear()
    vi.useRealTimers()
  })

  it('sends hello and target.register on connect', () => {
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { sockets } = makeSocket(calls)
    const socket = sockets[0]!
    socket.open()
    const types = socket.frames().map(frame => frame.type)
    expect(types).toContain('hello')
    expect(types).toContain('target.register')
    expect(socket.sentOf('target.register')).toMatchObject({
      target: { targetId: 't'.repeat(43), provider: 'vite', generation: 1 },
    })
  })

  it('dispatches tool calls with accepted-before-execution and correlated results', async () => {
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { sockets } = makeSocket(calls)
    const socket = sockets[0]!
    socket.open()
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 'r'.repeat(32),
      operation: 'observe',
      args: {},
    }))
    const types = socket.frames().map(frame => frame.type)
    expect(types).toContain('tool.accepted')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.operation).toBe('observe')
    await vi.waitFor(() => {
      const result = socket.frames().find(frame => frame.type === 'tool.result')
      expect(result).toMatchObject({ requestId: 'r'.repeat(32), result: { ok: true } })
    })
  })

  it('tool.cancel aborts the exact in-flight call', async () => {
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { sockets } = makeSocket(calls)
    const socket = sockets[0]!
    socket.open()
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 'r1'.padEnd(32, '1'),
      operation: 'observe',
      args: {},
    }))
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 'r2'.padEnd(32, '2'),
      operation: 'inspect',
      args: {},
    }))
    expect(calls).toHaveLength(2)
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.cancel',
      requestId: 'r1'.padEnd(32, '1'),
      reason: 'cancelled',
    }))
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(calls[1]!.signal.aborted).toBe(false)
  })

  it('replies pong to ping and heartbeats on its own interval', () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { sockets } = makeSocket(calls, { heartbeatMs: 15_000 })
    const socket = sockets[0]!
    socket.open()
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'ping' }))
    expect(socket.sentOf('pong')).toBeDefined()
    socket.sent.length = 0
    vi.advanceTimersByTime(15_000)
    expect(socket.sentOf('ping')).toBeDefined()
  })

  it('a disconnect settles in-flight calls and never replays accepted work on reconnect', async () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets } = makeSocket(calls, { backoffBaseMs: 250, backoffMaxMs: 250 })
    const first = sockets[0]!
    first.open()
    first.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 'r'.repeat(32),
      operation: 'act',
      args: { action: { kind: 'click', selector: '#x' } },
    }))
    expect(calls).toHaveLength(1)
    // The page acknowledged delivery; the connection drops.
    first.close()
    expect(calls[0]!.signal.aborted).toBe(true)
    vi.advanceTimersByTime(250)
    const second = sockets[1]!
    second.open()
    // Reconnect sends hello/register only — no re-execution, no replay.
    expect(second.frames().map(frame => frame.type)).toEqual(['hello', 'target.register'])
    expect(calls).toHaveLength(1)
    vi.useRealTimers()
  })

  it('reconnects with bounded exponential backoff', () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets } = makeSocket(calls, { backoffBaseMs: 250, backoffMaxMs: 500 })
    sockets[0]!.open()
    sockets[0]!.close()
    // Attempt 1 after ~250ms.
    vi.advanceTimersByTime(249)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    sockets[1]!.close()
    // Attempt 2 after ~500ms (capped at backoffMaxMs).
    vi.advanceTimersByTime(499)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
    vi.useRealTimers()
  })

  it('close() stops reconnecting and clears the heartbeat', () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets } = makeSocket(calls)
    sockets[0]!.open()
    socket.close()
    sockets[0]!.close()
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    vi.useRealTimers()
  })

  it('target.revoke notifies the owner', () => {
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets } = makeSocket(calls)
    const fake = sockets[0]!
    fake.open()
    const revokes: string[] = []
    socket.onRevoke(() => revokes.push('revoked'))
    fake.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'target.revoke' }))
    expect(revokes).toEqual(['revoked'])
  })

  it('a protocol_mismatch error frame stops reconnecting (terminal)', () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets } = makeSocket(calls, { backoffBaseMs: 250, backoffMaxMs: 250 })
    const first = sockets[0]!
    first.open()
    first.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'error',
      code: 'protocol_mismatch',
      message: 'unsupported vite page protocol version',
      retryable: false,
    }))
    // The host closes right after the error; no reconnect may follow.
    first.close()
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    vi.useRealTimers()
  })

  it('a permission_denied error frame stops reconnecting (terminal)', () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets } = makeSocket(calls, { backoffBaseMs: 250, backoffMaxMs: 250 })
    const first = sockets[0]!
    first.open()
    first.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'error',
      code: 'permission_denied',
      message: 'vite target origin is not loopback or allowed',
      retryable: false,
    }))
    first.close()
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    vi.useRealTimers()
  })

  it('the connect promise stays pending until the exact target.registered frame', async () => {
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { sockets, ready } = makeSocket(calls)
    const fake = sockets[0]!
    fake.open()
    // hello and target.register went out; no registration yet.
    expect(fake.sentOf('target.register')).toBeDefined()
    let settled = false
    void ready.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    fake.receive(TARGET_REGISTERED)
    await expect(ready).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  it('a malformed target.registered frame does not resolve the connect promise', async () => {
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { sockets, ready } = makeSocket(calls)
    const fake = sockets[0]!
    fake.open()
    // Missing targetId fails the strict host-frame schema.
    fake.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'target.registered' }))
    let settled = false
    void ready.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    fake.receive(TARGET_REGISTERED)
    await expect(ready).resolves.toBeUndefined()
  })

  it('a close before the first registration rejects the connect promise', async () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets, ready } = makeSocket(calls, { backoffBaseMs: 250, backoffMaxMs: 250 })
    const fake = sockets[0]!
    fake.open()
    fake.close()
    await expect(ready).rejects.toThrow(/before target registration/)
    // The failed initial handshake must not leave a reconnect loop behind.
    socket.close()
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    vi.useRealTimers()
  })

  it('a protocol_mismatch error frame before registration rejects the connect promise', async () => {
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { sockets, ready } = makeSocket(calls)
    const fake = sockets[0]!
    fake.open()
    fake.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'error',
      code: 'protocol_mismatch',
      message: 'unsupported vite page protocol version',
      retryable: false,
    }))
    await expect(ready).rejects.toThrow(/protocol_mismatch/)
  })

  it('a permission_denied error frame before registration rejects the connect promise', async () => {
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { sockets, ready } = makeSocket(calls)
    const fake = sockets[0]!
    fake.open()
    fake.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'error',
      code: 'permission_denied',
      message: 'vite target origin is not loopback or allowed',
      retryable: false,
    }))
    await expect(ready).rejects.toThrow(/permission_denied/)
  })

  it('the connect promise rejects when registration times out', async () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { sockets, ready } = makeSocket(calls, { registerTimeoutMs: 5_000 })
    const fake = sockets[0]!
    fake.open()
    let settled = false
    void ready.then(() => { settled = true }, () => { settled = true })
    vi.advanceTimersByTime(4_999)
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(ready).rejects.toThrow(/registration timed out/)
    vi.useRealTimers()
  })

  it('close() settles a pending registration (dispose path)', async () => {
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets, ready } = makeSocket(calls)
    sockets[0]!.open()
    socket.close()
    await expect(ready).rejects.toThrow(/closed/)
  })

  it('a retry after a failed registration opens a fresh registration window', async () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets, ready } = makeSocket(calls, { backoffBaseMs: 250, backoffMaxMs: 250 })
    const first = sockets[0]!
    first.open()
    first.close()
    await expect(ready).rejects.toThrow(/before target registration/)
    const retried = socket.connect()
    retried.catch(() => {})
    const second = sockets[1]!
    second.open()
    second.receive(TARGET_REGISTERED)
    await expect(retried).resolves.toBeUndefined()
    // The backoff timer of the failed first attempt must not fire a third
    // socket on top of the fresh registration window.
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(2)
    vi.useRealTimers()
  })

  it('reconnects after a successful registration without a new registration wait', async () => {
    vi.useFakeTimers()
    const calls: Array<{ operation: string; args: unknown; signal: AbortSignal }> = []
    const { socket, sockets, ready } = makeSocket(calls, { backoffBaseMs: 250, backoffMaxMs: 250 })
    const first = sockets[0]!
    first.open()
    first.receive(TARGET_REGISTERED)
    await expect(ready).resolves.toBeUndefined()
    // The registered bridge drops and reconnects transparently.
    first.close()
    vi.advanceTimersByTime(250)
    const second = sockets[1]!
    second.open()
    expect(second.frames().map(frame => frame.type)).toEqual(['hello', 'target.register'])
    vi.useRealTimers()
  })
})
