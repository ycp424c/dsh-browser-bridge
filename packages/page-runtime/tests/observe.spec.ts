import { describe, expect, it } from 'vitest'
import { ElementRegistry } from '../src/refs/registry.ts'
import { observeDocument, type ObserveResult } from '../src/tools/observe.ts'

function setupFixture(html: string): void {
  document.body.innerHTML = html
}

function observe(options: { maxNodes?: number; maxChars?: number; generation?: number } = {}): {
  result: ObserveResult
  refs: ElementRegistry
} {
  const refs = new ElementRegistry()
  const result = observeDocument({
    refs,
    generation: options.generation ?? 1,
    maxNodes: options.maxNodes,
    maxChars: options.maxChars,
    doc: document,
    win: window,
  })
  return { result, refs }
}

describe('observe document', () => {
  it('derives role and name from native semantics and ARIA', () => {
    setupFixture(`
      <h1>Dashboard</h1>
      <button id="save">Save</button>
      <a href="/next">Next page</a>
      <label for="name">Name</label>
      <input id="name" placeholder="Enter name">
      <input id="search" placeholder="Search">
      <select aria-label="Country"><option>US</option></select>
      <input type="checkbox" aria-label="Accept terms">
      <div role="tab" aria-label="Overview">Overview</div>
      <div aria-label="Custom" role="button" tabindex="0">Custom</div>
    `)
    const { result } = observe()
    expect(result.nodes.find(node => node.name === 'Save')?.role).toBe('button')
    expect(result.nodes.find(node => node.name === 'Next page')?.role).toBe('link')
    expect(result.nodes.find(node => node.name === 'Dashboard')?.role).toBe('heading')
    // The label wins over the placeholder; a placeholder-only field uses it.
    expect(result.nodes.find(node => node.name === 'Name')?.role).toBe('textbox')
    expect(result.nodes.find(node => node.name === 'Search')?.role).toBe('textbox')
    expect(result.nodes.find(node => node.name === 'Country')?.role).toBe('combobox')
    expect(result.nodes.find(node => node.name === 'Accept terms')?.role).toBe('checkbox')
    expect(result.nodes.find(node => node.name === 'Overview')?.role).toBe('tab')
    expect(result.nodes.find(node => node.name === 'Custom')?.role).toBe('button')
    expect(result.page).toMatchObject({ url: 'http://localhost:3000/', title: '' })
    expect(result.viewport).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
    expect(result.generation).toBe(1)
  })

  it('emits references only for actionable or meaningful elements', () => {
    setupFixture(`
      <button id="save">Save</button>
      <p>Plain paragraph text</p>
      <div>Some wrapper</div>
      <input id="name" value="alice">
    `)
    const { result } = observe()
    expect(result.nodes.every(node => node.ref !== undefined && node.ref !== '')).toBe(true)
    const names = result.nodes.map(node => node.name)
    expect(names).toContain('Save')
    expect(names).not.toContain('Plain paragraph text')
    expect(names).not.toContain('Some wrapper')
  })

  it('masks sensitive values so no secret appears in the JSON output', () => {
    setupFixture(`
      <input id="token" value="super-secret-token">
      <input type="password" value="hunter2-password">
      <input id="plain" value="visible-value">
    `)
    const { result } = observe()
    const json = JSON.stringify(result)
    expect(json).not.toContain('super-secret-token')
    expect(json).not.toContain('hunter2-password')
    expect(json).toContain('visible-value')
  })

  it('skips hidden and detached nodes', () => {
    const hidden = document.createElement('button')
    hidden.textContent = 'Hidden Button'
    hidden.style.display = 'none'
    document.body.appendChild(hidden)
    const detached = document.createElement('button')
    detached.textContent = 'Detached Button'
    // Never appended: stays outside the document.
    const { result } = observe()
    expect(result.nodes.find(node => node.name === 'Hidden Button')).toBeUndefined()
    expect(result.nodes.find(node => node.name === 'Detached Button')).toBeUndefined()
    document.body.removeChild(hidden)
  })

  it('caps nodes and text with explicit truncation flags', () => {
    setupFixture('<h1>Title</h1>')
    for (let index = 0; index < 10; index += 1) {
      const button = document.createElement('button')
      button.textContent = `Action ${index}`
      document.body.appendChild(button)
    }
    const { result } = observe({ maxNodes: 3, maxChars: 20 })
    expect(result.nodes).toHaveLength(3)
    expect(result.truncated.nodes).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(20)
    expect(result.truncated.text).toBe(true)
  })

  it('caps every individual string field before serialization', () => {
    const huge = document.createElement('button')
    huge.setAttribute('aria-label', 'x'.repeat(10_000))
    document.body.appendChild(huge)
    const { result } = observe()
    const json = JSON.stringify(result)
    expect(json.length).toBeLessThan(100_000)
    document.body.removeChild(huge)
  })

  it('strips query and fragment from its own page identity', () => {
    const original = window.location.href
    try {
      window.history.replaceState(null, '', '/app?secret=1#frag')
      setupFixture('<button>Save</button>')
      const { result } = observe()
      expect(result.page.url).not.toContain('secret=1')
      expect(result.page.url).not.toContain('#frag')
    } finally {
      window.history.replaceState(null, '', original)
    }
  })
})
