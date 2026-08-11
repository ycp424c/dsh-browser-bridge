/**
 * Element inspection with an explicit property allowlist: resolves either a
 * reference or a selector (never both, never neither), returns bounded
 * attributes, text, selected computed styles, geometry, and visibility, and
 * masks sensitive values. Selectors never reach outside the main document.
 */
import { boundField, isSensitiveAttribute, isSensitiveField, maskSensitiveValue, maskText } from './sanitize.ts'
import { bridgeFailure } from './dispatcher.ts'
import type { ElementRegistry } from '../refs/registry.ts'

export interface InspectArgs {
  ref?: string
  selector?: string
  properties?: string[]
}

export interface InspectResult {
  tag: string
  id?: string
  attributes: Array<{ name: string; value: string }>
  text: string
  computedStyle: Record<string, string>
  rect: { x: number; y: number; width: number; height: number }
  visible: boolean
}

export interface InspectContext {
  refs: ElementRegistry
  generation: number
  args: InspectArgs
  doc?: Document
  win?: Window
}

/** Computed CSS properties the page is allowed to return. */
export const COMPUTED_STYLE_ALLOWLIST = [
  'color', 'backgroundColor', 'display', 'visibility', 'opacity', 'position', 'zIndex',
  'width', 'height', 'margin', 'padding', 'border', 'fontSize', 'fontFamily', 'fontWeight',
  'lineHeight', 'textAlign', 'overflow', 'cursor', 'pointerEvents', 'transform',
] as const

/** CSSOM getPropertyValue only accepts kebab-case property names. */
function toKebabCase(name: string): string {
  return name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

export function inspectElement(ctx: InspectContext): InspectResult {
  const doc = ctx.doc ?? document
  const win = ctx.win ?? window
  const { ref, selector, properties } = ctx.args
  if ((ref === undefined) === (selector === undefined)) {
    bridgeFailure('internal', 'inspect requires exactly one of ref or selector')
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
  // The main-document boundary: an element inside an iframe is unreachable
  // through this document and is never followed.
  if (element.ownerDocument !== doc) {
    bridgeFailure('permission_denied', 'element belongs to another document')
  }

  const attributes: Array<{ name: string; value: string }> = []
  for (const attribute of element.attributes) {
    const name = attribute.name
    const sensitive = isSensitiveAttribute(name)
      || (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
        && isSensitiveField(element) && name === 'value'
    attributes.push({
      name: boundField(name),
      value: sensitive ? '[REDACTED]' : boundField(attribute.value),
    })
  }

  const requested = new Set(properties ?? [])
  const computedStyle: Record<string, string> = {}
  for (const name of COMPUTED_STYLE_ALLOWLIST) {
    if (!requested.has(name)) continue
    computedStyle[name] = boundField(win.getComputedStyle(element).getPropertyValue(toKebabCase(name)))
  }

  const rect = element.getBoundingClientRect()
  const style = win.getComputedStyle(element)
  const visible = element.getAttribute('aria-hidden') !== 'true'
    && !(element instanceof HTMLElement && element.hidden)
    && style.display !== 'none'
    && style.visibility !== 'hidden'

  return {
    tag: element.tagName.toLowerCase(),
    ...(element.id !== '' ? { id: boundField(element.id) } : {}),
    attributes,
    text: boundField(maskText(element.textContent ?? '')),
    computedStyle,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    visible,
  }
}
