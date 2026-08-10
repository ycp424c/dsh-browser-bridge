/**
 * Prompt-bound CDP session manager: lazy debugger attach, per-tab physical
 * session sharing, per-grant authorization views, navigation generations,
 * event routing, and detach cleanup.
 *
 * The physical `chrome.debugger` attach is shared by every grant of one tab
 * (one attach, one detach when the final grant revokes), but the
 * AUTHORIZATION state — the URL baseline a grant was issued for, the
 * expected-navigation window, and write suspension — is isolated per grant.
 * A navigation event is classified for every live grant: grant A's expected
 * cross-origin navigation never authorizes grant B, and a new grant issued
 * at the current URL is writable while the old grant stays suspended.
 */
import {
  bridgeError,
  type BridgeError,
  type GrantId,
} from '@dsh-external/dsh-browser-bridge-protocol'
import type { ChromeDebuggerApi } from './chrome-debugger.ts'
import { NodeRegistry } from './nodes.ts'
import { EVIDENCE_BUFFER_SIZE, normalizeConsoleEntry, normalizeNetworkEntry, pushBounded } from './capture.ts'

export const CDP_PROTOCOL_VERSION = '1.3'

export const ENABLED_DOMAINS = [
  'Page', 'DOM', 'CSS', 'Accessibility', 'Runtime', 'Log', 'Network',
] as const

/** One normalized console evidence row. */
export interface ConsoleRow {
  timestamp: number
  level: 'error' | 'warning' | 'log'
  text: string
  url: string
}

/** One normalized network evidence row (no headers, bodies, or cookies). */
export interface NetworkRow {
  timestamp: number
  method?: string
  url: string
  status?: number
  error?: string
}

/**
 * One grant's authorized view of a tab: proxies the shared physical state
 * (send, generation, refs, evidence buffers) while carrying its own URL
 * baseline, expected-navigation window, and write suspension.
 */
export interface TabSession {
  tabId: number
  /** Bumped by every main-frame document navigation (physical, shared). */
  generation: number
  attached: boolean
  /** Element references of the current generation (physical, shared). */
  refs: NodeRegistry
  /** Set when THIS grant observes an unexpected cross-origin transition. */
  writeSuspended: boolean
  /** Console/network evidence buffers (physical, shared; start empty). */
  consoleEntries: ConsoleRow[]
  networkEntries: NetworkRow[]
  /** Send one CDP command on this tab's physical session. */
  send(method: string, params?: object): Promise<unknown>
  /** This grant's view of the last observed main-frame URL. */
  currentUrl: string
  /** Timestamp of the latest DOM/lifecycle/main-frame change (physical). */
  lastChangeAt: number | null
  /** This grant's open expected-navigation window, or null. */
  expectNavigationWindow: { until: number; expectedOrigin: string | null } | null
  /** Arm THIS grant's expected-navigation window for the next navigation. */
  expectNavigation(timeoutMs: number, expectedOrigin?: string): void
  /** Classify one main-frame navigation for THIS grant. */
  onMainFrameNavigated(url: string, opts: { expected: boolean }): void
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

export interface SessionDetachInfo {
  tabId: number
  error: BridgeError
  grantIds: GrantId[]
}

export interface CdpSessionManagerOptions {
  debuggerApi: ChromeDebuggerApi
  onDetach?: (info: SessionDetachInfo) => void
  now?: () => number
}

interface PendingCommand {
  resolve(value: unknown): void
  reject(error: unknown): void
}

/** One tab's shared physical CDP state (one entry per attached tab). */
interface TabState {
  tabId: number
  generation: number
  attached: boolean
  refs: NodeRegistry
  consoleEntries: ConsoleRow[]
  networkEntries: NetworkRow[]
  networkRequestMethods: Map<string, string>
  lastChangeAt: number | null
  currentUrl: string
}

export class CdpSessionManager {
  private readonly debuggerApi: ChromeDebuggerApi
  private readonly onDetach: ((info: SessionDetachInfo) => void) | undefined
  private readonly now: () => number
  private readonly tabStates = new Map<number, TabState>()
  /** grantId -> its authorized view (created at bind, removed at revoke). */
  private readonly grantViews = new Map<string, TabSession>()
  private readonly grantToTab = new Map<string, number>()
  /** The exact URL each grant was issued for (its authorization baseline). */
  private readonly grantToUrl = new Map<string, string>()
  private readonly tabGrants = new Map<number, Set<string>>()
  private readonly pending = new Map<number, Set<PendingCommand>>()
  /** In-flight physical attach per tab, so concurrent calls share it. */
  private readonly attaching = new Map<number, Promise<void>>()

  constructor(options: CdpSessionManagerOptions) {
    this.debuggerApi = options.debuggerApi
    this.onDetach = options.onDetach
    this.now = options.now ?? Date.now
    this.debuggerApi.onEvent.addListener((source, method, params) => this.handleEvent(source, method, params))
    this.debuggerApi.onDetach.addListener((source, reason) => this.handleDetach(source, reason))
  }

  /** Bind a grant to its exact tab WITHOUT attaching the debugger. */
  bind(grant: { grantId: GrantId; tabId: number; url?: string }): void {
    this.grantToTab.set(grant.grantId, grant.tabId)
    if (grant.url !== undefined) this.grantToUrl.set(grant.grantId, grant.url)
    let grants = this.tabGrants.get(grant.tabId)
    if (grants === undefined) {
      grants = new Set()
      this.tabGrants.set(grant.tabId, grants)
    }
    grants.add(grant.grantId)
    // The grant's view exists from bind time on, so navigation events are
    // classified against its baseline even before its first tool call.
    this.grantViews.set(grant.grantId, this.createView(grant.tabId, grant.url ?? ''))
  }

  /** Revoke one grant; detaches when it was the final grant of its tab. */
  revoke(grantId: GrantId): void {
    const tabId = this.grantToTab.get(grantId)
    if (tabId === undefined) return
    this.grantToTab.delete(grantId)
    this.grantToUrl.delete(grantId)
    this.grantViews.delete(grantId)
    const grants = this.tabGrants.get(tabId)
    grants?.delete(grantId)
    if (grants === undefined || grants.size === 0) {
      this.tabGrants.delete(tabId)
      void this.detachTab(tabId)
    }
  }

  /**
   * Service-worker startup reconciliation: best-effort detach ONLY the owned
   * tab ids recorded in the prior session's ledger, then start empty.
   * This worker instance has no local session state for those tabs — the
   * previous worker may have died while the debugger was still attached —
   * so the detach must be attempted unconditionally.
   */
  async cleanupOwned(tabIds: number[]): Promise<void> {
    for (const tabId of tabIds) {
      await this.detachTabId(tabId)
      this.tabStates.delete(tabId)
      this.tabGrants.delete(tabId)
    }
  }

  /** Revoke every grant and detach every owned session. */
  revokeAll(): void {
    for (const tabId of [...this.tabStates.keys()]) {
      const grants = this.tabGrants.get(tabId)
      if (grants !== undefined) {
        for (const grantId of [...grants]) {
          this.grantToTab.delete(grantId)
          this.grantToUrl.delete(grantId)
          this.grantViews.delete(grantId)
        }
        this.tabGrants.delete(tabId)
      }
      void this.detachTab(tabId)
    }
  }

  /**
   * Resolve ONE grant's authorized session view, lazily attaching the shared
   * physical debugger session and enabling the required CDP domains on the
   * tab's first use. If any domain fails to enable, the attach is rolled
   * back (best-effort detach, unattached state) and the error propagates —
   * a half-initialized session is never returned.
   */
  async session(grantId: GrantId): Promise<TabSession> {
    const tabId = this.grantToTab.get(grantId)
    if (tabId === undefined) {
      throw bridgeError('grant_expired', 'grant is not bound to a tab', false)
    }
    await this.ensurePhysical(tabId)
    const view = this.grantViews.get(grantId)
    if (view === undefined) {
      // The grant was revoked while the physical attach was pending.
      throw bridgeError('grant_expired', 'grant is not bound to a tab', false)
    }
    return view
  }

  /** Send one CDP command on a grant's session; tracked for detach rejection. */
  async send(grantId: GrantId, method: string, params?: object): Promise<unknown> {
    const session = await this.session(grantId)
    return this.sendTab(session.tabId, method, params)
  }

  /** Send one CDP command on a tab's session; tracked for detach rejection. */
  private async sendTab(tabId: number, method: string, params?: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let pending: Set<PendingCommand> | undefined = this.pending.get(tabId)
      if (pending === undefined) {
        pending = new Set()
        this.pending.set(tabId, pending)
      }
      const entry: PendingCommand = { resolve, reject }
      pending.add(entry)
      this.debuggerApi.sendCommand({ tabId }, method, params).then(
        result => {
          pending?.delete(entry)
          resolve(result)
        },
        error => {
          pending?.delete(entry)
          reject(error)
        },
      )
    })
  }

  /** Route one CDP event to the owning tab's physical state and grant views. */
  handleEvent(source: chrome.debugger.Debuggee, method: string, params: object | undefined): void {
    params ??= {}
    if (source.tabId === undefined) return
    const state = this.tabStates.get(source.tabId)
    if (state === undefined) return
    const event = params as {
      frame?: { id?: string; parentId?: string; url?: string }
      type?: string
    }
    if (method === 'Page.frameNavigated' && event.frame !== undefined && event.frame.parentId === undefined) {
      // Main-frame document navigation: new document generation. The
      // physical state updates once; every live grant's view classifies the
      // transition against its OWN baseline and expected-navigation window.
      state.generation += 1
      state.refs.clear()
      state.lastChangeAt = this.now()
      state.currentUrl = event.frame.url ?? ''
      const grants = this.tabGrants.get(source.tabId)
      if (grants !== undefined) {
        for (const grantId of grants) {
          const view = this.grantViews.get(grantId)
          if (view === undefined) continue
          view.onMainFrameNavigated(state.currentUrl, {
            expected: view.expectNavigationWindow !== null && this.now() <= view.expectNavigationWindow.until,
          })
        }
      }
      return
    }
    if (method === 'DOM.documentUpdated' || method === 'Page.lifecycleEvent' || method === 'Page.navigatedWithinDocument') {
      state.lastChangeAt = this.now()
      return
    }
    if (method === 'Runtime.consoleAPICalled' || method === 'Log.entryAdded') {
      const row = normalizeConsoleEntry(method, params as Record<string, unknown>)
      if (row !== null) pushBounded(state.consoleEntries, row, EVIDENCE_BUFFER_SIZE)
      return
    }
    if (method === 'Network.requestWillBeSent' || method === 'Network.responseReceived' || method === 'Network.loadingFailed') {
      const row = normalizeNetworkEntry(method, params as Record<string, unknown>, state.networkRequestMethods)
      if (row !== null) pushBounded(state.networkEntries, row, EVIDENCE_BUFFER_SIZE)
    }
  }

  /** Handle a chrome.debugger detach for one of our sessions. */
  handleDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (source.tabId === undefined) return
    const state = this.tabStates.get(source.tabId)
    if (state === undefined) return
    state.attached = false
    state.refs.clear()
    state.consoleEntries = []
    state.networkEntries = []
    state.networkRequestMethods.clear()
    const pending = this.pending.get(source.tabId)
    if (pending !== undefined) {
      this.pending.delete(source.tabId)
      const error = reason === 'target_closed'
        ? bridgeError('tab_closed', 'the attached tab was closed', false)
        : bridgeError('debugger_detached', 'the CDP session detached (for example DevTools was opened); retry the tool call', false)
      for (const entry of pending) entry.reject(error)
    }
    const grantIds = [...(this.tabGrants.get(source.tabId) ?? [])] as GrantId[]
    const error = reason === 'target_closed'
      ? bridgeError('tab_closed', 'the attached tab was closed', false)
      : bridgeError('debugger_detached', 'the CDP session detached (for example DevTools was opened); retry the tool call', false)
    this.onDetach?.({ tabId: source.tabId, error, grantIds })
  }

  /** Ensure the tab's shared physical session is attached and initialized. */
  private async ensurePhysical(tabId: number): Promise<void> {
    const state = this.tabStates.get(tabId)
    if (state !== undefined && state.attached) return
    const pending = this.attaching.get(tabId)
    if (pending !== undefined) {
      await pending
      return
    }
    const work = this.attachPhysical(tabId)
    this.attaching.set(tabId, work)
    try {
      await work
    } finally {
      this.attaching.delete(tabId)
    }
  }

  /**
   * Attach the shared debugger session and enable the required CDP domains.
   * On any domain failure the attach is rolled back (best-effort detach and
   * unattached state) so no half-initialized session survives; the original
   * error propagates and a later call re-initializes from scratch.
   */
  private async attachPhysical(tabId: number): Promise<void> {
    let state = this.tabStates.get(tabId)
    if (state === undefined) {
      state = {
        tabId,
        generation: 1,
        attached: false,
        refs: new NodeRegistry(),
        consoleEntries: [],
        networkEntries: [],
        networkRequestMethods: new Map(),
        lastChangeAt: null,
        currentUrl: '',
      }
      this.tabStates.set(tabId, state)
    }
    try {
      await this.debuggerApi.attach({ tabId }, CDP_PROTOCOL_VERSION)
    } catch {
      throw bridgeError('debugger_busy', 'another debugger (for example DevTools) is attached to the tab; close it and retry', false)
    }
    try {
      for (const domain of ENABLED_DOMAINS) {
        await this.debuggerApi.sendCommand({ tabId }, `${domain}.enable`)
      }
      await this.debuggerApi.sendCommand({ tabId }, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
    } catch (error) {
      state.attached = false
      try {
        await this.debuggerApi.detach({ tabId })
      } catch {
        // Best-effort rollback; the debugger may already be gone.
      }
      throw error
    }
    state.attached = true
  }

  /** One grant's authorized view over a tab's shared physical state. */
  private createView(tabId: number, baseline: string): TabSession {
    let state = this.tabStates.get(tabId)
    if (state === undefined) {
      state = {
        tabId,
        generation: 1,
        attached: false,
        refs: new NodeRegistry(),
        consoleEntries: [],
        networkEntries: [],
        networkRequestMethods: new Map(),
        lastChangeAt: null,
        currentUrl: '',
      }
      this.tabStates.set(tabId, state)
    }
    const view: TabSession = {
      tabId,
      get generation() { return state.generation },
      get attached() { return state.attached },
      get refs() { return state.refs },
      get consoleEntries() { return state.consoleEntries },
      get networkEntries() { return state.networkEntries },
      get lastChangeAt() { return state.lastChangeAt },
      send: (method, params) => this.sendTab(tabId, method, params),
      // Authorization baseline: the exact URL the grant was issued for, so
      // the FIRST navigation event can already be classified cross-origin.
      currentUrl: baseline,
      writeSuspended: false,
      expectNavigationWindow: null,
      expectNavigation: (timeoutMs, expectedOrigin) => {
        view.expectNavigationWindow = {
          until: this.now() + timeoutMs,
          expectedOrigin: expectedOrigin ?? null,
        }
      },
      onMainFrameNavigated: (url, opts) => {
        const window = view.expectNavigationWindow
        view.expectNavigationWindow = null
        const previous = view.currentUrl
        view.currentUrl = url
        // This grant's armed expected-navigation window authorizes the
        // resulting main-frame navigation and its redirect chain.
        if (window !== null && this.now() <= window.until) return
        // An unmarked CROSS-ORIGIN transition suspends THIS grant's writes.
        // A same-origin transition (for example an HMR reload) only updates
        // the URL, and an unknown previous URL cannot be called cross-origin.
        if (!opts.expected && previous !== '' && originOf(url) !== originOf(previous)) {
          view.writeSuspended = true
        }
      },
    }
    return view
  }

  private async detachTab(tabId: number): Promise<void> {
    const state = this.tabStates.get(tabId)
    if (state === undefined) return
    this.tabStates.delete(tabId)
    if (!state.attached) return
    state.attached = false
    await this.detachTabId(tabId)
  }

  /** Unconditional best-effort detach of one tab's debugger session. */
  private async detachTabId(tabId: number): Promise<void> {
    try {
      await this.debuggerApi.detach({ tabId })
    } catch {
      // The tab or session may already be gone.
    }
  }
}
