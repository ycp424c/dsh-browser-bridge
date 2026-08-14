/**
 * `browser_observe`: semantic page observation through the accessibility
 * tree with short-lived element references. Password and secret values are
 * never returned; output is bounded by node and character caps.
 *
 * Output is deliberately compact: InlineTextBox nodes are dropped entirely,
 * StaticText that merely duplicates an enclosing interactive node's name is
 * filtered, and the joined `text` digest is opt-in (`text: true`) and derived
 * from the emitted nodes — the default result carries only the deduplicated
 * node list, so history no longer holds two copies of the same page text.
 */
import { bridgeError, type ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from './session-manager.ts'
import { SENSITIVE_PATTERN } from './sensitive.ts'

export interface ObserveResult {
  page: { url: string; title: string; readyState: string; generation: number }
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  /** Joined digest of the emitted nodes' accessible names; only with text:true. */
  text?: string
  nodes: Array<{
    ref?: ElementRef
    role: string
    name: string
    value?: string
    disabled?: boolean
    checked?: boolean
  }>
  truncated: { textChars: number; nodes: number }
}

export interface ObserveArgs {
  maxNodes?: number
  maxChars?: number
  /** Include a joined text digest derived from the emitted nodes. */
  text?: boolean
  /** Lower the default output budget for minimal contexts. */
  compact?: boolean
}

/** AX node shape from `Accessibility.getFullAXTree`. */
interface AxNode {
  nodeId: string
  ignored: boolean
  role?: { value: string }
  name?: { value: string }
  description?: { value: string }
  value?: { value: string }
  properties?: Array<{ name: string; value: { value?: unknown } }>
  childIds?: string[]
  backendDOMNodeId?: number
  frameId?: string
  /** Node-id index installed for the traversal. */
  childById?: Map<string, AxNode>
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'heading', 'checkbox', 'radio', 'combobox', 'textbox', 'searchbox',
  'menuitem', 'switch', 'slider', 'tab', 'listbox', 'option', 'treeitem', 'spinbutton',
  'meter', 'progressbar', 'dialog', 'alert', 'alertdialog',
])

/** Roles that only repeat a parent's text and are never useful on their own. */
const REDUNDANT_TEXT_ROLES = new Set(['InlineTextBox'])

/** Default node budget; compact mode halves it for minimal contexts. */
const DEFAULT_MAX_NODES = 100
const COMPACT_MAX_NODES = 40
const DEFAULT_MAX_CHARS = 8_000

function roleOf(node: AxNode): string {
  return node.role?.value ?? 'generic'
}

function textOf(node: AxNode): string {
  // Only the accessible name feeds the digest: description/value content is
  // already carried by the node records and would duplicate them.
  return node.name?.value ?? ''
}

function isSensitive(node: AxNode): boolean {
  // Shared with inspect/act so every tool masks the same field vocabulary.
  return SENSITIVE_PATTERN.test(`${node.name?.value ?? ''} ${node.role?.value ?? ''}`)
}

function propertyFlag(node: AxNode, name: string): boolean | undefined {
  const property = node.properties?.find(candidate => candidate.name === name)
  return property === undefined ? undefined : property.value.value === true
}

/** Walk the tree in document order and collect the bounded output. */
function collectNodes(
  root: AxNode,
  refs: TabSession['refs'],
  generation: number,
  options: { maxNodes: number; maxChars: number; includeText: boolean },
): { nodes: ObserveResult['nodes']; text: string | undefined; droppedNodes: number; droppedChars: number } {
  const nodes: ObserveResult['nodes'] = []
  const textParts: string[] = []
  let droppedNodes = 0
  let droppedChars = 0
  let textLength = 0
  /** Accessible names of enclosing interactive nodes (StaticText dedupe). */
  const ancestorNames: string[] = []

  const visit = (node: AxNode): void => {
    const role = roleOf(node)
    const text = textOf(node)
    // Redundant text roles (InlineTextBox) are never emitted or digested.
    const redundant = REDUNDANT_TEXT_ROLES.has(role)
    // StaticText that only repeats an enclosing interactive node's name is
    // pure duplication of the node list.
    const duplicatedStaticText = role === 'StaticText' && text !== '' && ancestorNames.includes(text)
    const meaningful = !node.ignored && !redundant && ((text !== '' && !duplicatedStaticText) || INTERACTIVE_ROLES.has(role))
    if (meaningful && nodes.length < options.maxNodes) {
      // The digest is derived strictly from EMITTED nodes: a node dropped by
      // the node cap contributes neither text nor truncated characters, so
      // truncated.textChars only counts maxChars cuts inside emitted nodes.
      if (options.includeText) {
        const separatorCost = textParts.length > 0 ? 1 : 0
        const remaining = options.maxChars - textLength - separatorCost
        if (remaining > 0) {
          textParts.push(text.slice(0, remaining))
          textLength += separatorCost + Math.min(text.length, remaining)
          if (text.length > remaining) droppedChars += text.length - remaining
        } else {
          droppedChars += text.length
        }
      }
      const record: ObserveResult['nodes'][number] = {
        role,
        name: node.name?.value ?? '',
      }
      // Only a valid positive backend DOM id can back a resolvable ref;
      // synthetic AX nodes without one stay semantic context only.
      const backendDOMNodeId = node.backendDOMNodeId
      if (backendDOMNodeId !== undefined && Number.isInteger(backendDOMNodeId) && backendDOMNodeId > 0) {
        record.ref = refs.register(backendDOMNodeId, node.frameId ?? 'main', generation)
      }
      const value = node.value?.value
      if (value !== undefined && value !== '' && !isSensitive(node)) {
        record.value = value
      }
      const disabled = propertyFlag(node, 'disabled')
      if (disabled !== undefined) record.disabled = disabled
      const checked = propertyFlag(node, 'checked')
      if (checked !== undefined) record.checked = checked
      nodes.push(record)
    } else if (meaningful) {
      droppedNodes += 1
    }
    // Track enclosing interactive names for StaticText dedupe.
    if (INTERACTIVE_ROLES.has(role) && text !== '') ancestorNames.push(text)
    for (const childId of node.childIds ?? []) {
      const child = root.childById?.get(childId)
      if (child !== undefined) visit(child)
    }
    if (INTERACTIVE_ROLES.has(role) && text !== '') ancestorNames.pop()
  }
  visit(root)
  const text = options.includeText ? textParts.join(' ') : undefined
  return { nodes, text, droppedNodes, droppedChars }
}

export async function observePage(session: TabSession, args: ObserveArgs = {}): Promise<ObserveResult> {
  const compact = args.compact === true
  const includeText = args.text === true && !compact
  const maxNodes = args.maxNodes ?? (compact ? COMPACT_MAX_NODES : DEFAULT_MAX_NODES)
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS
  const evaluate = await session.send('Runtime.evaluate', {
    expression: `({ url: location.href, title: document.title, readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY } })`,
    returnByValue: true,
  })
  const pageInfo = (evaluate as { result?: { value?: { url?: string; title?: string; readyState?: string; viewport?: { width?: number; height?: number; scrollX?: number; scrollY?: number } } } }).result?.value
  if (pageInfo === undefined) {
    throw bridgeError('internal', 'observe: page identity evaluate returned no value', false)
  }
  const tree = await session.send('Accessibility.getFullAXTree', {})
  const axNodes = (tree as { nodes?: AxNode[] }).nodes ?? []
  const byId = new Map(axNodes.map(node => [node.nodeId, node]))
  const root = axNodes.find(node => node.nodeId === '1') ?? axNodes[0]
  if (root === undefined) {
    throw bridgeError('internal', 'observe: accessibility tree is empty', false)
  }
  ;(root as AxNode & { childById?: Map<string, AxNode> }).childById = byId
  const collected = collectNodes(root, session.refs, session.generation, { maxNodes, maxChars, includeText })
  const result: ObserveResult = {
    page: {
      url: pageInfo.url ?? '',
      title: pageInfo.title ?? '',
      readyState: pageInfo.readyState ?? '',
      generation: session.generation,
    },
    viewport: {
      width: pageInfo.viewport?.width ?? 0,
      height: pageInfo.viewport?.height ?? 0,
      scrollX: pageInfo.viewport?.scrollX ?? 0,
      scrollY: pageInfo.viewport?.scrollY ?? 0,
    },
    nodes: collected.nodes,
    truncated: { textChars: collected.droppedChars, nodes: collected.droppedNodes },
  }
  if (collected.text !== undefined) result.text = collected.text
  return result
}
