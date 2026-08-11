/**
 * Authenticated WebSocket carrier, request correlation, and the
 * chrome-extension BrowserProvider. The server owns exactly one
 * authenticated extension connection; requests are correlated by random
 * request id and settled by `tool.result` frames, cancellation, the tool
 * timeout, or connection loss. Grants live in the TargetCoordinator; this
 * server normalizes incoming `TabDescriptor`s into provider-neutral target
 * bindings and dispatches through the coordinator like any other provider.
 */
import {
  bridgeError,
  ConnectionId,
  decodeFrame,
  encodeFrame,
  GrantId,
  newTargetId,
  PROTOCOL_VERSION,
  RequestId,
  type BridgeFrame,
  type BridgeError,
  type BrowserOperation,
  type BrowserTargetDescriptor,
  type ConnectionId as ConnectionIdBrand,
  type JsonValue,
  type TabDescriptor,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { BROWSER_OPERATIONS } from '@dsh-external/dsh-browser-bridge-protocol'
import type { WebSocket } from 'ws'
import { PairingStore } from './pairing-store.ts'
import { isReadOperation } from '../tools/definitions.ts'
import type { TargetCoordinator } from '../targets/coordinator.ts'
import type { BrowserProvider, TargetBinding } from '../targets/types.ts'

/** Socket face the server drives; the real transport wraps a `ws` socket. */
export interface BridgeSocket {
  send(text: string): void
  close(): void
  onMessage(handler: (text: string) => void): void
  onClose(handler: () => void): void
}

export interface BridgeServerOptions {
  pairing: PairingStore
  coordinator: TargetCoordinator
  now?: () => number
  randomId?: () => string
  toolTimeoutMs?: number
  /** How long a read-only call waits for a reconnected extension (default 10s). */
  readRetryWaitMs?: number
}

/**
 * Normalize one immutable Chrome tab snapshot into the provider-neutral
 * target descriptor. `tabId`/`windowId` stay provider-internal: they never
 * enter the descriptor or any model-facing surface.
 */
export function chromeDescriptor(tab: TabDescriptor): BrowserTargetDescriptor {
  let origin = ''
  try {
    origin = new URL(tab.url).origin
  } catch {
    // Non-parseable URLs keep an empty origin; they are rejected upstream.
  }
  return {
    targetId: newTargetId(),
    provider: 'chrome-extension',
    title: tab.title,
    url: tab.url,
    origin,
    generation: 0,
    capabilities: [...BROWSER_OPERATIONS],
  }
}

/** Adapter over a `ws` socket for the real DSH host transport. */
export function attachWebSocket(server: BridgeServer, socket: WebSocket, origin: string): void {
  const adapter: BridgeSocket = {
    send: text => {
      if (socket.readyState === socket.OPEN) socket.send(text)
    },
    close: () => socket.close(),
    onMessage: handler => {
      socket.on('message', data => {
        handler(typeof data === 'string' ? data : data.toString())
      })
    },
    onClose: handler => {
      socket.on('close', () => handler())
    },
  }
  server.attach(adapter, origin)
}

interface PendingCall {
  requestId: RequestId
  operation: BrowserOperation
  grantId: GrantId
  args: JsonValue
  resolve(value: JsonValue): void
  reject(error: unknown): void
  finish(): void
  /** The extension acknowledged delivery (tool.accepted). */
  accepted: boolean
  /** The call already consumed its one retry after a disconnect. */
  retried: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
}

interface LiveConnection {
  id: ConnectionIdBrand
  socket: BridgeSocket
  /** The authenticated extension origin the connection belongs to. */
  origin: string
}

export class BridgeServer implements BrowserProvider {
  readonly kind = 'chrome-extension' as const
  private readonly pairing: PairingStore
  private readonly coordinator: TargetCoordinator
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly toolTimeoutMs: number
  private readonly readRetryWaitMs: number
  /** Tab snapshots of offered grants (compat surface for pre-step rendering). */
  private readonly tabsByGrantId = new Map<string, TabDescriptor>()
  private connection: LiveConnection | null = null
  /** The last closed connection, so a reconnect from the SAME extension
   * origin resumes the same logical session (connection id preserved). */
  private lastConnection: { id: ConnectionIdBrand; origin: string } | null = null
  /**
   * Tombstone/outbox for revocations that could not be delivered while a
   * logical session was disconnected. Same-origin reconnects flush the
   * queued `grant.revoke` frames BEFORE any read retry or new work, so a
   * turn that ended during a transient drop still tears the grant and CDP
   * session down on the extension side.
   */
  private readonly revokeOutbox = new Map<string, Set<GrantId>>()
  private readonly pending = new Map<string, PendingCall>()
  private readonly wiredSockets = new Set<BridgeSocket>()

  constructor(options: BridgeServerOptions) {
    this.pairing = options.pairing
    this.coordinator = options.coordinator
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => {
      const buffer = new Uint8Array(32)
      globalThis.crypto.getRandomValues(buffer)
      let out = ''
      for (const byte of buffer) out += byte.toString(16).padStart(2, '0')
      return out
    })
    this.toolTimeoutMs = options.toolTimeoutMs ?? 60_000
    this.readRetryWaitMs = options.readRetryWaitMs ?? 10_000
  }

  /** The currently authenticated connection id, or undefined. */
  get connectionId(): ConnectionIdBrand | undefined {
    return this.connection?.id
  }

  /** The tab snapshot of one offered chrome grant (pre-step rendering). */
  tabFor(grantId: GrantId): TabDescriptor | undefined {
    return this.tabsByGrantId.get(grantId)
  }

  // --- BrowserProvider (chrome-extension) ------------------------------------

  isConnected(target: TargetBinding): boolean {
    return this.connection !== null && this.connection.id === target.connectionId
  }

  /**
   * Provider-role dispatch: the coordinator allocated the request id and
   * bound it to the grant; this implementation sends the correlated
   * `tool.call` frame and waits for its result, cancellation, timeout, or
   * connection loss. Read calls may retry once across a same-origin
   * reconnect; accepted or mutating calls never replay.
   */
  async request(
    target: TargetBinding,
    requestId: RequestId,
    operation: BrowserOperation,
    args: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const connection = this.connection
    if (connection === null || connection.id !== target.connectionId) {
      throw bridgeError('bridge_disconnected', 'browser extension is not connected', true)
    }
    if (signal.aborted) throw signal.reason
    const grantId = this.coordinator.grantIdFor(requestId)
    if (grantId === undefined) {
      throw bridgeError('internal', 'request without a bound grant', false)
    }
    return new Promise((resolve, reject) => {
      const pending: PendingCall = {
        requestId,
        operation,
        grantId,
        args,
        resolve,
        reject,
        finish: () => {},
        accepted: false,
        retried: false,
        retryTimer: null,
      }
      const finish = () => {
        clearTimeout(timer)
        if (pending.retryTimer !== null) clearTimeout(pending.retryTimer)
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(pending.requestId)
      }
      pending.finish = finish
      const onAbort = () => { finish(); reject(bridgeError('bridge_disconnected', 'browser call cancelled', false)) }
      const timer = setTimeout(() => { finish(); reject(bridgeError('timeout', `${operation} timed out`, true)) }, this.toolTimeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, pending)
      connection.socket.send(encodeFrame({
        v: PROTOCOL_VERSION, type: 'tool.call', requestId, grantId, operation, args,
      }))
    })
  }

  /** Provider-role revocation: deliver the frame or queue it for reconnect. */
  revoke(target: TargetBinding, grantId: GrantId): void {
    this.tabsByGrantId.delete(grantId)
    this.deliverRevokes(target.connectionId, [grantId])
  }

  // --- Public request/revoke surface -----------------------------------------

  /**
   * Dispatch one operation for one grant through the coordinator (turn
   * tools). Named `requestGrant` because the provider-role interface method
   * `request(target, requestId, ...)` must stay the same name.
   */
  requestGrant(
    grantId: GrantId,
    operation: BrowserOperation,
    args: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    return this.coordinator.request(grantId, operation, args, signal)
  }

  /** Revoke every grant of a connection and notify the extension. */
  revokeConnection(connectionId: string): GrantId[] {
    const records = this.coordinator.revokeConnection(connectionId)
    this.cancelPendingForGrants(records.map(record => record.grantId))
    return records.map(record => record.grantId)
  }

  /**
   * Revoke the grants of one turn and notify the extension. When the
   * connection is down the revocations are queued for the next same-origin
   * reconnect, and every pending call of the revoked grants is cancelled
   * immediately — never retried or replayed.
   */
  revokeTurn(connectionId: string, sessionId: string, turn: number): GrantId[] {
    const records = this.coordinator.revokeTurn(connectionId, sessionId, turn)
    this.cancelPendingForGrants(records.map(record => record.grantId))
    return records.map(record => record.grantId)
  }

  /**
   * Close the connection and reject everything pending. Terminal for the
   * whole bridge session: every remaining grant is revoked and the
   * extension is notified before the socket closes.
   */
  dispose(): void {
    if (this.connection !== null) {
      const connection = this.connection
      this.coordinator.revokeConnection(connection.id)
      this.tabsByGrantId.clear()
      this.connection = null
      connection.socket.close()
    }
    this.handleConnectionLost(
      bridgeError('bridge_disconnected', 'browser bridge disposed', true),
      { retryReads: false },
    )
    this.lastConnection = null
    // Terminal: no reconnect can ever flush the outbox again.
    this.revokeOutbox.clear()
  }

  // --- Handshake and connection lifecycle ------------------------------------

  /**
   * Attach one socket and run the pairing handshake: the first frame must be
   * a `hello` whose nonce was issued for this exact extension origin. After
   * a valid handshake the socket becomes the live connection, replacing and
   * closing any prior one.
   */
  attach(socket: BridgeSocket, origin: string): void {
    this.wireSocket(socket)
    let handshaken = false
    // The handshake listener owns ONLY the hello step; after that, the
    // wired message handler (wireSocket) dispatches every frame.
    socket.onMessage(text => {
      if (handshaken) return
      let frame: BridgeFrame
      try {
        frame = decodeFrame(text)
      } catch {
        this.fail(socket, 'protocol_mismatch', 'received an invalid bridge frame')
        return
      }
      if (frame.type !== 'hello') {
        this.fail(socket, 'protocol_mismatch', 'expected a hello frame first')
        return
      }
      try {
        this.pairing.consume(frame.pairingNonce, origin)
      } catch (error) {
        this.fail(socket, 'permission_denied', error instanceof Error ? error.message : 'pairing rejected')
        return
      }
      handshaken = true
      this.acceptAuthenticated(socket, this.connectionIdForOrigin(origin), origin)
    })
  }

  /**
   * The connection id of a reconnect from the same extension origin is the
   * id of the closed connection it replaces: a transient reconnect resumes
   * the SAME logical session, so grants, tools, and read retries survive.
   * A different origin (or a takeover of a live connection) always gets a
   * fresh id — a new logical session.
   */
  private connectionIdForOrigin(origin: string): ConnectionIdBrand {
    if (this.lastConnection !== null && this.lastConnection.origin === origin) {
      return this.lastConnection.id
    }
    return ConnectionId(this.randomId())
  }

  /** Register message/close handling exactly once per socket. */
  private wireSocket(socket: BridgeSocket): void {
    if (this.wiredSockets.has(socket)) return
    this.wiredSockets.add(socket)
    socket.onMessage(text => {
      let frame: BridgeFrame
      try {
        frame = decodeFrame(text)
      } catch {
        this.fail(socket, 'protocol_mismatch', 'received an invalid bridge frame')
        return
      }
      this.receive(frame, socket)
    })
    socket.onClose(() => {
      this.wiredSockets.delete(socket)
      if (this.connection?.socket !== socket) return
      const closed = this.connection
      this.connection = null
      // A dropped socket is TRANSIENT: the same extension may reconnect with
      // a fresh pairing nonce and resume this logical session, so the id is
      // remembered and read retries stay armed for the bounded window.
      this.lastConnection = { id: closed.id, origin: closed.origin }
      this.handleConnectionLost(
        bridgeError('bridge_disconnected', 'browser extension connection closed', true),
        { retryReads: true },
      )
    })
  }

  /**
   * Promote a socket to the live connection (used by the handshake and by
   * tests that pre-authenticate). A live connection replaced by another
   * socket from a DIFFERENT extension origin is TERMINAL for the prior
   * session: its grants are revoked and notified before the socket closes,
   * and its pending calls reject without retry — a foreign session must
   * never observe another session's work. A same-origin replacement (a
   * reconnect race from the same extension) continues the same logical
   * session: the connection id and grants survive and read retries stay
   * armed.
   */
  acceptAuthenticated(
    socket: BridgeSocket,
    connectionId: ConnectionIdBrand = ConnectionId(this.randomId()),
    origin = '',
  ): void {
    this.wireSocket(socket)
    const prior = this.connection
    if (prior != null && prior.socket !== socket) {
      const sameOrigin = origin !== '' && prior.origin === origin
      if (sameOrigin) {
        // The same extension replaced a still-open socket: the logical
        // session continues under the same connection id.
        connectionId = prior.id
      } else {
        this.coordinator.revokeConnection(prior.id)
        // The prior session is TERMINAL: its outbox can never be resumed
        // under the same id, and a later reconnect from that extension is a
        // fresh logical session (its own sessionChanged revokes locally).
        this.revokeOutbox.delete(prior.id)
      }
      this.connection = null
      prior.socket.close()
      this.handleConnectionLost(
        bridgeError('bridge_disconnected', 'browser extension connection replaced', true),
        { retryReads: sameOrigin },
      )
    }
    this.connection = { id: connectionId, socket, origin }
    this.lastConnection = null
    socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'hello.ok', connectionId }))
    // A resumed session first delivers every revocation queued while it was
    // disconnected: the extension must drop those grants and detach their
    // CDP sessions BEFORE any read retry or new work is sent.
    this.flushRevokeOutbox(connectionId, socket)
    // A newly authenticated connection may carry one retry for read calls.
    for (const [requestId, pending] of [...this.pending]) {
      if (!pending.retried || pending.retryTimer === null) continue
      clearTimeout(pending.retryTimer)
      pending.retryTimer = null
      const freshId = RequestId(this.randomId())
      this.pending.delete(requestId)
      pending.requestId = freshId
      this.pending.set(freshId, pending)
      socket.send(encodeFrame({
        v: PROTOCOL_VERSION, type: 'tool.call', requestId: freshId,
        grantId: pending.grantId, operation: pending.operation, args: pending.args,
      }))
    }
  }

  /** Send `grant.revoke` frames for one socket, best-effort. */
  private sendRevokes(socket: BridgeSocket, grantIds: GrantId[]): void {
    for (const grantId of grantIds) {
      socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'grant.revoke', grantId }))
    }
  }

  /**
   * Deliver revocations for one logical session: directly when it is live,
   * otherwise queue them in the session's outbox for the next same-origin
   * reconnect.
   */
  private deliverRevokes(connectionId: string, grantIds: GrantId[]): void {
    if (grantIds.length === 0) return
    if (this.connection !== null && this.connection.id === connectionId) {
      this.sendRevokes(this.connection.socket, grantIds)
      return
    }
    let queued = this.revokeOutbox.get(connectionId)
    if (queued === undefined) {
      queued = new Set()
      this.revokeOutbox.set(connectionId, queued)
    }
    for (const grantId of grantIds) queued.add(grantId)
  }

  /** Send every queued revocation of one connection and drop the outbox. */
  private flushRevokeOutbox(connectionId: string, socket: BridgeSocket): void {
    const queued = this.revokeOutbox.get(connectionId)
    if (queued === undefined) return
    this.revokeOutbox.delete(connectionId)
    if (queued.size === 0) return
    this.sendRevokes(socket, [...queued])
  }

  /**
   * Reject every pending call whose grant was just revoked: a revoked grant
   * must never complete, retry, or replay its work after turn cleanup.
   */
  private cancelPendingForGrants(grantIds: readonly GrantId[]): void {
    if (grantIds.length === 0) return
    const affected = new Set(grantIds)
    for (const pending of [...this.pending.values()]) {
      if (!affected.has(pending.grantId)) continue
      pending.finish()
      pending.reject(bridgeError('grant_expired', 'grant revoked before the call completed', false))
    }
  }

  /** Handle one authenticated inbound frame from the live connection. */
  private receive(frame: BridgeFrame, socket: BridgeSocket): void {
    switch (frame.type) {
      case 'pong':
      case 'hello.ok':
        return
      case 'tool.accepted': {
        const pending = this.pending.get(frame.requestId)
        if (pending !== undefined) pending.accepted = true
        return
      }
      case 'ping':
        socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'pong' }))
        return
      case 'grant.put': {
        if (this.connection?.socket !== socket) return
        try {
          const target: TargetBinding = {
            descriptor: chromeDescriptor(frame.tab),
            connectionId: this.connection.id,
            logicalKey: 'chrome:' + String(frame.tab.windowId) + ':' + String(frame.tab.tabId),
          }
          const record = this.coordinator.offerWithId(frame.grantId, {
            sessionId: frame.sessionId,
            expiresAt: frame.expiresAt,
            target,
          })
          this.tabsByGrantId.set(frame.grantId, frame.tab)
          socket.send(encodeFrame({
            v: PROTOCOL_VERSION, type: 'grant.accepted', grantId: record.grantId, handle: record.handle,
          }))
        } catch (error) {
          socket.send(encodeFrame({
            v: PROTOCOL_VERSION,
            type: 'error',
            code: 'internal',
            message: error instanceof Error ? error.message : 'grant offer rejected',
            retryable: false,
          }))
        }
        return
      }
      case 'grant.revoke':
        this.coordinator.revoke(GrantId(frame.grantId))
        return
      case 'tool.result': {
        const pending = this.pending.get(frame.requestId)
        if (pending === undefined) return
        pending.finish()
        if (frame.result.ok) {
          pending.resolve(frame.result.value)
        } else {
          pending.reject(frame.result.error)
        }
        return
      }
      case 'error':
        return
      case 'hello':
        return
    }
  }

  private fail(socket: BridgeSocket, code: BridgeError['code'], message: string): void {
    socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'error', code, message, retryable: false }))
    socket.close()
  }

  /**
   * Connection loss handling. A TRANSIENT drop (socket close) rejects
   * writes immediately and lets reads wait for one same-session reconnect.
   * A TERMINAL loss (connection takeover or bridge disposal) rejects
   * everything immediately: pending work is never retried against a foreign
   * or dead session, and write operations are never replayed.
   */
  private handleConnectionLost(error: BridgeError, options: { retryReads: boolean } = { retryReads: true }): void {
    for (const [requestId, pending] of [...this.pending]) {
      if (!options.retryReads || pending.retried || !isReadOperation(pending.operation)) {
        pending.finish()
        pending.reject(error)
        continue
      }
      pending.retried = true
      pending.retryTimer = setTimeout(() => {
        pending.finish()
        pending.reject(error)
      }, this.readRetryWaitMs)
    }
  }
}
