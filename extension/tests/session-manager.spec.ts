import { describe, expect, it, vi } from 'vitest'
import { GrantId } from '@dsh-external/dsh-browser-bridge-protocol'
import { ChromeDebugger, type ChromeDebuggerApi } from '../src/cdp/chrome-debugger.ts'
import { CdpSessionManager, type SessionDetachInfo } from '../src/cdp/session-manager.ts'

class FakeDebuggerApi implements ChromeDebuggerApi {
  attach = vi.fn((_target: chrome.debugger.Debuggee, _version: string, callback?: () => void): Promise<void> => {
    callback?.()
    return Promise.resolve()
  })
  detach = vi.fn((_target: chrome.debugger.Debuggee, callback?: () => void): Promise<void> => {
    callback?.()
    return Promise.resolve()
  })
  sendCommand = vi.fn((_target: chrome.debugger.Debuggee, _method: string, _params?: object, callback?: (result?: unknown) => void): Promise<unknown> => {
    callback?.({})
    return Promise.resolve({})
  })
  getTargets = vi.fn(async (): Promise<chrome.debugger.TargetInfo[]> => [])
  eventHandlers = new Set<(source: chrome.debugger.Debuggee, method: string, params: object) => void>()
  detachHandlers = new Set<(source: chrome.debugger.Debuggee, reason: string) => void>()

  onEvent = {
    addListener: (handler: (source: chrome.debugger.Debuggee, method: string, params: object) => void) => {
      this.eventHandlers.add(handler)
    },
    removeListener: (handler: (source: chrome.debugger.Debuggee, method: string, params: object) => void) => {
      this.eventHandlers.delete(handler)
    },
    hasListener: () => false,
    hasListeners: () => this.eventHandlers.size > 0,
  } as unknown as chrome.debugger.DebuggerEventEvent

  onDetach = {
    addListener: (handler: (source: chrome.debugger.Debuggee, reason: string) => void) => {
      this.detachHandlers.add(handler)
    },
    removeListener: (handler: (source: chrome.debugger.Debuggee, reason: string) => void) => {
      this.detachHandlers.delete(handler)
    },
    hasListener: () => false,
    hasListeners: () => this.detachHandlers.size > 0,
  } as unknown as chrome.debugger.DebuggerDetachedEvent

  emitEvent(source: chrome.debugger.Debuggee, method: string, params: object): void {
    for (const handler of this.eventHandlers) handler(source, method, params)
  }

  emitDetach(source: chrome.debugger.Debuggee, reason: string): void {
    for (const handler of this.detachHandlers) handler(source, reason)
  }
}

const GRANT_A = GrantId('grant-a')
const GRANT_B = GrantId('grant-b')

function makeManager(options: { lastError?: { message?: string } } = {}): {
  manager: CdpSessionManager
  api: FakeDebuggerApi
  detaches: SessionDetachInfo[]
} {
  const api = new FakeDebuggerApi()
  const detaches: SessionDetachInfo[] = []
  const lastError = options.lastError
  const manager = new CdpSessionManager({
    debuggerApi: new ChromeDebugger(api as unknown as typeof chrome.debugger, { lastError: () => lastError }),
    onDetach: info => detaches.push(info),
  })
  return { manager, api, detaches }
}

describe('CDP session manager', () => {
  it('lazily attaches on the first tool call and shares one session per tab', async () => {
    const { manager, api } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    expect(api.attach).not.toHaveBeenCalled()
    await manager.session(GRANT_A)
    expect(api.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3', expect.any(Function))
    manager.bind({ grantId: GRANT_B, tabId: 7 })
    await manager.session(GRANT_B)
    expect(api.attach).toHaveBeenCalledTimes(1)
  })

  it('detaches only when the final grant for a tab is revoked', async () => {
    const { manager, api } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    manager.bind({ grantId: GRANT_B, tabId: 7 })
    await manager.session(GRANT_A)
    manager.revoke(GRANT_A)
    expect(api.detach).not.toHaveBeenCalled()
    manager.revoke(GRANT_B)
    expect(api.detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function))
  })

  it('enables the required CDP domains and OOPIF auto-attach on first attach', async () => {
    const { manager, api } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    await manager.session(GRANT_A)
    const domains = ['Page', 'DOM', 'CSS', 'Accessibility', 'Runtime', 'Log', 'Network']
    for (const domain of domains) {
      expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, `${domain}.enable`, undefined, expect.any(Function))
    }
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, expect.any(Function))
  })

  it('does not re-enable domains for a shared session', async () => {
    const { manager, api } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    manager.bind({ grantId: GRANT_B, tabId: 7 })
    await manager.session(GRANT_A)
    await manager.session(GRANT_B)
    expect(api.sendCommand.mock.calls.filter(call => call[1] === 'Page.enable')).toHaveLength(1)
  })

  it('translates attach failures to debugger_busy', async () => {
    const { manager, api } = makeManager({ lastError: { message: 'Another debugger is already attached' } })
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    api.attach.mockImplementationOnce((_target: chrome.debugger.Debuggee, _version: string, callback?: () => void): Promise<void> => {
      callback?.()
      return Promise.resolve()
    })
    await expect(manager.session(GRANT_A)).rejects.toMatchObject({ code: 'debugger_busy' })
  })

  it('increments the generation and clears refs on main-frame navigation', async () => {
    const { manager, api } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    const session = await manager.session(GRANT_A)
    const ref = session.refs.register(42, 'frame-1', session.generation)
    api.emitEvent({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'frame-1', url: 'http://127.0.0.1:4173/new', parentId: undefined },
    })
    expect(session.generation).toBe(2)
    expect(() => session.refs.resolve(ref, session.generation)).toThrowError(expect.objectContaining({ code: 'stale_element' }))
  })

  it('suspends writes only on an unmarked cross-origin transition', async () => {
    const { manager, api } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    const session = await manager.session(GRANT_A)
    // The first observed navigation has no known previous URL, so it cannot
    // be classified cross-origin; an HMR reload must not suspend the dev loop.
    api.emitEvent({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'frame-1', url: 'http://127.0.0.1:4173/', parentId: undefined },
    })
    expect(session.writeSuspended).toBe(false)
    expect(session.currentUrl).toBe('http://127.0.0.1:4173/')
    // A same-origin navigation only updates the URL.
    api.emitEvent({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'frame-1', url: 'http://127.0.0.1:4173/reloaded', parentId: undefined },
    })
    expect(session.writeSuspended).toBe(false)
    // An armed expected-navigation window authorizes a cross-origin result.
    session.expectNavigation(5_000)
    api.emitEvent({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'frame-1', url: 'https://expected.example/', parentId: undefined },
    })
    expect(session.writeSuspended).toBe(false)
    // An unmarked cross-origin transition suspends writes.
    api.emitEvent({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'frame-1', url: 'https://unexpected.example/', parentId: undefined },
    })
    expect(session.writeSuspended).toBe(true)
  })

  it('does not bump the generation for iframe navigation', async () => {
    const { manager, api } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    const session = await manager.session(GRANT_A)
    api.emitEvent({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'frame-2', url: 'http://iframe.example/', parentId: 'frame-1' },
    })
    expect(session.generation).toBe(1)
  })

  it('reports tab_closed for target_closed detach and debugger_detached otherwise', async () => {
    const { manager, api, detaches } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    await manager.session(GRANT_A)
    api.emitDetach({ tabId: 7 }, 'target_closed')
    expect(detaches).toContainEqual(expect.objectContaining({
      tabId: 7,
      error: expect.objectContaining({ code: 'tab_closed' }),
    }))

    manager.bind({ grantId: GRANT_B, tabId: 9 })
    await manager.session(GRANT_B)
    api.emitDetach({ tabId: 9 }, 'canceled_by_user')
    expect(detaches).toContainEqual(expect.objectContaining({
      tabId: 9,
      error: expect.objectContaining({ code: 'debugger_detached' }),
    }))
  })

  it('detach clears buffers and refs and rejects pending calls', async () => {
    const { manager, api, detaches } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    const session = await manager.session(GRANT_A)
    session.refs.register(1, 'f', session.generation)
    api.sendCommand.mockImplementationOnce(() => new Promise(() => {}))
    const pending = manager.send(GRANT_A, 'Runtime.evaluate', { expression: '1' })
    // The async send() registers its pending entry before dispatching.
    await vi.waitFor(() => {
      expect(api.sendCommand).toHaveBeenCalled()
    })
    api.emitDetach({ tabId: 7 }, 'canceled_by_user')
    await expect(pending).rejects.toMatchObject({ code: 'debugger_detached' })
    expect(session.refs.resolve).toBeDefined()
    expect(detaches).toHaveLength(1)
  })

  it('sends commands through the wrapped debugger', async () => {
    const { manager, api } = makeManager()
    manager.bind({ grantId: GRANT_A, tabId: 7 })
    const session = await manager.session(GRANT_A)
    api.sendCommand.mockImplementationOnce((_target: chrome.debugger.Debuggee, _method: string, _params?: object, callback?: (result?: unknown) => void): Promise<unknown> => {
      callback?.({ result: { value: 42 } })
      return Promise.resolve({})
    })
    const result = await manager.send(GRANT_A, 'Runtime.evaluate', { expression: '1' })
    expect(result).toEqual({ result: { value: 42 } })
    expect(session.generation).toBe(1)
  })

  it('revokes the session for an unknown grant', async () => {
    const { manager } = makeManager()
    await expect(manager.session(GrantId('nope'))).rejects.toMatchObject({ code: 'grant_expired' })
  })

  it('cleanupOwned detaches owned tab ids without local session state', async () => {
    const { manager, api } = makeManager()
    // Startup reconciliation runs in a fresh worker: no local session exists
    // for the ledger's tab ids, but the previous worker's debugger session
    // must still be detached unconditionally.
    await manager.cleanupOwned([7, 8])
    expect(api.detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function))
    expect(api.detach).toHaveBeenCalledWith({ tabId: 8 }, expect.any(Function))
  })
})
