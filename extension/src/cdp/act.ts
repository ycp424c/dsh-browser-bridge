/**
 * `browser_act`: structured interaction over CDP — click, type, select,
 * hover, focus, press, and scroll. Every write checks `writeSuspended`
 * immediately before dispatch so a cross-origin race cannot write after
 * validation, and clicks arm an expected-navigation window.
 */
import { bridgeError } from '@dsh-external/dsh-browser-bridge-protocol'
import type { TabSession } from './session-manager.ts'
import { resolveNode } from './inspect.ts'

export interface ActResult {
  ok: true
  url: string
  generation: number
}

export type ActAction =
  | { kind: 'click'; ref?: string; selector?: string; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { kind: 'type'; ref?: string; selector?: string; text: string; replace?: boolean }
  | { kind: 'select'; ref?: string; selector?: string; value: string }
  | { kind: 'hover'; ref?: string; selector?: string }
  | { kind: 'focus'; ref?: string; selector?: string }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; ref?: string; selector?: string; deltaX?: number; deltaY?: number }

type Target = string | { ref?: string; selector?: string }

function normalizeTarget(target: Target): { ref?: string; selector?: string } {
  return typeof target === 'string' ? { ref: target } : target
}

function assertWritable(session: TabSession): void {
  if (session.writeSuspended) {
    throw bridgeError(
      'navigation_requires_confirmation',
      'the page navigated to an unexpected origin; attach the new page explicitly in a new prompt',
      false,
    )
  }
}

async function boxCenter(session: TabSession, nodeId: number): Promise<{ x: number; y: number }> {
  const box = await session.send('DOM.getBoxModel', { nodeId })
  const content = (box as { model?: { content?: number[] } }).model?.content
  if (content === undefined || content.length < 8) {
    throw bridgeError('stale_element', 'element has no layout box', false)
  }
  const xs = [content[0]!, content[2]!, content[4]!, content[6]!]
  const ys = [content[1]!, content[3]!, content[5]!, content[7]!]
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  }
}

async function resultOf(session: TabSession): Promise<ActResult> {
  return { ok: true, url: session.currentUrl, generation: session.generation }
}

async function click(session: TabSession, target: Target, options: { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}): Promise<ActResult> {
  assertWritable(session)
  const nodeId = await resolveNode(session, normalizeTarget(target))
  const center = await boxCenter(session, nodeId)
  session.expectNavigation(5_000)
  const button = options.button === 'right' ? 2 : options.button === 'middle' ? 1 : 0
  const clickCount = options.clickCount ?? 1
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: center.x, y: center.y, button, clickCount,
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: center.x, y: center.y, button, clickCount,
  })
  return resultOf(session)
}

async function hover(session: TabSession, target: Target): Promise<ActResult> {
  assertWritable(session)
  const nodeId = await resolveNode(session, normalizeTarget(target))
  const center = await boxCenter(session, nodeId)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: center.x, y: center.y,
  })
  return resultOf(session)
}

async function focus(session: TabSession, target: Target): Promise<ActResult> {
  assertWritable(session)
  const nodeId = await resolveNode(session, normalizeTarget(target))
  await session.send('DOM.focus', { nodeId })
  return resultOf(session)
}

async function typeText(
  session: TabSession,
  action: { ref?: string; selector?: string; text: string; replace?: boolean },
): Promise<ActResult> {
  assertWritable(session)
  const nodeId = await resolveNode(session, normalizeTarget(action))
  if (action.replace === true) {
    // Platform select-all then Backspace, then insert the replacement text.
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  } else {
    await session.send('DOM.focus', { nodeId })
  }
  await session.send('Input.insertText', { text: action.text })
  return resultOf(session)
}

async function select(
  session: TabSession,
  action: { ref?: string; selector?: string; value: string },
): Promise<ActResult> {
  assertWritable(session)
  const nodeId = await resolveNode(session, normalizeTarget(action))
  const resolved = await session.send('DOM.resolveNode', { nodeId })
  const objectId = (resolved as { object?: { objectId?: string } }).object?.objectId
  if (objectId === undefined) {
    throw bridgeError('stale_element', 'select target could not be resolved', false)
  }
  const value = JSON.stringify(action.value)
  await session.send('Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    functionDeclaration: `function (value) {
      const option = Array.from(this.options).find(o => o.value === value)
      if (option === undefined) return false
      option.selected = true
      this.dispatchEvent(new Event('input', { bubbles: true }))
      this.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }`,
    arguments: [{ value: JSON.parse(value) }],
  })
  return resultOf(session)
}

async function press(session: TabSession, key: string): Promise<ActResult> {
  assertWritable(session)
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key })
  return resultOf(session)
}

async function scroll(
  session: TabSession,
  target: { ref?: string; selector?: string },
  options: { deltaX?: number; deltaY?: number },
): Promise<ActResult> {
  assertWritable(session)
  let x = 0
  let y = 0
  const normalized = normalizeTarget(target)
  if (normalized.ref !== undefined || normalized.selector !== undefined) {
    const nodeId = await resolveNode(session, normalized)
    const center = await boxCenter(session, nodeId)
    x = center.x
    y = center.y
  }
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: options.deltaX ?? 0, deltaY: options.deltaY ?? 0,
  })
  return resultOf(session)
}

function targetOf(action: { ref?: string; selector?: string }): { ref?: string; selector?: string } {
  return action.ref !== undefined
    ? { ref: action.ref }
    : action.selector !== undefined
      ? { selector: action.selector }
      : {}
}

export async function performAction(session: TabSession, action: ActAction): Promise<ActResult> {
  switch (action.kind) {
    case 'click':
      return click(session, targetOf(action), {
        ...(action.button !== undefined ? { button: action.button } : {}),
        ...(action.clickCount !== undefined ? { clickCount: action.clickCount } : {}),
      })
    case 'type':
      return typeText(session, {
        ...targetOf(action),
        text: action.text,
        ...(action.replace !== undefined ? { replace: action.replace } : {}),
      })
    case 'select':
      return select(session, { ...targetOf(action), value: action.value })
    case 'hover':
      return hover(session, targetOf(action))
    case 'focus':
      return focus(session, targetOf(action))
    case 'press':
      return press(session, action.key)
    case 'scroll':
      return scroll(session, targetOf(action), {
        ...(action.deltaX !== undefined ? { deltaX: action.deltaX } : {}),
        ...(action.deltaY !== undefined ? { deltaY: action.deltaY } : {}),
      })
    default:
      throw bridgeError('internal', `unknown action ${JSON.stringify(action)}`, false)
  }
}

export { click, hover, focus, typeText, select, press, scroll }
