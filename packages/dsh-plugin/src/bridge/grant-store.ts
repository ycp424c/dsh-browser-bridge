/**
 * Connection/session/turn-bound grant state on the host side. Offers arrive
 * from providers (extension bridge, Vite broker); consumption happens at
 * `agent/pre-step` and binds one handle to exactly one (session, turn) with
 * the bound target's liveness checked atomically.
 */
import {
  bridgeError,
  newGrantHandle,
  type GrantHandle,
  type GrantId,
} from '@dsh-external/dsh-browser-bridge-protocol'
import type { TargetBinding } from '../targets/types.ts'

export interface GrantRecord {
  grantId: GrantId
  handle: GrantHandle
  sessionId: string
  /** The turn that consumed the handle; absent until consumed. */
  turn?: number
  expiresAt: number
  /** The exact provider/target/connection the grant is bound to. */
  target: TargetBinding
}

export interface GrantOfferInput {
  grantId: GrantId
  sessionId: string
  expiresAt: number
  target: TargetBinding
}

export interface ConsumeContext {
  /** Optional binding check; omitted when the coordinator owns dispatch. */
  connectionId?: string
  sessionId: string
  turn: number
}

export interface GrantStoreOptions {
  now?: () => number
}

export class GrantStore {
  private readonly now: () => number
  private readonly byHandle = new Map<string, GrantRecord>()
  private readonly byGrantId = new Map<string, GrantRecord>()

  constructor(options: GrantStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  /** Register one grant offer with a fresh random non-secret handle. */
  offer(input: GrantOfferInput): GrantRecord {
    if (this.byGrantId.has(input.grantId)) {
      throw new Error(`grant: duplicate grant ${input.grantId}`)
    }
    const handle = newGrantHandle()
    const record: GrantRecord = {
      grantId: input.grantId,
      handle,
      sessionId: input.sessionId,
      expiresAt: input.expiresAt,
      target: input.target,
    }
    this.byHandle.set(handle, record)
    this.byGrantId.set(input.grantId, record)
    return record
  }

  /**
   * Consume one handle for a turn. The record is returned unchanged on
   * repeat consumption of the SAME turn; any other (session, turn)
   * combination fails closed.
   */
  consume(handle: string, context: ConsumeContext, guard?: (record: GrantRecord) => void): GrantRecord {
    const record = this.validate(handle, context)
    if (guard !== undefined) guard(record)
    record.turn = context.turn
    return record
  }

  /**
   * Atomically consume MANY handles for one turn: every handle is validated
   * (and, when a guard is supplied, checked against it) BEFORE any record
   * is committed, so a single invalid, foreign, expired, or dead-target
   * handle rejects the whole batch without consuming any valid handle.
   * Repeat handles (the same marker twice) are validated twice and
   * committed idempotently. Same-turn steering uses this so a rejected step
   * never half-consumes its markers or changes the active turn's pages.
   */
  consumeBatch(
    handles: readonly string[],
    context: ConsumeContext,
    guard?: (record: GrantRecord) => void,
  ): GrantRecord[] {
    const records = handles.map(handle => this.validate(handle, context))
    if (guard !== undefined) {
      for (const record of records) guard(record)
    }
    for (const record of records) record.turn = context.turn
    return records
  }

  /** Validate one handle for a context WITHOUT mutating the record. */
  private validate(handle: string, context: ConsumeContext): GrantRecord {
    const record = this.byHandle.get(handle)
    if (record === undefined) {
      throw bridgeError('permission_denied', 'grant: unknown handle', false)
    }
    if (context.connectionId !== undefined && record.target.connectionId !== context.connectionId) {
      throw bridgeError('permission_denied', 'grant: handle belongs to another connection', false)
    }
    if (record.sessionId !== context.sessionId) {
      throw bridgeError('permission_denied', 'grant: handle belongs to another session', false)
    }
    if (record.turn !== undefined && record.turn !== context.turn) {
      throw bridgeError('permission_denied', 'grant: handle already used by another turn', false)
    }
    if (this.now() > record.expiresAt) {
      throw bridgeError('grant_expired', 'grant: grant expired', false)
    }
    return record
  }

  /** Resolve one grant by id, or throw `grant_expired`. */
  resolve(grantId: GrantId): GrantRecord {
    const record = this.byGrantId.get(grantId)
    if (record === undefined) {
      throw bridgeError('grant_expired', 'grant: unknown grant', false)
    }
    if (this.now() > record.expiresAt) {
      throw bridgeError('grant_expired', 'grant: grant expired', false)
    }
    return record
  }

  /** Revoke one grant by id; returns the affected records (empty when absent). */
  revoke(grantId: GrantId): GrantRecord[] {
    const record = this.byGrantId.get(grantId)
    if (record === undefined) return []
    this.byGrantId.delete(grantId)
    this.byHandle.delete(record.handle)
    return [record]
  }

  /** Revoke every grant of one connection; returns the affected records. */
  revokeConnection(connectionId: string): GrantRecord[] {
    return this.drop(record => record.target.connectionId === connectionId)
  }

  /** Revoke grants of one connection/session consumed by (or still pending for) a turn. */
  revokeTurn(connectionId: string, sessionId: string, turn: number): GrantRecord[] {
    return this.drop(record =>
      record.target.connectionId === connectionId && record.sessionId === sessionId && record.turn === turn)
  }

  /** Revoke every grant of one connection/session (disconnect, expiry, close). */
  revokeSession(connectionId: string, sessionId: string): GrantRecord[] {
    return this.drop(record =>
      record.target.connectionId === connectionId && record.sessionId === sessionId)
  }

  /** Revoke every grant of one logical target (origin change, window expiry). */
  revokeTarget(targetId: string, origin: string): GrantRecord[] {
    return this.drop(record =>
      record.target.descriptor.targetId === targetId && record.target.descriptor.origin === origin)
  }

  /** Read-only lookup of every record bound to one logical target. */
  recordsForTarget(targetId: string, origin: string): GrantRecord[] {
    return [...this.byGrantId.values()].filter(record =>
      record.target.descriptor.targetId === targetId && record.target.descriptor.origin === origin)
  }

  private drop(predicate: (record: GrantRecord) => boolean): GrantRecord[] {
    const affected: GrantRecord[] = []
    for (const record of [...this.byGrantId.values()]) {
      if (!predicate(record)) continue
      this.byGrantId.delete(record.grantId)
      this.byHandle.delete(record.handle)
      affected.push(record)
    }
    return affected
  }
}
