import { describe, expect, it } from 'vitest'
import { ElementRegistry } from '../src/refs/registry.ts'
import { inspectElement, type InspectResult } from '../src/tools/inspect.ts'

function setupFixture(html: string): void {
  document.body.innerHTML = html
}

function makeContext() {
  const refs = new ElementRegistry()
  return {
    refs,
    inspect: (args: { ref?: string; selector?: string; properties?: string[] }) =>
      inspectElement({
        refs,
        generation: 1,
        doc: document,
        win: window,
        args,
      }),
  }
}

describe('inspect element', () => {
  it('resolves by reference and returns attributes, text, and geometry', () => {
    setupFixture(`
      <button id="save" data-kind="primary" style="color: rgb(1, 2, 3)">Save <span>now</span></button>
    `)
    const { refs, inspect } = makeContext()
    const button = document.getElementById('save')!
    const ref = refs.capture(button, 1)
    const inspected = inspect({ ref }) as InspectResult
    expect(inspected.tag).toBe('button')
    expect(inspected.attributes).toEqual(expect.arrayContaining([
      { name: 'data-kind', value: 'primary' },
    ]))
    expect(inspected.text).toContain('Save now')
    expect(inspected.rect).toEqual(expect.objectContaining({ width: expect.any(Number) }))
    expect(inspected.visible).toBe(true)
  })

  it('resolves by selector', () => {
    setupFixture('<input id="name" value="alice">')
    const { inspect } = makeContext()
    const inspected = inspect({ selector: '#name' }) as InspectResult
    expect(inspected.attributes).toEqual(expect.arrayContaining([
      { name: 'value', value: 'alice' },
    ]))
  })

  it('returns requested allowlisted computed properties', () => {
    setupFixture('<div id="box" style="display: block; color: red">x</div>')
    const { inspect } = makeContext()
    const inspected = inspect({ selector: '#box', properties: ['color', 'display', 'position', 'evil-property'] }) as InspectResult
    expect(inspected.computedStyle).toMatchObject({
      // jsdom normalizes colors and does not compute defaulted positions.
      color: 'rgb(255, 0, 0)',
      display: 'block',
    })
    expect('position' in inspected.computedStyle).toBe(true)
    // Non-allowlisted properties are never computed or returned.
    expect(inspected.computedStyle['evil-property']).toBeUndefined()
  })

  it('rejects ambiguous missing inputs', () => {
    const { inspect } = makeContext()
    expect(() => inspect({})).toThrow()
  })

  it('masks sensitive attribute values', () => {
    setupFixture('<input id="token" value="super-secret-token">')
    const { inspect } = makeContext()
    const inspected = inspect({ selector: '#token' }) as InspectResult
    const json = JSON.stringify(inspected)
    expect(json).not.toContain('super-secret-token')
  })

  it('returns stale_element for disconnected references', () => {
    setupFixture('<button id="gone">Gone</button>')
    const { refs, inspect } = makeContext()
    const button = document.getElementById('gone')!
    const ref = refs.capture(button, 1)
    document.body.removeChild(button)
    expect(() => inspect({ ref })).toThrowError(/stale_element/)
  })

  it('rejects references of another generation', () => {
    setupFixture('<button id="gen">Gen</button>')
    const { refs } = makeContext()
    const button = document.getElementById('gen')!
    const ref = refs.capture(button, 1)
    expect(() => inspectElement({
      refs,
      generation: 2,
      doc: document,
      win: window,
      args: { ref },
    })).toThrowError(/stale_element/)
  })

  it('rejects selectors that resolve outside the main document', () => {
    setupFixture('<button id="main">Main</button>')
    const { inspect } = makeContext()
    // An iframe's document is not the main document: a selector reaching
    // into it must be rejected, not followed.
    expect(() => inspect({ selector: 'iframe html' })).toThrow()
    expect(() => inspect({ selector: '#main' })).not.toThrow()
  })
})
