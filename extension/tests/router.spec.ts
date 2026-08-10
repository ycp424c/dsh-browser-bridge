import { describe, expect, it, vi } from 'vitest'
import {
  GrantHandle, GrantId, PROTOCOL_VERSION, RequestId, type BridgeFrame, type GrantAcceptedFrame,
  type GrantPutFrame, type TabDescriptor,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { BridgeRouter, type PanelReply, type ToolExecutor } from '../src/bridge/router.ts'
import type { BridgeClient, BridgeClientState } from '../src/bridge/client.ts'
import type { TabCatalog } from '../src/tabs/catalog.ts'
import { GrantVault } from '../src/grants/vault.ts'
import { CdpSessionManager } from '../src/cdp/session-manager.ts'
import { ChromeDebugger, type ChromeDebuggerApi } from '../src/cdp/chrome-debugger.ts'

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

function makeRouter(overrides: { catalog?: TabCatalog; toolExecutor?: ToolExecutor } = {}): {
  router: BridgeRouter
  bridge: FakeBridge
  vault: GrantVault
  catalog: TabCatalog
  manager: CdpSessionManager
  debuggerApi: ChromeDebuggerApi
} {
  const bridge = new FakeBridge()
  const vault = new GrantVault()
  const catalog = overrides.catalog ?? ({
    byId: vi.fn(async (tabId: number): Promise<TabDescriptor | undefined> => (tabId === TAB.tabId ? { ...TAB } : undefined)),
    current: vi.fn(async (): Promise<TabDescriptor> => ({ ...TAB })),
    list: vi.fn(async (): Promise<TabDescriptor[]> => [{ ...TAB }]),
  } as unknown as TabCatalog)
  const debuggerApi = new FakeDebuggerApi()
  const manager = new CdpSessionManager({ debuggerApi: new ChromeDebugger(debuggerApi as never, { lastError: () => undefined }) })
  const router = new BridgeRouter({
    bridge: bridge as unknown as BridgeClient,
    vault,
    catalog,
    sessionManager: manager,
    ...(overrides.toolExecutor !== undefined ? { toolExecutor: overrides.toolExecutor } : {}),
  })
  return { router, bridge, vault, catalog, manager, debuggerApi }
}

class FakeDebuggerApi implements ChromeDebuggerApi {
  attach = vi.fn((_t: chrome.debugger.Debuggee, _v: string, cb?: () => void) => { cb?.(); return Promise.resolve() })
  detach = vi.fn((_t: chrome.debugger.Debuggee, cb?: () => void) => { cb?.(); return Promise.resolve() })
  sendCommand = vi.fn((_t: chrome.debugger.Debuggee, _m: string, _p?: object, cb?: (r?: unknown) => void) => { cb?.({}); return Promise.resolve({}) })
  getTargets = vi.fn(async (): Promise<chrome.debugger.TargetInfo[]> => [])
  onEvent = {
    addListener: () => {}, removeListener: () => {}, hasListener: () => false, hasListeners: () => false,
  } as unknown as chrome.debugger.DebuggerEventEvent
  onDetach = {
    addListener: () => {}, removeListener: () => {}, hasListener: () => false, hasListeners: () => false,
  } as unknown as chrome.debugger.DebuggerDetachedEvent
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

  it('binds the accepted grant without attaching the debugger', async () => {
    const { router, bridge, vault, debuggerApi } = makeRouter()
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB } })
    await vi.waitFor(() => {
      expect(bridge.sentOf('grant.put')).toBeDefined()
    })
    const put = bridge.sentOf('grant.put') as GrantPutFrame
    bridge.receive({
      v: PROTOCOL_VERSION,
      type: 'grant.accepted',
      grantId: put.grantId,
      handle: GrantHandle('h'.repeat(32)),
    })
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(1)
    })
    expect(debuggerApi.attach).not.toHaveBeenCalled()
    expect(vault.resolve(put.grantId).state).toBe('accepted')
  })

  it('routes a tool call to the exact grant session without querying the active tab', async () => {
    const executor = vi.fn(async (): Promise<unknown> => ({ ok: true, page: { url: 'http://x/' } }))
    const { router, bridge, debuggerApi } = makeRouter({ toolExecutor: executor as unknown as ToolExecutor })
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB } })
    await vi.waitFor(() => {
      expect(bridge.sentOf('grant.put')).toBeDefined()
    })
    const put = bridge.sentOf('grant.put') as GrantPutFrame
    bridge.receive({
      v: PROTOCOL_VERSION,
      type: 'grant.accepted',
      grantId: put.grantId,
      handle: GrantHandle('h'.repeat(32)),
    })
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(1)
    })
    // First tool call attaches lazily.
    bridge.receive({
      v: PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: RequestId('t1'),
      grantId: put.grantId,
      operation: 'observe',
      args: {},
    })
    await vi.waitFor(() => {
      expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 9 }, '1.3', expect.any(Function))
    })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toBeDefined()
    })
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 9 }),
      'observe',
      {},
    )
    expect(bridge.sentOf('tool.result')).toMatchObject({ requestId: RequestId('t1'), result: { ok: true } })
  })

  it('reports a stable error when a tool call fails', async () => {
    const executor = vi.fn(async (): Promise<unknown> => {
      throw { code: 'debugger_busy', message: 'devtools open', retryable: false }
    })
    const { router, bridge } = makeRouter({ toolExecutor: executor as unknown as ToolExecutor })
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB } })
    await vi.waitFor(() => {
      expect(bridge.sentOf('grant.put')).toBeDefined()
    })
    const put = bridge.sentOf('grant.put') as GrantPutFrame
    bridge.receive({
      v: PROTOCOL_VERSION,
      type: 'grant.accepted',
      grantId: put.grantId,
      handle: GrantHandle('h'.repeat(32)),
    })
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(1)
    })
    bridge.receive({
      v: PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: RequestId('t2'),
      grantId: put.grantId,
      operation: 'inspect',
      args: { selector: '#save' },
    })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toBeDefined()
    })
    expect(bridge.sentOf('tool.result')).toMatchObject({
      requestId: RequestId('t2'),
      result: { ok: false, error: { code: 'debugger_busy' } },
    })
  })

  it('revokes the CDP session when the host revokes the grant', async () => {
    const { router, bridge, debuggerApi } = makeRouter()
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB } })
    await vi.waitFor(() => {
      expect(bridge.sentOf('grant.put')).toBeDefined()
    })
    const put = bridge.sentOf('grant.put') as GrantPutFrame
    bridge.receive({
      v: PROTOCOL_VERSION,
      type: 'grant.accepted',
      grantId: put.grantId,
      handle: GrantHandle('h'.repeat(32)),
    })
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(1)
    })
    bridge.receive({
      v: PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: RequestId('t3'),
      grantId: put.grantId,
      operation: 'observe',
      args: {},
    })
    await vi.waitFor(() => {
      expect(debuggerApi.attach).toHaveBeenCalled()
    })
    bridge.receive({ v: PROTOCOL_VERSION, type: 'grant.revoke', grantId: put.grantId })
    await vi.waitFor(() => {
      expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 9 }, expect.any(Function))
    })
  })
})
