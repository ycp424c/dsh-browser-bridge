/**
 * `browser_inspect`: attributes, text, computed style, geometry, and
 * visibility for a referenced element or a selector under the main document.
 */
import { bridgeError, type ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from './session-manager.ts'

export interface InspectResult {
  ref?: ElementRef
  selector?: string
  attributes: Record<string, string>
  text: string
  rect: { x: number; y: number; width: number; height: number }
  visible: boolean
  computedStyle: Record<string, string>
  generation: number
}

export interface InspectArgs {
  ref?: string
  selector?: string
  properties?: string[]
}

const DEFAULT_STYLE_PATTERNS = [
  'display', 'position', 'color', 'background-color',
  'font', /^font-/, 'margin', /^margin-/, 'padding', /^padding-/,
  'border', /^border-/, 'width', 'height', 'opacity', 'visibility',
  'overflow', 'z-index', /^align-/, /^justify-/, 'gap',
]

function matchesDefaultSet(name: string): boolean {
  return DEFAULT_STYLE_PATTERNS.some(pattern =>
    typeof pattern === 'string' ? pattern === name : pattern.test(name))
}

/** Resolve a ref or selector to a frontend node id (shared with actions). */
export async function resolveNode(session: TabSession, args: { ref?: string; selector?: string }): Promise<number> {
  if (args.ref !== undefined) {
    const record = session.refs.resolve(args.ref, session.generation)
    const pushed = await session.send('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [record.backendNodeId],
    })
    const nodeIds = (pushed as { nodeIds?: number[] }).nodeIds ?? []
    const nodeId = nodeIds[0]
    if (nodeId === undefined || nodeId === 0) {
      throw bridgeError('stale_element', 'element reference could not be resolved', false)
    }
    return nodeId
  }
  if (args.selector !== undefined) {
    const document = await session.send('DOM.getDocument', { depth: -1, pierce: true })
    const rootId = (document as { root?: { nodeId?: number } }).root?.nodeId
    if (rootId === undefined) {
      throw bridgeError('internal', 'inspect: could not resolve the document root', false)
    }
    const found = await session.send('DOM.querySelector', { nodeId: rootId, selector: args.selector })
    const nodeId = (found as { nodeId?: number }).nodeId
    if (nodeId === undefined || nodeId === 0) {
      throw bridgeError('stale_element', `selector matched no element: ${args.selector}`, false)
    }
    return nodeId
  }
  throw bridgeError('stale_element', 'inspect requires ref or selector', false)
}

const CALL_FUNCTION = `function () {
  const rect = this.getBoundingClientRect()
  const style = getComputedStyle(this)
  const attributes = {}
  for (const attr of this.attributes) attributes[attr.name] = attr.value
  return {
    attributes,
    text: this.textContent ?? '',
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    viewportIntersects: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
  }
}`

export async function inspectElement(session: TabSession, args: InspectArgs): Promise<InspectResult> {
  const nodeId = await resolveNode(session, args)

  const styleResponse = await session.send('CSS.getComputedStyleForNode', {
    nodeId,
    ...(args.properties !== undefined && args.properties.length > 0
      ? { propertyNames: args.properties }
      : {}),
  })
  const computedPairs = (styleResponse as { computedStyle?: Array<{ name: string; value: string }> }).computedStyle ?? []
  const computedStyle: Record<string, string> = {}
  for (const pair of computedPairs) {
    if (args.properties !== undefined && args.properties.length > 0) {
      if (args.properties.includes(pair.name)) computedStyle[pair.name] = pair.value
    } else if (matchesDefaultSet(pair.name)) {
      computedStyle[pair.name] = pair.value
    }
  }

  const resolved = await session.send('DOM.resolveNode', { nodeId })
  const objectId = (resolved as { object?: { objectId?: string } }).object?.objectId
  if (objectId === undefined) {
    throw bridgeError('stale_element', 'element could not be resolved for inspection', false)
  }
  const callResult = await session.send('Runtime.callFunctionOn', {
    functionDeclaration: CALL_FUNCTION,
    objectId,
    returnByValue: true,
  })
  const value = (callResult as { result?: { value?: {
    attributes: Record<string, string>
    text: string
    rect: { x: number; y: number; width: number; height: number }
    display: string
    visibility: string
    opacity: string
    viewportIntersects: boolean
  } } }).result?.value
  if (value === undefined) {
    throw bridgeError('internal', 'inspect: element evaluation returned no value', false)
  }

  // CSS.getComputedStyleForNode returns longhands for shorthands such as
  // `padding`; resolve any requested name CDP did not provide through the
  // page's own getComputedStyle so shorthand requests work as documented.
  const requested = args.properties ?? []
  const missing = requested.filter(name => computedStyle[name] === undefined)
  if (missing.length > 0) {
    const fillResult = await session.send('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function (names) {
        const style = getComputedStyle(this)
        const out = {}
        for (const name of names) out[name] = style[name] ?? ''
        return out
      }`,
      arguments: [{ value: missing }],
    })
    const fill = (fillResult as { result?: { value?: Record<string, string> } }).result?.value
    for (const name of missing) {
      const value = fill?.[name]
      if (value !== undefined && value !== '') computedStyle[name] = value
    }
  }

  const visible = value.display !== 'none'
    && value.visibility !== 'hidden'
    && value.visibility !== 'collapse'
    && Number(value.opacity) > 0
    && value.rect.width > 0
    && value.rect.height > 0
    && value.viewportIntersects

  return {
    ...(args.ref !== undefined ? { ref: args.ref as ElementRef } : {}),
    ...(args.selector !== undefined ? { selector: args.selector } : {}),
    attributes: value.attributes,
    text: value.text,
    rect: value.rect,
    visible,
    computedStyle,
    generation: session.generation,
  }
}
