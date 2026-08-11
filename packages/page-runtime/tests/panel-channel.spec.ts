import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelChannel, type PanelChannelEnv } from '../src/panel/channel.ts'

const DSH_ORIGIN = 'http://127.0.0.1:3080'
const TARGET_ID = 't'.repeat(43)

class FakePort {
  sent: unknown[] = []
  closed = false
  onmessage: ((event: MessageEvent) => void) | null = null
  start(): void {}
  close(): void {
    this.closed = true
  }
  postMessage(message: unknown): void {
    this.sent.push(message)
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent)
  }
}

class FakeEnv implements PanelChannelEnv {
  posted: Array<{ message: unknown; targetOrigin: string; ports: unknown[] }> = []
  listeners: Array<() => void> = []
  port: FakePort
  onload: (() => void) | null = null

  constructor(port: FakePort) {
    this.port = port
  }

  postToIframe(message: unknown, targetOrigin: string, ports: unknown[]): void {
    this.posted.push({ message, targetOrigin, ports })
  }

  onIframeLoad(handler: () => void): void {
    this.onload = handler
  }
}

function makeChannel(options: { timeoutMs?: number } = {}) {
  const port1 = new FakePort()
  const port2 = new FakePort()
  const env = new FakeEnv(port1)
  const ready = vi.fn()
  const error = vi.fn()
  const channel = new PanelChannel({
    env,
    dshOrigin: DSH_ORIGIN,
    targetId: TARGET_ID as never,
    timeoutMs: options.timeoutMs ?? 5_000,
    messageChannelFactory: () => ({ port1: port1 as unknown as MessagePort, port2: port2 as unknown as MessagePort }),
  })
  channel.onReady(ready)
  channel.onError(error)
  return { port: port1, port2, env, ready, error, channel }
}

describe('panel channel', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts one init message with a transferred port to the exact origin', () => {
    const { env, channel, port: _port, port2 } = makeChannel()
    channel.init()
    // The init is posted once the iframe has loaded.
    env.onload?.()
    expect(env.posted).toHaveLength(1)
    expect(env.posted[0]!.targetOrigin).toBe(DSH_ORIGIN)
    // The transferred port is the channel's port2, exactly once.
    expect(env.posted[0]!.ports).toEqual([port2])
    const message = env.posted[0]!.message as { type: string; targetId: string }
    expect(message.type).toBe('dsh-browser-bridge-init')
    expect(message.targetId).toBe(TARGET_ID)
    // The init carries ONLY the non-sensitive targetId.
    expect(Object.keys(message)).toEqual(['type', 'targetId'])
  })

  it('never uses a wildcard target origin', () => {
    const { env, channel } = makeChannel()
    channel.init()
    env.onload?.()
    expect(env.posted.every(entry => entry.targetOrigin !== '*')).toBe(true)
  })

  it('resolves when the port receives ready within the bound', () => {
    vi.useFakeTimers()
    const { env, channel, port, ready } = makeChannel()
    channel.init()
    env.onload?.()
    port.receive({ type: 'dsh-browser-bridge.ready', targetId: TARGET_ID })
    expect(ready).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('maps a ready timeout to embedding_blocked without touching the target', () => {
    vi.useFakeTimers()
    const { env, channel, error, ready } = makeChannel()
    channel.init()
    env.onload?.()
    expect(ready).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_100)
    expect(error).toHaveBeenCalledWith('embedding_blocked')
    // The target connection itself is unaffected (no dispose, no teardown).
    expect(channel.disposed).toBe(false)
    vi.useRealTimers()
  })

  it('dispose closes the port and removes listeners', () => {
    const { env, channel, port } = makeChannel()
    channel.init()
    env.onload?.()
    channel.dispose()
    expect(port.closed).toBe(true)
    expect(channel.disposed).toBe(true)
  })
})
