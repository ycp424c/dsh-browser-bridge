import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResilientPanelPort, type ResilientPanelPortOptions } from '../src/bridge/resilient-panel-port.ts'

type Listener<T> = (value: T) => void

class FakeEvent<T> {
  private readonly listeners = new Set<Listener<T>>()

  addListener = (listener: Listener<T>): void => { this.listeners.add(listener) }
  removeListener = (listener: Listener<T>): void => { this.listeners.delete(listener) }
  emit(value: T): void { for (const listener of [...this.listeners]) listener(value) }

  get size(): number { return this.listeners.size }
}

class FakePort {
  readonly onMessage = new FakeEvent<unknown>()
  readonly onDisconnect = new FakeEvent<chrome.runtime.Port>()
  disconnected = false
  sent: unknown[] = []

  postMessage(message: unknown): void {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object')
    this.sent.push(message)
  }

  disconnect(): void {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object')
    this.disconnected = true
    this.onDisconnect.emit(this as unknown as chrome.runtime.Port)
  }

  fail(): void {
    this.disconnected = true
    this.onDisconnect.emit(this as unknown as chrome.runtime.Port)
  }
}

/** Port whose `postMessage` throws for selected messages (a port dying mid-send). */
class FlakyPort extends FakePort {
  constructor(private readonly failOn: (message: unknown) => boolean) { super() }

  override postMessage(message: unknown): void {
    if (this.failOn(message)) throw new Error('Attempting to use a disconnected port object')
    super.postMessage(message)
  }
}

describe('resilient panel port', () => {
  let ports: FakePort[]

  beforeEach(() => {
    vi.useFakeTimers()
    ports = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(overrides: Partial<ResilientPanelPortOptions> = {}) {
    const received: unknown[] = []
    let reconnecting = 0
    const port = new ResilientPanelPort({
      connect: () => {
        const fake = new FakePort()
        ports.push(fake)
        return fake as unknown as chrome.runtime.Port
      },
      onMessage: message => { received.push(message) },
      onReconnecting: () => { reconnecting += 1 },
      ...overrides,
    })
    return {
      port,
      received,
      reconnectCount: (): number => reconnecting,
    }
  }

  it('opens one port and forwards inbound messages', () => {
    const { port, received } = setup()
    port.open()
    expect(ports).toHaveLength(1)
    ports[0]!.onMessage.emit({ type: 'bridge.status', state: 'connected' })
    expect(received).toEqual([{ type: 'bridge.status', state: 'connected' }])
  })

  it('reconnects with bounded backoff after a disconnect', async () => {
    const { port, reconnectCount } = setup()
    port.open()
    ports[0]!.fail()
    expect(reconnectCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ports).toHaveLength(2)
  })

  it('does not reconnect after dispose', async () => {
    const { port } = setup()
    port.open()
    ports[0]!.fail()
    port.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ports).toHaveLength(1)
  })

  it('dispose removes listeners and best-effort-disconnects a live port', () => {
    const { port } = setup()
    port.open()
    const fake = ports[0]!
    expect(fake.onDisconnect.size).toBe(1)
    port.dispose()
    expect(fake.onDisconnect.size).toBe(0)
    expect(fake.onMessage.size).toBe(0)
    expect(fake.disconnected).toBe(true)
  })

  it('dispose never throws for an already disconnected port', () => {
    const { port } = setup()
    port.open()
    ports[0]!.fail()
    expect(() => port.dispose()).not.toThrow()
  })

  it('send never throws while disconnected and flushes messages in order', async () => {
    const { port } = setup()
    port.open()
    ports[0]!.fail()
    expect(() => {
      port.send({ type: 'panel.forward', payload: { a: 1 } })
      port.send({ type: 'panel.forward', payload: { a: 2 } })
    }).not.toThrow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ports).toHaveLength(2)
    expect(ports[1]!.sent).toEqual([
      { type: 'panel.forward', payload: { a: 1 } },
      { type: 'panel.forward', payload: { a: 2 } },
    ])
  })

  it('send never throws when postMessage fails on a dead port and schedules one reconnect', async () => {
    const { port, reconnectCount } = setup()
    port.open()
    const dead = ports[0]!
    dead.disconnected = true
    expect(() => port.send('survives')).not.toThrow()
    // The onDisconnect event follows asynchronously; it must not double-schedule.
    dead.fail()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reconnectCount()).toBe(1)
    expect(ports).toHaveLength(2)
    expect(ports[1]!.sent).toEqual(['survives'])
  })

  it('drops the oldest messages beyond the buffer cap', async () => {
    const { port } = setup({ maxBuffer: 3 })
    port.open()
    ports[0]!.fail()
    port.send(1)
    port.send(2)
    port.send(3)
    port.send(4)
    port.send(5)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ports[1]!.sent).toEqual([3, 4, 5])
  })

  it('flushes the queue in order even when a fresh port dies mid-flush', async () => {
    let calls = 0
    const first = new FakePort()
    const flaky = new FlakyPort(message => message === 2)
    const port = new ResilientPanelPort({
      connect: () => {
        const fake = calls === 0 ? first : calls === 1 ? flaky : new FakePort()
        calls += 1
        ports.push(fake)
        return fake as unknown as chrome.runtime.Port
      },
    })
    port.open()
    first.fail()
    port.send(1)
    port.send(2)
    port.send(3)
    await vi.advanceTimersByTimeAsync(1_000)
    // The flaky port accepted 1, died on 2; 2 and 3 stay buffered.
    expect(flaky.sent).toEqual([1])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ports).toHaveLength(3)
    expect(ports[2]!.sent).toEqual([2, 3])
  })

  it('ignores events from a stale port after a reconnect', async () => {
    const { port, received } = setup()
    port.open()
    const first = ports[0]!
    first.fail()
    await vi.advanceTimersByTimeAsync(1_000)
    const second = ports[1]!
    first.onMessage.emit('stale')
    second.onMessage.emit('fresh')
    expect(received).toEqual(['fresh'])
    // A late disconnect from the stale port must not schedule another reconnect.
    first.fail()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ports).toHaveLength(2)
  })

  it('respects the configured reconnect delay bounds', async () => {
    const { port } = setup({ reconnectBaseMs: 1_000, reconnectMaxMs: 1_000 })
    port.open()
    ports[0]!.fail()
    await vi.advanceTimersByTimeAsync(400)
    expect(ports).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(700)
    expect(ports).toHaveLength(2)
  })

  it('open is idempotent', () => {
    const { port } = setup()
    port.open()
    port.open()
    expect(ports).toHaveLength(1)
  })

  it('send before open buffers until the port opens', () => {
    const { port } = setup()
    port.send('early')
    port.open()
    expect(ports[0]!.sent).toEqual(['early'])
  })

  it('send and reconnect are no-ops after dispose', async () => {
    const { port, received } = setup()
    port.open()
    const fake = ports[0]!
    port.dispose()
    expect(() => port.send('ignored')).not.toThrow()
    fake.fail()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ports).toHaveLength(1)
    fake.onMessage.emit('late')
    expect(received).toEqual([])
  })
})
