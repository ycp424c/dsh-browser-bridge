/**
 * Bounded per-session target-reference state, generic over the copied
 * target descriptor (Chrome `TabDescriptor` or a provider-neutral
 * `BrowserTargetDescriptor`). Each record carries a random non-secret ref
 * id, a copied target, the session, and a display label; entries expire
 * after 10 minutes and are capped at 100 per session.
 */
import { newGrantHandle, type GrantHandle } from '@ycp424c/dsh-browser-bridge-protocol'

export interface TargetReference<T> {
  ref: GrantHandle
  target: T
  sessionId: string
  label: string
  createdAt: number
}

export interface ReferenceStoreOptions {
  now?: () => number
  maxEntries?: number
  maxAgeMs?: number
}

export class ReferenceStore<T> {
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly maxAgeMs: number
  private readonly entries = new Map<string, TargetReference<T>>()

  constructor(options: ReferenceStoreOptions = {}) {
    this.now = options.now ?? Date.now
    // A zero or negative cap would loop forever in the eviction while.
    this.maxEntries = Math.max(1, options.maxEntries ?? 100)
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000
  }

  /** Allocate a fresh reference; evicts the oldest entry of the session at the cap. */
  allocate(sessionId: string, target: T, label: string): TargetReference<T> {
    this.purgeExpired()
    const sessionEntries = [...this.entries.values()].filter(entry => entry.sessionId === sessionId)
    while (sessionEntries.length >= this.maxEntries) {
      const oldest = sessionEntries.sort((a, b) => a.createdAt - b.createdAt)[0]!
      this.entries.delete(oldest.ref)
      sessionEntries.splice(sessionEntries.indexOf(oldest), 1)
    }
    const ref = newGrantHandle()
    const record: TargetReference<T> = {
      ref,
      target: { ...target },
      sessionId,
      label,
      createdAt: this.now(),
    }
    this.entries.set(ref, record)
    return record
  }

  /** Resolve one reference; `sessionId` optionally pins the owning session. */
  get(ref: string, sessionId?: string): TargetReference<T> | undefined {
    const record = this.entries.get(ref)
    if (record === undefined) return undefined
    if (sessionId !== undefined && record.sessionId !== sessionId) return undefined
    if (this.now() - record.createdAt > this.maxAgeMs) {
      this.entries.delete(ref)
      return undefined
    }
    return record
  }

  private purgeExpired(): void {
    const now = this.now()
    for (const [ref, record] of this.entries) {
      if (now - record.createdAt > this.maxAgeMs) this.entries.delete(ref)
    }
  }
}
