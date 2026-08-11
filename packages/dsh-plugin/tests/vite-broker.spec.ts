import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VITE_PAGE_PROTOCOL_VERSION,
  type BrowserTargetDescriptor,
  type GrantId,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { GrantStore } from '../src/bridge/grant-store.ts'
import { TargetCoordinator } from '../src/targets/coordinator.ts'
import { ProviderRegistry } from '../src/targets/provider-registry.ts'
import { ViteTargetBroker, type ViteSocket } from '../src/vite/broker.ts'
import type { TargetBinding } from '../src/targets/types.ts'

const ORIGIN = 'http://127.0.0.1:5173'
/** Brokers created by fixtures, disposed in afterEach (fake timers). */
const createdBrokers: ViteTargetBroker[] = []

class FakeSocket implements ViteSocket {
  sent: string[] = []
  closed = false
  private handlers: ((text: string) => void)[] = []
  private closeHandlers: (() => void)[] = []

  onMessage(handler: (text: string) => void): void { this.handlers.push(handler) }
  onClose(handler: () => void): void { this.closeHandlers.push(handler) }
  send(text: string): void { this.sent.push(text) }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const handler of this.closeHandlers) handler()
  }
  receive(text: string): void { for (const handler of this.handlers) handler(text) }
  frames(): Array<Record<string, unknown>> { return this.sent.map(text => JSON.parse(text) as Record<string, unknown>) }
  sentOf<T extends string>(type: T): Extract<Record<string, unknown>, { type: T }> | undefined {
    return this.frames().find(frame => frame.type === type) as never
  }
}

interface Fixture {
  broker: ViteTargetBroker
  coordinator: TargetCoordinator
  grants: GrantStore
  registerPage(socket: FakeSocket, target?: Partial<BrowserTargetDescriptor>): { targetId: string; binding: TargetBinding | undefined }
  registerPageChecked(socket: FakeSocket, target?: Partial<BrowserTargetDescriptor>): { targetId: string; binding: TargetBinding }
  offerGrant(targetId: string, sessionId?: string): GrantId
}

function makeFixture(): Fixture {
  const grants = new GrantStore()
  const registry = new ProviderRegistry()
  const coordinator = new TargetCoordinator({ providers: registry, grants })
  const broker = new ViteTargetBroker({ coordinator })
  registry.register(broker)
  createdBrokers.push(broker)
  const registerPage = (socket: FakeSocket, target: Partial<BrowserTargetDescriptor> = {}) => {
    const targetId = (target.targetId ?? 't'.repeat(43)) as never
    const descriptor = {
      targetId,
      provider: 'vite',
      title: 'Vite Page',
      url: 'http://127.0.0.1:5173/',
      origin: ORIGIN,
      projectId: 'app',
      generation: 0,
      capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      ...target,
    }
    broker.attach(socket, descriptor.origin)
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'target.register', target: descriptor }))
    return { targetId: targetId as never, binding: broker.bindingFor(targetId as never) }
  }
  const registerPageChecked = (socket: FakeSocket, target: Partial<BrowserTargetDescriptor> = {}) => {
    const result = registerPage(socket, target)
    if (result.binding === undefined) throw new Error('target did not register')
    return result
  }
  const offerGrant = (targetId: string, sessionId = 'session-a'): GrantId => {
    const binding = broker.bindingFor(targetId as never)
    if (binding === undefined) throw new Error('no live target')
    return coordinator.offer({ sessionId, expiresAt: Date.now() + 60_000, target: binding }).grantId
  }
  return { broker, coordinator, grants, registerPage, registerPageChecked, offerGrant }
}

function sendPageFrame(socket: FakeSocket, frame: Record<string, unknown>): void {
  socket.receive(JSON.stringify(frame))
}

describe('vite target broker', () => {
  afterEach(() => {
    for (const broker of createdBrokers.splice(0)) broker.dispose()
    vi.useRealTimers()
  })

  it('registers a page and rejects host-shaped frames by closing that connection', () => {
    const { registerPage } = makeFixture()
    const socket = new FakeSocket()
    registerPage(socket)
    sendPageFrame(socket, { v: VITE_PAGE_PROTOCOL_VERSION, type: 'tool.call', requestId: 'r'.repeat(32), operation: 'observe', args: {} })
    expect(socket.closed).toBe(true)
  })

  it('rejects grant.put, target.revoke, and error frames from a page', () => {
    const { registerPage } = makeFixture()
    const hostShaped = [
      { v: VITE_PAGE_PROTOCOL_VERSION, type: 'grant.put', grantId: 'g'.repeat(32), sessionId: 's', tab: {}, expiresAt: 1 },
      { v: VITE_PAGE_PROTOCOL_VERSION, type: 'target.revoke' },
      { v: VITE_PAGE_PROTOCOL_VERSION, type: 'error', code: 'internal', message: 'x', retryable: false },
    ]
    for (const frame of hostShaped) {
      const socket = new FakeSocket()
      registerPage(socket)
      sendPageFrame(socket, frame)
      expect(socket.closed).toBe(true)
    }
  })

  it('rejects an unknown protocol version before registration', () => {
    const { broker } = makeFixture()
    const socket = new FakeSocket()
    broker.attach(socket, ORIGIN)
    socket.receive(JSON.stringify({ v: 99, type: 'hello' }))
    expect(socket.closed).toBe(true)
    expect(socket.frames().some(frame => frame.type === 'error')).toBe(true)
  })

  it('enforces the total target limit (32) and the per-origin limit (8)', () => {
    const { broker, registerPage } = makeFixture()
    const sockets: FakeSocket[] = []
    for (let index = 0; index < 32; index += 1) {
      const socket = new FakeSocket()
      registerPage(socket, {
        targetId: `${'a'.repeat(30)}${String(index).padStart(2, '0')}`,
        origin: `http://127.0.0.1:${6000 + Math.floor(index / 8)}`,
        url: `http://127.0.0.1:${6000 + Math.floor(index / 8)}/`,
      })
      sockets.push(socket)
    }
    const extra = new FakeSocket()
    registerPage(extra, { targetId: 'b'.repeat(43), origin: 'http://127.0.0.1:9999', url: 'http://127.0.0.1:9999/' })
    expect(extra.closed).toBe(true)
    expect(broker.liveTargetCount()).toBe(32)
  })

  it('enforces the per-origin limit of 8 targets', () => {
    const { broker, registerPage } = makeFixture()
    const sockets: FakeSocket[] = []
    for (let index = 0; index < 8; index += 1) {
      const socket = new FakeSocket()
      registerPage(socket, { targetId: `${'a'.repeat(30)}${String(index).padStart(2, '0')}` })
      sockets.push(socket)
    }
    const ninth = new FakeSocket()
    registerPage(ninth, { targetId: 'c'.repeat(43) })
    expect(ninth.closed).toBe(true)
    expect(broker.liveTargetCount()).toBe(8)
  })

  it('closes a connection on an oversized frame (1 MiB)', () => {
    const { registerPage } = makeFixture()
    const socket = new FakeSocket()
    registerPage(socket)
    socket.receive('x'.repeat(1_048_577))
    expect(socket.closed).toBe(true)
  })

  it('enforces the frame rate limit of 16 non-heartbeat frames per second', () => {
    vi.useFakeTimers()
    const { registerPage } = makeFixture()
    const socket = new FakeSocket()
    registerPage(socket)
    for (let index = 0; index < 16; index += 1) {
      sendPageFrame(socket, { v: VITE_PAGE_PROTOCOL_VERSION, type: 'ping' })
      socket.sent.length = 0
      sendPageFrame(socket, { v: VITE_PAGE_PROTOCOL_VERSION, type: 'pong' })
    }
    // Heartbeat frames do not count toward the limit.
    expect(socket.closed).toBe(false)
    const update = (generation: number): Record<string, unknown> => ({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.update',
      target: {
        targetId: 't'.repeat(43),
        provider: 'vite',
        title: 'Vite Page',
        url: 'http://127.0.0.1:5173/',
        origin: ORIGIN,
        projectId: 'app',
        generation,
        capabilities: ['observe'],
      },
    })
    for (let index = 0; index < 16; index += 1) {
      sendPageFrame(socket, update(index))
    }
    expect(socket.closed).toBe(false)
    // The 17th non-heartbeat frame in the same second closes the connection.
    sendPageFrame(socket, update(16))
    expect(socket.closed).toBe(true)
  })

  it('enforces the 45-second disconnect default and keeps a bounded reconnect tombstone', () => {
    vi.useFakeTimers()
    const { broker, registerPageChecked } = makeFixture()
    const socket = new FakeSocket()
    const { targetId, binding } = registerPageChecked(socket)
    vi.advanceTimersByTime(46_000)
    expect(socket.closed).toBe(true)
    // A reconnect within the recovery window rebinds the same logical target.
    const second = new FakeSocket()
    broker.attach(second, ORIGIN)
    second.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    second.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: { ...binding.descriptor },
    }))
    expect(second.closed).toBe(false)
    expect(broker.bindingFor(targetId)?.connectionId).toBe(binding.connectionId)
  })

  it('revokes the logical target and its grants when the reconnect window expires', () => {
    vi.useFakeTimers()
    const { coordinator, registerPage, offerGrant } = makeFixture()
    const socket = new FakeSocket()
    const { targetId } = registerPage(socket)
    const grantId = offerGrant(targetId)
    vi.advanceTimersByTime(46_000)
    socket.close()
    vi.advanceTimersByTime(46_000)
    // The window expired: grants of the logical target are revoked.
    expect(() => coordinator.request(grantId, 'observe', {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'grant_expired' })
  })

  it('rejects a second connection taking over a live target', () => {
    const { registerPage } = makeFixture()
    const first = new FakeSocket()
    registerPage(first)
    const second = new FakeSocket()
    registerPage(second)
    expect(second.closed).toBe(true)
    expect(first.closed).toBe(false)
  })

  it('strips query and fragment from registered metadata before model exposure', () => {
    const { registerPageChecked } = makeFixture()
    const socket = new FakeSocket()
    const { binding } = registerPageChecked(socket, {
      url: 'http://127.0.0.1:5173/app?secret=1&x=2#frag',
    })
    expect(binding.descriptor.url).toBe('http://127.0.0.1:5173/app')
    expect(binding.descriptor.url).not.toContain('secret')
  })

  it('masks sensitive values in page results and bounds error text before model exposure', async () => {
    const { registerPage, offerGrant, coordinator } = makeFixture()
    const socket = new FakeSocket()
    const { targetId } = registerPage(socket)
    const grantId = offerGrant(targetId)
    const pending = coordinator.request(grantId, 'observe', {}, new AbortController().signal)
    const call = socket.frames().find(frame => frame.type === 'tool.call') as { requestId: string }
    sendPageFrame(socket, {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.result',
      requestId: call.requestId,
      result: { ok: true, value: { nodes: [{ name: 'Save' }], token: 'super-secret-token', nested: { password: 'hunter2-secret' } } },
    })
    const value = await pending
    expect(JSON.stringify(value)).not.toContain('super-secret-token')
    expect(JSON.stringify(value)).not.toContain('hunter2-secret')
    // The key names may survive; the VALUES never do.
    expect(JSON.stringify(value)).toContain('"token":"[REDACTED]"')
  })

  it('rejects a fifth concurrent call on one target', async () => {
    const { registerPage, offerGrant, coordinator } = makeFixture()
    const socket = new FakeSocket()
    const { targetId } = registerPage(socket)
    const grantId = offerGrant(targetId)
    const controller = new AbortController()
    const calls = [1, 2, 3, 4].map(() => coordinator.request(grantId, 'observe', {}, controller.signal))
    await expect(coordinator.request(grantId, 'observe', {}, controller.signal))
      .rejects.toMatchObject({ code: 'timeout' })
    // Settle the four in-flight calls so the fixture does not leak.
    for (const call of socket.frames().filter(frame => frame.type === 'tool.call')) {
      sendPageFrame(socket, {
        v: VITE_PAGE_PROTOCOL_VERSION,
        type: 'tool.result',
        requestId: (call as { requestId: string }).requestId,
        result: { ok: true, value: {} },
      })
    }
    await Promise.all(calls)
  })

  it('emits one correlated tool.cancel on abort and settles idempotently', async () => {
    const { registerPage, offerGrant, coordinator } = makeFixture()
    const socket = new FakeSocket()
    const { targetId } = registerPage(socket)
    const grantId = offerGrant(targetId)
    const controller = new AbortController()
    const pending = coordinator.request(grantId, 'observe', {}, controller.signal)
    const call = socket.frames().find(frame => frame.type === 'tool.call') as { requestId: string }
    controller.abort()
    await expect(pending).rejects.toBeTruthy()
    const cancels = socket.frames().filter(frame => frame.type === 'tool.cancel')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]).toMatchObject({ requestId: call.requestId, reason: 'cancelled' })
    // A late result for the settled call is ignored (no replay, no crash).
    sendPageFrame(socket, {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.result',
      requestId: call.requestId,
      result: { ok: true, value: { late: true } },
    })
    // A second abort emits nothing more.
    expect(socket.frames().filter(frame => frame.type === 'tool.cancel')).toHaveLength(1)
  })

  it('retries an unaccepted read at most once after a legal rebind and never replays accepted or mutating calls', async () => {
    vi.useFakeTimers()
    const { broker, registerPageChecked, offerGrant, coordinator } = makeFixture()
    const first = new FakeSocket()
    const { targetId, binding } = registerPageChecked(first)
    const grantId = offerGrant(targetId)
    // A WRITE is never replayed, even unaccepted.
    const write = coordinator.request(grantId, 'act', { action: { kind: 'click', selector: '#x' } }, new AbortController().signal)
    first.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'tool.accepted', requestId: (first.frames().find(f => f.type === 'tool.call') as { requestId: string }).requestId }))
    const read = coordinator.request(grantId, 'observe', {}, new AbortController().signal)
    const readCall = first.frames().find(f => f.type === 'tool.call') as { requestId: string }
    first.close()
    await expect(write).rejects.toMatchObject({ code: 'target_disconnected' })
    // The read stays pending: it may retry once after a legal rebind.
    const second = new FakeSocket()
    broker.attach(second, ORIGIN)
    second.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    second.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: { ...binding.descriptor },
    }))
    // Exactly one retried read call on the new connection; the accepted
    // write is never replayed.
    const retried = second.frames().filter(frame => frame.type === 'tool.call')
    expect(retried).toHaveLength(1)
    expect(retried[0]!.requestId).not.toBe(readCall.requestId)
    sendPageFrame(second, {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.result',
      requestId: retried[0]!.requestId as string,
      result: { ok: true, value: { page: { url: 'http://127.0.0.1:5173/' } } },
    })
    await expect(read).resolves.toMatchObject({ page: { url: 'http://127.0.0.1:5173/' } })
    // A second disconnect settles the read without a second retry once the
    // reconnect window expires (the grant dies with the revoked target).
    const read2 = coordinator.request(grantId, 'observe', {}, new AbortController().signal)
    second.close()
    vi.advanceTimersByTime(91_000)
    await expect(read2).rejects.toMatchObject({ code: 'grant_expired' })
    vi.useRealTimers()
  })

  it('revokes the logical target on origin change instead of entering the reconnect window', () => {
    const { broker, registerPageChecked, offerGrant, coordinator } = makeFixture()
    const socket = new FakeSocket()
    const { targetId, binding } = registerPageChecked(socket)
    const grantId = offerGrant(targetId)
    socket.close()
    // The page left for a DIFFERENT loopback origin: the old logical target
    // is revoked, not rebound. (Remote origins are rejected earlier by the
    // loopback allowlist.)
    const other = new FakeSocket()
    broker.attach(other, 'http://127.0.0.1:5174')
    other.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    other.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: { ...binding.descriptor, origin: 'http://127.0.0.1:5174', url: 'http://127.0.0.1:5174/' },
    }))
    expect(other.closed).toBe(false)
    // The old origin's grants are revoked, not rebound.
    expect(() => coordinator.request(grantId, 'observe', {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'grant_expired' })
  })

  it('resolves live targets for grant issuance', () => {
    const { registerPageChecked, offerGrant } = makeFixture()
    const socket = new FakeSocket()
    const { targetId, binding } = registerPageChecked(socket)
    expect(offerGrant(targetId)).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    expect(binding.descriptor.provider).toBe('vite')
  })
})

describe('vite target broker review fixes', () => {
  afterEach(() => {
    for (const broker of createdBrokers.splice(0)) broker.dispose()
    vi.useRealTimers()
  })

  it('locks the registered identity: target.update cannot change targetId or origin', () => {
    const fixture = makeFixture()
    const { registerPageChecked } = fixture
    const socket = new FakeSocket()
    const { binding } = registerPageChecked(socket)
    const updated = { ...binding.descriptor, title: 'New Title' }
    sendPageFrame(socket, {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.update',
      target: updated,
    })
    expect(socket.closed).toBe(false)
    expect(fixture.broker.liveTargets()[0]!.title).toBe('New Title')
    // Identity drift in either field closes the connection.
    for (const tampered of [
      { ...binding.descriptor, origin: 'https://other.example', url: 'https://other.example/' },
      { ...binding.descriptor, targetId: 'x'.repeat(43) },
    ]) {
      const other = new FakeSocket()
      registerPageChecked(other, { targetId: binding.descriptor.targetId, origin: binding.descriptor.origin })
      sendPageFrame(other, {
        v: VITE_PAGE_PROTOCOL_VERSION,
        type: 'target.update',
        target: tampered,
      })
      expect(other.closed).toBe(true)
    }
  })

  it('never dispatches a tool.call for an already-aborted request', async () => {
    const { registerPageChecked, offerGrant, coordinator } = makeFixture()
    const socket = new FakeSocket()
    const { targetId } = registerPageChecked(socket)
    const grantId = offerGrant(targetId)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(coordinator.request(grantId, 'act', { action: { kind: 'click', selector: '#x' } }, controller.signal))
      .rejects.toThrow('cancelled')
    expect(socket.frames().filter(frame => frame.type === 'tool.call')).toHaveLength(0)
  })

  it('times out a call the page never answers and emits one tool.cancel', async () => {
    vi.useFakeTimers()
    const grants = new GrantStore()
    const registry = new ProviderRegistry()
    const coordinator = new TargetCoordinator({ providers: registry, grants })
    const broker = new ViteTargetBroker({ coordinator, toolTimeoutMs: 50 })
    registry.register(broker)
    createdBrokers.push(broker)
    const socket = new FakeSocket()
    broker.attach(socket, ORIGIN)
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: {
        targetId: 't'.repeat(43),
        provider: 'vite',
        title: 'Vite Page',
        url: 'http://127.0.0.1:5173/',
        origin: ORIGIN,
        projectId: 'app',
        generation: 0,
        capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      },
    }))
    const binding = broker.bindingFor('t'.repeat(43) as never)!
    const grantId = coordinator.offer({ sessionId: 's', expiresAt: Date.now() + 60_000, target: binding }).grantId
    const pending = coordinator.request(grantId, 'observe', {}, new AbortController().signal)
    vi.advanceTimersByTime(60)
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
    const cancels = socket.frames().filter(frame => frame.type === 'tool.cancel')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]).toMatchObject({ reason: 'timeout' })
    vi.useRealTimers()
  })

  it('rejects a registration whose handshake origin does not match the declared origin', () => {
    const { broker } = makeFixture()
    const socket = new FakeSocket()
    broker.attach(socket, 'http://localhost:5173')
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: {
        targetId: 't'.repeat(43),
        provider: 'vite',
        title: 'Vite Page',
        url: 'http://127.0.0.1:5173/',
        origin: ORIGIN,
        projectId: 'app',
        generation: 0,
        capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      },
    }))
    expect(socket.closed).toBe(true)
    expect(socket.sentOf('error')).toMatchObject({ code: 'permission_denied' })
    expect(broker.liveTargetCount()).toBe(0)
  })

  it('rejects a registration without a connection origin (missing Origin header)', () => {
    const { broker } = makeFixture()
    const socket = new FakeSocket()
    broker.attach(socket, '')
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: {
        targetId: 't'.repeat(43),
        provider: 'vite',
        title: 'Vite Page',
        url: 'http://127.0.0.1:5173/',
        origin: ORIGIN,
        projectId: 'app',
        generation: 0,
        capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      },
    }))
    expect(socket.closed).toBe(true)
    expect(socket.sentOf('error')).toMatchObject({ code: 'permission_denied' })
    expect(broker.liveTargetCount()).toBe(0)
  })

  it('rejects a target registered from a non-loopback origin by default', () => {
    const { broker } = makeFixture()
    const socket = new FakeSocket()
    broker.attach(socket, 'https://other.example')
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: {
        targetId: 't'.repeat(43),
        provider: 'vite',
        title: 'Remote Page',
        url: 'https://other.example/',
        origin: 'https://other.example',
        projectId: 'app',
        generation: 0,
        capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      },
    }))
    expect(socket.closed).toBe(true)
    expect(socket.sentOf('error')).toMatchObject({ code: 'permission_denied' })
    expect(broker.liveTargetCount()).toBe(0)
  })

  it('admits a non-loopback origin explicitly listed in allowedOrigins', () => {
    const grants = new GrantStore()
    const registry = new ProviderRegistry()
    const coordinator = new TargetCoordinator({ providers: registry, grants })
    const broker = new ViteTargetBroker({ coordinator, allowedOrigins: ['https://other.example'] })
    registry.register(broker)
    createdBrokers.push(broker)
    const socket = new FakeSocket()
    broker.attach(socket, 'https://other.example')
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: {
        targetId: 't'.repeat(43),
        provider: 'vite',
        title: 'Remote Page',
        url: 'https://other.example/',
        origin: 'https://other.example',
        projectId: 'app',
        generation: 0,
        capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      },
    }))
    expect(socket.closed).toBe(false)
    expect(broker.liveTargetCount()).toBe(1)
  })

  it('settles a disconnected read by its call timeout even while tombstoned', async () => {
    vi.useFakeTimers()
    const grants = new GrantStore()
    const registry = new ProviderRegistry()
    const coordinator = new TargetCoordinator({ providers: registry, grants })
    const broker = new ViteTargetBroker({ coordinator, toolTimeoutMs: 20_000 })
    registry.register(broker)
    createdBrokers.push(broker)
    const socket = new FakeSocket()
    broker.attach(socket, ORIGIN)
    socket.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    socket.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: {
        targetId: 't'.repeat(43),
        provider: 'vite',
        title: 'Vite Page',
        url: 'http://127.0.0.1:5173/',
        origin: ORIGIN,
        projectId: 'app',
        generation: 0,
        capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      },
    }))
    const binding = broker.bindingFor('t'.repeat(43) as never)!
    const grantId = coordinator.offer({ sessionId: 's', expiresAt: Date.now() + 60_000, target: binding }).grantId
    const pending = coordinator.request(grantId, 'observe', {}, new AbortController().signal)
    socket.close()
    vi.advanceTimersByTime(21_000)
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
    const cancels = socket.frames().filter(frame => frame.type === 'tool.cancel')
    expect(cancels).toHaveLength(1)
    vi.useRealTimers()
  })

  it('a revoked grant never retries a tombstoned read after a legal rebind', async () => {
    vi.useFakeTimers()
    const { broker, registerPageChecked, offerGrant, coordinator } = makeFixture()
    const first = new FakeSocket()
    const { targetId, binding } = registerPageChecked(first)
    const grantId = offerGrant(targetId)
    const read = coordinator.request(grantId, 'observe', {}, new AbortController().signal)
    first.close()
    // The grant is revoked while the target is disconnected: its unaccepted
    // read must settle in the tombstone, never retry after a rebind.
    coordinator.revokeTarget({ targetId: targetId as never, origin: ORIGIN })
    await expect(read).rejects.toMatchObject({ code: 'grant_expired' })
    const second = new FakeSocket()
    broker.attach(second, ORIGIN)
    second.receive(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
    second.receive(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: { ...binding.descriptor },
    }))
    expect(second.closed).toBe(false)
    expect(second.frames().filter(frame => frame.type === 'tool.call')).toHaveLength(0)
    vi.useRealTimers()
  })
})
