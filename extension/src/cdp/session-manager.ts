/**
 * Prompt-bound CDP session manager: lazy debugger attach, per-tab session
 * sharing, navigation generations, event routing, and detach cleanup.
 */
import {
  bridgeError,
  type BridgeError,
  type GrantId,
} from '@dsh-external/dsh-browser-bridge-protocol'
import type { ChromeDebuggerApi } from './chrome-debugger.ts'
import { NodeRegistry } from './nodes.ts'

export const CDP_PROTOCOL_VERSION = '1.3'

export const ENABLED_DOMAINS = [
  'Page', 'DOM', 'CSS', 'Accessibility', 'Runtime', 'Log', 'Network',
] as const

/** One tab's live CDP session; ownership is shared by its grants. */
export interface TabSession {
  tabId: number
  /** Bumped by every main-frame document navigation. */
  generation: number
  attached: boolean
  /** Element references of the current generation. */
  refs: NodeRegistry
  /** Set when an unexpected cross-origin transition occurs. */
  writeSuspended: boolean
  /** Console/network evidence buffers (start empty, cleared on detach). */
  consoleEntries: Array<{ timestamp: number; level: string; text: string; url: string }>
  networkEntries: Array<{ timestamp: number; method: string; url: string; status?: number; error?: string }>
}

export interface SessionDetachInfo {
  tabId: number
  error: BridgeError
  grantIds: GrantId[]
}

export interface CdpSessionManagerOptions {
  debuggerApi: ChromeDebuggerApi
  onDetach?: (info: SessionDetachInfo) => void
}

interface PendingCommand {
  resolve(value: unknown): void
  reject(error: unknown): void
}

export class CdpSessionManager {
  private readonly debuggerApi: ChromeDebuggerApi
  private readonly onDetach: ((info: SessionDetachInfo) => void) | undefined
  private readonly sessions = new Map<number, TabSession>()
  private readonly grantToTab = new Map<string, number>()
  private readonly tabGrants = new Map<number, Set<string>>()
  private readonly pending = new Map<number, Set<PendingCommand>>()

  constructor(options: CdpSessionManagerOptions) {
    this.debuggerApi = options.debuggerApi
    this.onDetach = options.onDetach
    this.debuggerApi.onEvent.addListener((source, method, params) => this.handleEvent(source, method, params))
    this.debuggerApi.onDetach.addListener((source, reason) => this.handleDetach(source, reason))
  }

  /** Bind a grant to its exact tab WITHOUT attaching the debugger. */
  bind(grant: { grantId: GrantId; tabId: number }): void {
    this.grantToTab.set(grant.grantId, grant.tabId)
    let grants = this.tabGrants.get(grant.tabId)
    if (grants === undefined) {
      grants = new Set()
      this.tabGrants.set(grant.tabId, grants)
    }
    grants.add(grant.grantId)
  }

  /** Revoke one grant; detaches when it was the final grant of its tab. */
  revoke(grantId: GrantId): void {
    const tabId = this.grantToTab.get(grantId)
    if (tabId === undefined) return
    this.grantToTab.delete(grantId)
    const grants = this.tabGrants.get(tabId)
    grants?.delete(grantId)
    if (grants === undefined || grants.size === 0) {
      this.tabGrants.delete(tabId)
      void this.detachTab(tabId)
    }
  }

  /** Revoke every grant and detach every owned session. */
  revokeAll(): void {
    for (const tabId of [...this.sessions.keys()]) {
      const grants = this.tabGrants.get(tabId)
      if (grants !== undefined) {
        for (const grantId of [...grants]) this.grantToTab.delete(grantId)
        this.tabGrants.delete(tabId)
      }
      void this.detachTab(tabId)
    }
  }

  /**
   * Resolve the session for one grant, lazily attaching and enabling only
   * the required CDP domains on first use.
   */
  async session(grantId: GrantId): Promise<TabSession> {
    const tabId = this.grantToTab.get(grantId)
    if (tabId === undefined) {
      throw bridgeError('grant_expired', 'grant is not bound to a tab', false)
    }
    const existing = this.sessions.get(tabId)
    if (existing !== undefined && existing.attached) return existing
    try {
      await this.debuggerApi.attach({ tabId }, CDP_PROTOCOL_VERSION)
    } catch {
      throw bridgeError('debugger_busy', 'another debugger (for example DevTools) is attached to the tab; close it and retry', false)
    }
    const session: TabSession = {
      tabId,
      generation: 1,
      attached: true,
      refs: new NodeRegistry(),
      writeSuspended: false,
      consoleEntries: [],
      networkEntries: [],
    }
    this.sessions.set(tabId, session)
    for (const domain of ENABLED_DOMAINS) {
      await this.debuggerApi.sendCommand({ tabId }, `${domain}.enable`)
    }
    await this.debuggerApi.sendCommand({ tabId }, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
    return session
  }

  /** Send one CDP command on a grant's session; tracked for detach rejection. */
  async send(grantId: GrantId, method: string, params?: object): Promise<unknown> {
    const session = await this.session(grantId)
    return new Promise((resolve, reject) => {
      let pending: Set<PendingCommand> | undefined = this.pending.get(session.tabId)
      if (pending === undefined) {
        pending = new Set()
        this.pending.set(session.tabId, pending)
      }
      const entry: PendingCommand = { resolve, reject }
      pending.add(entry)
      this.debuggerApi.sendCommand({ tabId: session.tabId }, method, params).then(
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

  /** Route one CDP event to the owning session. */
  handleEvent(source: chrome.debugger.Debuggee, method: string, params: object | undefined): void {
    params ??= {}
    if (source.tabId === undefined) return
    const session = this.sessions.get(source.tabId)
    if (session === undefined) return
    const event = params as {
      frame?: { id?: string; parentId?: string; url?: string }
      type?: string
    }
    if (method === 'Page.frameNavigated' && event.frame !== undefined && event.frame.parentId === undefined) {
      // Main-frame document navigation: new document generation.
      session.generation += 1
      session.refs.clear()
      return
    }
    // Console and network evidence capture lands with the capture task;
    // the buffers already exist on the session.
  }

  /** Handle a chrome.debugger detach for one of our sessions. */
  handleDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (source.tabId === undefined) return
    const session = this.sessions.get(source.tabId)
    if (session === undefined) return
    session.attached = false
    session.refs.clear()
    session.consoleEntries = []
    session.networkEntries = []
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

  private async detachTab(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId)
    if (session === undefined || !session.attached) {
      this.sessions.delete(tabId)
      return
    }
    session.attached = false
    try {
      await this.debuggerApi.detach({ tabId })
    } catch {
      // The tab may already be gone; the onDetach path owns that outcome.
    }
    this.sessions.delete(tabId)
  }
}
