/**
 * Stable element resolution for the CDP tool layer. Concurrent DOM reads used
 * to share frontend node ids (`DOM.pushNodesByBackendIdsToFrontend`), which
 * parallel calls can invalidate — the "Could not find node with given id"
 * race. Every read here resolves through stable paths instead:
 *
 * - a ref resolves its backend node id directly to a Runtime object id via
 *   `DOM.resolveNode { backendNodeId }` (backend ids are document-stable and
 *   never invalidated by other tool calls);
 * - a selector resolves through page-side `document.querySelector` via
 *   `Runtime.evaluate`, never through the frontend-id DOM tree.
 *
 * Both paths yield a Runtime object id that stays valid for the element as
 * long as the element lives, so parallel reads cannot poison each other.
 *
 * Every resolved object id is a CDP remote handle: it must be returned to the
 * browser with `Runtime.releaseObject` once the caller is done with it, or
 * long sessions and postcondition polling accumulate handles. Callers go
 * through `withResolvedObject`, which ALWAYS releases the handle it resolved
 * — success, business error, or CDP error — and `releaseObject` itself is
 * best-effort: a failed release can never mask the business result or the
 * original error, and each call releases only its own object id, never a
 * concurrent call's.
 */
import { bridgeError } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from './session-manager.ts'

export interface TargetArgs {
  ref?: string
  selector?: string
}

export type ResolvedTarget = { kind: 'ref'; ref: string } | { kind: 'selector'; selector: string }

/** Resolve a ref or selector to a stable Runtime object id. */
export async function resolveObjectId(session: TabSession, args: TargetArgs): Promise<{ objectId: string; target: ResolvedTarget }> {
  if (args.ref !== undefined) {
    const record = session.refs.resolve(args.ref, session.generation)
    const resolved = await session.send('DOM.resolveNode', { backendNodeId: record.backendNodeId })
    const objectId = (resolved as { object?: { objectId?: string } }).object?.objectId
    if (objectId === undefined) {
      throw bridgeError('stale_element', 'element reference could not be resolved', false)
    }
    return { objectId, target: { kind: 'ref', ref: args.ref } }
  }
  if (args.selector !== undefined) {
    const evaluated = await session.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(args.selector)})`,
      returnByValue: false,
    })
    const response = evaluated as { result?: { objectId?: string }; exceptionDetails?: unknown }
    if (response.exceptionDetails !== undefined) {
      throw bridgeError('internal', 'selector evaluation failed in the page', false)
    }
    const objectId = response.result?.objectId
    if (objectId === undefined) {
      throw bridgeError('stale_element', `selector matched no element: ${args.selector}`, false)
    }
    return { objectId, target: { kind: 'selector', selector: args.selector } }
  }
  throw bridgeError('stale_element', 'operation requires ref or selector', false)
}

/**
 * Return one Runtime object id to the browser. Best-effort by contract: a
 * failure (session detached, object already gone, ...) is swallowed so
 * cleanup can never mask the business result or the original error.
 */
export async function releaseObject(session: TabSession, objectId: string): Promise<void> {
  try {
    await session.send('Runtime.releaseObject', { objectId })
  } catch {
    // Best-effort: the session may be detached or the object already gone.
  }
}

/**
 * Resolve a ref/selector, run `fn` with the resulting object id, and ALWAYS
 * release that object id afterwards — on success, on a business error thrown
 * by `fn`, and on a CDP error thrown by the calls inside `fn`. Only the
 * object id produced by THIS resolution is released, so concurrent
 * `withResolvedObject` calls never release each other's handles.
 */
export async function withResolvedObject<T>(
  session: TabSession,
  args: TargetArgs,
  fn: (objectId: string, target: ResolvedTarget) => Promise<T>,
): Promise<T> {
  const { objectId, target } = await resolveObjectId(session, args)
  try {
    return await fn(objectId, target)
  } finally {
    await releaseObject(session, objectId)
  }
}

/** Evaluate one function declaration on a resolved element, returning its value. */
export async function callOn(
  session: TabSession,
  objectId: string,
  functionDeclaration: string,
  args: unknown[] = [],
): Promise<unknown> {
  const response = await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    returnByValue: true,
    ...(args.length > 0 ? { arguments: args.map(value => ({ value })) } : {}),
  })
  return (response as { result?: { value?: unknown } }).result?.value
}

export interface ElementRect {
  x: number
  y: number
  width: number
  height: number
  /** Non-zero area intersecting the viewport. */
  visible: boolean
}

const RECT_FUNCTION = `function () {
  const r = this.getBoundingClientRect()
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
  }
}`

/** Viewport-space layout box of a resolved element (no frontend node ids). */
export async function elementRect(session: TabSession, objectId: string): Promise<ElementRect> {
  const value = await callOn(session, objectId, RECT_FUNCTION) as ElementRect | undefined
  if (value === undefined) {
    throw bridgeError('stale_element', 'element has no layout box', false)
  }
  return value
}
