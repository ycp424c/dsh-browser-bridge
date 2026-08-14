import { describe, expect, it } from 'vitest'
import { GrantId, type TabDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'
import { GrantVault } from '../src/grants/vault.ts'

const TAB: TabDescriptor = { tabId: 9, windowId: 3, title: 'App', url: 'http://127.0.0.1:4173/' }

describe('grant vault', () => {
  it('uses a six-hour absolute lifetime by default', () => {
    const now = 1_000
    const vault = new GrantVault({ now: () => now })
    const grant = vault.create({ sessionId: 's1', tab: TAB })

    expect(grant.maxExpiresAt).toBe(now + 6 * 60 * 60_000)
  })

  it('renews the idle deadline when an active grant is used', () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000, maxTtlMs: 300_000 })
    const grant = vault.create({ sessionId: 's1', tab: TAB })

    expect(grant.expiresAt).toBe(61_000)
    expect(grant.maxExpiresAt).toBe(301_000)

    now = 51_000
    vault.renew(grant.grantId)

    expect(grant.expiresAt).toBe(111_000)
    now = 110_000
    expect(vault.resolve(grant.grantId)).toBe(grant)
  })

  it('never renews a grant beyond its absolute lifetime cap', () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000, maxTtlMs: 120_000 })
    const grant = vault.create({ sessionId: 's1', tab: TAB })

    now = 51_000
    vault.renew(grant.grantId)
    now = 101_000
    vault.renew(grant.grantId)

    expect(grant.expiresAt).toBe(121_000)
    expect(grant.maxExpiresAt).toBe(121_000)
    now = 121_001
    expect(() => vault.resolve(grant.grantId)).toThrow(/grant expired/)
  })

  it('creates send-time immutable grants bound to the exact tab id', () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000 })
    const grant = vault.create({ sessionId: 's1', tab: TAB, idleTtlMs: 60_000 })
    expect(grant.grantId).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    // The active tab changes after the grant was created; resolve still targets tab 9.
    expect(vault.resolve(grant.grantId).tab.tabId).toBe(9)
    expect(vault.resolve(grant.grantId).tab).not.toBe(TAB)
  })

  it('expires grants', () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000 })
    const grant = vault.create({ sessionId: 's1', tab: TAB })
    now = 1_000 + 61_000
    expect(() => vault.resolve(grant.grantId)).toThrow(/grant expired/)
  })

  it('does not resurrect a grant after its idle deadline', () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000, maxTtlMs: 300_000 })
    const grant = vault.create({ sessionId: 's1', tab: TAB })

    now = 61_001

    expect(() => vault.renew(grant.grantId)).toThrow(/grant expired/)
    expect(grant.expiresAt).toBe(61_000)
  })

  it('revokes grants', () => {
    const vault = new GrantVault()
    const grant = vault.create({ sessionId: 's1', tab: TAB })
    vault.revoke(grant.grantId)
    expect(() => vault.resolve(grant.grantId)).toThrow(/grant expired/)
  })

  it('records acceptance with the non-secret handle', () => {
    const vault = new GrantVault()
    const grant = vault.create({ sessionId: 's1', tab: TAB })
    const handle = 'h'.repeat(32)
    vault.accept(grant.grantId, handle)
    expect(vault.resolve(grant.grantId).handle).toBe(handle)
    expect(vault.resolve(grant.grantId).state).toBe('accepted')
  })

  it('exposes an owned { grantId, tabId } ledger for startup cleanup', () => {
    const vault = new GrantVault()
    const a = vault.create({ sessionId: 's1', tab: TAB })
    const b = vault.create({ sessionId: 's1', tab: { ...TAB, tabId: 12 } })
    expect(vault.owned()).toEqual([
      { grantId: a.grantId, tabId: 9 },
      { grantId: b.grantId, tabId: 12 },
    ])
    vault.revoke(a.grantId)
    expect(vault.owned()).toEqual([{ grantId: b.grantId, tabId: 12 }])
  })

  it('reports the nearest expiry deadline', () => {
    let now = 1_000
    const vault = new GrantVault({ now: () => now, idleTtlMs: 60_000 })
    vault.create({ sessionId: 's1', tab: TAB })
    const later = vault.create({ sessionId: 's2', tab: { ...TAB, tabId: 12 }, idleTtlMs: 120_000 })
    expect(vault.nearestExpiry()).toBe(now + 60_000)
    vault.revoke(later.grantId)
    expect(vault.nearestExpiry()).toBe(now + 60_000)
    vault.revoke(vault.owned()[0]!.grantId)
    expect(vault.nearestExpiry()).toBeUndefined()
  })

  it('tracks grants by session for connection cleanup', () => {
    const vault = new GrantVault()
    const a = vault.create({ sessionId: 's1', tab: TAB })
    vault.create({ sessionId: 's2', tab: { ...TAB, tabId: 12 } })
    expect(vault.grantIdsOfSession('s1')).toEqual([a.grantId])
  })
})
