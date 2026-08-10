import { describe, expect, it } from 'vitest'
import {
  ConnectionId, GrantId, PROTOCOL_VERSION,
  type BridgeFrame, type GrantPutFrame, type HelloFrame, type ToolCallFrame, type ToolResultFrame,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { GrantStore } from '../src/bridge/grant-store.ts'
import { PairingStore } from '../src/bridge/pairing-store.ts'
import { BridgeServer, type BridgeSocket } from '../src/bridge/server.ts'

const EXT_A = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const TAB = { tabId: 7, windowId: 2, title: 'Fixture', url: 'http://127.0.0.1:4173/' }

class FakeSocket implements BridgeSocket {
  sent: string[] = []
  closed = false
  private handlers: ((text: string) => void)[] = []
  private closeHandlers: (() => void)[] = []

  onMessage(handler: (text: string) => void): void {
    this.handlers.push(handler)
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler)
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const handler of this.closeHandlers) handler()
  }

  receive(text: string): void {
    for (const handler of this.handlers) handler(text)
  }

  frames(): BridgeFrame[] {
    return this.sent.map(text => JSON.parse(text) as BridgeFrame)
  }

  sentOf<T extends BridgeFrame['type']>(type: T): Extract<BridgeFrame, { type: T }> | undefined {
    return this.frames().find(frame => frame.type === type) as Extract<BridgeFrame, { type: T }> | undefined
  }
}

function makeServer(overrides: { toolTimeoutMs?: number } = {}): {
  server: BridgeServer
  pairing: PairingStore
  grants: GrantStore
} {
  const pairing = new PairingStore()
  const grants = new GrantStore()
  const server = new BridgeServer({
    pairing,
    grants,
    ...(overrides.toolTimeoutMs !== undefined ? { toolTimeoutMs: overrides.toolTimeoutMs } : {}),
  })
  return { server, pairing, grants }
}

/** Drive the hello handshake over a fake socket. */
async function connect(server: BridgeServer, pairing: PairingStore, socket = new FakeSocket(), origin = EXT_A): Promise<{ socket: FakeSocket; connectionId: string }> {
  server.attach(socket, origin)
  const nonce = pairing.issue(EXT_A)
  const hello: HelloFrame = { v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }
  socket.receive(JSON.stringify(hello))
  const ok = socket.sentOf('hello.ok')
  expect(ok).toBeDefined()
  return { socket, connectionId: (ok as { connectionId: string }).connectionId }
}

describe('bridge server', () => {
  it('requires the hello handshake before any other frame', () => {
    const { server } = makeServer()
    const socket = new FakeSocket()
    server.attach(socket, EXT_A)
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'pong' }))
    expect(socket.closed).toBe(true)
    expect(socket.frames().some(frame => frame.type === 'error')).toBe(true)
  })

  it('rejects a hello with an unknown pairing nonce', () => {
    const { server } = makeServer()
    const socket = new FakeSocket()
    server.attach(socket, EXT_A)
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: 'n'.repeat(32) }))
    expect(socket.closed).toBe(true)
  })

  it('rejects a hello whose nonce was issued for another origin', () => {
    const { server, pairing } = makeServer()
    const socket = new FakeSocket()
    server.attach(socket, EXT_B())
    const nonce = pairing.issue(EXT_A)
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }))
    expect(socket.closed).toBe(true)
  })

  it('replies pong to ping', async () => {
    const { server, pairing } = makeServer()
    const { socket } = await connect(server, pairing)
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ping' }))
    expect(socket.sentOf('pong')).toBeDefined()
  })

  it('correlates a tool call with its result and settles the promise', async () => {
    const { server, pairing } = makeServer()
    const { socket, connectionId } = await connect(server, pairing)
    const grantId = GrantId('g1')
    const pending = server.request(grantId, 'observe', {}, new AbortController().signal)
    const call = socket.sentOf('tool.call') as ToolCallFrame | undefined
    expect(call).toBeDefined()
    expect(call!.operation).toBe('observe')
    const result: ToolResultFrame = {
      v: PROTOCOL_VERSION,
      type: 'tool.result',
      requestId: call!.requestId,
      result: { ok: true, value: { page: { url: 'http://x/' }, nodes: [] } },
    }
    socket.receive(JSON.stringify(result))
    await expect(pending).resolves.toMatchObject({ page: { url: 'http://x/' } })
  })

  it('rejects the promise with the bridge error when the extension reports failure', async () => {
    const { server, pairing } = makeServer()
    const { socket } = await connect(server, pairing)
    const pending = server.request(GrantId('g1'), 'inspect', {}, new AbortController().signal)
    const call = socket.sentOf('tool.call') as ToolCallFrame | undefined
    const result: ToolResultFrame = {
      v: PROTOCOL_VERSION,
      type: 'tool.result',
      requestId: call!.requestId,
      result: { ok: false, error: { code: 'stale_element', message: 'gone', retryable: false } },
    }
    socket.receive(JSON.stringify(result))
    await expect(pending).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('rejects pending calls when the connection closes', async () => {
    const { server, pairing } = makeServer()
    const { socket } = await connect(server, pairing)
    const pending = server.request(GrantId('g1'), 'observe', {}, new AbortController().signal)
    socket.close()
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('a replacement connection closes the prior one and rejects its pending calls', async () => {
    const { server, pairing } = makeServer()
    const first = new FakeSocket()
    await connect(server, pairing, first)
    const pending = server.request(GrantId('g1'), 'observe', {}, new AbortController().signal)
    const second = new FakeSocket()
    await connect(server, pairing, second)
    expect(first.closed).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('aborts a pending call on signal abort', async () => {
    const { server, pairing } = makeServer()
    await connect(server, pairing)
    const controller = new AbortController()
    const pending = server.request(GrantId('g1'), 'observe', {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('times out a pending call', async () => {
    const { server, pairing } = makeServer({ toolTimeoutMs: 50 })
    const { socket } = await connect(server, pairing)
    const pending = server.request(GrantId('g1'), 'observe', {}, new AbortController().signal)
    expect(socket.sentOf('tool.call')).toBeDefined()
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects tool calls while disconnected', async () => {
    const { server } = makeServer()
    expect(() => server.request(GrantId('g1'), 'observe', {}, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: 'bridge_disconnected' }))
  })

  it('accepts grant offers and replies with a non-secret handle', async () => {
    const { server, pairing, grants } = makeServer()
    const { socket, connectionId } = await connect(server, pairing)
    const grantId = GrantId('g-put-1')
    const put: GrantPutFrame = {
      v: PROTOCOL_VERSION,
      type: 'grant.put',
      grantId,
      sessionId: 'session-a',
      tab: TAB,
      expiresAt: Date.now() + 30_000,
    }
    socket.receive(JSON.stringify(put))
    const accepted = socket.sentOf('grant.accepted')
    expect(accepted).toBeDefined()
    expect(accepted!.grantId).toBe(grantId)
    expect(accepted!.handle).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    const record = grants.consume(accepted!.handle, {
      connectionId: ConnectionId(connectionId), sessionId: 'session-a', turn: 1,
    })
    expect(record.grantId).toBe(grantId)
  })
})

function EXT_B(): string {
  return 'chrome-extension://bcdefghijklmnopqbcdefghijklmnopq'
}
