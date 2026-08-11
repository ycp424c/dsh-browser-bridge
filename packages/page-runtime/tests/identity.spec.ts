import { describe, expect, it } from 'vitest'
import { clearIdentity, loadOrCreateIdentity } from '../src/identity.ts'

function freshStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

describe('page identity', () => {
  it('creates one per-tab targetId and increments the generation on reload', () => {
    const storage = freshStorage()
    const first = loadOrCreateIdentity(storage)
    expect(first.targetId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.generation).toBe(1)
    const second = loadOrCreateIdentity(storage)
    expect(second.targetId).toBe(first.targetId)
    expect(second.generation).toBe(first.generation + 1)
    const third = loadOrCreateIdentity(storage)
    expect(third.generation).toBe(first.generation + 2)
  })

  it('ignores invalid stored values and starts fresh', () => {
    const storage = freshStorage()
    storage.setItem('dsh-browser-bridge:targetId', 'too-short')
    storage.setItem('dsh-browser-bridge:generation', 'garbage')
    const identity = loadOrCreateIdentity(storage)
    expect(identity.targetId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(identity.targetId).not.toBe('too-short')
    expect(identity.generation).toBe(1)
  })

  it('clamps a maliciously large stored generation', () => {
    const storage = freshStorage()
    storage.setItem('dsh-browser-bridge:targetId', 't'.repeat(43))
    storage.setItem('dsh-browser-bridge:generation', '99999999999999999999')
    const identity = loadOrCreateIdentity(storage)
    expect(identity.targetId).toBe('t'.repeat(43))
    expect(identity.generation).toBe(1)
  })

  it('clearIdentity removes every identity key', () => {
    const storage = freshStorage()
    const identity = loadOrCreateIdentity(storage)
    clearIdentity(storage)
    expect(storage.getItem('dsh-browser-bridge:targetId')).toBeNull()
    expect(storage.getItem('dsh-browser-bridge:generation')).toBeNull()
    const next = loadOrCreateIdentity(storage)
    expect(next.targetId).not.toBe(identity.targetId)
  })

  it('never writes identity or grant evidence into localStorage', () => {
    const before = window.localStorage.length
    const storage = freshStorage()
    loadOrCreateIdentity(storage)
    clearIdentity(storage)
    expect(window.localStorage.length).toBe(before)
    expect(window.localStorage.getItem('dsh-browser-bridge:targetId')).toBeNull()
  })
})
