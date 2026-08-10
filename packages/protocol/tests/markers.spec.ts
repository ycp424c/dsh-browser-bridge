import { describe, expect, it } from 'vitest'
import { encodeMarker, extractMarkers, newGrantHandle } from '../src/index.ts'

describe('prompt markers', () => {
  it('extracts only syntactically valid non-secret handles', () => {
    const a = 'a'.repeat(32)
    const b = 'B'.repeat(32)
    const text = `check ${encodeMarker(a)} and ${encodeMarker(b)}`
    expect(extractMarkers(text).map(item => item.handle)).toEqual([a, b])
    expect(extractMarkers('[[dsh-browser-context:<script>]]')).toEqual([])
  })

  it('produces markers whose handles match the strict charset', () => {
    for (let i = 0; i < 20; i += 1) {
      const handle = newGrantHandle()
      expect(handle).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
      expect(extractMarkers(encodeMarker(handle))).toEqual([{ handle, marker: encodeMarker(handle) }])
    }
  })

  it('extracts every occurrence including repeated and adjacent markers', () => {
    const a = 'a'.repeat(32)
    const b = 'b'.repeat(32)
    const text = `${encodeMarker(a)}${encodeMarker(b)} tail ${encodeMarker(a)}`
    expect(extractMarkers(text).map(item => item.handle)).toEqual([a, b, a])
  })

  it('rejects handles outside the allowed length and charset', () => {
    expect(() => encodeMarker('short')).toThrow(/invalid grant handle/)
    expect(() => encodeMarker('x'.repeat(100))).toThrow(/invalid grant handle/)
    expect(() => encodeMarker('has space'.padEnd(32, 'x'))).toThrow(/invalid grant handle/)
  })

  it('does not match marker-like text with invalid handles', () => {
    expect(extractMarkers('[[dsh-browser-context:]]')).toEqual([])
    expect(extractMarkers('[[dsh-browser-context:short]]')).toEqual([])
    expect(extractMarkers('[[dsh-browser-context:' + 'x'.repeat(65) + ']]')).toEqual([])
  })
})
