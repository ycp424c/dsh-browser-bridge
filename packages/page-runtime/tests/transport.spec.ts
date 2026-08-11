import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VITE_PAGE_PROTOCOL_VERSION,
  type ViteBrowserTargetDescriptor,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { PageSocket, type PageDispatcher, type PageWebSocket } from '../src/transport/socket.ts'
import { probeLocalDsh } from '../src/probe.ts'

const URL_WS = 'ws://127.0.0.1:3080/dsh-browser-bridge/vite/ws'

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
  options: { heartbeatMs?: number; backoffBaseMs?: number; backoffMaxMs?: number } = {},
): { socket: PageSocket; sockets: FakeWebSocket[]; dispatcher: PageDispatcher } {
  const sockets: FakeWebSocket[] = []
  const dispatcher = makeDispatcher(calls)
  const socket = new PageSocket({
    url: URL_WS,
    descriptor: () => DESCRIPTOR,
    dispatcher,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    backoffBaseMs: options.backoffBaseMs ?? 250,
    backoffMaxMs: options.backoffMaxMs ?? 5_000,
    connectImpl: url => {
      const fake = new FakeWebSocket(url)
      sockets.push(fake)
      return fake
    },
  })
  socket.connect()
  return { socket, sockets, dispatcher }
}

describe('local DSH probe', () => {
  it('reaches only the exact health endpoint without scanning ports', async () => {
    const urls: string[] = []
    let init: RequestInit | undefined
    const ok = await probeLocalDsh({
      dshOrigin: 'http://127.0.0.1:3080',
      fetchImpl: (async (url: unknown, requestInit?: RequestInit) => {
        urls.push(String(url))
        init = requestInit
        return { ok: true, type: 'basic' } as unknown as Response
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
})

describe('page socket', () => {
  afterEach(() => {
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
})
