/**
 * `browser_act`: structured interaction over CDP — click, type, fill, select,
 * hover, focus, press, and scroll, plus a sequential `actions` batch and an
 * optional `expect` postcondition polled in the SAME call.
 *
 * Every write checks `writeSuspended` immediately before dispatch, clicks arm
 * an expected-navigation window, and every state-changing action reads its
 * post-state back so the model sees what actually happened:
 * - click reads checkbox/radio `checked` before and after;
 * - type/fill/select read the field value (masked for sensitive fields);
 * - a type whose text did not change the field fails with `input_not_applied`
 *   instead of a false ok:true;
 * - fill overwrites through the prototype-native value setter plus
 *   input/change events (text, textarea, select, datetime-local, ...).
 *
 * Target resolution is stable (backend id / page-side querySelector →
 * runtime object id) and pointer targeting falls back to scrollIntoView +
 * getBoundingClientRect, so clicks never depend on a stale frontend node id
 * or an unavailable box model.
 */
import { bridgeError, bridgeErrorSchema, type BridgeError } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from './session-manager.ts'
import { callOn, elementRect, withResolvedObject, type ResolvedTarget } from './resolve.ts'
import { isSensitiveField } from './sensitive.ts'
import { pollPostcondition, postconditionFailureMessage, type Postcondition } from './postcondition.ts'

export interface ActResult {
  ok: true
  action: ActAction['kind']
  target?: { ref?: string; selector?: string }
  url: string
  generation: number
  /** Whether the element's observable state changed (value or checked). */
  changed?: boolean
  /** Readback value for type/fill; ABSENT for sensitive fields. */
  value?: string
  /** True when the field is sensitive and its value was withheld. */
  masked?: boolean
  /** Readback checked state for toggle clicks. */
  checked?: boolean
  /** Readback selected values for select/fill on selects. */
  selectedValues?: string[]
  /** Whether post-state readback succeeded. */
  readback?: 'ok' | 'unavailable'
  postcondition?: { satisfied: boolean; attempts: number; elapsedMs: number }
}

export type ActAction =
  | { kind: 'click'; ref?: string; selector?: string; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { kind: 'type'; ref?: string; selector?: string; text: string; replace?: boolean }
  | { kind: 'fill'; ref?: string; selector?: string; value: string }
  | { kind: 'select'; ref?: string; selector?: string; value: string }
  | { kind: 'hover'; ref?: string; selector?: string }
  | { kind: 'focus'; ref?: string; selector?: string }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; ref?: string; selector?: string; deltaX?: number; deltaY?: number }

export interface ActArgs {
  action?: ActAction
  actions?: ActAction[]
  expect?: Postcondition
}

export interface ActOptions {
  postconditionTimeoutMs?: number
  postconditionPollMs?: number
  now?: () => number
}

export const MAX_BATCH_ACTIONS = 20
export const DEFAULT_POSTCONDITION_TIMEOUT_MS = 5_000

type Target = string | { ref?: string; selector?: string }

function normalizeTarget(target: Target): { ref?: string; selector?: string } {
  return typeof target === 'string' ? { ref: target } : target
}

function targetDescriptor(target: ResolvedTarget): { ref?: string; selector?: string } {
  return target.kind === 'ref' ? { ref: target.ref } : { selector: target.selector }
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

/** Normalize any thrown value into a stable bridge error (batch mode). */
function toBridgeError(error: unknown): BridgeError {
  const parsed = bridgeErrorSchema.safeParse(error)
  if (parsed.success) return parsed.data
  return bridgeError('internal', error instanceof Error ? error.message : String(error), false)
}

const TOGGLE_FUNCTION = `function () {
  if (this instanceof HTMLInputElement && (this.type === 'checkbox' || this.type === 'radio')) {
    return { toggle: true, checked: this.checked === true }
  }
  return { toggle: false }
}`

const FIELD_VALUE_FUNCTION = `function () {
  const isField = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement
  if (!isField) return { kind: 'other' }
  return {
    kind: 'field',
    value: this.value,
    type: this instanceof HTMLInputElement ? (this.type || '') : (this instanceof HTMLSelectElement ? 'select' : 'textarea'),
    name: this.getAttribute('name') ?? '',
    id: this.id ?? '',
    placeholder: this.getAttribute('placeholder') ?? '',
    autocomplete: this.getAttribute('autocomplete') ?? '',
    className: this.getAttribute('class') ?? '',
  }
}`

interface FieldValue {
  kind: 'field'
  value: string
  type: string
  name: string
  id: string
  placeholder: string
  autocomplete: string
  className: string
}

/** Viewport center of a resolved element with a bounded scroll fallback. */
async function pointerCenter(session: TabSession, objectId: string): Promise<{ x: number; y: number }> {
  try {
    let rect = await elementRect(session, objectId)
    if (!rect.visible) {
      // Bounded fallback: scroll the element into view once, then re-read.
      await callOn(session, objectId, `function () {
        this.scrollIntoView({ block: 'center', inline: 'center' })
        return true
      }`)
      rect = await elementRect(session, objectId)
    }
    if (!rect.visible || rect.width <= 0 || rect.height <= 0) {
      throw bridgeError('stale_element', 'element has no layout box', false)
    }
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  } catch (error) {
    const parsed = bridgeErrorSchema.safeParse(error)
    if (parsed.success) throw parsed.data
    throw bridgeError('stale_element', 'element could not be positioned for interaction', false)
  }
}

function fieldResult(
  action: ActAction['kind'],
  target: ResolvedTarget,
  session: TabSession,
  after: FieldValue | undefined,
  before?: FieldValue | undefined,
): ActResult {
  const base: ActResult = {
    ok: true,
    action,
    target: targetDescriptor(target),
    url: session.currentUrl,
    generation: session.generation,
  }
  if (after === undefined || after.kind !== 'field') {
    // contenteditable or non-field targets have no value readback.
    return { ...base, readback: 'unavailable' }
  }
  const sensitive = isSensitiveField(after)
  const result: ActResult = {
    ...base,
    readback: 'ok',
    ...(sensitive ? { masked: true } : { value: after.value }),
  }
  if (before !== undefined && before.kind === 'field') {
    result.changed = before.value !== after.value
  }
  return result
}

async function click(session: TabSession, target: Target, options: { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}): Promise<ActResult> {
  assertWritable(session)
  // The resolved runtime object id is released on every path once the click
  // and its readback are done.
  return withResolvedObject(session, normalizeTarget(target), async (objectId, resolved) => {
    const before = await callOn(session, objectId, TOGGLE_FUNCTION) as { toggle?: boolean; checked?: boolean } | undefined
    const center = await pointerCenter(session, objectId)
    session.expectNavigation(5_000)
    // CDP expects the MouseButton string enum, not a numeric code.
    const button = options.button === 'right' ? 'right' : options.button === 'middle' ? 'middle' : 'left'
    const clickCount = options.clickCount ?? 1
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: center.x, y: center.y, button, clickCount,
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: center.x, y: center.y, button, clickCount,
    })
    const base: ActResult = {
      ok: true,
      action: 'click',
      target: targetDescriptor(resolved),
      url: session.currentUrl,
      generation: session.generation,
    }
    if (before?.toggle === true) {
      try {
        const after = await callOn(session, objectId, TOGGLE_FUNCTION) as { checked?: boolean } | undefined
        if (after !== undefined && after.checked !== undefined) {
          return {
            ...base,
            checked: after.checked,
            changed: before.checked !== after.checked,
            readback: 'ok',
          }
        }
        return { ...base, readback: 'ok' }
      } catch {
        // The click replaced the element (for example a navigation); the state
        // could not be read back and no state claim is made.
        return { ...base, readback: 'unavailable' }
      }
    }
    return base
  })
}

async function hover(session: TabSession, target: Target): Promise<ActResult> {
  assertWritable(session)
  return withResolvedObject(session, normalizeTarget(target), async (objectId, resolved) => {
    const center = await pointerCenter(session, objectId)
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: center.x, y: center.y,
    })
    return {
      ok: true,
      action: 'hover',
      target: targetDescriptor(resolved),
      url: session.currentUrl,
      generation: session.generation,
    }
  })
}

async function focus(session: TabSession, target: Target): Promise<ActResult> {
  assertWritable(session)
  return withResolvedObject(session, normalizeTarget(target), async (objectId, resolved) => {
    await callOn(session, objectId, `function () { this.focus(); return true }`)
    return {
      ok: true,
      action: 'focus',
      target: targetDescriptor(resolved),
      url: session.currentUrl,
      generation: session.generation,
    }
  })
}

async function typeText(
  session: TabSession,
  action: { ref?: string; selector?: string; text: string; replace?: boolean },
): Promise<ActResult> {
  assertWritable(session)
  return withResolvedObject(session, normalizeTarget(action), async (objectId, resolved) => {
    const before = await callOn(session, objectId, FIELD_VALUE_FUNCTION) as FieldValue | undefined
    await callOn(session, objectId, `function () { this.focus(); return true }`)
    if (action.replace === true) {
      // Focus and select the existing text programmatically: synthesized
      // platform shortcut keys (Ctrl/Meta+A) do not reliably trigger the
      // browser's select-all keybinding, so the selection is set on the
      // element instead. A Backspace clears the selection, then insertText
      // replaces it.
      await callOn(session, objectId, `function () {
        if (typeof this.select === 'function') this.select()
        return true
      }`)
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    }
    await session.send('Input.insertText', { text: action.text })
    const after = await callOn(session, objectId, FIELD_VALUE_FUNCTION) as FieldValue | undefined
    if (after === undefined) {
      // The element detached mid-type; the write cannot be confirmed and no
      // value claim is made.
      throw bridgeError('stale_element', 'type target detached while typing', false)
    }
    if (before?.kind === 'field' && after.kind !== 'field') {
      // The element was replaced by a non-field while typing; the text went
      // into a detached element and is lost.
      throw bridgeError('stale_element', 'type target was replaced while typing', false)
    }
    if (
      action.text !== ''
      && before?.kind === 'field'
      && after.kind === 'field'
      && before.value === after.value
      && after.value !== expectedValue(action, before.value)
    ) {
      // insertText went through the input pipeline but the field value did not
      // change to what was asked (datetime-local and other segmented inputs
      // reject plain text; an idempotent replace that already holds is fine).
      // Fail visibly instead of reporting a false success.
      throw bridgeError(
        'input_not_applied',
        'typed text was not applied to the field (the input rejected the text); use fill to overwrite the value reliably',
        true,
      )
    }
    return fieldResult('type', resolved, session, after, before)
  })
}

/** The value a type action is expected to produce. */
function expectedValue(action: { text: string; replace?: boolean }, current: string): string {
  return action.replace === true ? action.text : current + action.text
}

const FILL_FUNCTION = `function (value) {
  const el = this
  const identity = () => ({
    type: el instanceof HTMLInputElement ? (el.type || '') : (el instanceof HTMLSelectElement ? 'select' : 'textarea'),
    name: el.getAttribute('name') ?? '',
    id: el.id ?? '',
    placeholder: el.getAttribute('placeholder') ?? '',
    autocomplete: el.getAttribute('autocomplete') ?? '',
    className: el.getAttribute('class') ?? '',
  })
  const setter = (proto, v) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    if (descriptor && descriptor.set) descriptor.set.call(el, v)
    else el.value = v
  }
  if (el instanceof HTMLSelectElement) {
    const option = Array.from(el.options).find(o => o.value === value || o.text === value)
    if (option === undefined) return { applied: false, reason: 'no-option' }
    // Always select by the option's own value: a text match must not feed
    // the raw label into the value setter (which would select nothing).
    setter(HTMLSelectElement.prototype, option.value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    const selectedValues = Array.from(el.selectedOptions).map(o => o.value)
    if (!selectedValues.includes(option.value)) return { applied: false, reason: 'rejected' }
    return { applied: true, value: el.value, selectedValues, ...identity() }
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    setter(proto, value)
    // A rejected assignment stays '' (datetime-local normalizes; invalid
    // values leave the field empty). The setter rejection is synchronous.
    if (value !== '' && el.value === '') return { applied: false, reason: 'rejected' }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    // Post-state readback AFTER the page's handlers ran: a controlled input
    // or sanitizer that reverts the value surfaces as a rejected fill.
    const final = el.value
    if (value !== '' && final === '') return { applied: false, reason: 'rejected' }
    return { applied: true, value: final, ...identity() }
  }
  return { applied: false, reason: 'not-a-field' }
}`

interface FillOutcome {
  applied: boolean
  reason?: string
  value?: string
  selectedValues?: string[]
  type?: string
  name?: string
  id?: string
  placeholder?: string
  autocomplete?: string
  className?: string
}

async function fill(
  session: TabSession,
  action: { ref?: string; selector?: string; value: string },
): Promise<ActResult> {
  assertWritable(session)
  return withResolvedObject(session, normalizeTarget(action), async (objectId, resolved) => {
    const result = await callOn(session, objectId, FILL_FUNCTION, [action.value]) as FillOutcome | undefined
    if (result === undefined) {
      throw bridgeError('stale_element', 'fill target detached while filling', false)
    }
    if (!result.applied) {
      if (result.reason === 'not-a-field') {
        throw bridgeError('unsupported_operation', 'fill target is not an input, textarea, or select', false)
      }
      if (result.reason === 'no-option') {
        throw bridgeError('invalid_value', 'select has no option matching the given value', false)
      }
      throw bridgeError('input_not_applied', 'fill value was rejected by the field (the page did not accept the value)', true)
    }
    const sensitive = isSensitiveField({
      type: result.type,
      name: result.name,
      id: result.id,
      placeholder: result.placeholder,
      autocomplete: result.autocomplete,
      className: result.className,
    })
    const base: ActResult = {
      ok: true,
      action: 'fill',
      target: targetDescriptor(resolved),
      url: session.currentUrl,
      generation: session.generation,
      changed: true,
      readback: 'ok',
    }
    if (sensitive) {
      base.masked = true
    } else {
      if (result.selectedValues !== undefined) base.selectedValues = result.selectedValues
      if (result.value !== undefined) base.value = result.value
    }
    return base
  })
}

const SELECT_FUNCTION = `function (value) {
  const option = Array.from(this.options).find(o => o.value === value)
  if (option === undefined) return { ok: false }
  option.selected = true
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return {
    ok: true,
    selectedValues: Array.from(this.selectedOptions).map(o => o.value),
    type: 'select',
    name: this.getAttribute('name') ?? '',
    id: this.id ?? '',
    placeholder: this.getAttribute('placeholder') ?? '',
    autocomplete: this.getAttribute('autocomplete') ?? '',
    className: this.getAttribute('class') ?? '',
  }
}`

async function select(
  session: TabSession,
  action: { ref?: string; selector?: string; value: string },
): Promise<ActResult> {
  assertWritable(session)
  return withResolvedObject(session, normalizeTarget(action), async (objectId, resolved) => {
    const result = await callOn(session, objectId, SELECT_FUNCTION, [action.value]) as { ok?: boolean; selectedValues?: string[]; type?: string; name?: string; id?: string; placeholder?: string; autocomplete?: string; className?: string } | undefined
    if (result?.ok !== true) {
      throw bridgeError('invalid_value', 'select has no option matching the given value', false)
    }
    const sensitive = isSensitiveField({
      type: result.type,
      name: result.name,
      id: result.id,
      placeholder: result.placeholder,
      autocomplete: result.autocomplete,
      className: result.className,
    })
    const base: ActResult = {
      ok: true,
      action: 'select',
      target: targetDescriptor(resolved),
      url: session.currentUrl,
      generation: session.generation,
      changed: true,
      readback: 'ok',
    }
    if (sensitive) {
      base.masked = true
    } else if (result.selectedValues !== undefined) {
      base.selectedValues = result.selectedValues
    }
    return base
  })
}

async function press(session: TabSession, key: string): Promise<ActResult> {
  assertWritable(session)
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key })
  return { ok: true, action: 'press', url: session.currentUrl, generation: session.generation }
}

async function scroll(
  session: TabSession,
  target: Target,
  options: { deltaX?: number; deltaY?: number },
): Promise<ActResult> {
  assertWritable(session)
  let x = 0
  let y = 0
  const normalized = normalizeTarget(target)
  if (normalized.ref !== undefined || normalized.selector !== undefined) {
    const center = await withResolvedObject(session, normalized, (objectId) => pointerCenter(session, objectId))
    x = center.x
    y = center.y
  }
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: options.deltaX ?? 0, deltaY: options.deltaY ?? 0,
  })
  return { ok: true, action: 'scroll', url: session.currentUrl, generation: session.generation }
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
    case 'fill':
      return fill(session, { ...targetOf(action), value: action.value })
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

export type BatchActionResult =
  | ({ index: number; ok: true } & ActResult)
  | { index: number; ok: false; action: ActAction['kind']; error: BridgeError }

export interface BatchActResult {
  ok: true
  actions: BatchActionResult[]
  failedIndex: number | null
  url: string
  generation: number
  postcondition?: { satisfied: boolean; attempts: number; elapsedMs: number }
  /** True when `expect` was declared but skipped because an action failed. */
  expectSkipped?: boolean
}

/** Run actions sequentially on the same tab with fail-fast semantics. */
export async function performBatch(
  session: TabSession,
  args: { actions: ActAction[]; expect?: Postcondition },
  options: ActOptions = {},
): Promise<BatchActResult> {
  if (args.actions.length === 0) {
    throw bridgeError('internal', 'batch requires at least one action', false)
  }
  if (args.actions.length > MAX_BATCH_ACTIONS) {
    throw bridgeError('internal', `batch supports at most ${MAX_BATCH_ACTIONS} actions`, false)
  }
  const entries: BatchActionResult[] = []
  let failedIndex: number | null = null
  for (let index = 0; index < args.actions.length; index++) {
    const action = args.actions[index]!
    try {
      const result = await performAction(session, action)
      // ActResult already carries ok: true; the entry adds the batch index.
      entries.push({ index, ...result })
    } catch (error) {
      failedIndex = index
      entries.push({ index, ok: false, action: action.kind, error: toBridgeError(error) })
      break
    }
  }
  const base: BatchActResult = {
    ok: true,
    actions: entries,
    failedIndex,
    url: session.currentUrl,
    generation: session.generation,
  }
  if (failedIndex !== null) {
    // Fail-fast: a failed action means the final state is undefined, so the
    // declared postcondition is skipped and the model is told so explicitly.
    if (args.expect !== undefined) base.expectSkipped = true
    return base
  }
  if (args.expect === undefined) return base
  const outcome = await pollPostcondition(session, args.expect, postconditionOptions(options))
  if (!outcome.satisfied) {
    throw bridgeError('postcondition_failed', postconditionFailureMessage(args.expect), true)
  }
  return { ...base, postcondition: outcome }
}

/** Build bounded postcondition options without violating exactOptionalPropertyTypes. */
function postconditionOptions(options: ActOptions): import('./postcondition.ts').PostconditionOptions {
  const result: import('./postcondition.ts').PostconditionOptions = {
    timeoutMs: options.postconditionTimeoutMs ?? DEFAULT_POSTCONDITION_TIMEOUT_MS,
  }
  if (options.postconditionPollMs !== undefined) result.pollMs = options.postconditionPollMs
  if (options.now !== undefined) result.now = options.now
  return result
}

/**
 * Entry point: one action (with an optional postcondition) or a sequential
 * actions batch (with an optional final postcondition), all inside one call.
 */
export async function performAct(
  session: TabSession,
  args: ActArgs,
  options: ActOptions = {},
): Promise<ActResult | BatchActResult> {
  if (args.actions !== undefined) {
    if (args.action !== undefined) {
      throw bridgeError('internal', 'pass either action or actions, not both', false)
    }
    const batchArgs: { actions: ActAction[]; expect?: Postcondition } = { actions: args.actions }
    if (args.expect !== undefined) batchArgs.expect = args.expect
    return performBatch(session, batchArgs, options)
  }
  if (args.action === undefined) {
    throw bridgeError('internal', 'act requires action or actions', false)
  }
  const result = await performAction(session, args.action)
  if (args.expect === undefined) return result
  const outcome = await pollPostcondition(session, args.expect, postconditionOptions(options))
  if (!outcome.satisfied) {
    throw bridgeError('postcondition_failed', postconditionFailureMessage(args.expect), true)
  }
  return { ...result, postcondition: outcome }
}

export { click, hover, focus, typeText, fill, select, press, scroll }
