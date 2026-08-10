import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectionId, PROTOCOL_VERSION, type BridgeFrame, type HelloOkFrame,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { BridgeClient, type BridgeSocket } from '../src/bridge/client.ts'

class FakeSocket implements BridgeSocket {
  sent: BridgeFrame[] = []
  sentRaw: string[] = []
  closed = false
  private openHandlers: (() => void)[] = []
  private messageHandlers: ((text: string) => void)[] = []
  private closeHandlers: (() => void)[] = []

  onOpen(handler: () => void): void { this.openHandlers.push(handler) }
  onMessage(handler: (text: string) => void): void { this.messageHandlers.push(handler) }
  onClose(handler: () => void): void { this.closeHandlers.push(handler) }

  send(text: string): void {
    this.sentRaw.push(text)
    this.sent.push(JSON.parse(text) as BridgeFrame)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const handler of this.closeHandlers) handler()
  }

  open(): void { for (const handler of this.openHandlers) handler() }
  receive(text: string): void { for (const handler of this.messageHandlers) handler(text) }
  sentFrames(): BridgeFrame[] { return this.sent }
}

function helloOk(): string {
  const frame: HelloOkFrame = { v: PROTOCOL_VERSION, type: 'hello.ok', connectionId: ConnectionId('c1') }
  return JSON.stringify(frame)
}

describe('bridge client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends hello before other frames', () => {
    const socket = new FakeSocket()
    const client = new BridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
    client.connect('ws://127.0.0.1:3080/dsh-browser-bridge/ws', 'n'.repeat(32))
    socket.open()
    expect(socket.sent[0]).toMatchObject({ type: 'hello', pairingNonce: 'n'.repeat(32) })
    socket.receive(helloOk())
    expect(client.state).toBe('connected')
  })

  it('emits typed state transitions', () => {
    const states: string[] = []
    const socket = new FakeSocket()
    const client = new BridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
    client.onState(state => states.push(state))
    client.connect('ws://x', 'n'.repeat(32))
    expect(states).toEqual(['connecting'])
    socket.open()
    expect(states).toEqual(['connecting'])
    socket.receive(helloOk())
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('replies pong to host ping', () => {
    const socket = new FakeSocket()
    const client = new BridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
    client.connect('ws://x', 'n'.repeat(32))
    socket.open()
    socket.receive(helloOk())
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ping' }))
    expect(socket.sentFrames().some(frame => frame.type === 'pong')).toBe(true)
  })

  it('sends heartbeat pings while connected', () => {
    const socket = new FakeSocket()
    const client = new BridgeClient({ createSocket: () => socket, heartbeatMs: 1_000 })
    client.connect('ws://x', 'n'.repeat(32))
    socket.open()
    socket.receive(helloOk())
    vi.advanceTimersByTime(3_000)
    expect(socket.sentFrames().filter(frame => frame.type === 'ping')).toHaveLength(3)
  })

  it('emits pairing-required after backoff when the connection drops', () => {
    const socket = new FakeSocket()
    const client = new BridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
    const required: number[] = []
    client.onPairingRequired(delayMs => required.push(delayMs))
    client.connect('ws://x', 'n'.repeat(32))
    socket.open()
    socket.receive(helloOk())
    socket.close()
    expect(required).toEqual([])
    vi.advanceTimersByTime(500)
    expect(required).toHaveLength(1)
    expect(required[0]).toBeGreaterThanOrEqual(250)
    expect(required[0]).toBeLessThanOrEqual(500)
  })

  it('does not emit pairing-required when the owner closes the client', () => {
    const socket = new FakeSocket()
    const client = new BridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
    const required: number[] = []
    client.onPairingRequired(delayMs => required.push(delayMs))
    client.connect('ws://x', 'n'.repeat(32))
    socket.open()
    socket.receive(helloOk())
    client.close()
    vi.advanceTimersByTime(10_000)
    expect(required).toEqual([])
  })

  it('does not replay the old pairing nonce on a new connect', () => {
    let socket = new FakeSocket()
    const client = new BridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
    client.connect('ws://x', 'nonce-one')
    socket.open()
    socket.receive(helloOk())
    socket.close()
    vi.advanceTimersByTime(1_000)
    // A fresh nonce arrives out of band and reconnects.
    socket = new FakeSocket()
    client.connect('ws://x', 'nonce-two')
    socket.open()
    const hello = socket.sentFrames().find(frame => frame.type === 'hello')
    expect(hello).toMatchObject({ pairingNonce: 'nonce-two' })
  })

  it('forwards decoded frames to listeners', () => {
    const socket = new FakeSocket()
    const client = new BridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
    const frames: BridgeFrame[] = []
    client.onFrame(frame => frames.push(frame))
    client.connect('ws://x', 'n'.repeat(32))
    socket.open()
    socket.receive(helloOk())
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'grant.revoke', grantId: 'g1' }))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'grant.revoke', grantId: 'g1' })
  })
})
