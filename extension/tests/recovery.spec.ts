import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GrantHandle, GrantId, PROTOCOL_VERSION, type BridgeFrame, type GrantPutFrame,
  type TabDescriptor, type ToolAcceptedFrame,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { BridgeRouter, type ToolExecutor } from '../src/bridge/router.ts'
import type { BridgeClient } from '../src/bridge/client.ts'
import type { TabCatalog } from '../src/tabs/catalog.ts'
import { GrantVault } from '../src/grants/vault.ts'
import { CdpSessionManager } from '../src/cdp/session-manager.ts'
import { ChromeDebugger, type ChromeDebuggerApi } from '../src/cdp/chrome-debugger.ts'

const TAB: TabDescriptor = { tabId: 9, windowId: 3, title: 'App', url: 'http://127.0.0.1:4173/' }

class FakeBridge {
  sent: BridgeFrame[] = []
  private frameHandlers = new Set<(frame: BridgeFrame) => void>()

  send(frame: BridgeFrame): void { this.sent.push(frame) }
  onFrame(handler: (frame: BridgeFrame) => void): () => void {
    this.frameHandlers.add(handler)
    return () => this.frameHandlers.delete(handler)
  }
  onState(): () => void { return () => {} }
  connect(): void {}
  close(): void {}

  receive(frame: BridgeFrame): void {
    for (const handler of this.frameHandlers) handler(frame)
  }

  sentOf<T extends BridgeFrame['type']>(type: T): Extract<BridgeFrame, { type: T }>[] {
    return this.sent.filter(frame => frame.type === type) as Extract<BridgeFrame, { type: T }>[]
  }
}

class FakeDebuggerApi implements ChromeDebuggerApi {
  attach = vi.fn((_t: chrome.debugger.Debuggee, _v: string, cb?: () => void) => { cb?.(); return Promise.resolve() })
  detach = vi.fn((_t: chrome.debugger.Debuggee, cb?: () => void) => { cb?.(); return Promise.resolve() })
  sendCommand = vi.fn((_t: chrome.debugger.Debuggee, _m: string, _p?: object, cb?: (r?: unknown) => void) => { cb?.({}); return Promise.resolve({}) })
  getTargets = vi.fn(async (): Promise<chrome.debugger.TargetInfo[]> => [])
  onEvent = { addListener: () => {}, removeListener: () => {}, hasListener: () => false, hasListeners: () => false } as unknown as chrome.debugger.DebuggerEventEvent
  onDetach = { addListener: () => {}, removeListener: () => {}, hasListener: () => false, hasListeners: () => false } as unknown as chrome.debugger.DebuggerDetachedEvent
}

class FakePort {
  readonly messages: unknown[] = []
  private messageHandlers = new Set<(message: unknown) => void>()
  readonly raw: chrome.runtime.Port

  constructor() {
    const self = this
    this.raw = {
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

  receive(message: unknown): void {
    for (const handler of this.messageHandlers) handler(message)
  }
}

async function makeRouter(executor: ToolExecutor = async () => ({ ok: true })): Promise<{
  router: BridgeRouter
  bridge: FakeBridge
  vault: GrantVault
  manager: CdpSessionManager
  debuggerApi: FakeDebuggerApi
  grantId: GrantId
}> {
  const bridge = new FakeBridge()
  const vault = new GrantVault()
  const catalog = {
    byId: async (tabId: number): Promise<TabDescriptor | undefined> => (tabId === TAB.tabId ? { ...TAB } : undefined),
    current: async (): Promise<TabDescriptor> => ({ ...TAB }),
    list: async (): Promise<TabDescriptor[]> => [{ ...TAB }],
  } as unknown as TabCatalog
  const debuggerApi = new FakeDebuggerApi()
  const manager = new CdpSessionManager({ debuggerApi: new ChromeDebugger(debuggerApi as never, { lastError: () => undefined }) })
  const router = new BridgeRouter({ bridge: bridge as unknown as BridgeClient, vault, catalog, sessionManager: manager, toolExecutor: executor })
  const port = new FakePort()
  router.connectPanel(port.raw)
  port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB } })
  await vi.waitFor(() => {
    expect(bridge.sentOf('grant.put')).toHaveLength(1)
  })
  const put = bridge.sentOf('grant.put')[0] as GrantPutFrame
  bridge.receive({ v: PROTOCOL_VERSION, type: 'grant.accepted', grantId: put.grantId, handle: GrantHandle('h'.repeat(32)) })
  await vi.waitFor(() => {
    expect(port.messages).toHaveLength(1)
  })
  return { router, bridge, vault, manager, debuggerApi, grantId: put.grantId }
}

describe('extension recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('acknowledges a tool call before executing and answering', async () => {
    const executor = vi.fn(async () => ({ ok: true }))
    const { bridge, grantId } = await makeRouter(executor as unknown as ToolExecutor)
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't1' as never, grantId, operation: 'observe', args: {},
    })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.accepted')).toHaveLength(1)
      expect(bridge.sentOf('tool.result')).toHaveLength(1)
    })
    const accepted = bridge.sentOf('tool.accepted')[0] as ToolAcceptedFrame
    expect(accepted.requestId).toBe('t1')
    expect(bridge.sentOf('tool.result')[0]).toMatchObject({ requestId: 't1', result: { ok: true } })
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('answers an exact duplicate request id from the journal cache without re-executing', async () => {
    const executor = vi.fn(async () => ({ ok: true, page: { url: 'http://x/' } }))
    const { bridge, grantId } = await makeRouter(executor as unknown as ToolExecutor)
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't2' as never, grantId, operation: 'observe', args: {},
    })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(1)
    })
    // The same request id arrives again (network-level duplication).
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't2' as never, grantId, operation: 'observe', args: {},
    })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(2)
    })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(bridge.sentOf('tool.result')[1]).toMatchObject({ requestId: 't2', result: { ok: true } })
  })

  it('expires grants through the sweep and detaches their sessions', async () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, ttlMs: 60_000 })
    const debuggerApi = new FakeDebuggerApi()
    const manager = new CdpSessionManager({ debuggerApi: new ChromeDebugger(debuggerApi as never, { lastError: () => undefined }) })
    const grant = vault.create({ sessionId: 's1', tab: TAB, ttlMs: 60_000 })
    manager.bind({ grantId: grant.grantId, tabId: TAB.tabId })
    await manager.session(grant.grantId)
    expect(debuggerApi.attach).toHaveBeenCalled()
    const expired: GrantId[][] = []
    const off = vault.startExpirySweep(ids => {
      expired.push(ids)
      for (const id of ids) manager.revoke(id)
    })
    now = 1_000 + 61_000
    await vi.advanceTimersByTimeAsync(61_000)
    expect(expired).toEqual([[grant.grantId]])
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 9 }, expect.any(Function))
    off()
  })

  it('exposes grants by tab for close-time revocation', () => {
    const vault = new GrantVault()
    const a = vault.create({ sessionId: 's1', tab: TAB })
    vault.create({ sessionId: 's1', tab: { ...TAB, tabId: 12 } })
    expect(vault.grantIdsOfTab(9)).toEqual([a.grantId])
    expect(vault.grantIdsOfTab(12)).toHaveLength(1)
    expect(vault.grantIdsOfTab(99)).toEqual([])
  })

  it('cleans up only the owned tab ids at startup', async () => {
    const debuggerApi = new FakeDebuggerApi()
    const manager = new CdpSessionManager({ debuggerApi: new ChromeDebugger(debuggerApi as never, { lastError: () => undefined }) })
    manager.bind({ grantId: GrantId('g1'), tabId: 7 })
    await manager.session(GrantId('g1'))
    await manager.cleanupOwned([7, 99])
    expect(debuggerApi.detach).toHaveBeenCalledTimes(1)
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function))
  })
})
