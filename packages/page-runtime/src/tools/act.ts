/**
 * Reliable action semantics: click via `HTMLElement.click`, type via the
 * prototype-native value setter plus input/change events (React/Vue
 * controlled fields), select, focus, synthetic key press, scroll, and a
 * synthetic hover disclosure. Any operation that demands trusted input
 * (`requireTrusted`) fails with unsupported_operation: page JavaScript can
 * never produce `isTrusted === true` input.
 */
import { bridgeFailure } from './dispatcher.ts'
import type { ElementRegistry } from '../refs/registry.ts'

export interface ActArgs {
  action: {
    kind: 'click' | 'type' | 'select' | 'hover' | 'focus' | 'press' | 'scroll'
    ref?: string
    selector?: string
    text?: string
    replace?: boolean
    value?: string
    key?: string
    deltaX?: number
    deltaY?: number
    /** Trusted input is impossible from page JavaScript. */
    requireTrusted?: boolean
  }
}

export interface ActContext {
  refs: ElementRegistry
  generation: number
  args: ActArgs
  doc?: Document
  win?: Window
}

function resolveTarget(ctx: ActContext): HTMLElement {
  const doc = ctx.doc ?? document
  const { ref, selector } = ctx.args.action
  if ((ref === undefined) === (selector === undefined)) {
    bridgeFailure('internal', 'act requires exactly one of ref or selector')
  }
  let element: Element
  if (ref !== undefined) {
    element = ctx.refs.resolve(ref, ctx.generation)
  } else {
    const found = doc.querySelector(selector!)
    if (found === null) {
      bridgeFailure('stale_element', 'selector did not match any element')
    }
    element = found
  }
  if (element.ownerDocument !== doc) {
    bridgeFailure('permission_denied', 'element belongs to another document')
  }
  return element as HTMLElement
}

/** The prototype-native value setter: drives React/Vue controlled inputs. */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set !== undefined) {
    descriptor.set.call(element, value)
  } else {
    element.value = value
  }
}

function emitChange(element: Element): void {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

export function actOnElement(ctx: ActContext): Record<string, unknown> {
  const win = ctx.win ?? window
  const action = ctx.args.action
  if (action.requireTrusted === true) {
    bridgeFailure('unsupported_operation', 'trusted input cannot be synthesized from page JavaScript')
  }
  const element = resolveTarget(ctx)

  switch (action.kind) {
    case 'click':
      element.click()
      return { ok: true, action: 'click' }
    case 'type': {
      if (typeof action.text !== 'string') {
        bridgeFailure('internal', 'type requires text')
      }
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        bridgeFailure('unsupported_operation', 'type target is not a text field')
      }
      const current = element.value
      const next = action.replace === true ? action.text : current + action.text
      setNativeValue(element, next)
      emitChange(element)
      return { ok: true, action: 'type', value: element.value }
    }
    case 'select': {
      if (!(element instanceof HTMLSelectElement)) {
        bridgeFailure('unsupported_operation', 'select target is not a select element')
      }
      if (typeof action.value !== 'string') {
        bridgeFailure('internal', 'select requires value')
      }
      setNativeValue(element, action.value)
      emitChange(element)
      return { ok: true, action: 'select', value: element.value }
    }
    case 'focus':
      element.focus()
      return { ok: true, action: 'focus' }
    case 'press': {
      if (typeof action.key !== 'string') {
        bridgeFailure('internal', 'press requires key')
      }
      const target = document.activeElement ?? element
      target.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true, composed: true }))
      target.dispatchEvent(new KeyboardEvent('keyup', { key: action.key, bubbles: true, composed: true }))
      return { ok: true, action: 'press', key: action.key }
    }
    case 'scroll': {
      const deltaX = action.deltaX ?? 0
      const deltaY = action.deltaY ?? 0
      const scroller = element as Element & { scrollBy?: (x: number, y: number) => void }
      if (typeof scroller.scrollBy === 'function') {
        scroller.scrollBy(deltaX, deltaY)
      } else if (typeof win.scrollBy === 'function') {
        win.scrollBy(deltaX, deltaY)
      }
      return { ok: true, action: 'scroll', deltaX, deltaY }
    }
    case 'hover': {
      // Synthetic pointer/mouse events only: the browser CSS :hover state is
      // never forced, and the result discloses exactly that.
      for (const type of ['pointerenter', 'pointerover', 'pointermove', 'mouseenter', 'mouseover', 'mousemove']) {
        element.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }))
      }
      return { ok: true, action: 'hover', synthetic: true, cssPseudoState: false }
    }
    default:
      bridgeFailure('unsupported_operation', `unsupported action ${action.kind}`)
  }
}
