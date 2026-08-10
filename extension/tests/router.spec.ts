import { describe, expect, it, vi } from 'vitest'
import {
  GrantHandle, GrantId, PROTOCOL_VERSION, type BridgeFrame, type GrantAcceptedFrame,
  type GrantPutFrame, type TabDescriptor,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { BridgeRouter, type PanelReply } from '../src/bridge/router.ts'
import type { BridgeClient, BridgeClientState } from '../src/bridge/client.ts'
import type { TabCatalog } from '../src/tabs/catalog.ts'
import { GrantVault } from '../src/grants/vault.ts'

const TAB: TabDescriptor = { tabId: 9, windowId: 3, title: 'App', url: 'http://127.0.0.1:4173/' }

class FakeBridge {
  sent: BridgeFrame[] = []
  connected = true
  private frameHandlers = new Set<(frame: BridgeFrame) => void>()
  state: BridgeClientState = 'connected'

  send(frame: BridgeFrame): void {
    if (!this.connected) throw new Error('not connected')
    this.sent.push(frame)
  }

  connect(_url: string, _pairingNonce: string): void {
    this.state = 'connecting'
  }

  close(): void {
    this.state = 'closed'
  }

  onFrame(handler: (frame: BridgeFrame) => void): () => void {
    this.frameHandlers.add(handler)
    return () => this.frameHandlers.delete(handler)
  }

  onState(): () => void { return () => {} }

  receive(frame: BridgeFrame): void {
    for (const handler of this.frameHandlers) handler(frame)
  }

  sentOf<T extends BridgeFrame['type']>(type: T): Extract<BridgeFrame, { type: T }> | undefined {
    return this.sent.find(frame => frame.type === type) as Extract<BridgeFrame, { type: T }> | undefined
  }
}

class FakePort {
  readonly messages: unknown[] = []
  private messageHandlers = new Set<(message: unknown) => void>()
  private readonly port: chrome.runtime.Port

  constructor() {
    const self = this
    this.port = {
      name: 'sidepanel',
      onMessage: {
        addListener: (handler: (message: unknown) => void) => { self.messageHandlers.add(handler) },
        removeListener: (handler: (message: unknown) => void) => { self.messageHandlers.delete(handler) },
        hasListener: (handler: (message: unknown) => void) => self.messageHandlers.has(handler),
        hasListeners: () => self.messageHandlers.size > 0,
      },
      onDisconnect: { addListener: () => {}, removeListener: () => {}, hasListener: () => false, hasListeners: () => false },
      postMessage: (message: unknown) => { self.messages.push(message) },
      disconnect: () => {},
    } as unknown as chrome.runtime.Port
  }

  get raw(): chrome.runtime.Port {
    return this.port
  }

  receive(message: unknown): void {
    for (const handler of this.messageHandlers) handler(message)
  }

  replies(): PanelReply[] {
    return this.messages.filter((message): message is PanelReply =>
      typeof message === 'object' && message !== null && (message as { type?: string }).type === 'panel.reply')
  }
}

function makeRouter(overrides: { catalog?: TabCatalog } = {}): {
  router: BridgeRouter
  bridge: FakeBridge
  vault: GrantVault
  catalog: TabCatalog
} {
  const bridge = new FakeBridge()
  const vault = new GrantVault()
  const catalog = overrides.catalog ?? ({
    byId: vi.fn(async (tabId: number): Promise<TabDescriptor | undefined> => (tabId === TAB.tabId ? { ...TAB } : undefined)),
    current: vi.fn(async (): Promise<TabDescriptor> => ({ ...TAB })),
    list: vi.fn(async (): Promise<TabDescriptor[]> => [{ ...TAB }]),
  } as unknown as TabCatalog)
  const router = new BridgeRouter({ bridge: bridge as unknown as BridgeClient, vault, catalog })
  return { router, bridge, vault, catalog }
}

describe('bridge router', () => {
  it('replies to tabs.current with the current tab descriptor', async () => {
    const { router } = makeRouter()
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'tabs.current', requestId: 'r1' })
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(1)
    })
    expect(port.replies()[0]).toMatchObject({ requestId: 'r1', ok: true, value: { tabId: 9 } })
  })

  it('rejects a closed or changed tab during grant.create', async () => {
    const { router, vault } = makeRouter()
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB, tabId: 999 } })
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(1)
    })
    expect(port.replies()[0]).toMatchObject({ requestId: 'r1', ok: false, error: { code: 'tab_closed' } })
    expect(vault.owned()).toEqual([])
  })

  it('sends grant.put, waits for grant.accepted, and returns only the handle', async () => {
    const { router, bridge, vault } = makeRouter()
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB } })
    await vi.waitFor(() => {
      expect(bridge.sentOf('grant.put')).toBeDefined()
    })
    const put = bridge.sentOf('grant.put') as GrantPutFrame
    expect(put.sessionId).toBe('s1')
    expect(put.tab).toMatchObject({ tabId: 9 })
    const handle = GrantHandle('h'.repeat(32))
    const accepted: GrantAcceptedFrame = { v: PROTOCOL_VERSION, type: 'grant.accepted', grantId: put.grantId, handle }
    bridge.receive(accepted)
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(1)
    })
    const reply = port.replies()[0]
    expect(reply).toMatchObject({ requestId: 'r1', ok: true })
    expect((reply as { value: { handle: string } }).value).toEqual({ handle })
    // The vault record is accepted and the reply carries no grant id or tab id.
    expect(JSON.stringify(reply)).not.toContain(put.grantId)
    expect(JSON.stringify(reply)).not.toContain('tabId')
    expect(vault.resolve(put.grantId).handle).toBe(handle)
  })

  it('revokes the local grant when acknowledgement fails', async () => {
    const { router, bridge, vault } = makeRouter()
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB } })
    await vi.waitFor(() => {
      expect(bridge.sentOf('grant.put')).toBeDefined()
    })
    const put = bridge.sentOf('grant.put') as GrantPutFrame
    bridge.receive({ v: PROTOCOL_VERSION, type: 'error', code: 'internal', message: 'nope', retryable: false })
    await vi.waitFor(() => {
      expect(vault.owned()).toEqual([])
    })
    expect(() => vault.resolve(put.grantId)).toThrow(/grant expired/)
  })

  it('connects the bridge only for loopback WebSocket URLs', async () => {
    const { router } = makeRouter()
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'bridge.connect', requestId: 'r1', wsUrl: 'ws://127.0.0.1:3080/dsh-browser-bridge/ws', pairingNonce: 'n'.repeat(32) })
    port.receive({ type: 'bridge.connect', requestId: 'r2', wsUrl: 'wss://evil.example/ws', pairingNonce: 'n'.repeat(32) })
    await vi.waitFor(() => {
      expect(port.replies().length).toBeGreaterThanOrEqual(2)
    })
    const replies = port.replies()
    expect(replies[0]).toMatchObject({ requestId: 'r1', ok: true })
    expect(replies[1]).toMatchObject({ requestId: 'r2', ok: false })
  })
})
