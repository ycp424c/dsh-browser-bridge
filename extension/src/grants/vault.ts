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
  expiresAt: number
  state: 'issued' | 'accepted' | 'revoked'
  handle?: GrantHandle
}

export interface GrantVaultOptions {
  now?: () => number
  ttlMs?: number
}

export interface OwnedGrantLedgerEntry {
  grantId: GrantId
  tabId: number
}

export class GrantVault {
  private readonly now: () => number
  private readonly defaultTtlMs: number
  private readonly grants = new Map<string, VaultGrant>()
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private sweepActive = false
  private onExpired: ((grantIds: GrantId[]) => void) | null = null
  private readonly listeners = new Set<() => void>()

  constructor(options: GrantVaultOptions = {}) {
    this.now = options.now ?? Date.now
    this.defaultTtlMs = options.ttlMs ?? 10 * 60_000
  }

  /** Subscribe to grant-set changes (for ledger synchronization). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  create(input: { sessionId: string; tab: TabDescriptor; ttlMs?: number }): VaultGrant {
    const grantId = newGrantId()
    const grant: VaultGrant = {
      grantId,
      sessionId: input.sessionId,
      tab: { ...input.tab },
      expiresAt: this.now() + (input.ttlMs ?? this.defaultTtlMs),
      state: 'issued',
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
