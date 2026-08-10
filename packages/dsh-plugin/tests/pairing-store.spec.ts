import { describe, expect, it } from 'vitest'
import { PairingStore } from '../src/bridge/pairing-store.ts'

const EXT_A = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const EXT_B = 'chrome-extension://bcdefghijklmnopqbcdefghijklmnopq'

describe('pairing store', () => {
  it('issues single-use nonces bound to one exact extension origin', () => {
    let now = 1_000
    const store = new PairingStore({ now: () => now })
    const nonce = store.issue(EXT_A)
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    expect(store.consume(nonce, EXT_A)).toBe(true)
    // Replay always fails: the nonce was deleted before validation.
    expect(() => store.consume(nonce, EXT_A)).toThrow(/pairing/)
  })

  it('rejects a mismatched origin and still burns the nonce', () => {
    const store = new PairingStore()
    const nonce = store.issue(EXT_A)
    expect(() => store.consume(nonce, EXT_B)).toThrow(/pairing/)
    expect(() => store.consume(nonce, EXT_A)).toThrow(/pairing/)
  })

  it('rejects expired nonces', () => {
    let now = 1_000
    const store = new PairingStore({ now: () => now, pairingTtlMs: 30_000 })
    const nonce = store.issue(EXT_A)
    now = 1_000 + 31_000
    expect(() => store.consume(nonce, EXT_A)).toThrow(/pairing/)
  })

  it('rejects malformed extension origins at issue time', () => {
    const store = new PairingStore()
    expect(() => store.issue('https://example.com')).toThrow(/chrome-extension/)
    expect(() => store.issue('chrome-extension://SHORT')).toThrow(/chrome-extension/)
    expect(() => store.issue('chrome-extension://')).toThrow(/chrome-extension/)
  })

  it('rejects unknown nonces', () => {
    const store = new PairingStore()
    expect(() => store.consume('unknown-nonce', EXT_A)).toThrow(/pairing/)
  })
})
