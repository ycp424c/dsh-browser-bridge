import { describe, expect, it } from 'vitest'
import { ConnectionId, GrantId, newTargetId } from '@dsh-external/dsh-browser-bridge-protocol'
import { GrantStore } from '../src/bridge/grant-store.ts'
import type { TargetBinding } from '../src/targets/types.ts'

function chromeBinding(connectionId: string): TargetBinding {
  return {
    descriptor: {
      targetId: newTargetId(),
      provider: 'chrome-extension',
      title: 'Fixture',
      url: 'http://127.0.0.1:4173/',
      origin: 'http://127.0.0.1:4173',
      generation: 0,
      capabilities: ['observe', 'inspect', 'screenshot', 'act', 'navigate', 'wait', 'console', 'network'],
    },
    connectionId: connectionId as never,
    logicalKey: 'chrome:2:7',
  }
}

function offer(grants: GrantStore, grantId: string, connectionId: string, sessionId = 'session-a') {
  return grants.offer({
    grantId: GrantId(grantId),
    sessionId,
    expiresAt: 1_000 + 30_000,
    target: chromeBinding(connectionId),
  })
}

describe('grant store', () => {
  it('binds one handle to one turn and rejects cross-session consumption', () => {
    let now = 1_000
    const grants = new GrantStore({ now: () => now })
    const connectionId = ConnectionId('c1')
    const grantId = GrantId('g1')
    const record = grants.offer({
      grantId,
      sessionId: 'session-a',
      expiresAt: now + 30_000,
      target: chromeBinding(connectionId),
    })
    expect(record.handle).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    expect(grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 1 }).grantId).toBe(grantId)
    expect(() => grants.consume(record.handle, { connectionId, sessionId: 'session-b', turn: 1 })).toThrow(/session/)
  })

  it('returns the same record within the bound turn and rejects later turns', () => {
    let now = 1_000
    const grants = new GrantStore({ now: () => now })
    const connectionId = ConnectionId('c1')
    const record = grants.offer({
      grantId: GrantId('g1'),
      sessionId: 'session-a',
      expiresAt: now + 30_000,
      target: chromeBinding(connectionId),
    })
    const first = grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 2 })
    const again = grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 2 })
    expect(again).toBe(first)
    expect(() => grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 3 })).toThrow(/turn/)
  })

  it('rejects handles from another connection', () => {
    const grants = new GrantStore()
    const record = grants.offer({
      grantId: GrantId('g1'),
      sessionId: 'session-a',
      expiresAt: Date.now() + 30_000,
      target: chromeBinding('c1'),
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
    const record = grants.offer({
      grantId: GrantId('g1'),
      sessionId: 'session-a',
      expiresAt: now + 30_000,
      target: chromeBinding(connectionId),
    })
    now = 1_000 + 31_000
    expect(() => grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 1 })).toThrow(/expired/)
  })

  it('revokes by connection, by turn, by target, and by grant id with records returned', () => {
    let now = 1_000
    const grants = new GrantStore({ now: () => now })
    const c1 = ConnectionId('c1')
    const c2 = ConnectionId('c2')
    const r1 = offer(grants, 'g1', c1)
    const r2 = offer(grants, 'g2', c1)
    const r3 = offer(grants, 'g3', c2)
    grants.consume(r1.handle, { connectionId: c1, sessionId: 'session-a', turn: 1 })
    expect(grants.revokeTurn(c1, 'session-a', 1).map(record => record.grantId)).toEqual([GrantId('g1')])
    expect(grants.revokeConnection(c1).map(record => record.grantId)).toEqual([GrantId('g2')])
    expect(grants.revoke(GrantId('g3')).map(record => record.grantId)).toEqual([GrantId('g3')])
    expect(grants.revoke(GrantId('g3'))).toEqual([])
    expect(grants.revokeConnection(c2)).toEqual([])
  })

  it('revokes every grant of one logical target and lists its records', () => {
    const grants = new GrantStore()
    const c1 = ConnectionId('c1')
    const binding = chromeBinding(c1)
    const sameTarget = { ...binding, logicalKey: 'vite:t:1' }
    const otherTarget = {
      ...binding,
      descriptor: { ...binding.descriptor, targetId: newTargetId() },
      logicalKey: 'vite:t:2',
    }
    const r1 = grants.offer({
      grantId: GrantId('g1'),
      sessionId: 'session-a',
      expiresAt: Date.now() + 30_000,
      target: sameTarget,
    })
    const r2 = grants.offer({
      grantId: GrantId('g2'),
      sessionId: 'session-a',
      expiresAt: Date.now() + 30_000,
      target: otherTarget,
    })
    const targetId = binding.descriptor.targetId
    const origin = binding.descriptor.origin
    expect(grants.recordsForTarget(targetId, origin)).toHaveLength(1)
    expect(grants.recordsForTarget(targetId, origin)[0]).toBe(r1)
    expect(grants.revokeTarget(targetId, origin).map(record => record.grantId)).toEqual([GrantId('g1')])
    expect(grants.resolve(r2.grantId).grantId).toBe(GrantId('g2'))
  })
})
