/**
 * `browser_inspect`: attributes, text, form state, geometry, and visibility
 * for referenced elements or selectors — plus a batch mode that reads many
 * targets in ONE call. Resolution is stable (backend id / page-side
 * querySelector → runtime object id), never a shareable frontend node id, so
 * reads cannot race each other. Password and secret-like fields never return
 * a plaintext value, and computed style is returned ONLY for explicitly
 * requested properties.
 */
import {
  bridgeError,
  bridgeErrorSchema,
  type BridgeError,
  type ElementRef,
} from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from './session-manager.ts'
import { callOn, withResolvedObject, type ResolvedTarget } from './resolve.ts'
import { isSensitiveField, SENSITIVE_PATTERN } from './sensitive.ts'

export interface InspectResult {
  ref?: ElementRef
  selector?: string
  attributes: Record<string, string>
  text: string
  /** Lowercased tag name (input, textarea, select, button, ...). */
  tag?: string
  /** For inputs: the resolved input type (text, checkbox, datetime-local, ...). */
  inputType?: string
  /** Current value of input/textarea fields; ABSENT for sensitive fields. */
  value?: string
  /** True when the field is a password/secret field and value was withheld. */
  masked?: boolean
  /** For checkbox/radio: the checked state. */
  checked?: boolean
  /** For select: the selected index. */
  selected?: number
  /** For select: the values of the selected options. */
  selectedValues?: string[]
  /** For select: the option list with per-option state. */
  options?: Array<{ value: string; label: string; selected: boolean; disabled: boolean }>
  disabled?: boolean
  readOnly?: boolean
  rect: { x: number; y: number; width: number; height: number }
  visible: boolean
  /** Present only when `properties` were explicitly requested. */
  computedStyle?: Record<string, string>
  generation: number
}

export interface InspectArgs {
  ref?: string
  selector?: string
  targets?: Array<{ ref?: string; selector?: string }>
  properties?: string[]
}

export type InspectBatchEntry =
  | { index: number; ok: true; result: InspectResult }
  | { index: number; ok: false; error: BridgeError }

/** Object-rooted batch result: tool outputs are schema-validated by the host. */
export interface InspectBatchResult {
  ok: true
  results: InspectBatchEntry[]
  failedCount: number
  generation: number
}

export const MAX_INSPECT_TARGETS = 20

/** Page-side read: geometry, attributes, form state, and visibility signals. */
const CALL_FUNCTION = `function () {
  const rect = this.getBoundingClientRect()
  const style = getComputedStyle(this)
  const attributes = {}
  for (const attr of this.attributes) attributes[attr.name] = attr.value
  const isInput = this instanceof HTMLInputElement
  const isTextarea = this instanceof HTMLTextAreaElement
  const isSelect = this instanceof HTMLSelectElement
  const out = {
    attributes,
    text: this.textContent ?? '',
    tag: (this.tagName ?? '').toLowerCase(),
    inputType: isInput ? (this.type || this.getAttribute('type') || 'text') : undefined,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    viewportIntersects: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    disabled: this.disabled === true || this.getAttribute('aria-disabled') === 'true',
  }
  if (isInput || isTextarea) {
    out.value = this.value
    out.readOnly = this.readOnly === true
  }
  if (isInput && (this.type === 'checkbox' || this.type === 'radio')) {
    out.checked = this.checked === true
  }
  if (isSelect) {
    out.selected = this.selectedIndex
    out.selectedValues = Array.from(this.selectedOptions).map(o => o.value)
    out.options = Array.from(this.options).map(o => ({ value: o.value, label: o.text, selected: o.selected, disabled: o.disabled }))
  }
  return out
}`

const STYLE_FILL_FUNCTION = `function (names) {
  const style = getComputedStyle(this)
  const out = {}
  for (const name of names) out[name] = style[name] ?? ''
  return out
}`

interface InspectEval {
  attributes: Record<string, string>
  text: string
  tag?: string
  inputType?: string
  value?: string
  readOnly?: boolean
  checked?: boolean
  selected?: number
  selectedValues?: string[]
  options?: Array<{ value: string; label: string; selected: boolean; disabled: boolean }>
  disabled?: boolean
  rect: { x: number; y: number; width: number; height: number }
  display: string
  visibility: string
  opacity: string
  viewportIntersects: boolean
}

/** Normalize any thrown value into a stable bridge error (batch mode). */
function toBridgeError(error: unknown): BridgeError {
  const parsed = bridgeErrorSchema.safeParse(error)
  if (parsed.success) return parsed.data
  return bridgeError('internal', error instanceof Error ? error.message : String(error), false)
}

async function evaluateElement(session: TabSession, objectId: string, properties?: string[]): Promise<{
  value: InspectEval
  computedStyle: Record<string, string> | undefined
}> {
  try {
    let computedStyle: Record<string, string> | undefined
    if (properties !== undefined && properties.length > 0) {
      const styleValue = await callOn(session, objectId, STYLE_FILL_FUNCTION, [properties]) as Record<string, string> | undefined
      computedStyle = styleValue ?? {}
    }
    const value = await callOn(session, objectId, CALL_FUNCTION) as InspectEval | undefined
    if (value === undefined) {
      throw bridgeError('internal', 'inspect: element evaluation returned no value', false)
    }
    return { value, computedStyle }
  } catch (error) {
    // A detached element surfaces as a raw CDP error ("Could not find object
    // with the given id"); keep stable bridge errors (debugger_detached,
    // ...) intact and map everything else to the stale-element contract.
    const parsed = bridgeErrorSchema.safeParse(error)
    if (parsed.success) throw parsed.data
    throw bridgeError('stale_element', 'element detached during inspection', false)
  }
}

/** Inspect ONE target; throws on failure (singular mode). */
export async function inspectElement(
  session: TabSession,
  args: { ref?: string; selector?: string; properties?: string[] },
): Promise<InspectResult> {
  // The resolved runtime object id is released on every path (success and
  // failure) once inspection is done.
  return withResolvedObject(session, args, (objectId, target) =>
    inspectResolved(session, objectId, target, args.properties ?? []))
}

async function inspectResolved(
  session: TabSession,
  objectId: string,
  target: ResolvedTarget,
  properties: string[],
): Promise<InspectResult> {
  const { value, computedStyle } = await evaluateElement(session, objectId, properties)

  // Attribute values whose NAME marks them secret (token, secret, api_key,
  // password, cvv, ...) are redacted for every element, not only form fields:
  // a hidden data-token attribute must never reach a model-visible result.
  const attributes: Record<string, string> = {}
  for (const [name, attrValue] of Object.entries(value.attributes)) {
    attributes[name] = SENSITIVE_PATTERN.test(name) ? '[REDACTED]' : attrValue
  }

  // Field-level masking applies only to form controls: only they carry a
  // plaintext value/selected state worth withholding.
  const isForm = value.tag === 'input' || value.tag === 'textarea' || value.tag === 'select'
  const sensitive = isForm && isSensitiveField({
    type: value.inputType,
    name: attributes['name'],
    id: attributes['id'],
    placeholder: attributes['placeholder'],
    autocomplete: attributes['autocomplete'],
    className: attributes['class'],
  })

  const result: InspectResult = {
    ...(target.kind === 'ref' ? { ref: target.ref as ElementRef } : {}),
    ...(target.kind === 'selector' ? { selector: target.selector } : {}),
    attributes,
    text: value.text,
    rect: value.rect,
    visible: value.display !== 'none'
      && value.visibility !== 'hidden'
      && value.visibility !== 'collapse'
      && Number(value.opacity) > 0
      && value.rect.width > 0
      && value.rect.height > 0
      && value.viewportIntersects,
    generation: session.generation,
  }
  if (value.tag !== undefined) result.tag = value.tag
  if (value.inputType !== undefined) result.inputType = value.inputType
  if (value.disabled !== undefined) result.disabled = value.disabled
  if (value.readOnly !== undefined) result.readOnly = value.readOnly
  if (value.checked !== undefined) result.checked = value.checked
  if (value.selected !== undefined) result.selected = value.selected
  if (value.selectedValues !== undefined) result.selectedValues = value.selectedValues
  if (value.options !== undefined) result.options = value.options
  if (computedStyle !== undefined) result.computedStyle = computedStyle

  if (sensitive) {
    result.masked = true
    delete result.value
    delete result.selected
    delete result.selectedValues
    delete result.options
    // A plaintext copy can also sit in the value ATTRIBUTE of a form field
    // (a password input with an HTML default); scrub it with the property.
    if (result.attributes['value'] !== undefined) {
      const { value: _scrubbed, ...rest } = result.attributes
      result.attributes = rest
    }
    // A sensitive textarea carries its default content in textContent, and a
    // sensitive select's option values can be secret identifiers: none of
    // them may reach a model-visible result.
    if (value.tag === 'textarea') result.text = ''
  } else if (value.value !== undefined) {
    result.value = value.value
  }
  return result
}

/**
 * Inspect a batch of targets sequentially in ONE call. Every target reports
 * success or failure independently: one failing target never drops the rest.
 * The result is object-rooted because the host validates every tool output
 * against its declared schema.
 */
export async function inspectMany(
  session: TabSession,
  targets: Array<{ ref?: string; selector?: string }>,
  properties: string[] = [],
): Promise<InspectBatchResult> {
  if (targets.length === 0) {
    throw bridgeError('internal', 'inspect batch requires at least one target', false)
  }
  if (targets.length > MAX_INSPECT_TARGETS) {
    throw bridgeError('internal', `inspect batch supports at most ${MAX_INSPECT_TARGETS} targets`, false)
  }
  const results: InspectBatchEntry[] = []
  let failedCount = 0
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!
    try {
      const result = await withResolvedObject(session, target, (objectId, resolved) =>
        inspectResolved(session, objectId, resolved, properties))
      results.push({ index, ok: true, result })
    } catch (error) {
      failedCount += 1
      results.push({ index, ok: false, error: toBridgeError(error) })
    }
  }
  return { ok: true, results, failedCount, generation: session.generation }
}

/** Entry point: singular ref/selector or a targets batch. */
export async function inspect(session: TabSession, args: InspectArgs): Promise<InspectResult | InspectBatchResult> {
  if (args.targets !== undefined) {
    return inspectMany(session, args.targets, args.properties ?? [])
  }
  return inspectElement(session, args)
}
