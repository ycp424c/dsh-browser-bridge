import { describe, expect, it, vi } from 'vitest'
import {
  GrantHandle, GrantId, PROTOCOL_VERSION, RequestId, type BridgeFrame, type GrantAcceptedFrame,
  type GrantPutFrame, type TabDescriptor,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { BridgeRouter, isLoopbackWsUrl, type PanelReply, type ToolExecutor } from '../src/bridge/router.ts'
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
  private sessionChangedHandlers = new Set<() => void>()
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

  onSessionChanged(handler: () => void): () => void {
    this.sessionChangedHandlers.add(handler)
    return () => this.sessionChangedHandlers.delete(handler)
  }

  receive(frame: BridgeFrame): void {
    for (const handler of this.frameHandlers) handler(frame)
  }

  sessionChanged(): void {
    for (const handler of this.sessionChangedHandlers) handler()
  }

  sentOf<T extends BridgeFrame['type']>(type: T): Extract<BridgeFrame, { type: T }> | undefined {
    return this.sent.find(frame => frame.type === type) as Extract<BridgeFrame, { type: T }> | undefined
  }
}

class FakePort {
  readonly messages: unknown[] = []
  private messageHandlers = new Set<(message: unknown) => void>()
  private disconnectHandlers = new Set<() => void>()
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
      onDisconnect: {
        addListener: (handler: () => void) => { self.disconnectHandlers.add(handler) },
        removeListener: (handler: () => void) => { self.disconnectHandlers.delete(handler) },
        hasListener: (handler: () => void) => self.disconnectHandlers.has(handler),
        hasListeners: () => self.disconnectHandlers.size > 0,
      },
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

  /** Fire the port's disconnect listeners (terminal panel loss). */
  disconnect(): void {
    for (const handler of this.disconnectHandlers) handler()
  }

  replies(): PanelReply[] {
    return this.messages.filter((message): message is PanelReply =>
      typeof message === 'object' && message !== null && (message as { type?: string }).type === 'panel.reply')
  }
}

function makeRouter(overrides: { catalog?: TabCatalog; toolExecutor?: ToolExecutor; startupReady?: Promise<void> } = {}): {
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
    ...(overrides.startupReady !== undefined ? { startupReady: overrides.startupReady } : {}),
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
  it('rejects IPv6 loopback URLs that Chrome extension CSP cannot authorize', () => {
    expect(isLoopbackWsUrl('ws://[::1]:3080/dsh-browser-bridge/ws')).toBe(false)
  })

  it('defers panel requests and bridge frames until startup reconciliation finishes', async () => {
    // Startup reconciliation is a delayed storage read + best-effort cleanup;
    // while it is pending, NO business traffic may be processed.
    let release!: () => void
    const startupReady = new Promise<void>(resolve => { release = resolve })
    const { router, bridge, vault } = makeRouter({ startupReady })
    const port = new FakePort()
    router.connectPanel(port.raw)

    // Panel requests before readiness: nothing is answered, no grant.put.
    port.receive({ type: 'tabs.current', requestId: 'r1' })
    port.receive({ type: 'grant.create', requestId: 'r2', sessionId: 's1', tab: { ...TAB } })
    // Bridge frames before readiness: no acknowledgement, no execution.
    bridge.receive({
      v: PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: RequestId('t1'),
      grantId: GrantId('g-gated'),
      operation: 'observe',
      args: {},
    })
    await vi.waitFor(() => {
      // Give any (buggy) immediate handling a chance to run.
    })
    expect(port.replies()).toEqual([])
    expect(bridge.sentOf('grant.put')).toBeUndefined()
    expect(bridge.sentOf('tool.accepted')).toBeUndefined()
    expect(bridge.sentOf('tool.result')).toBeUndefined()
    expect(vault.owned()).toEqual([])

    // Readiness resolves: deferred requests flow; the deferred tool call
    // fails closed because its grant was never accepted.
    release()
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(1)
      expect(bridge.sentOf('grant.put')).toBeDefined()
      expect(bridge.sentOf('tool.result')).toBeDefined()
    })
    expect(port.replies()[0]).toMatchObject({ requestId: 'r1', ok: true, value: { tabId: 9 } })
    expect(bridge.sentOf('tool.result')).toMatchObject({
      requestId: RequestId('t1'),
      result: { ok: false, error: { code: 'grant_expired' } },
    })
    // The deferred grant.create completes once the host acknowledges it.
    const put = bridge.sentOf('grant.put') as GrantPutFrame
    bridge.receive({
      v: PROTOCOL_VERSION,
      type: 'grant.accepted',
      grantId: put.grantId,
      handle: GrantHandle('h'.repeat(32)),
    })
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(2)
    })
    expect(port.replies()[1]).toMatchObject({ requestId: 'r2', ok: true })
    expect(vault.owned()).toHaveLength(1)
  })

  it('processes work immediately once startup reconciliation already finished', async () => {
    const { router, bridge } = makeRouter({ startupReady: Promise.resolve() })
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'tabs.current', requestId: 'r1' })
    await vi.waitFor(() => {
      expect(port.replies()).toHaveLength(1)
    })
    expect(port.replies()[0]).toMatchObject({ requestId: 'r1', ok: true })
    expect(bridge.sentOf('grant.put')).toBeUndefined()
  })

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

  it('binds the accepted grant with its exact URL as the authorization baseline', async () => {
    const { router, bridge, manager } = makeRouter()
    const bindSpy = vi.spyOn(manager, 'bind')
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
      expect(bindSpy).toHaveBeenCalled()
    })
    // The session baseline is the exact URL observed at grant issue time.
    expect(bindSpy).toHaveBeenCalledWith({
      grantId: put.grantId,
      tabId: 9,
      url: 'http://127.0.0.1:4173/',
    })
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

  describe('pending grant offer lifecycle', () => {
    /** Issue one grant.create and wait for its grant.put offer. */
    async function offer(router: BridgeRouter, bridge: FakeBridge, port: FakePort): Promise<GrantPutFrame> {
      port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB } })
      await vi.waitFor(() => {
        expect(bridge.sentOf('grant.put')).toBeDefined()
      })
      return bridge.sentOf('grant.put') as GrantPutFrame
    }

    it('grant.cancel revokes the local and host grants immediately and a late grant.accepted does not rebind', async () => {
      const { router, bridge, vault } = makeRouter()
      const port = new FakePort()
      router.connectPanel(port.raw)
      const put = await offer(router, bridge, port)
      // The iframe aborted the grant.create request (channel abort): the
      // router must revoke the local grant, notify the host, and settle the
      // acknowledgement timer without waiting for the 10-second timeout.
      port.receive({ type: 'grant.cancel', requestId: 'r1' })
      await vi.waitFor(() => {
        expect(vault.owned()).toEqual([])
      })
      expect(bridge.sentOf('grant.revoke')).toMatchObject({ grantId: put.grantId })
      // No reply to a settled request.
      expect(port.replies()).toHaveLength(0)
      // A late grant.accepted must NOT rebind the grant.
      bridge.receive({
        v: PROTOCOL_VERSION,
        type: 'grant.accepted',
        grantId: put.grantId,
        handle: GrantHandle('h'.repeat(32)),
      })
      expect(vault.owned()).toEqual([])
      expect(() => vault.resolve(put.grantId)).toThrow(/grant expired/)
    })

    it('panel disconnect settles pending acknowledgements immediately and a late accepted does not rebind', async () => {
      const { router, bridge, vault } = makeRouter()
      const port = new FakePort()
      router.connectPanel(port.raw)
      const put = await offer(router, bridge, port)
      port.disconnect()
      expect(vault.owned()).toEqual([])
      expect(bridge.sentOf('grant.revoke')).toMatchObject({ grantId: put.grantId })
      // A late acknowledgement after the panel closed must be ignored
      // without rebinding the grant or throwing.
      bridge.receive({
        v: PROTOCOL_VERSION,
        type: 'grant.accepted',
        grantId: put.grantId,
        handle: GrantHandle('h'.repeat(32)),
      })
      expect(vault.owned()).toEqual([])
    })

    it('session change settles pending acknowledgements immediately and a late accepted does not rebind', async () => {
      const { router, bridge, vault } = makeRouter()
      const port = new FakePort()
      router.connectPanel(port.raw)
      const put = await offer(router, bridge, port)
      bridge.sessionChanged()
      expect(vault.owned()).toEqual([])
      bridge.receive({
        v: PROTOCOL_VERSION,
        type: 'grant.accepted',
        grantId: put.grantId,
        handle: GrantHandle('h'.repeat(32)),
      })
      expect(vault.owned()).toEqual([])
      expect(() => vault.resolve(put.grantId)).toThrow(/grant expired/)
    })
  })
})
