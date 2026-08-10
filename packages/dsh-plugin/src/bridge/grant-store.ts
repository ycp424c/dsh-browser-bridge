/**
 * Connection/session/turn-bound grant state on the host side. Offers arrive
 * over the authenticated bridge; consumption happens at `agent/pre-step` and
 * binds one handle to exactly one (connection, session, turn).
 */
import {
  bridgeError,
  newGrantHandle,
  type GrantHandle,
  type GrantId,
  type TabDescriptor,
} from '@dsh-external/dsh-browser-bridge-protocol'

export interface GrantRecord {
  grantId: GrantId
  handle: GrantHandle
  connectionId: string
  sessionId: string
  /** The turn that consumed the handle; absent until consumed. */
  turn?: number
  expiresAt: number
  tab: TabDescriptor
}

export interface GrantOfferInput {
  grantId: GrantId
  sessionId: string
  expiresAt: number
  tab: TabDescriptor
}

export interface ConsumeContext {
  connectionId: string
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
  offer(connectionId: string, input: GrantOfferInput): GrantRecord {
    if (this.byGrantId.has(input.grantId)) {
      throw new Error(`grant: duplicate grant ${input.grantId}`)
    }
    const handle = newGrantHandle()
    const record: GrantRecord = {
      grantId: input.grantId,
      handle,
      connectionId,
      sessionId: input.sessionId,
      expiresAt: input.expiresAt,
      tab: input.tab,
    }
    this.byHandle.set(handle, record)
    this.byGrantId.set(input.grantId, record)
    return record
  }

  /**
   * Consume one handle for a turn. The record is returned unchanged on
   * repeat consumption of the SAME turn; any other (connection, session,
   * turn) combination fails closed.
   */
  consume(handle: string, context: ConsumeContext): GrantRecord {
    const record = this.byHandle.get(handle)
    if (record === undefined) {
      throw bridgeError('permission_denied', 'grant: unknown handle', false)
    }
    if (record.connectionId !== context.connectionId) {
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
    record.turn = context.turn
    return record
  }

  /** Resolve one grant by id on a connection, or throw `grant_expired`. */
  resolve(grantId: GrantId, connectionId: string): GrantRecord {
    const record = this.byGrantId.get(grantId)
    if (record === undefined || record.connectionId !== connectionId) {
      throw bridgeError('grant_expired', 'grant: unknown or foreign grant', false)
    }
    if (this.now() > record.expiresAt) {
      throw bridgeError('grant_expired', 'grant: grant expired', false)
    }
    return record
  }

  /** Revoke one grant by id; returns the affected ids (empty when absent). */
  revoke(grantId: GrantId): GrantId[] {
    const record = this.byGrantId.get(grantId)
    if (record === undefined) return []
    this.byGrantId.delete(grantId)
    this.byHandle.delete(record.handle)
    return [grantId]
  }

  /** Revoke every grant of one connection; returns the affected ids. */
  revokeConnection(connectionId: string): GrantId[] {
    const affected: GrantId[] = []
    for (const record of [...this.byGrantId.values()]) {
      if (record.connectionId !== connectionId) continue
      this.byGrantId.delete(record.grantId)
      this.byHandle.delete(record.handle)
      affected.push(record.grantId)
    }
    return affected
  }

  /** Revoke grants of one connection/session consumed by (or still pending for) a turn. */
  revokeTurn(connectionId: string, sessionId: string, turn: number): GrantId[] {
    const affected: GrantId[] = []
    for (const record of [...this.byGrantId.values()]) {
      if (record.connectionId !== connectionId || record.sessionId !== sessionId) continue
      if (record.turn !== turn) continue
      this.byGrantId.delete(record.grantId)
      this.byHandle.delete(record.handle)
      affected.push(record.grantId)
    }
    return affected
  }

  /** Revoke every grant of one connection/session (disconnect, expiry, close). */
  revokeSession(connectionId: string, sessionId: string): GrantId[] {
    const affected: GrantId[] = []
    for (const record of [...this.byGrantId.values()]) {
      if (record.connectionId !== connectionId || record.sessionId !== sessionId) continue
      this.byGrantId.delete(record.grantId)
      this.byHandle.delete(record.handle)
      affected.push(record.grantId)
    }
    return affected
  }
}
