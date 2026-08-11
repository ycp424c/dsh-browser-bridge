/**
 * TargetCoordinator: the single authority for grants and dispatch across
 * every browser provider. Grants bind one session to one logical target;
 * requests resolve the bound provider, check capability and liveness, and
 * dispatch exactly once. Revocations return complete records so the
 * coordinator can notify the owning provider.
 */
import {
  bridgeError,
  newGrantId,
  newRequestId,
  type BrowserOperation,
  type GrantId,
  type JsonValue,
  type RequestId,
  type TargetId,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { GrantStore, type GrantRecord } from '../bridge/grant-store.ts'
import type { ProviderRegistry } from './provider-registry.ts'
import type { TargetBinding } from './types.ts'

export interface TargetCoordinatorOptions {
  providers: ProviderRegistry
  grants: GrantStore
}

export interface GrantOfferInput {
  sessionId: string
  expiresAt: number
  target: TargetBinding
}

export interface ConsumeContext {
  sessionId: string
  turn: number
}

/** One logical target key: exact targetId plus exact page origin. */
export interface TargetKey {
  targetId: TargetId
  origin: string
}

export class TargetCoordinator {
  private readonly providers: ProviderRegistry
  private readonly grants: GrantStore
  /** Request id → grant id, so providers can embed the grant in wire frames. */
  private readonly requestGrantIds = new Map<RequestId, GrantId>()

  constructor(options: TargetCoordinatorOptions) {
    this.providers = options.providers
    this.grants = options.grants
  }

  /** Register one offer with a host-allocated grant id and non-secret handle. */
  offer(input: GrantOfferInput): GrantRecord {
    return this.grants.offer({ grantId: newGrantId(), ...input })
  }

  /** Register one offer with an explicit grant id (Chrome grant.put path). */
  offerWithId(grantId: GrantId, input: GrantOfferInput): GrantRecord {
    return this.grants.offer({ grantId, ...input })
  }

  /**
   * Atomically consume many handles for one turn: every handle is validated
   * (session, turn, expiry, binding) and every bound target checked for
   * liveness BEFORE any record is committed, so a single dead or invalid
   * target rejects the whole batch without consuming the valid handles.
   */
  consumeBatch(handles: readonly string[], context: ConsumeContext): GrantRecord[] {
    return this.grants.consumeBatch(handles, context, record => {
      const provider = this.providers.get(record.target.descriptor.provider)
      if (provider === undefined) {
        throw bridgeError('internal', 'grant: unknown provider', false)
      }
      if (!provider.isConnected(record.target)) {
        throw bridgeError('target_disconnected', 'grant: bound target is not connected', false)
      }
    })
  }

  /** The grant id bound to one in-flight request (providers embed it). */
  grantIdFor(requestId: RequestId): GrantId | undefined {
    return this.requestGrantIds.get(requestId)
  }

  /**
   * Dispatch one operation to the exact bound target of one grant. The
   * grant must exist, its provider must be registered, the capability must
   * be advertised by the bound target, and the bound connection must be
   * live — otherwise the call fails before any forwarding.
   */
  async request(
    grantId: GrantId,
    operation: BrowserOperation,
    args: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const record = this.grants.resolve(grantId)
    const target = record.target
    const provider = this.providers.get(target.descriptor.provider)
    if (provider === undefined) {
      throw bridgeError('internal', 'request: unknown provider', false)
    }
    if (!(target.descriptor.capabilities as readonly string[]).includes(operation)) {
      throw bridgeError(
        'unsupported_operation',
        `${target.descriptor.provider} target does not support ${operation}`,
        false,
      )
    }
    if (!provider.isConnected(target)) {
      throw bridgeError(
        provider.kind === 'chrome-extension' ? 'bridge_disconnected' : 'target_disconnected',
        `${target.descriptor.provider} target is not connected`,
        true,
      )
    }
    const requestId = newRequestId()
    this.requestGrantIds.set(requestId, grantId)
    try {
      return await provider.request(target, requestId, operation, args, signal)
    } finally {
      this.requestGrantIds.delete(requestId)
    }
  }

  /** Revoke every grant of one turn and notify the owning providers. */
  revokeTurn(connectionId: string, sessionId: string, turn: number): GrantRecord[] {
    return this.revokeRecords(this.grants.revokeTurn(connectionId, sessionId, turn))
  }

  /** Revoke every grant of one connection/session and notify providers. */
  revokeSession(connectionId: string, sessionId: string): GrantRecord[] {
    return this.revokeRecords(this.grants.revokeSession(connectionId, sessionId))
  }

  /** Revoke every grant of one connection and notify providers. */
  revokeConnection(connectionId: string): GrantRecord[] {
    return this.revokeRecords(this.grants.revokeConnection(connectionId))
  }

  /** Revoke every grant bound to one logical target and notify providers. */
  revokeTarget(key: TargetKey): GrantRecord[] {
    return this.revokeRecords(this.grants.revokeTarget(key.targetId, key.origin))
  }

  /** Revoke one grant by id and notify its provider. */
  revoke(grantId: GrantId): GrantRecord[] {
    return this.revokeRecords(this.grants.revoke(grantId))
  }

  private revokeRecords(records: GrantRecord[]): GrantRecord[] {
    for (const record of records) {
      const provider = this.providers.get(record.target.descriptor.provider)
      if (provider === undefined) continue
      provider.revoke(record.target, record.grantId)
    }
    return records
  }

  /**
   * Rebind one logical target to a new connection (page reconnect within
   * the recovery window). A target whose current connection is still live
   * can never be taken over; only a confirmed dead connection may rebind.
   * Every grant of the logical target follows the new connection.
   */
  rebindTarget(key: TargetKey, next: TargetBinding): void {
    for (const record of this.grants.recordsForTarget(key.targetId, key.origin)) {
      const provider = this.providers.get(record.target.descriptor.provider)
      if (provider === undefined) continue
      if (provider.isConnected(record.target)) {
        throw bridgeError('target_disconnected', 'grant: live target cannot be taken over by a new connection', false)
      }
      record.target = { ...record.target, connectionId: next.connectionId }
    }
  }
}
