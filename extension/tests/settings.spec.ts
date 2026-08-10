import { describe, expect, it } from 'vitest'
import { DEFAULT_DSH_ORIGIN, loadDshOrigin, normalizeDshOrigin, saveDshOrigin, type SettingsStorage } from '../src/settings.ts'

class MemoryStorage implements SettingsStorage {
  readonly values = new Map<string, string>()

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
}

describe('local DSH origin normalization', () => {
  it('accepts loopback origins and normalizes paths away', () => {
    expect(normalizeDshOrigin('http://127.0.0.1:3080/chat')).toBe('http://127.0.0.1:3080')
    expect(normalizeDshOrigin('http://localhost:3080')).toBe('http://localhost:3080')
    expect(normalizeDshOrigin(' http://[::1]:3080/ ')).toBe('http://[::1]:3080')
  })

  it('rejects non-loopback and non-http(s) origins', () => {
    expect(() => normalizeDshOrigin('https://example.com')).toThrow(/local DSH origin/)
    expect(() => normalizeDshOrigin('http://192.168.1.10:3080')).toThrow(/local DSH origin/)
    expect(() => normalizeDshOrigin('ftp://127.0.0.1:3080')).toThrow(/local DSH origin/)
    expect(() => normalizeDshOrigin('not a url')).toThrow(/local DSH origin/)
  })

  it('defaults and persists only the normalized origin', async () => {
    const storage = new MemoryStorage()
    expect(await loadDshOrigin(storage)).toBe(DEFAULT_DSH_ORIGIN)
    await saveDshOrigin(storage, 'http://localhost:4173/chat')
    expect(await loadDshOrigin(storage)).toBe('http://localhost:4173')
    expect(storage.values.get('dshOrigin')).toBe('http://localhost:4173')
  })
})
