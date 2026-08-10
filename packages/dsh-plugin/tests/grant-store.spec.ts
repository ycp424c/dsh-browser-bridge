import { describe, expect, it } from 'vitest'
import { ConnectionId, GrantId } from '@dsh-external/dsh-browser-bridge-protocol'
import { GrantStore } from '../src/bridge/grant-store.ts'

const TAB = { tabId: 7, windowId: 2, title: 'Fixture', url: 'http://127.0.0.1:4173/' }

describe('grant store', () => {
  it('binds one handle to one turn and rejects cross-session consumption', () => {
    let now = 1_000
    const grants = new GrantStore({ now: () => now })
    const connectionId = ConnectionId('c1')
    const grantId = GrantId('g1')
    const record = grants.offer(connectionId, {
      grantId, sessionId: 'session-a', expiresAt: now + 30_000, tab: TAB,
    })
    expect(record.handle).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    expect(grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 1 }).grantId).toBe(grantId)
    expect(() => grants.consume(record.handle, { connectionId, sessionId: 'session-b', turn: 1 })).toThrow(/session/)
  })

  it('returns the same record within the bound turn and rejects later turns', () => {
    let now = 1_000
    const grants = new GrantStore({ now: () => now })
    const connectionId = ConnectionId('c1')
    const record = grants.offer(connectionId, {
      grantId: GrantId('g1'), sessionId: 'session-a', expiresAt: now + 30_000, tab: TAB,
    })
    const first = grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 2 })
    const again = grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 2 })
    expect(again).toBe(first)
    expect(() => grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 3 })).toThrow(/turn/)
  })

  it('rejects handles from another connection', () => {
    const grants = new GrantStore()
    const record = grants.offer(ConnectionId('c1'), {
      grantId: GrantId('g1'), sessionId: 'session-a', expiresAt: Date.now() + 30_000, tab: TAB,
    })
    expect(() => grants.consume(record.handle, { connectionId: ConnectionId('c2'), sessionId: 'session-a', turn: 1 })).toThrow(/connection/)
  })

  it('rejects unknown handles', () => {
    const grants = new GrantStore()
    expect(() => grants.consume('a'.repeat(32), { connectionId: ConnectionId('c1'), sessionId: 's', turn: 1 })).toThrow(/handle/)
  })

  it('rejects expired grants at consume time', () => {
    let now = 1_000
    const grants = new GrantStore({ now: () => now })
    const connectionId = ConnectionId('c1')
    const record = grants.offer(connectionId, {
      grantId: GrantId('g1'), sessionId: 'session-a', expiresAt: now + 30_000, tab: TAB,
    })
    now = 1_000 + 31_000
    expect(() => grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 1 })).toThrow(/expired/)
  })

  it('revokes by connection, by turn, and by grant id with affected ids returned', () => {
    let now = 1_000
    const grants = new GrantStore({ now: () => now })
    const c1 = ConnectionId('c1')
    const c2 = ConnectionId('c2')
    const r1 = grants.offer(c1, { grantId: GrantId('g1'), sessionId: 'session-a', expiresAt: now + 30_000, tab: TAB })
    const r2 = grants.offer(c1, { grantId: GrantId('g2'), sessionId: 'session-a', expiresAt: now + 30_000, tab: TAB })
    const r3 = grants.offer(c2, { grantId: GrantId('g3'), sessionId: 'session-a', expiresAt: now + 30_000, tab: TAB })
    grants.consume(r1.handle, { connectionId: c1, sessionId: 'session-a', turn: 1 })
    expect(grants.revokeTurn(c1, 'session-a', 1)).toEqual([GrantId('g1')])
    expect(grants.revokeConnection(c1).sort()).toEqual([GrantId('g2')])
    expect(grants.revoke(GrantId('g3'))).toEqual([GrantId('g3')])
    expect(grants.revoke(GrantId('g3'))).toEqual([])
    expect(grants.revokeConnection(c2)).toEqual([])
  })
})
