/**
 * Background router: side-panel requests, bridge frames, and grant issuance.
 * Panel requests arrive over the runtime port; grant offers travel over the
 * authenticated bridge; the iframe never sees grant ids or tab ids — only
 * the non-secret correlation handle.
 */
import {
  bridgeError,
  PROTOCOL_VERSION,
  type BridgeError,
  type BridgeFrame,
  type GrantId,
  type TabDescriptor,
} from '@dsh-external/dsh-browser-bridge-protocol'
import type { BridgeClient } from './client.ts'
import { GrantVault } from '../grants/vault.ts'
import type { TabCatalog } from '../tabs/catalog.ts'
import type { CdpSessionManager, TabSession } from '../cdp/session-manager.ts'
import type { BrowserOperation, JsonValue } from '@dsh-external/dsh-browser-bridge-protocol'

export type PanelRequest =
  | { type: 'bridge.connect'; requestId: string; wsUrl: string; pairingNonce: string }
  | { type: 'tabs.current'; requestId: string }
  | { type: 'tabs.list'; requestId: string }
  | { type: 'grant.create'; requestId: string; sessionId: string; tab: TabDescriptor }
  | { type: 'grant.cancel'; requestId: string }

export interface PanelReply {
  type: 'panel.reply'
  requestId: string
  ok: boolean
  value?: unknown
  error?: BridgeError
}

export interface BridgeRouterDeps {
  bridge: BridgeClient
  vault: GrantVault
  catalog: TabCatalog
  sessionManager: CdpSessionManager
  /** Operation dispatcher; wired by the CDP task layers. */
  toolExecutor?: ToolExecutor
  grantAckTimeoutMs?: number
  /**
   * Startup reconciliation promise. Panel requests and bridge frames wait
   * for it so a restarted worker can never process new work while its
   * previous session's ownership ledger is still pending cleanup.
   */
  startupReady?: Promise<void>
}

export type ToolExecutor = (
  session: TabSession,
  operation: BrowserOperation,
  args: JsonValue,
) => Promise<JsonValue>

/** How one pending grant offer settled. */
type GrantAckResult =
  | { kind: 'accepted'; handle: string }
  /** Explicitly cancelled (iframe abort, panel loss, session change). */
  | { kind: 'cancelled' }
  /** Timed out or rejected by the host. */
  | { kind: 'failed' }

interface PendingGrant {
  resolve(result: GrantAckResult): void
  timer: ReturnType<typeof setTimeout>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function isLoopbackWsUrl(input: string): boolean {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return false
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false
  return LOOPBACK_HOSTS.has(url.hostname)
}

/** Normalize an arbitrary thrown value into a stable bridge error. */
export function normalizeToolError(error: unknown): BridgeError {
  if (typeof error === 'object' && error !== null
    && 'code' in error && typeof (error as { code: unknown }).code === 'string'
    && 'message' in error && typeof (error as { message: unknown }).message === 'string'
    && 'retryable' in error && typeof (error as { retryable: unknown }).retryable === 'boolean') {
    return error as BridgeError
  }
  return bridgeError('internal', error instanceof Error ? error.message : String(error), false)
}

export class BridgeRouter {
  private readonly bridge: BridgeClient
  private readonly vault: GrantVault
  private readonly catalog: TabCatalog
  private readonly sessionManager: CdpSessionManager
  private readonly toolExecutor: ToolExecutor | undefined
  private readonly grantAckTimeoutMs: number
  private readonly startupReady: Promise<void>
  private readonly pendingGrants = new Map<string, PendingGrant>()
  /** Panel request id -> grant id of an in-flight grant.create. */
  private readonly pendingGrantRequests = new Map<string, GrantId>()
  /** Execution journal: requestId -> in-flight execution (dedupes duplicates). */
  private readonly inFlight = new Map<string, Promise<JsonValue>>()
  /** Settled read results kept briefly to answer exact duplicate request ids. */
  private readonly resultCache = new Map<string, { result: JsonValue; at: number }>()
  private readonly resultCacheTtlMs = 10_000

  constructor(deps: BridgeRouterDeps) {
    this.bridge = deps.bridge
    this.vault = deps.vault
    this.catalog = deps.catalog
    this.sessionManager = deps.sessionManager
    this.toolExecutor = deps.toolExecutor
    this.grantAckTimeoutMs = deps.grantAckTimeoutMs ?? 10_000
    this.startupReady = deps.startupReady ?? Promise.resolve()
    deps.bridge.onFrame(frame => this.onBridgeFrame(frame))
    // A new logical session (host restart or takeover) invalidates every
    // grant of the previous one: settle every pending offer, revoke locally,
    // and release all CDP sessions so no orphaned permission survives. The
    // new host has no records for those grants, so there is nothing to
    // notify.
    deps.bridge.onSessionChanged(() => {
      this.settleAllPendingGrants({ kind: 'cancelled' })
      this.vault.revokeAll()
      this.sessionManager.revokeAll()
    })
  }

  /** Attach one side-panel runtime port. */
  connectPanel(port: chrome.runtime.Port): void {
    port.onMessage.addListener((message: unknown) => {
      void this.handlePanelMessage(port, message)
    })
    port.onDisconnect.addListener(() => {
      // The bridge is panel-scoped: when the panel goes away, stop the
      // connection and drop every grant and CDP session it owned. Pending
      // grant offers are settled IMMEDIATELY (no acknowledgement timer
      // leak), the host is notified first so its grant records die with the
      // session, and no reply is sent to the disconnected port.
      this.settleAllPendingGrants({ kind: 'cancelled' })
      const revoked = this.vault.revokeAll()
      for (const grantId of revoked) {
        try {
          this.bridge.send({ v: PROTOCOL_VERSION, type: 'grant.revoke', grantId })
        } catch {
          // The bridge may already be down; the host drops its grants on
          // its own terminal paths.
        }
      }
      this.sessionManager.revokeAll()
      this.bridge.close()
    })
  }

  /** No business request may run before startup reconciliation finishes. */
  private async ready(): Promise<void> {
    await this.startupReady
  }

  private async handlePanelMessage(port: chrome.runtime.Port, message: unknown): Promise<void> {
    await this.ready()
    const raw = message as { type?: string; payload?: unknown }
    // The panel forwards iframe messages as `panel.forward` wrappers; tests
    // and direct panel traffic may also arrive unwrapped.
    const request = (raw.type === 'panel.forward' ? raw.payload : raw) as PanelRequest
    switch (request.type) {
      case 'bridge.connect': {
        if (!isLoopbackWsUrl(request.wsUrl)) {
          this.reply(port, request.requestId, bridgeError('permission_denied', 'bridge: wsUrl must be a loopback ws:// URL', false))
          return
        }
        this.bridge.connect(request.wsUrl, request.pairingNonce)
        this.reply(port, request.requestId, null)
        return
      }
      case 'tabs.current': {
        try {
          const tab = await this.catalog.current()
          this.reply(port, request.requestId, tab)
        } catch {
          this.reply(port, request.requestId, bridgeError('tab_closed', 'no eligible current tab', false))
        }
        return
      }
      case 'tabs.list': {
        const tabs = await this.catalog.list()
        this.reply(port, request.requestId, tabs)
        return
      }
      case 'grant.create': {
        await this.createGrant(port, request)
        return
      }
      case 'grant.cancel': {
        // The iframe aborted a grant.create request: revoke the local grant,
        // its CDP binding, and the host grant (if already offered) RIGHT
        // NOW, and settle the acknowledgement timer. A late grant.accepted
        // must never rebind the grant.
        const grantId = this.pendingGrantRequests.get(request.requestId)
        if (grantId !== undefined) {
          this.pendingGrantRequests.delete(request.requestId)
          this.settlePendingGrant(grantId, { kind: 'cancelled' })
          this.revokeGrantAndNotify(grantId)
        }
        return
      }
      default:
        return
    }
  }

  /**
   * Revoke one grant everywhere (vault, CDP binding) and notify the host.
   * Used by the explicit grant.cancel path; the host drops the grant even
   * when it never saw the offer.
   */
  private revokeGrantAndNotify(grantId: GrantId): void {
    this.vault.revoke(grantId)
    this.sessionManager.revoke(grantId)
    try {
      this.bridge.send({ v: PROTOCOL_VERSION, type: 'grant.revoke', grantId })
    } catch {
      // The bridge may be down; the host drops its grants on its own paths.
    }
  }

  private async createGrant(
    port: chrome.runtime.Port,
    request: Extract<PanelRequest, { type: 'grant.create' }>,
  ): Promise<void> {
    const reRead = await this.catalog.byId(request.tab.tabId)
    if (reRead === undefined) {
      this.reply(port, request.requestId, bridgeError('tab_closed', 'attached tab is closed', false))
      return
    }
    if (reRead.url !== request.tab.url) {
      this.reply(port, request.requestId, bridgeError('permission_denied', 'attached tab URL changed; attach the current page again', false))
      return
    }
    const grant = this.vault.create({ sessionId: request.sessionId, tab: reRead })
    this.pendingGrantRequests.set(request.requestId, grant.grantId)
    try {
      this.bridge.send({
        v: PROTOCOL_VERSION,
        type: 'grant.put',
        grantId: grant.grantId,
        sessionId: request.sessionId,
        tab: reRead,
        expiresAt: grant.expiresAt,
      })
    } catch {
      this.pendingGrantRequests.delete(request.requestId)
      this.vault.revoke(grant.grantId)
      this.reply(port, request.requestId, bridgeError('bridge_disconnected', 'browser extension is not connected', true))
      return
    }
    const result = await this.waitForAccepted(grant.grantId)
    if (result.kind === 'cancelled') {
      // Explicit abort (iframe cancel, panel loss, session change): the
      // revocation already happened and no reply is owed to a settled or
      // dead request.
      return
    }
    if (result.kind === 'failed') {
      this.pendingGrantRequests.delete(request.requestId)
      this.vault.revoke(grant.grantId)
      this.reply(port, request.requestId, bridgeError('grant_expired', 'grant acknowledgement timed out', false))
      return
    }
    this.pendingGrantRequests.delete(request.requestId)
    // The iframe receives ONLY the non-secret handle.
    this.reply(port, request.requestId, { handle: result.handle })
  }

  private waitForAccepted(grantId: GrantId): Promise<GrantAckResult> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingGrants.delete(grantId)
        resolve({ kind: 'failed' })
      }, this.grantAckTimeoutMs)
      this.pendingGrants.set(grantId, {
        resolve: result => {
          clearTimeout(timer)
          this.pendingGrants.delete(grantId)
          resolve(result)
        },
        timer,
      })
    })
  }

  /** Settle ONE pending grant offer and drop its request correlation. */
  private settlePendingGrant(grantId: GrantId, result: GrantAckResult): void {
    const pending = this.pendingGrants.get(grantId)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.pendingGrants.delete(grantId)
      pending.resolve(result)
    }
    for (const [requestId, id] of [...this.pendingGrantRequests]) {
      if (id === grantId) this.pendingGrantRequests.delete(requestId)
    }
  }

  /** Settle EVERY pending grant offer (panel loss, session change). */
  private settleAllPendingGrants(result: GrantAckResult): void {
    for (const [grantId, pending] of [...this.pendingGrants]) {
      clearTimeout(pending.timer)
      this.pendingGrants.delete(grantId)
      pending.resolve(result)
    }
    this.pendingGrantRequests.clear()
  }

  private onBridgeFrame(frame: BridgeFrame): void {
    void this.ready().then(() => this.handleFrame(frame))
  }

  private handleFrame(frame: BridgeFrame): void {
    if (frame.type === 'grant.accepted') {
      const pending = this.pendingGrants.get(frame.grantId)
      if (pending === undefined) return
      this.vault.accept(frame.grantId, frame.handle)
      // Bind the CDP session WITHOUT attaching the debugger. The grant's
      // exact URL becomes the session's authorization baseline so the first
      // navigation can already be classified cross-origin.
      const grant = this.vault.resolve(frame.grantId)
      this.sessionManager.bind({ grantId: frame.grantId, tabId: grant.tab.tabId, url: grant.tab.url })
      pending.resolve({ kind: 'accepted', handle: frame.handle })
      return
    }
    if (frame.type === 'tool.call') {
      void this.handleToolCall(frame)
      return
    }
    if (frame.type === 'error') {
      // The host rejected something; fail every pending grant offer so the
      // local grants cannot outlive their acknowledgements.
      for (const grantId of [...this.pendingGrants.keys()] as GrantId[]) {
        this.settlePendingGrant(grantId, { kind: 'failed' })
        this.vault.revoke(grantId)
      }
      return
    }
    if (frame.type === 'grant.revoke') {
      this.vault.revoke(frame.grantId)
      this.sessionManager.revoke(frame.grantId)
    }
  }

  /**
   * Resolve the exact grant and its session for one tool call. The active
   * tab is NEVER queried: a grant binds one exact tab at issue time.
   *
   * Delivery acknowledgement (`tool.accepted`) is sent only after the frame
   * validated, the grant resolved live, and the execution entered the local
   * journal. Exact duplicate request ids are answered from the journal cache
   * without re-executing.
   */
  private async handleToolCall(frame: Extract<BridgeFrame, { type: 'tool.call' }>): Promise<void> {
    const { requestId, grantId, operation, args } = frame
    const cached = this.resultCache.get(requestId)
    if (cached !== undefined && Date.now() - cached.at <= this.resultCacheTtlMs) {
      this.bridge.send({ v: PROTOCOL_VERSION, type: 'tool.result', requestId, result: { ok: true, value: cached.result } })
      return
    }
    const inFlight = this.inFlight.get(requestId)
    if (inFlight !== undefined) {
      try {
        const value = await inFlight
        this.bridge.send({ v: PROTOCOL_VERSION, type: 'tool.result', requestId, result: { ok: true, value } })
      } catch (error) {
        this.bridge.send({
          v: PROTOCOL_VERSION,
          type: 'tool.result',
          requestId,
          result: { ok: false, error: normalizeToolError(error) },
        })
      }
      return
    }
    try {
      this.vault.resolve(grantId)
      const session = await this.sessionManager.session(grantId)
      const executing = (async (): Promise<JsonValue> => {
        if (this.toolExecutor === undefined) {
          throw bridgeError('internal', 'browser tool executor is not wired', false)
        }
        return this.toolExecutor(session, operation, args)
      })()
      this.inFlight.set(requestId, executing)
      // Validated and journaled: acknowledge delivery before executing.
      this.bridge.send({ v: PROTOCOL_VERSION, type: 'tool.accepted', requestId })
      const value = await executing
      this.resultCache.set(requestId, { result: value, at: Date.now() })
      this.bridge.send({ v: PROTOCOL_VERSION, type: 'tool.result', requestId, result: { ok: true, value } })
    } catch (error) {
      this.bridge.send({
        v: PROTOCOL_VERSION,
        type: 'tool.result',
        requestId,
        result: { ok: false, error: normalizeToolError(error) },
      })
    } finally {
      this.inFlight.delete(requestId)
    }
  }

  private reply(port: chrome.runtime.Port, requestId: string, valueOrError: unknown): void {
    const ok = !(valueOrError instanceof Object && 'code' in valueOrError && 'message' in valueOrError)
    const reply: PanelReply = ok
      ? { type: 'panel.reply', requestId, ok: true, value: valueOrError as never }
      : { type: 'panel.reply', requestId, ok: false, error: valueOrError as BridgeError }
    port.postMessage(reply)
  }
}
