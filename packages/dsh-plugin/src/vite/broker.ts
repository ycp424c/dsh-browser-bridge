/**
 * Low-authority, multi-target Vite page broker. Pages connect over a
 * dedicated WebSocket, register one target each, and may never send grant,
 * host, or filesystem frames. The broker enforces every resource bound
 * (targets, per-origin targets, frame bytes, concurrent calls, frame rate,
 * heartbeat/disconnect, reconnect window) and settles pending calls without
 * ever replaying accepted or mutating operations.
 */
import {
  bridgeError,
  decodeVitePageToHostFrame,
  newConnectionId,
  newRequestId,
  VITE_PAGE_PROTOCOL_VERSION,
  type BrowserOperation,
  type ConnectionId,
  type GrantId,
  type JsonValue,
  type RequestId,
  type TargetId,
  type ViteBrowserTargetDescriptor,
  type VitePageToHostFrame,
} from '@dsh-external/dsh-browser-bridge-protocol'
import {
  MAX_VITE_CONCURRENT_CALLS,
  MAX_VITE_DISCONNECT_MS,
  MAX_VITE_FRAME_BYTES,
  MAX_VITE_FRAMES_PER_SECOND,
  MAX_VITE_HEARTBEAT_MS,
  MAX_VITE_RECONNECT_WINDOW_MS,
  MAX_VITE_TARGETS,
  MAX_VITE_TARGETS_PER_ORIGIN,
  sanitizePageErrorText,
  sanitizePageResultValue,
  sanitizeViteTarget,
} from './sanitize.ts'
import type { TargetCoordinator } from '../targets/coordinator.ts'
import { isReadOperation } from '../tools/definitions.ts'
import type { BrowserProvider, TargetBinding } from '../targets/types.ts'

/** Socket face of one page connection; the real transport wraps a `ws`. */
export interface ViteSocket {
  send(text: string): void
  close(): void
  onMessage(handler: (text: string) => void): void
  onClose(handler: () => void): void
}

export interface ViteBrokerOptions {
  coordinator: TargetCoordinator
  /** Bounded per-call timeout; on expiry a tool.cancel is sent (default 60s). */
  toolTimeoutMs?: number
  maxTargets?: number
  maxTargetsPerOrigin?: number
  maxFrameBytes?: number
  maxConcurrentCalls?: number
  maxFramesPerSecond?: number
  heartbeatMs?: number
  disconnectMs?: number
  reconnectWindowMs?: number
  now?: () => number
}

interface PendingViteCall {
  requestId: RequestId
  grantId: GrantId
  operation: BrowserOperation
  args: JsonValue
  resolve(value: JsonValue): void
  reject(error: unknown): void
  finish(): void
  /** The page acknowledged delivery (tool.accepted). */
  accepted: boolean
  /** The call already consumed its one retry after a legal rebind. */
  retried: boolean
  cancelSent: boolean
  /** Bounded per-call timeout timer. */
  timer: ReturnType<typeof setTimeout> | null
}

interface LiveViteTarget {
  binding: TargetBinding
  socket: ViteSocket
  lastSeenAt: number
  pending: Map<string, PendingViteCall>
  frameWindow: { startedAt: number; count: number }
}

/** Bounded reconnect tombstone of one logical target. */
interface ViteTombstone {
  connectionId: ConnectionId
  disconnectedAt: number
  pending: Map<string, PendingViteCall>
}

function keyOf(targetId: string, origin: string): string {
  return `${targetId}\u0000${origin}`
}

/** Adapter over a `ws` socket for the real DSH host transport. */
export function attachViteWebSocket(broker: ViteTargetBroker, socket: { send(data: string): void; close(): void; on(event: 'message', handler: (data: unknown) => void): void; on(event: 'close', handler: () => void): void }, origin: string): void {
  const adapter: ViteSocket = {
    send: text => socket.send(text),
    close: () => socket.close(),
    onMessage: handler => {
      socket.on('message', data => {
        handler(typeof data === 'string' ? data : String(data))
      })
    },
    onClose: handler => {
      socket.on('close', () => handler())
    },
  }
  broker.attach(adapter, origin)
}

export class ViteTargetBroker implements BrowserProvider {
  readonly kind = 'vite' as const
  private readonly coordinator: TargetCoordinator
  private readonly toolTimeoutMs: number
  private readonly maxTargets: number
  private readonly maxTargetsPerOrigin: number
  private readonly maxFrameBytes: number
  private readonly maxConcurrentCalls: number
  private readonly maxFramesPerSecond: number
  private readonly heartbeatMs: number
  private readonly disconnectMs: number
  private readonly reconnectWindowMs: number
  private readonly now: () => number
  /** connectionId → live target */
  private readonly live = new Map<string, LiveViteTarget>()
  /** targetId+origin key → connectionId */
  private readonly liveByKey = new Map<string, string>()
  /** targetId+origin key → bounded reconnect tombstone */
  private readonly tombstones = new Map<string, ViteTombstone>()
  private readonly wiredSockets = new Set<ViteSocket>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: ViteBrokerOptions) {
    this.coordinator = options.coordinator
    this.toolTimeoutMs = options.toolTimeoutMs ?? 60_000
    this.maxTargets = options.maxTargets ?? MAX_VITE_TARGETS
    this.maxTargetsPerOrigin = options.maxTargetsPerOrigin ?? MAX_VITE_TARGETS_PER_ORIGIN
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_VITE_FRAME_BYTES
    this.maxConcurrentCalls = options.maxConcurrentCalls ?? MAX_VITE_CONCURRENT_CALLS
    this.maxFramesPerSecond = options.maxFramesPerSecond ?? MAX_VITE_FRAMES_PER_SECOND
    this.heartbeatMs = options.heartbeatMs ?? MAX_VITE_HEARTBEAT_MS
    this.disconnectMs = options.disconnectMs ?? MAX_VITE_DISCONNECT_MS
    this.reconnectWindowMs = options.reconnectWindowMs ?? MAX_VITE_RECONNECT_WINDOW_MS
    this.now = options.now ?? Date.now
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs)
    this.sweepTimer = setInterval(() => this.sweep(), 1_000)
  }

  /** Number of currently live targets (tests and health reporting). */
  liveTargetCount(): number {
    return this.live.size
  }

  /** Sanitized descriptors of every live target (DSH Web target list). */
  liveTargets(): ViteBrowserTargetDescriptor[] {
    return [...this.live.values()].map(target => target.binding.descriptor as ViteBrowserTargetDescriptor)
  }

  /** The binding of one live target, or undefined. */
  bindingFor(targetId: TargetId): TargetBinding | undefined {
    for (const target of this.live.values()) {
      if (target.binding.descriptor.targetId === targetId) return target.binding
    }
    return undefined
  }

  // --- BrowserProvider (vite) ------------------------------------------------

  isConnected(target: TargetBinding): boolean {
    const liveTarget = this.live.get(target.connectionId)
    return liveTarget !== undefined && liveTarget.binding.logicalKey === target.logicalKey
  }

  async request(
    target: TargetBinding,
    requestId: RequestId,
    operation: BrowserOperation,
    args: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const liveTarget = this.live.get(target.connectionId)
    if (liveTarget === undefined || liveTarget.binding.logicalKey !== target.logicalKey) {
      throw bridgeError('target_disconnected', 'vite target is not connected', true)
    }
    if (liveTarget.pending.size >= this.maxConcurrentCalls) {
      throw bridgeError('timeout', `vite target busy: ${this.maxConcurrentCalls} concurrent calls`, true)
    }
    // A request that was already cancelled must never reach the page: a
    // write could otherwise execute after the turn ended.
    if (signal.aborted) throw signal.reason
    const grantId = this.coordinator.grantIdFor(requestId)
    if (grantId === undefined) {
      throw bridgeError('internal', 'request without a bound grant', false)
    }
    return new Promise((resolve, reject) => {
      const pending: PendingViteCall = {
        requestId,
        grantId,
        operation,
        args,
        resolve,
        reject,
        finish: () => {},
        accepted: false,
        retried: false,
        cancelSent: false,
        timer: null,
      }
      const finish = () => {
        signal.removeEventListener('abort', onAbort)
        if (pending.timer !== null) clearTimeout(pending.timer)
        liveTarget.pending.delete(pending.requestId)
      }
      pending.finish = finish
      const onAbort = () => {
        // One correlated tool.cancel per call; settlement is idempotent.
        if (!pending.cancelSent) {
          pending.cancelSent = true
          liveTarget.socket.send(JSON.stringify({
            v: VITE_PAGE_PROTOCOL_VERSION,
            type: 'tool.cancel',
            requestId: pending.requestId,
            reason: 'cancelled',
          }))
        }
        finish()
        reject(bridgeError('target_disconnected', 'vite browser call cancelled', false))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pending.timer = setTimeout(() => {
        // Bounded per-call timeout: one correlated tool.cancel, then settle.
        if (!pending.cancelSent) {
          pending.cancelSent = true
          liveTarget.socket.send(JSON.stringify({
            v: VITE_PAGE_PROTOCOL_VERSION,
            type: 'tool.cancel',
            requestId: pending.requestId,
            reason: 'timeout',
          }))
        }
        finish()
        reject(bridgeError('timeout', `${operation} timed out`, true))
      }, this.toolTimeoutMs)
      liveTarget.pending.set(requestId, pending)
      liveTarget.socket.send(JSON.stringify({
        v: VITE_PAGE_PROTOCOL_VERSION,
        type: 'tool.call',
        requestId,
        operation,
        args,
      }))
    })
  }

  /** Provider-role revocation: notify the page and settle its pending calls. */
  revoke(target: TargetBinding, grantId: GrantId): void {
    const liveTarget = this.live.get(target.connectionId)
    if (liveTarget === undefined || liveTarget.binding.logicalKey !== target.logicalKey) return
    liveTarget.socket.send(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'target.revoke' }))
    this.settleGrant(liveTarget.pending, grantId)
  }

  // --- Connection lifecycle --------------------------------------------------

  /**
   * Attach one page socket. The first frame must be a `hello` carrying the
   * current page protocol version; every later frame must be a page-to-host
   * frame of this broker (hello/register/update/accepted/result/ping/pong).
   * Unknown, oversized, over-rate, or host-shaped frames close ONLY that
   * page connection.
   */
  attach(socket: ViteSocket, origin: string): void {
    this.wireSocket(socket, origin)
  }

  private wireSocket(socket: ViteSocket, origin: string): void {
    if (this.wiredSockets.has(socket)) return
    this.wiredSockets.add(socket)
    let handshaken = false
    socket.onMessage(text => {
      if (Buffer.byteLength(text, 'utf8') > this.maxFrameBytes) {
        this.closeConnection(socket)
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        this.closeConnection(socket)
        return
      }
      if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== VITE_PAGE_PROTOCOL_VERSION) {
        this.fail(socket, 'protocol_mismatch', `unsupported vite page protocol version; expected ${VITE_PAGE_PROTOCOL_VERSION}`)
        return
      }
      let frame: VitePageToHostFrame
      try {
        frame = decodeVitePageToHostFrame(text)
      } catch {
        this.closeConnection(socket)
        return
      }
      if (!handshaken) {
        if (frame.type !== 'hello') {
          this.fail(socket, 'protocol_mismatch', 'expected a hello frame first')
          return
        }
        handshaken = true
        return
      }
      this.handleFrame(frame, socket, origin)
    })
    socket.onClose(() => {
      this.wiredSockets.delete(socket)
      const entry = [...this.live.entries()].find(([, target]) => target.socket === socket)
      if (entry === undefined) return
      const [connectionId, target] = entry
      this.live.delete(connectionId)
      this.liveByKey.delete(keyOf(target.binding.descriptor.targetId, target.binding.descriptor.origin))
      // Accepted or mutating calls settle immediately; unaccepted reads may
      // retry once after a legal rebind inside the bounded window.
      for (const pending of [...target.pending.values()]) {
        if (pending.accepted || !isReadOperation(pending.operation)) {
          pending.finish()
          pending.reject(bridgeError('target_disconnected', 'vite target disconnected', false))
        }
      }
      this.tombstones.set(keyOf(target.binding.descriptor.targetId, target.binding.descriptor.origin), {
        connectionId: connectionId as ConnectionId,
        disconnectedAt: this.now(),
        pending: target.pending,
      })
    })
  }

  private handleFrame(frame: VitePageToHostFrame, socket: ViteSocket, origin: string): void {
    const entry = [...this.live.entries()].find(([, target]) => target.socket === socket)
    if (entry === undefined) {
      // Only target.register is accepted before a live registration.
      if (frame.type === 'target.register') {
        this.registerTarget(frame.target, socket, origin)
        return
      }
      this.closeConnection(socket)
      return
    }
    const [connectionId, target] = entry
    // Heartbeat: every frame keeps the connection alive; only non-heartbeat
    // frames count toward the per-second rate limit.
    target.lastSeenAt = this.now()
    if (frame.type !== 'ping' && frame.type !== 'pong') {
      const window = target.frameWindow
      if (this.now() - window.startedAt >= 1_000) {
        target.frameWindow = { startedAt: this.now(), count: 1 }
      } else {
        window.count += 1
        if (window.count > this.maxFramesPerSecond) {
          this.closeConnection(socket)
          return
        }
      }
    }
    switch (frame.type) {
      case 'hello':
        return
      case 'ping':
        socket.send(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'pong' }))
        return
      case 'pong':
        return
      case 'target.update': {
        // The registered identity is immutable: a page can refresh title,
        // url, project id, generation, or capabilities, but never its
        // targetId or origin. Identity drift would corrupt grant bindings
        // and bypass the origin-change revocation.
        if (frame.target.targetId !== target.binding.descriptor.targetId
          || frame.target.origin !== target.binding.descriptor.origin) {
          this.closeConnection(socket)
          return
        }
        try {
          target.binding.descriptor = sanitizeViteTarget(frame.target)
        } catch {
          this.closeConnection(socket)
        }
        return
      }
      case 'tool.accepted': {
        const pending = target.pending.get(frame.requestId)
        if (pending !== undefined) pending.accepted = true
        return
      }
      case 'tool.result': {
        const pending = target.pending.get(frame.requestId)
        if (pending === undefined) return
        pending.finish()
        if (frame.result.ok) {
          pending.resolve(sanitizePageResultValue(frame.result.value))
        } else {
          pending.reject(bridgeError(
            frame.result.error.code,
            sanitizePageErrorText(frame.result.error.message),
            frame.result.error.retryable,
          ))
        }
        return
      }
      default:
        // Host-shaped frames (tool.call, tool.cancel, grant.*, error,
        // target.revoke) are never accepted from a page.
        this.closeConnection(socket)
    }
  }

  /**
   * Register one target. A live target with the same logical key is never
   * taken over; a target that left for a DIFFERENT origin is revoked
   * instead of entering the reconnect window; a legal rebind inside the
   * window resumes the same connection identity and retries unaccepted
   * reads at most once.
   */
  private registerTarget(raw: ViteBrowserTargetDescriptor, socket: ViteSocket, origin: string): void {
    let target: ViteBrowserTargetDescriptor
    try {
      target = sanitizeViteTarget(raw)
    } catch {
      this.fail(socket, 'permission_denied', 'invalid vite target registration')
      return
    }
    // The browser never lets a page open a WebSocket from another origin;
    // the recorded origin must match the WS handshake origin exactly (a
    // missing Origin header is rejected too — browsers always send one).
    if (origin !== target.origin) {
      this.fail(socket, 'permission_denied', 'vite target origin does not match the connection origin')
      return
    }
    const key = keyOf(target.targetId, target.origin)
    const existing = this.liveByKey.get(key)
    if (existing !== undefined) {
      const liveTarget = this.live.get(existing)
      if (liveTarget !== undefined && liveTarget.socket !== socket) {
        // A live target cannot be taken over by a second connection.
        this.fail(socket, 'target_disconnected', 'vite target is already connected')
        return
      }
      return
    }
    if (this.live.size >= this.maxTargets) {
      this.fail(socket, 'target_disconnected', `vite target limit (${this.maxTargets}) reached`)
      return
    }
    const perOrigin = [...this.live.values()].filter(candidate =>
      candidate.binding.descriptor.origin === target.origin)
    if (perOrigin.length >= this.maxTargetsPerOrigin) {
      this.fail(socket, 'target_disconnected', `vite target limit (${this.maxTargetsPerOrigin}) per origin reached`)
      return
    }
    // The same targetId registered from a different origin means the page
    // left: revoke that logical target (live or tombstoned) instead of
    // entering the reconnect window.
    for (const [oldKey, connectionId] of [...this.liveByKey.entries()]) {
      const oldTarget = this.live.get(connectionId)
      if (oldTarget === undefined) continue
      if (oldTarget.binding.descriptor.targetId === target.targetId && oldKey !== key) {
        this.coordinator.revokeTarget({
          targetId: target.targetId as TargetId,
          origin: oldTarget.binding.descriptor.origin,
        })
        this.live.delete(connectionId)
        this.liveByKey.delete(oldKey)
        this.tombstones.delete(oldKey)
        oldTarget.socket.close()
      }
    }
    for (const [oldKey, tombstone] of [...this.tombstones.entries()]) {
      const [oldTargetId, oldOrigin] = oldKey.split('\u0000')
      if (oldTargetId === target.targetId && oldOrigin !== target.origin) {
        this.coordinator.revokeTarget({
          targetId: target.targetId as TargetId,
          origin: oldOrigin!,
        })
        this.settleAll(tombstone.pending)
        this.tombstones.delete(oldKey)
      }
    }
    let connectionId: string
    let pending: Map<string, PendingViteCall>
    const tombstone = this.tombstones.get(key)
    if (tombstone !== undefined && this.now() - tombstone.disconnectedAt <= this.reconnectWindowMs) {
      // Legal rebind: the same logical target resumes under its previous
      // connection identity; grants follow via the coordinator.
      this.coordinator.rebindTarget(
        { targetId: target.targetId as TargetId, origin: target.origin },
        {
          descriptor: target,
          connectionId: tombstone.connectionId,
          logicalKey: key,
        },
      )
      this.tombstones.delete(key)
      connectionId = tombstone.connectionId
      pending = tombstone.pending
    } else {
      if (tombstone !== undefined) {
        // The recovery window expired: the logical target is revoked.
        this.coordinator.revokeTarget({ targetId: target.targetId as TargetId, origin: target.origin })
        this.settleAll(tombstone.pending)
        this.tombstones.delete(key)
      }
      connectionId = newConnectionId()
      pending = new Map()
    }
    const liveTarget: LiveViteTarget = {
      binding: {
        descriptor: target,
        connectionId: connectionId as ConnectionId,
        logicalKey: key,
      },
      socket,
      lastSeenAt: this.now(),
      pending,
      frameWindow: { startedAt: this.now(), count: 0 },
    }
    this.live.set(connectionId, liveTarget)
    this.liveByKey.set(key, connectionId)
    socket.send(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.registered',
      targetId: target.targetId,
    }))
    // A legal rebind retries each unaccepted read exactly once.
    for (const call of [...pending.values()]) {
      if (call.retried || !isReadOperation(call.operation)) continue
      call.retried = true
      const freshId = newRequestId()
      pending.delete(call.requestId)
      call.requestId = freshId
      pending.set(freshId, call)
      socket.send(JSON.stringify({
        v: VITE_PAGE_PROTOCOL_VERSION,
        type: 'tool.call',
        requestId: freshId,
        operation: call.operation,
        args: call.args,
      }))
    }
  }

  /** Periodic keep-alive ping to every live target. */
  private heartbeat(): void {
    for (const target of this.live.values()) {
      target.socket.send(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'ping' }))
    }
  }

  /** Periodic sweep: disconnect silent targets, expire reconnect tombstones. */
  private sweep(): void {
    for (const [, target] of [...this.live.entries()]) {
      if (this.now() - target.lastSeenAt >= this.disconnectMs) {
        target.socket.close()
      }
    }
    for (const [key, tombstone] of [...this.tombstones.entries()]) {
      if (this.now() - tombstone.disconnectedAt >= this.reconnectWindowMs) {
        this.coordinator.revokeTarget({
          targetId: key.split('\u0000')[0] as TargetId,
          origin: key.split('\u0000')[1]!,
        })
        this.settleAll(tombstone.pending)
        this.tombstones.delete(key)
      }
    }
  }

  private settleGrant(pending: Map<string, PendingViteCall>, grantId: GrantId): void {
    for (const call of [...pending.values()]) {
      if (call.grantId !== grantId) continue
      call.finish()
      call.reject(bridgeError('grant_expired', 'vite grant revoked before the call completed', false))
    }
  }

  private settleAll(pending: Map<string, PendingViteCall>): void {
    for (const call of [...pending.values()]) {
      call.finish()
      call.reject(bridgeError('target_disconnected', 'vite target disconnected', false))
    }
  }

  private closeConnection(socket: ViteSocket): void {
    this.fail(socket, 'permission_denied', 'invalid vite page frame')
  }

  private fail(socket: ViteSocket, code: string, message: string): void {
    socket.send(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'error',
      code,
      message,
      retryable: false,
    }))
    socket.close()
  }

  /** Terminal: settle every pending call and drop every connection. */
  dispose(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    this.heartbeatTimer = null
    this.sweepTimer = null
    for (const [, target] of [...this.live.entries()]) {
      this.settleAll(target.pending)
      target.socket.close()
    }
    for (const tombstone of this.tombstones.values()) {
      this.settleAll(tombstone.pending)
    }
    this.live.clear()
    this.liveByKey.clear()
    this.tombstones.clear()
    this.wiredSockets.clear()
  }
}
