/**
 * Bounded postcondition polling for `browser_act`: after an action (or an
 * actions batch) the SAME tool call polls a declared condition until it
 * holds or the budget expires. Failure is reported as the stable
 * `postcondition_failed` error by the caller; failure text never echoes the
 * compared values, so sensitive field values cannot leak into the model.
 */
import type { TabSession } from './session-manager.ts'
import { callOn, withResolvedObject } from './resolve.ts'

export type Postcondition =
  | { kind: 'value'; ref?: string; selector?: string; equals?: string; contains?: string }
  | { kind: 'checked'; ref?: string; selector?: string; equals: boolean }
  | { kind: 'visible'; ref?: string; selector?: string; equals: boolean }
  | { kind: 'text'; ref?: string; selector?: string; contains: string }
  | { kind: 'url'; equals?: string; contains?: string }

export interface PostconditionOutcome {
  satisfied: boolean
  attempts: number
  elapsedMs: number
}

export interface PostconditionOptions {
  timeoutMs: number
  pollMs?: number
  now?: () => number
}

export const DEFAULT_POSTCONDITION_POLL_MS = 100

const FIELD_VALUE_FUNCTION = `function () {
  const isField = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement
  if (!isField) return { kind: 'other' }
  return { kind: 'field', value: this.value }
}`

const TOGGLE_FUNCTION = `function () {
  if (this instanceof HTMLInputElement && (this.type === 'checkbox' || this.type === 'radio')) {
    return { toggle: true, checked: this.checked === true }
  }
  return { toggle: false }
}`

const RECT_VISIBLE_FUNCTION = `function () {
  const r = this.getBoundingClientRect()
  const style = getComputedStyle(this)
  const visible = style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse'
    && Number(style.opacity) > 0
    && r.width > 0 && r.height > 0
    && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  return { visible }
}`

const TEXT_FUNCTION = `function () {
  return { text: this.textContent ?? '' }
}`

/** A non-secret description of the condition for failure messages. */
export function postconditionFailureMessage(condition: Postcondition): string {
  const target = condition.kind === 'url'
    ? 'the page URL'
    : condition.ref !== undefined
      ? `ref ${condition.ref}`
      : condition.selector !== undefined
        ? `selector ${condition.selector}`
        : 'the target'
  return `postcondition ${condition.kind} was not satisfied for ${target} within the poll window`
}

async function checkOnce(session: TabSession, condition: Postcondition): Promise<boolean> {
  switch (condition.kind) {
    case 'url': {
      if (condition.equals === undefined && condition.contains === undefined) return false
      const evaluated = await session.send('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      }) as { result?: { value?: string } }
      const url = evaluated.result?.value ?? ''
      if (condition.equals !== undefined && url !== condition.equals) return false
      if (condition.contains !== undefined && !url.includes(condition.contains)) return false
      return true
    }
    case 'value': {
      if (condition.equals === undefined && condition.contains === undefined) return false
      if (condition.ref === undefined && condition.selector === undefined) return false
      // Every poll attempt resolves AND releases its own runtime object id,
      // so long polls never accumulate remote handles.
      return withResolvedObject(session, {
        ...(condition.ref !== undefined ? { ref: condition.ref } : {}),
        ...(condition.selector !== undefined ? { selector: condition.selector } : {}),
      }, async (objectId) => {
        const value = await callOn(session, objectId, FIELD_VALUE_FUNCTION) as { kind: string; value?: string } | undefined
        const raw = value?.kind === 'field' ? value.value ?? '' : ''
        if (condition.equals !== undefined && raw !== condition.equals) return false
        if (condition.contains !== undefined && !raw.includes(condition.contains)) return false
        return true
      })
    }
    case 'checked': {
      if (condition.ref === undefined && condition.selector === undefined) return false
      return withResolvedObject(session, {
        ...(condition.ref !== undefined ? { ref: condition.ref } : {}),
        ...(condition.selector !== undefined ? { selector: condition.selector } : {}),
      }, async (objectId) => {
        const value = await callOn(session, objectId, TOGGLE_FUNCTION) as { toggle?: boolean; checked?: boolean } | undefined
        return value?.toggle === true && value.checked === condition.equals
      })
    }
    case 'visible': {
      if (condition.ref === undefined && condition.selector === undefined) return false
      return withResolvedObject(session, {
        ...(condition.ref !== undefined ? { ref: condition.ref } : {}),
        ...(condition.selector !== undefined ? { selector: condition.selector } : {}),
      }, async (objectId) => {
        const value = await callOn(session, objectId, RECT_VISIBLE_FUNCTION) as { visible?: boolean } | undefined
        return value?.visible === condition.equals
      })
    }
    case 'text': {
      if (condition.ref === undefined && condition.selector === undefined) return false
      return withResolvedObject(session, {
        ...(condition.ref !== undefined ? { ref: condition.ref } : {}),
        ...(condition.selector !== undefined ? { selector: condition.selector } : {}),
      }, async (objectId) => {
        const value = await callOn(session, objectId, TEXT_FUNCTION) as { text?: string } | undefined
        return (value?.text ?? '').includes(condition.contains)
      })
    }
  }
}

/**
 * Poll the condition until it holds or `timeoutMs` elapses. A transient
 * evaluation failure counts as "not satisfied" for that attempt; the poll is
 * always bounded by the timeout.
 */
export async function pollPostcondition(
  session: TabSession,
  condition: Postcondition,
  options: PostconditionOptions,
): Promise<PostconditionOutcome> {
  const now = options.now ?? Date.now
  const started = now()
  const timeoutAt = started + options.timeoutMs
  const pollMs = options.pollMs ?? DEFAULT_POSTCONDITION_POLL_MS
  let attempts = 0
  while (true) {
    attempts += 1
    let satisfied = false
    try {
      satisfied = await checkOnce(session, condition)
    } catch {
      // A detached element or transient CDP failure is not a satisfied
      // condition; keep polling until the bounded budget expires.
      satisfied = false
    }
    if (satisfied) {
      return { satisfied: true, attempts, elapsedMs: now() - started }
    }
    if (now() >= timeoutAt) {
      return { satisfied: false, attempts, elapsedMs: now() - started }
    }
    await delay(pollMs)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
