/**
 * `browser_observe`: semantic page observation through the accessibility
 * tree with short-lived element references. Password and secret values are
 * never returned; output is bounded by node and character caps.
 */
import { bridgeError, type ElementRef } from '@dsh-external/dsh-browser-bridge-protocol'
import type { TabSession } from './session-manager.ts'

export interface ObserveResult {
  page: { url: string; title: string; readyState: string; generation: number }
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  text: string
  nodes: Array<{
    ref: ElementRef
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

const SENSITIVE_PATTERN = /password|passwd|secret|token|card|cvv|pin|api[-_]?key/i

function roleOf(node: AxNode): string {
  return node.role?.value ?? 'generic'
}

function textOf(node: AxNode): string {
  const parts = [node.name?.value, node.description?.value]
  // Sensitive inputs (password fields etc.) never contribute their value.
  if (!isSensitive(node)) parts.push(node.value?.value)
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' ')
}

function isSensitive(node: AxNode): boolean {
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
  maxNodes: number,
  maxChars: number,
): { nodes: ObserveResult['nodes']; text: string; droppedNodes: number; droppedChars: number } {
  const nodes: ObserveResult['nodes'] = []
  const textParts: string[] = []
  let droppedNodes = 0
  let droppedChars = 0
  let textLength = 0
  const visit = (node: AxNode): void => {
    if (node.ignored) return
    const role = roleOf(node)
    const text = textOf(node)
    const meaningful = text !== '' || INTERACTIVE_ROLES.has(role)
    if (meaningful) {
      const separatorCost = textParts.length > 0 ? 1 : 0
      const remaining = maxChars - textLength - separatorCost
      if (remaining > 0) {
        textParts.push(text.slice(0, remaining))
        textLength += separatorCost + Math.min(text.length, remaining)
        if (text.length > remaining) droppedChars += text.length - remaining
      } else {
        droppedChars += text.length
      }
    }
    const interactive = INTERACTIVE_ROLES.has(role) || text !== ''
    if (interactive && nodes.length < maxNodes) {
      const record: ObserveResult['nodes'][number] = {
        ref: refs.register(node.backendDOMNodeId ?? -1, node.frameId ?? 'main', generation),
        role,
        name: node.name?.value ?? '',
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
    } else if (interactive) {
      droppedNodes += 1
    }
    for (const childId of node.childIds ?? []) {
      const child = root.childById?.get(childId)
      if (child !== undefined) visit(child)
    }
  }
  visit(root)
  return { nodes, text: textParts.join(' '), droppedNodes, droppedChars }
}

export async function observePage(session: TabSession, args: ObserveArgs = {}): Promise<ObserveResult> {
  const maxNodes = args.maxNodes ?? 100
  const maxChars = args.maxChars ?? 20_000
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
  const collected = collectNodes(root, session.refs, session.generation, maxNodes, maxChars)
  return {
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
    text: collected.text,
    nodes: collected.nodes,
    truncated: { textChars: collected.droppedChars, nodes: collected.droppedNodes },
  }
}
