import { describe, expect, it } from 'vitest'
import {
  GrantId, PROTOCOL_VERSION, type BridgeFrame, type HelloFrame,
  type ToolCallFrame, type ToolResultFrame,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { GrantStore } from '../src/bridge/grant-store.ts'
import { PairingStore } from '../src/bridge/pairing-store.ts'
import { BridgeServer, type BridgeSocket } from '../src/bridge/server.ts'

const EXT_A = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const FIXTURE_URL = 'http://127.0.0.1:4173/'

class FakeSocket implements BridgeSocket {
  sent: string[] = []
  closed = false
  private messageHandlers: ((text: string) => void)[] = []
  private closeHandlers: (() => void)[] = []

  onMessage(handler: (text: string) => void): void { this.messageHandlers.push(handler) }
  onClose(handler: () => void): void { this.closeHandlers.push(handler) }
  send(text: string): void { this.sent.push(text) }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const handler of this.closeHandlers) handler()
  }
  receive(text: string): void { for (const handler of this.messageHandlers) handler(text) }
  frames(): BridgeFrame[] { return this.sent.map(text => JSON.parse(text) as BridgeFrame) }
  sentOf<T extends BridgeFrame['type']>(type: T): Extract<BridgeFrame, { type: T }> | undefined {
    return this.frames().find(frame => frame.type === type) as Extract<BridgeFrame, { type: T }> | undefined
  }
}

interface Fixture {
  server: BridgeServer
  pairing: PairingStore
  grants: GrantStore
  connectionId: string
  grantId: GrantId
  socket: FakeSocket
}

async function makeFixture(): Promise<Fixture> {
  const pairing = new PairingStore()
  const grants = new GrantStore()
  const server = new BridgeServer({ pairing, grants, toolTimeoutMs: 60_000, readRetryWaitMs: 120 })
  const socket = new FakeSocket()
  server.attach(socket, EXT_A)
  const nonce = pairing.issue(EXT_A)
  const hello: HelloFrame = { v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }
  socket.receive(JSON.stringify(hello))
  const ok = socket.sentOf('hello.ok') as { connectionId: string }
  const connectionId = ok.connectionId
  const grantId = GrantId('g-retry')
  grants.offer(connectionId, {
    grantId,
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
    tab: { tabId: 7, windowId: 2, title: 'Fixture', url: FIXTURE_URL },
  })
  return { server, pairing, grants, connectionId, grantId, socket }
}

function toolResultFor(requestId: string, value: unknown): string {
  const frame: ToolResultFrame = {
    v: PROTOCOL_VERSION,
    type: 'tool.result',
    requestId: requestId as never,
    result: { ok: true, value },
  }
  return JSON.stringify(frame)
}

function toolAcceptedFor(requestId: string): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'tool.accepted', requestId })
}

describe('bridge recovery', () => {
  it('retries one read after a newly authenticated connection appears', async () => {
    const fixture = await makeFixture()
    const { server, grantId } = fixture
    const firstSocket = fixture.socket
    const signal = new AbortController().signal
    const pending = server.request(grantId, 'observe', {}, signal)
    firstSocket.close()
    const secondSocket = new FakeSocket()
    server.acceptAuthenticated(secondSocket, fixture.connectionId as never)
    expect(secondSocket.frames().filter(frame => frame.type === 'tool.call')).toHaveLength(1)
    const call = secondSocket.sentOf('tool.call') as ToolCallFrame
    secondSocket.receive(toolResultFor(call.requestId, { page: { url: FIXTURE_URL } }))
    await expect(pending).resolves.toMatchObject({ page: { url: FIXTURE_URL } })
  })

  it('does not retry reads again after a second disconnect', async () => {
    const fixture = await makeFixture()
    const { server, grantId } = fixture
    const firstSocket = fixture.socket
    const pending = server.request(grantId, 'observe', {}, new AbortController().signal)
    firstSocket.close()
    const secondSocket = new FakeSocket()
    server.acceptAuthenticated(secondSocket, fixture.connectionId as never)
    expect(secondSocket.frames().filter(frame => frame.type === 'tool.call')).toHaveLength(1)
    secondSocket.close()
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('gives up a read retry after the bounded wait', async () => {
    const fixture = await makeFixture()
    const { server, grantId } = fixture
    const pending = server.request(grantId, 'observe', {}, new AbortController().signal)
    fixture.socket.close()
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it.each(['act', 'navigate'] as const)('never replays the %s operation', async operation => {
    const fixture = await makeFixture()
    const { server, grantId } = fixture
    const firstSocket = fixture.socket
    const args = operation === 'act'
      ? { action: { kind: 'click', selector: '#save' } }
      : { url: 'http://127.0.0.1:4173/next' }
    const pending = server.request(grantId, operation, args, new AbortController().signal)
    const firstCall = firstSocket.sentOf('tool.call') as ToolCallFrame
    firstSocket.receive(toolAcceptedFor(firstCall.requestId))
    firstSocket.close()
    const secondSocket = new FakeSocket()
    server.acceptAuthenticated(secondSocket, fixture.connectionId as never)
    expect(secondSocket.frames).not.toContainEqual(expect.objectContaining({ type: 'tool.call' }))
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('rejects writes on disconnect even without acknowledgement', async () => {
    const fixture = await makeFixture()
    const { server, grantId } = fixture
    const pending = server.request(grantId, 'act', { action: { kind: 'press', key: 'Enter' } }, new AbortController().signal)
    fixture.socket.close()
    const secondSocket = new FakeSocket()
    server.acceptAuthenticated(secondSocket, fixture.connectionId as never)
    expect(secondSocket.frames).not.toContainEqual(expect.objectContaining({ type: 'tool.call' }))
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('answers an exact duplicate request id from the execution journal', async () => {
    const fixture = await makeFixture()
    const { server, grantId } = fixture
    const firstSocket = fixture.socket
    const pending = server.request(grantId, 'observe', {}, new AbortController().signal)
    const call = firstSocket.sentOf('tool.call') as ToolCallFrame
    // The extension executed and answered; the host already settled.
    firstSocket.receive(toolResultFor(call.requestId, { page: { url: FIXTURE_URL } }))
    await expect(pending).resolves.toMatchObject({ page: { url: FIXTURE_URL } })
  })
})
