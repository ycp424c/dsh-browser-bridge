/**
 * Bounded per-session tab-reference state. Each record carries a random
 * non-secret ref id, a copied tab descriptor, the session, and a display
 * label; entries expire after 10 minutes and are capped at 100 per session.
 */
import { newGrantHandle, type GrantHandle, type TabDescriptor } from '@dsh-external/dsh-browser-bridge-protocol'

export interface TabReference {
  ref: GrantHandle
  tab: TabDescriptor
  sessionId: string
  label: string
  createdAt: number
}

export interface ReferenceStoreOptions {
  now?: () => number
  maxEntries?: number
  maxAgeMs?: number
}

export class ReferenceStore {
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly maxAgeMs: number
  private readonly entries = new Map<string, TabReference>()

  constructor(options: ReferenceStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? 100
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000
  }

  /** Allocate a fresh reference; evicts the oldest entry of the session at the cap. */
  allocate(sessionId: string, tab: TabDescriptor, label: string): TabReference {
    this.purgeExpired()
    const sessionEntries = [...this.entries.values()].filter(entry => entry.sessionId === sessionId)
    while (sessionEntries.length >= this.maxEntries) {
      const oldest = sessionEntries.sort((a, b) => a.createdAt - b.createdAt)[0]!
      this.entries.delete(oldest.ref)
      sessionEntries.splice(sessionEntries.indexOf(oldest), 1)
    }
    const ref = newGrantHandle()
    const record: TabReference = {
      ref,
      tab: { ...tab },
      sessionId,
      label,
      createdAt: this.now(),
    }
    this.entries.set(ref, record)
    return record
  }

  /** Resolve one reference; `sessionId` optionally pins the owning session. */
  get(ref: string, sessionId?: string): TabReference | undefined {
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
