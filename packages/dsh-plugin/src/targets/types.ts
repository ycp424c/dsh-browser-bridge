/**
 * Provider-neutral host abstractions: a target binding pairs a normalized
 * descriptor with the exact connection that owns it, and a BrowserProvider
 * is the host-side face of one transport (Chrome extension, Vite page).
 */
import type {
  BrowserProviderKind,
  BrowserTargetDescriptor,
  BrowserOperation,
  ConnectionId,
  GrantId,
  JsonValue,
  RequestId,
} from '@ycp424c/dsh-browser-bridge-protocol'

/**
 * One grant-bound target snapshot: the normalized descriptor plus the
 * exact connection identity and a stable logical key. Connection identity
 * and logical keys stay provider-internal and never enter model tool args.
 */
export interface TargetBinding {
  descriptor: BrowserTargetDescriptor
  connectionId: ConnectionId
  /** Stable identity across reconnects (for example `chrome:2:7`). */
  logicalKey: string
}

/** One provider transport registered with the coordinator. */
export interface BrowserProvider {
  readonly kind: BrowserProviderKind
  /** Whether the exact bound connection is currently live. */
  isConnected(target: TargetBinding): boolean
  /**
   * Dispatch one correlated request to the exact bound target. The
   * requestId is host-allocated; the provider settles the returned promise
   * on result, cancellation (signal abort), timeout, or connection loss.
   * Write operations must never be replayed by the provider.
   */
  request(
    target: TargetBinding,
    requestId: RequestId,
    operation: BrowserOperation,
    args: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue>
  /** Revoke one grant on the exact bound target (best-effort delivery). */
  revoke(target: TargetBinding, grantId: GrantId): void
}
