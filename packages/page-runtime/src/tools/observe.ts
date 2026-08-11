/**
 * Bounded semantic DOM projection: walks the main document in document
 * order, derives role/name from native semantics and ARIA, emits
 * short-lived references only for actionable or meaningful elements, masks
 * sensitive values, and returns page identity, viewport, text, nodes,
 * generation, and truncation counts. Every string field is bounded before
 * serialization.
 */
import { boundField, isSensitiveField, maskSensitiveValue, maskText } from './sanitize.ts'
import type { ElementRegistry } from '../refs/registry.ts'

export interface ObserveNode {
  ref: string
  role: string
  name: string
  tag: string
  /** Current value of textbox/combobox fields (masked when sensitive). */
  value?: string
}

export interface ObserveResult {
  page: { url: string; title: string }
  viewport: { width: number; height: number }
  text: string
  nodes: ObserveNode[]
  generation: number
  truncated: { nodes?: boolean; text?: boolean }
}

export interface ObserveContext {
  refs: ElementRegistry
  generation: number
  /** Cap on returned element nodes (default 100, accepted max 500). */
  maxNodes?: number | undefined
  /** Cap on returned text characters (default 20_000, accepted max 100_000). */
  maxChars?: number | undefined
  doc?: Document
  win?: Window
}

export const DEFAULT_MAX_NODES = 100
export const MAX_NODES_LIMIT = 500
export const DEFAULT_MAX_CHARS = 20_000
export const MAX_CHARS_LIMIT = 100_000

function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute('role')
  if (explicit !== null && explicit !== '') return explicit
  const tag = element.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'button') return 'button'
  if (tag === 'a' && element.hasAttribute('href')) return 'link'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'select') return 'combobox'
  if (tag === 'summary') return 'button'
  if (tag === 'input') {
    const type = (element as HTMLInputElement).type
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
    if (type === 'range') return 'slider'
    return 'textbox'
  }
  return undefined
}

function textOf(element: Element): string {
  return (element.textContent ?? '').trim()
}

function labelFor(element: Element, doc: Document): string | undefined {
  const id = element.getAttribute('id')
  if (id === null || id === '') return undefined
  for (const label of doc.querySelectorAll('label')) {
    if (label.getAttribute('for') === id) {
      const text = textOf(label)
      if (text !== '') return text
    }
  }
  return undefined
}

function nameOf(element: Element, doc: Document): string {
  const ariaLabel = element.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim()
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy !== null && labelledBy !== '') {
    const parts = labelledBy.split(/\s+/)
      .map(id => doc.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
      .map(node => textOf(node))
      .filter(text => text !== '')
    if (parts.length > 0) return parts.join(' ')
  }
  const title = element.getAttribute('title')
  if (title !== null && title.trim() !== '') return title.trim()
  const tag = element.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) {
    const text = textOf(element)
    if (text !== '') return text
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const label = labelFor(element, doc)
    if (label !== undefined) return label
    const placeholder = element.getAttribute('placeholder')
    if (placeholder !== null && placeholder.trim() !== '') return placeholder.trim()
  }
  if (tag === 'button' || tag === 'a' || tag === 'summary') {
    const text = textOf(element)
    if (text !== '') return text
  }
  return element.tagName.toLowerCase()
}

function isVisible(element: Element, win: Window): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return false
  if (element instanceof HTMLElement && element.hidden) return false
  if (element instanceof HTMLElement) {
    const style = win.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/** Visible text of the main document in document order, bounded. */
function collectVisibleText(doc: Document, win: Window, maxChars: number, masked: boolean): { text: string; truncated: boolean } {
  const parts: string[] = []
  let length = 0
  let truncated = false
  let done = false
  const visit = (element: Element): void => {
    if (done || !isVisible(element, win)) return
    let hasVisibleChildren = false
    for (const child of element.children) {
      if (isVisible(child, win)) {
        hasVisibleChildren = true
        visit(child)
      }
    }
    if (!hasVisibleChildren) {
      const text = (element.textContent ?? '').trim()
      if (text === '') return
      const bounded = boundField(masked ? maskText(text) : text)
      const separator = parts.length > 0 ? 1 : 0
      if (length + separator + bounded.length > maxChars) {
        if (maxChars - length - separator > 0) parts.push(bounded.slice(0, maxChars - length - separator))
        truncated = true
        done = true
        return
      }
      parts.push(bounded)
      length += separator + bounded.length
    }
  }
  for (const child of doc.body.children) visit(child)
  return { text: parts.join('\n'), truncated }
}

export function observeDocument(ctx: ObserveContext): ObserveResult {
  const doc = ctx.doc ?? document
  const win = ctx.win ?? window
  const maxNodes = Math.min(ctx.maxNodes ?? DEFAULT_MAX_NODES, MAX_NODES_LIMIT)
  const maxChars = Math.min(ctx.maxChars ?? DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT)
  const nodes: ObserveNode[] = []
  let truncatedNodes = false

  const visit = (element: Element): void => {
    if (!isVisible(element, win)) return
    const role = roleOf(element)
    if (role !== undefined && nodes.length < maxNodes) {
      let value: string | undefined
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        value = isSensitiveField(element) ? maskSensitiveValue(element) : boundField(element.value)
      }
      const node: ObserveNode = {
        ref: ctx.refs.capture(element, ctx.generation),
        role,
        name: boundField(nameOf(element, doc)),
        tag: element.tagName.toLowerCase(),
        ...(value !== undefined ? { value } : {}),
      }
      nodes.push(node)
    } else if (role !== undefined) {
      truncatedNodes = true
    }
    for (const child of element.children) visit(child)
  }
  for (const child of doc.body.children) visit(child)

  let pageUrl = win.location.href
  try {
    const parsed = new URL(pageUrl)
    parsed.search = ''
    parsed.hash = ''
    pageUrl = parsed.href
  } catch {
    // Keep the raw value; it is bounded below.
  }
  const { text, truncated: truncatedText } = collectVisibleText(doc, win, maxChars, true)

  return {
    page: { url: boundField(pageUrl), title: boundField(doc.title) },
    viewport: { width: win.innerWidth, height: win.innerHeight },
    text,
    nodes,
    generation: ctx.generation,
    truncated: {
      ...(truncatedNodes ? { nodes: true } : {}),
      ...(truncatedText ? { text: true } : {}),
    },
  }
}
