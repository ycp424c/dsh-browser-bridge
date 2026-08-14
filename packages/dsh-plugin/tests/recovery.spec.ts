import { describe, expect, it } from 'vitest'
import {
  GrantId, PROTOCOL_VERSION, type BridgeFrame, type HelloFrame,
  type ToolCallFrame, type ToolResultFrame,
} from '@ycp424c/dsh-browser-bridge-protocol'
import { GrantStore } from '../src/bridge/grant-store.ts'
import { PairingStore } from '../src/bridge/pairing-store.ts'
import { BridgeServer, type BridgeSocket } from '../src/bridge/server.ts'
import { TargetCoordinator } from '../src/targets/coordinator.ts'
import { ProviderRegistry } from '../src/targets/provider-registry.ts'
import type { TargetBinding } from '../src/targets/types.ts'

const EXT_A = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const EXT_B = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
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
  const registry = new ProviderRegistry()
  const coordinator = new TargetCoordinator({ providers: registry, grants })
  const server = new BridgeServer({ pairing, coordinator, toolTimeoutMs: 60_000, readRetryWaitMs: 120 })
  registry.register(server)
  const socket = new FakeSocket()
  server.attach(socket, EXT_A)
  const nonce = pairing.issue(EXT_A)
  const hello: HelloFrame = { v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }
  socket.receive(JSON.stringify(hello))
  const ok = socket.sentOf('hello.ok') as { connectionId: string }
  const connectionId = ok.connectionId
  const grantId = GrantId('g-retry')
  const target: TargetBinding = {
    descriptor: {
      targetId: 't'.repeat(43),
      provider: 'chrome-extension',
      title: 'Fixture',
      url: FIXTURE_URL,
      origin: 'http://127.0.0.1:4173',
      generation: 0,
      capabilities: ['observe', 'inspect', 'screenshot', 'act', 'navigate', 'wait', 'console', 'network'],
    },
    connectionId: connectionId as never,
    logicalKey: 'chrome:2:7',
  }
  coordinator.offerWithId(grantId, {
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
    target,
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
    const pending = server.requestGrant(grantId, 'observe', {}, signal)
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
    const pending = server.requestGrant(grantId, 'observe', {}, new AbortController().signal)
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
    const pending = server.requestGrant(grantId, 'observe', {}, new AbortController().signal)
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
    const pending = server.requestGrant(grantId, operation, args, new AbortController().signal)
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
    const pending = server.requestGrant(grantId, 'act', { action: { kind: 'press', key: 'Enter' } }, new AbortController().signal)
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
    const pending = server.requestGrant(grantId, 'observe', {}, new AbortController().signal)
    const call = firstSocket.sentOf('tool.call') as ToolCallFrame
    // The extension executed and answered; the host already settled.
    firstSocket.receive(toolResultFor(call.requestId, { page: { url: FIXTURE_URL } }))
    await expect(pending).resolves.toMatchObject({ page: { url: FIXTURE_URL } })
  })

  it('reuses the connection id across a same-origin reconnect (transient)', async () => {
    const fixture = await makeFixture()
    const { server, pairing, connectionId, socket: firstSocket } = fixture
    firstSocket.close()
    const secondSocket = new FakeSocket()
    server.attach(secondSocket, EXT_A)
    const nonce = pairing.issue(EXT_A)
    secondSocket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }))
    const ok = secondSocket.sentOf('hello.ok') as { connectionId: string }
    // A transient reconnect resumes the SAME logical session: grants and
    // tools bound to the old connection id keep working.
    expect(ok.connectionId).toBe(connectionId)
  })

  it('terminal dispose revokes grants, notifies the extension, and rejects pending calls', async () => {
    const fixture = await makeFixture()
    const { server, grants, grantId, socket } = fixture
    const pending = server.requestGrant(grantId, 'observe', {}, new AbortController().signal)
    server.dispose()
    // Every grant of the connection is gone on both sides: the store is
    // empty and the extension received grant.revoke before the socket closed.
    expect(grants.revokeConnection(fixture.connectionId)).toEqual([])
    expect(socket.frames().filter(frame => frame.type === 'grant.revoke'))
      .toContainEqual(expect.objectContaining({ grantId }))
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('a foreign takeover revokes the prior grants and never retries its reads', async () => {
    const fixture = await makeFixture()
    const { server, pairing, grants, grantId, socket: firstSocket } = fixture
    const pending = server.requestGrant(grantId, 'observe', {}, new AbortController().signal)
    const secondSocket = new FakeSocket()
    server.attach(secondSocket, EXT_B)
    const nonce = pairing.issue(EXT_B)
    secondSocket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }))
    // The prior session is terminal: grants revoked and notified...
    expect(grants.revokeConnection(fixture.connectionId)).toEqual([])
    expect(firstSocket.frames().filter(frame => frame.type === 'grant.revoke'))
      .toContainEqual(expect.objectContaining({ grantId }))
    expect(firstSocket.closed).toBe(true)
    // ...and the foreign connection never observes the old session's reads.
    expect(secondSocket.frames().filter(frame => frame.type === 'tool.call')).toHaveLength(0)
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('keeps grants and a fresh logical session after a foreign takeover replaces the old one', async () => {
    const fixture = await makeFixture()
    const { server, pairing, connectionId, socket: firstSocket } = fixture
    firstSocket.close()
    // EXT_B reconnects: a different extension is a NEW logical session and
    // must receive a different connection id.
    const secondSocket = new FakeSocket()
    server.attach(secondSocket, EXT_B)
    const nonce = pairing.issue(EXT_B)
    secondSocket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }))
    const ok = secondSocket.sentOf('hello.ok') as { connectionId: string }
    expect(ok.connectionId).not.toBe(connectionId)
  })

  it('queues turn revocations during a disconnect and flushes them before work resumes on a same-origin reconnect', async () => {
    const fixture = await makeFixture()
    const { server, pairing, grants, connectionId, grantId, socket: firstSocket } = fixture
    // The turn consumed the grant (pre-step), so turn cleanup owns it.
    const record = grants.resolve(grantId)
    grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 1 })
    // Attach the CDP session: the extension is active on this grant.
    const pending = server.requestGrant(grantId, 'observe', {}, new AbortController().signal)
    firstSocket.receive(toolAcceptedFor((firstSocket.sentOf('tool.call') as ToolCallFrame).requestId))
    // The socket drops TRANSIENTLY: the logical session survives, but the
    // extension can no longer receive frames.
    firstSocket.close()
    // The turn stops while disconnected: the grant is revoked locally and
    // must be delivered once the same extension reconnects.
    expect(server.revokeTurn(connectionId, 'session-a', 1)).toEqual([grantId])
    expect(grants.revokeConnection(fixture.connectionId)).toEqual([])
    // The in-flight read was cancelled by the turn cleanup.
    await expect(pending).rejects.toMatchObject({ code: 'grant_expired' })
    // A same-origin reconnect with a fresh nonce resumes the SAME session.
    const secondSocket = new FakeSocket()
    server.attach(secondSocket, EXT_A)
    const nonce = pairing.issue(EXT_A)
    secondSocket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }))
    const ok = secondSocket.sentOf('hello.ok') as { connectionId: string }
    expect(ok.connectionId).toBe(fixture.connectionId)
    // The queued grant.revoke is flushed BEFORE any retried or new work:
    // the extension must drop the grant and detach CDP before it can serve
    // another tool call.
    const frames = secondSocket.frames()
    const revokeIndex = frames.findIndex(frame => frame.type === 'grant.revoke')
    expect(revokeIndex).toBeGreaterThanOrEqual(0)
    expect(frames[revokeIndex]).toMatchObject({ grantId })
    const toolIndex = frames.findIndex(frame => frame.type === 'tool.call')
    if (toolIndex >= 0) expect(revokeIndex).toBeLessThan(toolIndex)
  })

  it('revokeTurn rejects pending calls of the revoked grants immediately and never replays them', async () => {
    const fixture = await makeFixture()
    const { server, grants, connectionId, grantId, socket: firstSocket } = fixture
    const record = grants.resolve(grantId)
    grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 1 })
    const pending = server.requestGrant(grantId, 'observe', {}, new AbortController().signal)
    firstSocket.receive(toolAcceptedFor((firstSocket.sentOf('tool.call') as ToolCallFrame).requestId))
    // The socket drops and the read retry window is armed...
    firstSocket.close()
    // ...but the turn ends before any reconnect: the pending read must be
    // cancelled NOW, not retried against the resumed session.
    server.revokeTurn(connectionId, 'session-a', 1)
    await expect(pending).rejects.toMatchObject({ code: 'grant_expired' })
    // A same-origin reconnect retries NOTHING: no replay of the cancelled
    // read (and never a replay of a write).
    const secondSocket = new FakeSocket()
    server.acceptAuthenticated(secondSocket, fixture.connectionId as never)
    expect(secondSocket.frames().filter(frame => frame.type === 'tool.call')).toHaveLength(0)
  })

  it('a foreign takeover still fails closed when turn revocations were queued', async () => {
    const fixture = await makeFixture()
    const { server, pairing, grants, connectionId, grantId, socket: firstSocket } = fixture
    const record = grants.resolve(grantId)
    grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 1 })
    firstSocket.close()
    server.revokeTurn(connectionId, 'session-a', 1)
    expect(grants.revokeConnection(fixture.connectionId)).toEqual([])
    // EXT_B takes the session over: it must NEVER receive the old session's
    // queued revocations or work (it is a different logical session).
    const secondSocket = new FakeSocket()
    server.attach(secondSocket, EXT_B)
    const nonce = pairing.issue(EXT_B)
    secondSocket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }))
    expect(secondSocket.frames().filter(frame => frame.type === 'grant.revoke')).toHaveLength(0)
    expect(secondSocket.frames().filter(frame => frame.type === 'tool.call')).toHaveLength(0)
    // The old extension cannot resume the old id either: its reconnect gets
    // a fresh logical session (its sessionChanged revokes locally).
    const thirdSocket = new FakeSocket()
    server.attach(thirdSocket, EXT_A)
    const nonceA = pairing.issue(EXT_A)
    thirdSocket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonceA }))
    const ok = thirdSocket.sentOf('hello.ok') as { connectionId: string }
    expect(ok.connectionId).not.toBe(connectionId)
    expect(thirdSocket.frames().filter(frame => frame.type === 'grant.revoke')).toHaveLength(0)
  })
})
