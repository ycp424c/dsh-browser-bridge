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
}

export type ToolExecutor = (
  session: TabSession,
  operation: BrowserOperation,
  args: JsonValue,
) => Promise<JsonValue>

interface PendingGrant {
  resolve(handle: string): void
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
  private readonly pendingGrants = new Map<string, PendingGrant>()

  constructor(deps: BridgeRouterDeps) {
    this.bridge = deps.bridge
    this.vault = deps.vault
    this.catalog = deps.catalog
    this.sessionManager = deps.sessionManager
    this.toolExecutor = deps.toolExecutor
    this.grantAckTimeoutMs = deps.grantAckTimeoutMs ?? 10_000
    deps.bridge.onFrame(frame => this.onBridgeFrame(frame))
  }

  /** Attach one side-panel runtime port. */
  connectPanel(port: chrome.runtime.Port): void {
    port.onMessage.addListener((message: unknown) => {
      void this.handlePanelMessage(port, message)
    })
    port.onDisconnect.addListener(() => {
      // The bridge is panel-scoped: when the panel goes away, stop the
      // connection and drop every grant and CDP session it owned.
      this.vault.revokeAll()
      this.sessionManager.revokeAll()
      this.bridge.close()
    })
  }

  private async handlePanelMessage(port: chrome.runtime.Port, message: unknown): Promise<void> {
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
      default:
        return
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
      this.vault.revoke(grant.grantId)
      this.reply(port, request.requestId, bridgeError('bridge_disconnected', 'browser extension is not connected', true))
      return
    }
    const handle = await this.waitForAccepted(grant.grantId)
    if (handle === null) {
      this.vault.revoke(grant.grantId)
      this.reply(port, request.requestId, bridgeError('grant_expired', 'grant acknowledgement timed out', false))
      return
    }
    // The iframe receives ONLY the non-secret handle.
    this.reply(port, request.requestId, { handle })
  }

  private waitForAccepted(grantId: GrantId): Promise<string | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingGrants.delete(grantId)
        resolve(null)
      }, this.grantAckTimeoutMs)
      this.pendingGrants.set(grantId, {
        resolve: handle => {
          clearTimeout(timer)
          this.pendingGrants.delete(grantId)
          resolve(handle)
        },
        timer,
      })
    })
  }

  private onBridgeFrame(frame: BridgeFrame): void {
    if (frame.type === 'grant.accepted') {
      const pending = this.pendingGrants.get(frame.grantId)
      if (pending === undefined) return
      this.vault.accept(frame.grantId, frame.handle)
      // Bind the CDP session WITHOUT attaching the debugger.
      const grant = this.vault.resolve(frame.grantId)
      this.sessionManager.bind({ grantId: frame.grantId, tabId: grant.tab.tabId })
      pending.resolve(frame.handle)
      return
    }
    if (frame.type === 'tool.call') {
      void this.handleToolCall(frame)
      return
    }
    if (frame.type === 'error') {
      // The host rejected something; fail every pending grant offer so the
      // local grants cannot outlive their acknowledgements.
      for (const [grantId, pending] of [...this.pendingGrants]) {
        this.vault.revoke(grantId as GrantId)
        clearTimeout(pending.timer)
        this.pendingGrants.delete(grantId)
        pending.resolve('')
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
   */
  private async handleToolCall(frame: Extract<BridgeFrame, { type: 'tool.call' }>): Promise<void> {
    const { requestId, grantId, operation, args } = frame
    try {
      this.vault.resolve(grantId)
      const session = await this.sessionManager.session(grantId)
      if (this.toolExecutor === undefined) {
        throw bridgeError('internal', 'browser tool executor is not wired', false)
      }
      const value = await this.toolExecutor(session, operation, args)
      this.bridge.send({ v: PROTOCOL_VERSION, type: 'tool.result', requestId, result: { ok: true, value } })
    } catch (error) {
      this.bridge.send({
        v: PROTOCOL_VERSION,
        type: 'tool.result',
        requestId,
        result: { ok: false, error: normalizeToolError(error) },
      })
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
