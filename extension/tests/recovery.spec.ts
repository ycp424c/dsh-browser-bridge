import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectionId, GrantHandle, GrantId, PROTOCOL_VERSION, type BridgeFrame,
  type GrantPutFrame, type JsonValue, type TabDescriptor, type ToolAcceptedFrame,
} from '@ycp424c/dsh-browser-bridge-protocol'
import { BridgeRouter, type ToolExecutor } from '../src/bridge/router.ts'
import { BridgeClient as RealBridgeClient, type BridgeSocket } from '../src/bridge/client.ts'
import type { BridgeClient } from '../src/bridge/client.ts'
import type { TabCatalog } from '../src/tabs/catalog.ts'
import { GrantVault } from '../src/grants/vault.ts'
import { CdpSessionManager } from '../src/cdp/session-manager.ts'
import { ChromeDebugger, type ChromeDebuggerApi } from '../src/cdp/chrome-debugger.ts'

const TAB: TabDescriptor = { tabId: 9, windowId: 3, title: 'App', url: 'http://127.0.0.1:4173/' }

class FakeBridge {
  sent: BridgeFrame[] = []
  closed = false
  private frameHandlers = new Set<(frame: BridgeFrame) => void>()
  private sessionChangedHandlers = new Set<() => void>()

  send(frame: BridgeFrame): void { this.sent.push(frame) }
  onFrame(handler: (frame: BridgeFrame) => void): () => void {
    this.frameHandlers.add(handler)
    return () => this.frameHandlers.delete(handler)
  }
  onState(): () => void { return () => {} }
  onSessionChanged(handler: () => void): () => void {
    this.sessionChangedHandlers.add(handler)
    return () => this.sessionChangedHandlers.delete(handler)
  }
  connect(): void {}
  close(): void {
    this.closed = true
  }

  receive(frame: BridgeFrame): void {
    for (const handler of this.frameHandlers) handler(frame)
  }

  sessionChanged(): void {
    for (const handler of this.sessionChangedHandlers) handler()
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
  private disconnectHandlers = new Set<() => void>()
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

  receive(message: unknown): void {
    for (const handler of this.messageHandlers) handler(message)
  }

  /** Fire the port's disconnect listeners (terminal panel loss). */
  disconnect(): void {
    for (const handler of this.disconnectHandlers) handler()
  }
}

async function makeRouter(
  executor: ToolExecutor = async () => ({ ok: true }),
  vaultOverride?: GrantVault,
): Promise<{
  router: BridgeRouter
  bridge: FakeBridge
  vault: GrantVault
  manager: CdpSessionManager
  debuggerApi: FakeDebuggerApi
  grantId: GrantId
  port: FakePort
}> {
  const bridge = new FakeBridge()
  const vault = vaultOverride ?? new GrantVault()
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
  return { router, bridge, vault, manager, debuggerApi, grantId: put.grantId, port }
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
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000, maxTtlMs: 300_000 })
    const executor = vi.fn(async () => ({ ok: true, page: { url: 'http://x/' } }))
    const { bridge, grantId } = await makeRouter(executor as unknown as ToolExecutor, vault)
    now = 51_000
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't2' as never, grantId, operation: 'observe', args: {},
    })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(1)
    })
    expect(vault.resolve(grantId).expiresAt).toBe(111_000)
    // The same request id arrives again (network-level duplication).
    now = 71_000
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't2' as never, grantId, operation: 'observe', args: {},
    })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(2)
    })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(vault.resolve(grantId).expiresAt).toBe(111_000)
    expect(bridge.sentOf('tool.result')[1]).toMatchObject({ requestId: 't2', result: { ok: true } })
  })

  it('journals a concurrent duplicate before lazy CDP attachment can yield', async () => {
    let release!: (value: JsonValue) => void
    const pending = new Promise<JsonValue>(resolve => { release = resolve })
    const executor = vi.fn(() => pending)
    const { bridge, grantId } = await makeRouter(executor as unknown as ToolExecutor)
    const frame = {
      v: PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 't-concurrent' as never,
      grantId,
      operation: 'observe',
      args: {},
    } as const

    bridge.receive(frame)
    bridge.receive(frame)
    await vi.waitFor(() => {
      expect(executor).toHaveBeenCalled()
    })
    release({ ok: true })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(2)
    })

    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('replays a failed duplicate without renewing or executing it again', async () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000, maxTtlMs: 300_000 })
    const executor = vi.fn(async () => {
      throw { code: 'internal', message: 'fixture failure', retryable: false }
    })
    const { bridge, grantId } = await makeRouter(executor as unknown as ToolExecutor, vault)
    const frame = {
      v: PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 't-failed-duplicate' as never,
      grantId,
      operation: 'observe',
      args: {},
    } as const

    now = 51_000
    bridge.receive(frame)
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(1)
    })
    expect(vault.resolve(grantId).expiresAt).toBe(111_000)

    now = 71_000
    bridge.receive(frame)
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(2)
    })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(vault.resolve(grantId).expiresAt).toBe(111_000)
    expect(bridge.sentOf('tool.result')[1]).toMatchObject({
      requestId: 't-failed-duplicate',
      result: { ok: false, error: { code: 'internal', message: 'fixture failure' } },
    })
  })

  it('replays a successful duplicate after the former short cache window', async () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000, maxTtlMs: 300_000 })
    const executor = vi.fn(async () => ({ ok: true }))
    const { bridge, grantId } = await makeRouter(executor as unknown as ToolExecutor, vault)
    const frame = {
      v: PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 't-delayed-duplicate' as never,
      grantId,
      operation: 'observe',
      args: {},
    } as const

    now = 51_000
    bridge.receive(frame)
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(1)
    })
    await vi.advanceTimersByTimeAsync(11_000)
    now = 71_000
    bridge.receive(frame)
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(2)
    })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(vault.resolve(grantId).expiresAt).toBe(111_000)
  })

  it('fails closed when a request id is reused with a different payload', async () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000, maxTtlMs: 300_000 })
    const executor = vi.fn(async () => ({ ok: true }))
    const { bridge, grantId } = await makeRouter(executor as unknown as ToolExecutor, vault)
    now = 51_000
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't-reused' as never, grantId, operation: 'observe', args: {},
    })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(1)
    })
    now = 71_000
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't-reused' as never, grantId, operation: 'inspect', args: {},
    })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(2)
    })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(vault.resolve(grantId).expiresAt).toBe(111_000)
    expect(bridge.sentOf('tool.result')[1]).toMatchObject({
      result: { ok: false, error: { code: 'permission_denied' } },
    })
  })

  it('does not treat an in-flight tool call as idle before it settles', async () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000, maxTtlMs: 300_000 })
    let release!: (value: JsonValue) => void
    const pending = new Promise<JsonValue>(resolve => { release = resolve })
    const executor = vi.fn(() => pending)
    const { bridge, grantId, manager } = await makeRouter(executor as unknown as ToolExecutor, vault)
    const expired: GrantId[][] = []
    const off = vault.startExpirySweep(ids => {
      expired.push(ids)
      for (const id of ids) manager.revoke(id)
    })

    now = 51_000
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't-long' as never, grantId, operation: 'observe', args: {},
    })
    await vi.waitFor(() => {
      expect(executor).toHaveBeenCalledTimes(1)
    })
    now = 112_000
    await vi.advanceTimersByTimeAsync(61_000)

    expect(expired).toEqual([])
    expect(vault.resolve(grantId)).toBeDefined()

    release({ ok: true })
    await vi.waitFor(() => {
      expect(bridge.sentOf('tool.result')).toHaveLength(1)
    })
    expect(vault.resolve(grantId).expiresAt).toBe(172_000)
    off()
  })

  it('expires grants through the sweep and detaches their sessions', async () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000 })
    const debuggerApi = new FakeDebuggerApi()
    const manager = new CdpSessionManager({ debuggerApi: new ChromeDebugger(debuggerApi as never, { lastError: () => undefined }) })
    const grant = vault.create({ sessionId: 's1', tab: TAB, idleTtlMs: 60_000 })
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

  it('sweeps grants created after the sweep started on an empty vault', async () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000 })
    const expired: GrantId[][] = []
    // The real startup order: the sweep is started BEFORE any grant exists,
    // so no timer is armed for the empty vault.
    vault.startExpirySweep(ids => expired.push(ids))
    const grant = vault.create({ sessionId: 's1', tab: TAB, idleTtlMs: 60_000 })
    now = 1_000 + 61_000
    await vi.advanceTimersByTimeAsync(61_000)
    expect(expired).toEqual([[grant.grantId]])
  })

  it('re-arms the sweep after a grant created later expires', async () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000 })
    const expired: GrantId[][] = []
    vault.startExpirySweep(ids => expired.push(ids))
    const first = vault.create({ sessionId: 's1', tab: TAB, idleTtlMs: 60_000 })
    const second = vault.create({ sessionId: 's1', tab: { ...TAB, tabId: 12 }, idleTtlMs: 120_000 })
    now = 1_000 + 61_000
    await vi.advanceTimersByTimeAsync(61_000)
    expect(expired).toEqual([[first.grantId]])
    // The sweep keeps running for the remaining grant instead of stopping.
    now = 1_000 + 121_000
    await vi.advanceTimersByTimeAsync(60_000)
    expect(expired).toEqual([[first.grantId], [second.grantId]])
  })

  it('expiry revokes the CDP session and reports the grant for host notification', async () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000 })
    const debuggerApi = new FakeDebuggerApi()
    const manager = new CdpSessionManager({ debuggerApi: new ChromeDebugger(debuggerApi as never, { lastError: () => undefined }) })
    const revoked: GrantId[] = []
    const notified: GrantId[] = []
    // Mirrors the background wiring: the sweep revokes the CDP binding and
    // notifies the host with grant.revoke.
    vault.startExpirySweep(ids => {
      for (const id of ids) {
        manager.revoke(id)
        revoked.push(id)
        notified.push(id)
      }
    })
    const grant = vault.create({ sessionId: 's1', tab: TAB, idleTtlMs: 60_000 })
    manager.bind({ grantId: grant.grantId, tabId: TAB.tabId })
    await manager.session(grant.grantId)
    expect(debuggerApi.attach).toHaveBeenCalled()
    now = 1_000 + 61_000
    await vi.advanceTimersByTimeAsync(61_000)
    expect(revoked).toEqual([grant.grantId])
    expect(notified).toEqual([grant.grantId])
    // The final grant of the tab is gone: the debugger session is released.
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 9 }, expect.any(Function))
    expect(() => vault.resolve(grant.grantId)).toThrow(/grant expired/)
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
    // Startup reconciliation runs in a fresh worker: EVERY ledger tab id is
    // detached unconditionally, whether or not a local session exists.
    await manager.cleanupOwned([7, 99])
    expect(debuggerApi.detach).toHaveBeenCalledTimes(2)
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function))
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 99 }, expect.any(Function))
  })

  it('panel-port loss is terminal: revokes grants, notifies the host, detaches CDP, and closes the bridge', async () => {
    const { bridge, vault, debuggerApi, grantId, port } = await makeRouter()
    // Execute one tool call so the debugger is attached.
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't1' as never, grantId, operation: 'observe', args: {},
    })
    await vi.waitFor(() => {
      expect(debuggerApi.attach).toHaveBeenCalled()
    })
    // The side panel closes: the logical session is TERMINAL on both sides.
    port.disconnect()
    expect(vault.owned()).toEqual([])
    expect(bridge.sentOf('grant.revoke')).toContainEqual(expect.objectContaining({ grantId }))
    await vi.waitFor(() => {
      expect(debuggerApi.detach).toHaveBeenCalled()
    })
    expect(bridge.closed).toBe(true)
  })

  it('revokes local grants and sessions when the bridge reports a new logical session', async () => {
    const { bridge, vault, debuggerApi, grantId } = await makeRouter()
    bridge.receive({
      v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't2' as never, grantId, operation: 'observe', args: {},
    })
    await vi.waitFor(() => {
      expect(debuggerApi.attach).toHaveBeenCalled()
    })
    // The host restarted: hello.ok carries a different connection id and the
    // client emits session-changed. Every grant of the dead session is
    // revoked locally and the CDP session is released.
    bridge.sessionChanged()
    expect(vault.owned()).toEqual([])
    await vi.waitFor(() => {
      expect(debuggerApi.detach).toHaveBeenCalled()
    })
  })

  it('delivers a queued turn revocation over a same-origin reconnect and detaches CDP', async () => {
    // REAL two-sided contract: the BridgeClient keeps the same connection id
    // across a transient drop (no session-changed), so the host's queued
    // grant.revoke is the ONLY thing that tears the grant and CDP down.
    let socket = new RealSocket()
    const client = new RealBridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
    const vault = new GrantVault()
    const debuggerApi = new FakeDebuggerApi()
    const manager = new CdpSessionManager({ debuggerApi: new ChromeDebugger(debuggerApi as never, { lastError: () => undefined }) })
    const router = new BridgeRouter({
      bridge: client as unknown as BridgeClient,
      vault,
      catalog: {
        byId: async (tabId: number): Promise<TabDescriptor | undefined> => (tabId === TAB.tabId ? { ...TAB } : undefined),
        current: async (): Promise<TabDescriptor> => ({ ...TAB }),
        list: async (): Promise<TabDescriptor[]> => [{ ...TAB }],
      } as unknown as TabCatalog,
      sessionManager: manager,
      toolExecutor: async () => ({ ok: true }),
    })
    let changed = 0
    client.onSessionChanged(() => { changed += 1 })
    client.connect('ws://x', 'nonce-one')
    socket.open()
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello.ok', connectionId: ConnectionId('c1') }))

    // Issue and accept one grant through the real frames.
    const port = new FakePort()
    router.connectPanel(port.raw)
    port.receive({ type: 'grant.create', requestId: 'r1', sessionId: 's1', tab: { ...TAB } })
    await vi.waitFor(() => {
      expect(socket.sentFrames().some(frame => frame.type === 'grant.put')).toBe(true)
    })
    const put = socket.sentFrames().find(frame => frame.type === 'grant.put') as GrantPutFrame
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'grant.accepted', grantId: put.grantId, handle: GrantHandle('h'.repeat(32)) }))
    await vi.waitFor(() => {
      expect(vault.owned()).toHaveLength(1)
    })

    // CDP is active on the grant.
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'tool.call', requestId: 't1', grantId: put.grantId, operation: 'observe', args: {} }))
    await vi.waitFor(() => {
      expect(debuggerApi.attach).toHaveBeenCalled()
    })

    // The socket drops transiently; the turn ends on the host while it is
    // down and the host queues grant.revoke for this same logical session.
    socket.close()
    expect(client.state).toBe('reconnecting')
    // A same-origin reconnect with a FRESH nonce resumes the SAME session:
    // the client must NOT treat it as a session change.
    socket = new RealSocket()
    client.connect('ws://x', 'nonce-two')
    socket.open()
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello.ok', connectionId: ConnectionId('c1') }))
    expect(changed).toBe(0)
    // The flushed revocation arrives and tears the grant and CDP down.
    socket.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: 'grant.revoke', grantId: put.grantId }))
    await vi.waitFor(() => {
      expect(vault.owned()).toEqual([])
      expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 9 }, expect.any(Function))
    })
    expect(() => vault.resolve(put.grantId)).toThrow(/grant expired/)
  })
})

class RealSocket implements BridgeSocket {
  sent: BridgeFrame[] = []
  closed = false
  private openHandlers: (() => void)[] = []
  private messageHandlers: ((text: string) => void)[] = []
  private closeHandlers: (() => void)[] = []

  onOpen(handler: () => void): void { this.openHandlers.push(handler) }
  onMessage(handler: (text: string) => void): void { this.messageHandlers.push(handler) }
  onClose(handler: () => void): void { this.closeHandlers.push(handler) }
  send(text: string): void { this.sent.push(JSON.parse(text) as BridgeFrame) }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const handler of this.closeHandlers) handler()
  }
  open(): void { for (const handler of this.openHandlers) handler() }
  receive(text: string): void { for (const handler of this.messageHandlers) handler(text) }
  sentFrames(): BridgeFrame[] { return this.sent }
}
