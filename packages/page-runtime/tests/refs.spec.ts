import { describe, expect, it } from 'vitest'
import { ElementRegistry } from '../src/refs/registry.ts'

describe('element registry', () => {
  it('captures and resolves one element with its generation', () => {
    const refs = new ElementRegistry()
    const button = document.createElement('button')
    document.body.appendChild(button)
    const ref = refs.capture(button, 3)
    expect(ref).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(refs.resolve(ref, 3)).toBe(button)
    document.body.removeChild(button)
  })

  it('resolves the same element to one stable reference within a generation', () => {
    const refs = new ElementRegistry()
    const button = document.createElement('button')
    document.body.appendChild(button)
    const first = refs.capture(button, 1)
    const second = refs.capture(button, 1)
    expect(second).toBe(first)
  })

  it('rejects malformed references', () => {
    const refs = new ElementRegistry()
    expect(() => refs.resolve('not-a-ref!', 1)).toThrowError(/stale_element/)
    expect(() => refs.resolve('', 1)).toThrowError(/stale_element/)
  })

  it('rejects references from another generation', () => {
    const refs = new ElementRegistry()
    const button = document.createElement('button')
    document.body.appendChild(button)
    const ref = refs.capture(button, 1)
    expect(() => refs.resolve(ref, 2)).toThrowError(/stale_element/)
    document.body.removeChild(button)
  })

  it('rejects disconnected elements', () => {
    const refs = new ElementRegistry()
    const button = document.createElement('button')
    document.body.appendChild(button)
    const ref = refs.capture(button, 1)
    document.body.removeChild(button)
    expect(button.isConnected).toBe(false)
    expect(() => refs.resolve(ref, 1)).toThrowError(/stale_element/)
  })

  it('rejects elements from another document', () => {
    const refs = new ElementRegistry()
    const foreign = document.implementation.createHTMLDocument('foreign')
    const button = foreign.createElement('button')
    foreign.body.appendChild(button)
    const ref = refs.capture(button, 1)
    expect(() => refs.resolve(ref, 1)).toThrowError(/stale_element/)
  })

  it('clear invalidates every reference', () => {
    const refs = new ElementRegistry()
    const button = document.createElement('button')
    document.body.appendChild(button)
    const ref = refs.capture(button, 1)
    refs.clear()
    expect(() => refs.resolve(ref, 1)).toThrowError(/stale_element/)
  })

  it('dispose invalidates everything and drops records', () => {
    const refs = new ElementRegistry()
    const button = document.createElement('button')
    document.body.appendChild(button)
    const ref = refs.capture(button, 1)
    refs.dispose()
    expect(() => refs.resolve(ref, 1)).toThrowError(/stale_element/)
  })
})
