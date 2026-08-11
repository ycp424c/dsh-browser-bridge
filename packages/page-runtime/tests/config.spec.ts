import { describe, expect, it } from 'vitest'
import { normalizeDshOrigin, pageRuntimeConfigSchema } from '../src/config.ts'

describe('page runtime config', () => {
  it('accepts the loopback allowlist: localhost, *.localhost, 127/8, and ::1', () => {
    expect(normalizeDshOrigin('http://localhost:3080')).toBe('http://localhost:3080')
    expect(normalizeDshOrigin('http://app.localhost:3080/')).toBe('http://app.localhost:3080')
    expect(normalizeDshOrigin('http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080')
    expect(normalizeDshOrigin('http://127.8.9.10:3080')).toBe('http://127.8.9.10:3080')
    expect(normalizeDshOrigin('https://127.0.0.1:3443')).toBe('https://127.0.0.1:3443')
    expect(normalizeDshOrigin('https://[::1]:3080')).toBe('https://[::1]:3080')
  })

  it('rejects credentials, non-HTTP(S) schemes, and non-loopback hosts', () => {
    expect(() => normalizeDshOrigin('http://user:pass@localhost:3080')).toThrow()
    expect(() => normalizeDshOrigin('http://user@localhost:3080')).toThrow()
    expect(() => normalizeDshOrigin('file:///tmp/dsh')).toThrow()
    expect(() => normalizeDshOrigin('ws://localhost:3080')).toThrow()
    expect(() => normalizeDshOrigin('ftp://localhost:3080')).toThrow()
    expect(() => normalizeDshOrigin('https://example.com')).toThrow()
    expect(() => normalizeDshOrigin('https://localhost.evil.com')).toThrow()
    expect(() => normalizeDshOrigin('https://127.0.0.1.evil.com')).toThrow()
    expect(() => normalizeDshOrigin('https://128.0.0.1')).toThrow()
  })

  it('returns the exact origin without path, query, or fragment', () => {
    expect(normalizeDshOrigin('http://127.0.0.1:3080/dsh/web?x=1#frag')).toBe('http://127.0.0.1:3080')
    expect(normalizeDshOrigin('https://[::1]:3080/')).toBe('https://[::1]:3080')
  })

  it('exposes no secret-bearing configuration key', () => {
    const keys = Object.keys(pageRuntimeConfigSchema.shape)
    for (const secret of ['token', 'secret', 'cookie', 'apiKey', 'password', 'grant']) {
      expect(keys).not.toContain(secret)
    }
  })
})
