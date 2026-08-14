/**
 * In-memory prompt grant vault. Grants bind an exact send-time tab snapshot
 * to one session; the vault also writes a non-secret ownership ledger to
 * `chrome.storage.session` so a restarted service worker can clean up CDP
 * sessions it owned before accepting new work.
 */
import {
  bridgeError,
  newGrantId,
  type GrantHandle,
  type GrantId,
  type TabDescriptor,
} from '@ycp424c/dsh-browser-bridge-protocol'

export interface VaultGrant {
  grantId: GrantId
  sessionId: string
  tab: TabDescriptor
  /** Sliding idle deadline; renewed by each new authorized tool call. */
  expiresAt: number
  /** Absolute deadline that renewal can never move past. */
  maxExpiresAt: number
  state: 'issued' | 'accepted' | 'revoked'
  handle?: GrantHandle
  /** Per-grant idle window retained for deterministic renewal. */
  idleTtlMs: number
  /** Fresh tool calls currently executing under this authority. */
  activeCalls: number
}

export interface GrantVaultOptions {
  now?: () => number
  idleTtlMs?: number
  maxTtlMs?: number
}

export interface OwnedGrantLedgerEntry {
  grantId: GrantId
  tabId: number
}

/** Inactive prompt authority is revoked after ten minutes. */
export const DEFAULT_GRANT_IDLE_TTL_MS = 10 * 60_000
/** Active prompts remain bounded even when browser calls keep renewing them. */
export const DEFAULT_GRANT_MAX_TTL_MS = 6 * 60 * 60_000

export class GrantVault {
  private readonly now: () => number
  private readonly defaultIdleTtlMs: number
  private readonly defaultMaxTtlMs: number
  private readonly grants = new Map<string, VaultGrant>()
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private sweepActive = false
  private onExpired: ((grantIds: GrantId[]) => void) | null = null
  private readonly listeners = new Set<() => void>()

  constructor(options: GrantVaultOptions = {}) {
    this.now = options.now ?? Date.now
    this.defaultIdleTtlMs = options.idleTtlMs ?? DEFAULT_GRANT_IDLE_TTL_MS
    this.defaultMaxTtlMs = options.maxTtlMs ?? DEFAULT_GRANT_MAX_TTL_MS
  }

  /** Subscribe to grant-set changes (for ledger synchronization). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  create(input: {
    sessionId: string
    tab: TabDescriptor
    idleTtlMs?: number
    maxTtlMs?: number
  }): VaultGrant {
    const now = this.now()
    const idleTtlMs = input.idleTtlMs ?? this.defaultIdleTtlMs
    const maxExpiresAt = now + (input.maxTtlMs ?? this.defaultMaxTtlMs)
    const grantId = newGrantId()
    const grant: VaultGrant = {
      grantId,
      sessionId: input.sessionId,
      tab: { ...input.tab },
      expiresAt: Math.min(now + idleTtlMs, maxExpiresAt),
      maxExpiresAt,
      state: 'issued',
      idleTtlMs,
      activeCalls: 0,
    }
    this.grants.set(grantId, grant)
    this.notify()
    this.schedule()
    return grant
  }

  /** Resolve a live grant or throw `grant_expired` (absent, revoked, expired). */
  resolve(grantId: GrantId): VaultGrant {
    const grant = this.grants.get(grantId)
    if (grant === undefined || grant.state === 'revoked') {
      throw bridgeError('grant_expired', 'grant expired or revoked', false)
    }
    if (this.now() > grant.expiresAt) {
      throw bridgeError('grant_expired', 'grant expired', false)
    }
    return grant
  }

  /** Renew one live grant's idle deadline without exceeding its hard cap. */
  renew(grantId: GrantId): VaultGrant {
    const grant = this.resolve(grantId)
    grant.expiresAt = Math.min(this.now() + grant.idleTtlMs, grant.maxExpiresAt)
    this.schedule()
    return grant
  }

  /** Mark one fresh tool call active; duplicates must never call this. */
  beginActivity(grantId: GrantId): VaultGrant {
    const grant = this.resolve(grantId)
    grant.activeCalls += 1
    // An executing call is not idle, but the immutable hard cap still wins.
    grant.expiresAt = grant.maxExpiresAt
    this.schedule()
    return grant
  }

  /** End one fresh call and start idle time after the last call settles. */
  endActivity(grantId: GrantId): void {
    const grant = this.grants.get(grantId)
    if (grant === undefined || grant.activeCalls === 0) return
    grant.activeCalls -= 1
    if (grant.activeCalls === 0) {
      grant.expiresAt = Math.min(this.now() + grant.idleTtlMs, grant.maxExpiresAt)
    }
    this.schedule()
  }

  revoke(grantId: GrantId): void {
    const grant = this.grants.get(grantId)
    if (grant === undefined) return
    grant.state = 'revoked'
    this.grants.delete(grantId)
    this.notify()
    this.schedule()
  }

  /** Record the host's acceptance and its non-secret correlation handle. */
  accept(grantId: GrantId, handle: string): void {
    const grant = this.grants.get(grantId)
    if (grant === undefined) {
      throw bridgeError('grant_expired', 'grant expired before acceptance', false)
    }
    grant.state = 'accepted'
    grant.handle = handle as GrantHandle
    this.schedule()
  }

  /** Revoke everything; returns the affected grant ids. */
  revokeAll(): GrantId[] {
    const affected = [...this.grants.keys()] as GrantId[]
    this.grants.clear()
    this.notify()
    this.schedule()
    return affected
  }

  /** The non-secret ownership ledger for startup reconciliation. */
  owned(): OwnedGrantLedgerEntry[] {
    return [...this.grants.values()].map(grant => ({ grantId: grant.grantId, tabId: grant.tab.tabId }))
  }

  /** Nearest expiry deadline, or undefined when the vault is empty. */
  nearestExpiry(): number | undefined {
    let nearest: number | undefined
    for (const grant of this.grants.values()) {
      if (nearest === undefined || grant.expiresAt < nearest) nearest = grant.expiresAt
    }
    return nearest
  }

  grantIdsOfSession(sessionId: string): GrantId[] {
    return [...this.grants.values()]
      .filter(grant => grant.sessionId === sessionId)
      .map(grant => grant.grantId)
  }

  grantIdsOfTab(tabId: number): GrantId[] {
    return [...this.grants.values()]
      .filter(grant => grant.tab.tabId === tabId)
      .map(grant => grant.grantId)
  }

  /**
   * Serialize the non-secret ownership ledger for `chrome.storage.session`.
   * Contains only { grantId, tabId } pairs — never page data.
   */
  serializeLedger(): string {
    return JSON.stringify(this.owned())
  }

  /**
   * Schedule one expiry sweep for the nearest deadline, re-arming whenever
   * grants are created, accepted, or revoked. The sweep starts even when the
   * vault is empty: grants created later must still expire on time. Expired
   * grants are dropped and reported through `onExpired`; the returned
   * disposer stops the sweep.
   */
  startExpirySweep(onExpired: (grantIds: GrantId[]) => void): () => void {
    this.onExpired = onExpired
    this.sweepActive = true
    this.schedule()
    return () => {
      this.sweepActive = false
      this.onExpired = null
      if (this.expiryTimer !== null) {
        clearTimeout(this.expiryTimer)
        this.expiryTimer = null
      }
    }
  }

  /** (Re-)arm the expiry timer for the nearest deadline, if a sweep is active. */
  private schedule(): void {
    if (!this.sweepActive) return
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    const nearest = this.nearestExpiry()
    if (nearest === undefined) return
    const delay = Math.max(1, nearest - this.now())
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      const expired: GrantId[] = []
      for (const [grantId, grant] of [...this.grants]) {
        if (this.now() > grant.expiresAt) {
          this.grants.delete(grantId)
          expired.push(grantId as GrantId)
        }
      }
      if (expired.length > 0) {
        this.onExpired?.(expired)
        this.notify()
      }
      this.schedule()
    }, delay)
  }
}
