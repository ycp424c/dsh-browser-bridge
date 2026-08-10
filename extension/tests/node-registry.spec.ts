import { describe, expect, it } from 'vitest'
import { ElementRef } from '@dsh-external/dsh-browser-bridge-protocol'
import { NodeRegistry } from '../src/cdp/nodes.ts'

describe('node registry', () => {
  it('registers backend nodes and resolves them within one generation', () => {
    const registry = new NodeRegistry()
    const ref = registry.register(42, 'frame-1', 1)
    expect(ref).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(registry.resolve(ref, 1)).toEqual({ ref, backendNodeId: 42, frameId: 'frame-1', generation: 1 })
  })

  it('throws stale_element for unknown refs', () => {
    const registry = new NodeRegistry()
    expect(() => registry.resolve('nope', 1)).toThrowError(expect.objectContaining({ code: 'stale_element' }))
  })

  it('throws stale_element for refs from another document generation', () => {
    const registry = new NodeRegistry()
    const ref = registry.register(42, 'frame-1', 1)
    expect(() => registry.resolve(ref, 2)).toThrowError(expect.objectContaining({ code: 'stale_element' }))
  })

  it('clears every reference on main-frame navigation', () => {
    const registry = new NodeRegistry()
    const ref = registry.register(42, 'frame-1', 1)
    registry.clear()
    expect(() => registry.resolve(ref, 1)).toThrowError(expect.objectContaining({ code: 'stale_element' }))
  })

  it('keeps refs of the current generation after navigation', () => {
    const registry = new NodeRegistry()
    const before = registry.register(42, 'frame-1', 1)
    registry.clear()
    const after = registry.register(43, 'frame-1', 2)
    expect(() => registry.resolve(before, 2)).toThrowError(expect.objectContaining({ code: 'stale_element' }))
    expect(registry.resolve(after, 2).backendNodeId).toBe(43)
  })

  it('uses an injectable ref factory', () => {
    const registry = new NodeRegistry({ randomId: () => ElementRef('e1') })
    expect(registry.register(1, 'f', 1)).toBe('e1')
  })
})
