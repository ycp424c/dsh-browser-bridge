import { describe, expect, it, vi } from 'vitest'
import { ElementRegistry } from '../src/refs/registry.ts'
import { actOnElement } from '../src/tools/act.ts'

function makeContext() {
  const refs = new ElementRegistry()
  return {
    refs,
    act: (action: Record<string, unknown>) =>
      actOnElement({
        refs,
        generation: 1,
        doc: document,
        win: window,
        args: { action: action as never },
      }),
  }
}

function setupFixture(html: string): void {
  document.body.innerHTML = html
}

describe('act on element', () => {
  it('click calls HTMLElement.click', () => {
    setupFixture('<button id="save">Save</button>')
    const { refs, act } = makeContext()
    const button = document.getElementById('save')!
    const spy = vi.spyOn(button, 'click')
    const ref = refs.capture(button, 1)
    act({ kind: 'click', ref })
    expect(spy).toHaveBeenCalledOnce()
  })

  it('type writes through the native setter and emits input/change for controlled fields', () => {
    setupFixture('<input id="name">')
    const { refs, act } = makeContext()
    const input = document.getElementById('name') as HTMLInputElement
    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))
    input.addEventListener('change', () => events.push('change'))
    const ref = refs.capture(input, 1)
    act({ kind: 'type', ref, text: 'hello' })
    expect(input.value).toBe('hello')
    expect(events).toEqual(['input', 'change'])
  })

  it('type with replace overwrites instead of appending', () => {
    setupFixture('<input id="name" value="old">')
    const { refs, act } = makeContext()
    const input = document.getElementById('name') as HTMLInputElement
    const ref = refs.capture(input, 1)
    act({ kind: 'type', ref, text: 'new', replace: true })
    expect(input.value).toBe('new')
  })

  it('select sets the selected value and emits input/change', () => {
    setupFixture('<select id="country"><option value="us">US</option><option value="de">DE</option></select>')
    const { refs, act } = makeContext()
    const select = document.getElementById('country') as HTMLSelectElement
    const events: string[] = []
    select.addEventListener('input', () => events.push('input'))
    select.addEventListener('change', () => events.push('change'))
    const ref = refs.capture(select, 1)
    act({ kind: 'select', ref, value: 'de' })
    expect(select.value).toBe('de')
    expect(events).toEqual(['input', 'change'])
  })

  it('focus moves document focus to the element', () => {
    setupFixture('<input id="name">')
    const { refs, act } = makeContext()
    const input = document.getElementById('name') as HTMLInputElement
    const ref = refs.capture(input, 1)
    act({ kind: 'focus', ref })
    expect(document.activeElement).toBe(input)
  })

  it('press dispatches a synthetic keyboard event with the key', () => {
    setupFixture('<input id="name">')
    const { refs, act } = makeContext()
    const input = document.getElementById('name') as HTMLInputElement
    input.focus()
    const keys: string[] = []
    document.addEventListener('keydown', (event: KeyboardEvent) => keys.push(event.key))
    const ref = refs.capture(input, 1)
    act({ kind: 'press', ref, key: 'Enter' })
    expect(keys).toContain('Enter')
  })

  it('scroll scrolls the element by the deltas', () => {
    setupFixture('<div id="box">x</div>')
    const { refs, act } = makeContext()
    const box = document.getElementById('box')!
    const spy = vi.fn()
    ;(Element.prototype as unknown as { scrollBy: typeof spy }).scrollBy = spy
    const ref = refs.capture(box, 1)
    act({ kind: 'scroll', ref, deltaX: 10, deltaY: 20 })
    expect(spy).toHaveBeenCalledWith(10, 20)
  })

  it('hover emits pointer/mouse events and discloses its synthetic nature', () => {
    setupFixture('<button id="save">Save</button>')
    const { refs, act } = makeContext()
    const button = document.getElementById('save')!
    const events: string[] = []
    for (const type of ['pointerenter', 'pointerover', 'pointermove', 'mouseenter', 'mouseover', 'mousemove']) {
      button.addEventListener(type, () => events.push(type))
    }
    const ref = refs.capture(button, 1)
    const result = act({ kind: 'hover', ref }) as { synthetic: boolean; cssPseudoState: boolean }
    expect(events).toEqual(['pointerenter', 'pointerover', 'pointermove', 'mouseenter', 'mouseover', 'mousemove'])
    expect(result).toMatchObject({ synthetic: true, cssPseudoState: false })
  })

  it('rejects operations that demand trusted input', () => {
    setupFixture('<button id="save">Save</button>')
    const { refs, act } = makeContext()
    const button = document.getElementById('save')!
    const ref = refs.capture(button, 1)
    expect(() => act({ kind: 'click', ref, requireTrusted: true })).toThrowError(/unsupported_operation/)
  })

  it('returns stale_element for disconnected references', () => {
    setupFixture('<button id="gone">Gone</button>')
    const { refs, act } = makeContext()
    const button = document.getElementById('gone')!
    const ref = refs.capture(button, 1)
    document.body.removeChild(button)
    expect(() => act({ kind: 'click', ref })).toThrowError(/stale_element/)
  })
})
