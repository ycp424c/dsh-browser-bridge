import { describe, expect, it, vi } from 'vitest'
import type { BrowserTargetDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'
import { ViteParentChannel, type ViteParentChannelEnv } from '../src/client/vite-parent-channel.ts'
import type { ViteTargetApi } from '../src/client/vite-api.ts'

const DSH_ORIGIN = 'http://127.0.0.1:3080'
const PAGE_ORIGIN = 'http://127.0.0.1:5173'
const TARGET_ID = 't'.repeat(43)

class FakePort {
  sent: unknown[] = []
  closed = false
  onmessage: ((event: MessageEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  start(): void {}
  close(): void {
    this.closed = true
  }
}

class FakeEnv implements ViteParentChannelEnv {
  parent = {}
  listeners: Array<(event: MessageEvent) => void> = []

  addMessageListener(handler: (event: MessageEvent) => void): void {
    this.listeners.push(handler)
  }

  removeMessageListener(handler: (event: MessageEvent) => void): void {
    this.listeners = this.listeners.filter(candidate => candidate !== handler)
  }

  emit(event: Partial<MessageEvent> & { data: unknown }): void {
    for (const listener of [...this.listeners]) {
      listener({ source: this.parent, origin: PAGE_ORIGIN, ports: [], ...event } as MessageEvent)
    }
  }
}

class FakeApi {
  targets: BrowserTargetDescriptor[] = []

  async listTargets(): Promise<BrowserTargetDescriptor[]> {
    return this.targets
  }

  async issueGrant(): Promise<{ handle: string }> {
    return { handle: 'h'.repeat(32) }
  }
}

const DESCRIPTOR: BrowserTargetDescriptor = {
  targetId: TARGET_ID as never,
  provider: 'vite',
  title: 'Vite Page',
  url: 'http://127.0.0.1:5173/',
  origin: PAGE_ORIGIN,
  projectId: 'app',
  generation: 0,
  capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
}

describe('vite parent channel', () => {
  it('verifies the parent-provided targetId against the host before exposing the current page', async () => {
    const env = new FakeEnv()
    const api = new FakeApi()
    api.targets = [DESCRIPTOR]
    const channel = new ViteParentChannel({ env, api: api as unknown as ViteTargetApi, dshOrigin: DSH_ORIGIN })
    const port = new FakePort()
    const verified = vi.fn()
    channel.onVerified(verified)
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, ports: [port as unknown as MessagePort] })
    await vi.waitFor(() => {
      expect(verified).toHaveBeenCalledWith(expect.objectContaining({ targetId: TARGET_ID, origin: PAGE_ORIGIN }))
      expect(port.sent).toContainEqual(expect.objectContaining({ type: 'dsh-browser-bridge.ready' }))
    })
    expect(channel.getVerified()).toEqual({ targetId: TARGET_ID, origin: PAGE_ORIGIN })
    channel.dispose()
  })

  it('accepts only init messages from the exact parent source and origin', async () => {
    const env = new FakeEnv()
    const api = new FakeApi()
    api.targets = [DESCRIPTOR]
    const channel = new ViteParentChannel({ env, api: api as unknown as ViteTargetApi, dshOrigin: DSH_ORIGIN })
    const verified = vi.fn()
    channel.onVerified(verified)
    // Wrong source: ignored.
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, source: {} })
    // Wrong origin: ignored.
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, origin: 'https://evil.example' })
    // Non-HTTP(S) origin: ignored.
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, origin: 'file:///tmp/x' })
    // Missing port: ignored.
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, ports: [] })
    expect(channel.getVerified()).toBeNull()
    expect(verified).not.toHaveBeenCalled()
    channel.dispose()
  })

  it('rejects duplicate init messages without re-verifying', async () => {
    const env = new FakeEnv()
    const api = new FakeApi()
    api.targets = [DESCRIPTOR]
    const channel = new ViteParentChannel({ env, api: api as unknown as ViteTargetApi, dshOrigin: DSH_ORIGIN })
    const firstPort = new FakePort()
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, ports: [firstPort as unknown as MessagePort] })
    await vi.waitFor(() => expect(channel.getVerified()).not.toBeNull())
    const secondPort = new FakePort()
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, ports: [secondPort as unknown as MessagePort] })
    // The duplicate port is rejected; the first verification stays intact.
    expect(secondPort.sent).toContainEqual(expect.objectContaining({ type: 'dsh-browser-bridge.error' }))
    expect(channel.getVerified()).not.toBeNull()
    channel.dispose()
  })

  it('rejects an init whose targetId is not registered on the host', async () => {
    const env = new FakeEnv()
    const api = new FakeApi()
    api.targets = []
    const channel = new ViteParentChannel({ env, api: api as unknown as ViteTargetApi, dshOrigin: DSH_ORIGIN })
    const port = new FakePort()
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, ports: [port as unknown as MessagePort] })
    await vi.waitFor(() => {
      expect(port.sent).toContainEqual(expect.objectContaining({ type: 'dsh-browser-bridge.error' }))
    })
    expect(channel.getVerified()).toBeNull()
    channel.dispose()
  })

  it('dispose removes the listener, closes the port, and clears verification', async () => {
    const env = new FakeEnv()
    const api = new FakeApi()
    api.targets = [DESCRIPTOR]
    const channel = new ViteParentChannel({ env, api: api as unknown as ViteTargetApi, dshOrigin: DSH_ORIGIN })
    const port = new FakePort()
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, ports: [port as unknown as MessagePort] })
    await vi.waitFor(() => expect(channel.getVerified()).not.toBeNull())
    channel.dispose()
    expect(port.closed).toBe(true)
    expect(env.listeners).toHaveLength(0)
    expect(channel.getVerified()).toBeNull()
    // A late init after dispose is ignored.
    const late = new FakePort()
    env.emit({ data: { type: 'dsh-browser-bridge-init', targetId: TARGET_ID }, ports: [late as unknown as MessagePort] })
    expect(late.sent).toHaveLength(0)
  })
})
