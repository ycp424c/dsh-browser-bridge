/**
 * Regression tests for the runtime object id release contract:
 *
 * - every successfully resolved object id (ref or selector) is released on
 *   ALL paths — success, business error, CDP error — via `withResolvedObject`;
 * - the release itself is best-effort: a failed `Runtime.releaseObject` never
 *   masks the business result or the original error;
 * - only the object id a call resolved itself is released, so concurrent
 *   calls never release each other's handles;
 * - every call site (inspect singular/batch, act, capture, postcondition
 *   polling) releases what it resolved, and postcondition polling releases on
 *   EVERY poll attempt.
 *
 * The fake session mirrors the production contract: `Runtime.releaseObject`
 * is short-circuited (best-effort, never consumes the business command
 * queue), while every other command flows through the sequential mock queue.
 */
import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { releaseObject, withResolvedObject } from '../src/cdp/resolve.ts'
import { inspectElement, inspectMany } from '../src/cdp/inspect.ts'
import { captureScreenshot } from '../src/cdp/capture.ts'
import { performAction } from '../src/cdp/act.ts'
import { pollPostcondition } from '../src/cdp/postcondition.ts'

const FIXTURE_URL = 'http://127.0.0.1:4173/'

function fakeSession(): {
  session: TabSession
  /** Sequential mock queue for business commands (never sees releases). */
  send: ReturnType<typeof vi.fn>
  /** Session adapter: records every command, short-circuits releases. */
  sessionSend: ReturnType<typeof vi.fn>
  refs: NodeRegistry
} {
  const refs = new NodeRegistry({ randomId: () => ElementRef('e1') })
  const send = vi.fn()
  const sessionSend = vi.fn((method: string, params?: object) => {
    // Best-effort releases never consume the business command queue.
    if (method === 'Runtime.releaseObject') return Promise.resolve({})
    return send(method, params)
  })
  const session = {
    tabId: 7,
    generation: 1,
    attached: true,
    refs,
    writeSuspended: false,
    consoleEntries: [],
    networkEntries: [],
    currentUrl: FIXTURE_URL,
    lastChangeAt: null,
    expectNavigationWindow: null,
    expectNavigation: () => {},
    onMainFrameNavigated: () => {},
    send: sessionSend,
  } as unknown as TabSession
  return { session, send, sessionSend, refs }
}

/** Every released object id, in release order. */
function releaseCalls(sessionSend: ReturnType<typeof vi.fn>): string[] {
  return sessionSend.mock.calls
    .filter((call: unknown[]) => call[0] === 'Runtime.releaseObject')
    .map((call: unknown[]) => (call[1] as { objectId: string }).objectId)
}

/** Mock the ref resolution round trip (DOM.resolveNode by backend id). */
function mockRefResolution(send: ReturnType<typeof vi.fn>, objectId: string): void {
  send.mockResolvedValueOnce({ object: { objectId } })
}

/** Mock the selector resolution round trip (Runtime.evaluate querySelector). */
function mockSelectorResolution(send: ReturnType<typeof vi.fn>, objectId: string): void {
  send.mockResolvedValueOnce({ result: { objectId } })
}

/** A full `Runtime.callFunctionOn` result with the inspect evaluation shape. */
function inspectValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result: {
      value: {
        attributes: { id: 'save' },
        text: 'Save',
        tag: 'button',
        rect: { x: 10, y: 20, width: 120, height: 32 },
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        viewportIntersects: true,
        ...overrides,
      },
    },
  }
}

describe('runtime object id release', () => {
  it('releases the handle resolved through a ref (success path)', async () => {
    const { session, send, sessionSend, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    mockRefResolution(send, 'obj-ref')
    send.mockResolvedValueOnce(inspectValue())
    await inspectElement(session, { ref: 'e1' })
    expect(releaseCalls(sessionSend)).toEqual(['obj-ref'])
  })

  it('releases the handle resolved through a selector (success path)', async () => {
    const { session, send, sessionSend } = fakeSession()
    mockSelectorResolution(send, 'obj-sel')
    send.mockResolvedValueOnce(inspectValue())
    await inspectElement(session, { selector: '#save' })
    expect(releaseCalls(sessionSend)).toEqual(['obj-sel'])
  })

  it('releases on a business error thrown after resolution', async () => {
    const { session, send, sessionSend, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    mockRefResolution(send, 'obj')
    // callOn resolves to undefined -> inspect maps it to an internal
    // business error.
    send.mockResolvedValueOnce({ result: { value: undefined } })
    await expect(inspectElement(session, { ref: 'e1' })).rejects.toMatchObject({ code: 'internal' })
    expect(releaseCalls(sessionSend)).toEqual(['obj'])
  })

  it('releases on a CDP error thrown by the read calls', async () => {
    const { session, send, sessionSend, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    mockRefResolution(send, 'obj')
    // Runtime.callFunctionOn fails (for example the object detached).
    send.mockRejectedValueOnce(new Error('Could not find object with given id'))
    await expect(inspectElement(session, { ref: 'e1' })).rejects.toMatchObject({ code: 'stale_element' })
    expect(releaseCalls(sessionSend)).toEqual(['obj'])
  })

  it('releases on a zero-area stale element in capture', async () => {
    const { session, send, sessionSend, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    mockRefResolution(send, 'obj')
    send.mockResolvedValueOnce({ result: { value: { x: 0, y: 0, width: 0, height: 0, visible: false } } })
    await expect(captureScreenshot(session, { ref: 'e1' })).rejects.toMatchObject({ code: 'stale_element' })
    expect(releaseCalls(sessionSend)).toEqual(['obj'])
  })

  it('does not release when resolution fails (no handle was created)', async () => {
    const { session, send, sessionSend } = fakeSession()
    // querySelector matched nothing: no object id ever existed.
    send.mockResolvedValueOnce({ result: { type: 'object', subtype: 'null', value: null } })
    await expect(inspectElement(session, { selector: '#gone' })).rejects.toMatchObject({ code: 'stale_element' })
    expect(releaseCalls(sessionSend)).toEqual([])
  })

  it('releaseObject swallows a failed release (best-effort)', async () => {
    const { session, send } = fakeSession()
    send.mockRejectedValueOnce(new Error('debugger detached'))
    await expect(releaseObject(session, 'obj')).resolves.toBeUndefined()
  })

  it('a failed release never masks the business result', async () => {
    const { session, sessionSend } = fakeSession()
    sessionSend.mockImplementationOnce(() => Promise.resolve({ result: { objectId: 'obj' } }))
    sessionSend.mockImplementationOnce(() => Promise.reject(new Error('release failed')))
    const result = await withResolvedObject(session, { selector: '#a' }, async () => 'ok')
    expect(result).toBe('ok')
  })

  it('a failed release never masks the original error', async () => {
    const { session, sessionSend } = fakeSession()
    sessionSend.mockImplementationOnce(() => Promise.resolve({ result: { objectId: 'obj' } }))
    sessionSend.mockImplementationOnce(() => Promise.reject(new Error('release failed')))
    await expect(withResolvedObject(session, { selector: '#a' }, async () => {
      throw new Error('business failure')
    })).rejects.toThrow('business failure')
  })

  it('concurrent resolutions release only their own object ids', async () => {
    const { session, send, sessionSend } = fakeSession()
    mockSelectorResolution(send, 'obj-a')
    mockSelectorResolution(send, 'obj-b')
    const [a, b] = await Promise.all([
      withResolvedObject(session, { selector: '#a' }, async () => 'a'),
      withResolvedObject(session, { selector: '#b' }, async () => 'b'),
    ])
    expect([a, b]).toEqual(['a', 'b'])
    // Each call released exactly the handle it resolved; neither call can
    // release the other's handle.
    expect(releaseCalls(sessionSend).sort()).toEqual(['obj-a', 'obj-b'])
  })

  it('act releases the click target handle', async () => {
    const { session, send, sessionSend, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    mockRefResolution(send, 'obj')
    send.mockResolvedValueOnce({ result: { value: { toggle: false } } }) // before
    send.mockResolvedValueOnce({ result: { value: { x: 10, y: 20, width: 100, height: 20, visible: true } } }) // rect
    send.mockResolvedValueOnce({}) // mousePressed
    send.mockResolvedValueOnce({}) // mouseReleased
    const result = await performAction(session, { kind: 'click', ref: 'e1' })
    expect(result.ok).toBe(true)
    expect(releaseCalls(sessionSend)).toEqual(['obj'])
  })

  it('capture releases the element handle after reading its rect', async () => {
    const { session, send, sessionSend, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    mockRefResolution(send, 'obj')
    send.mockResolvedValueOnce({ result: { value: { x: 10, y: 20, width: 120, height: 32, visible: true } } })
    send.mockResolvedValueOnce({ data: 'iVBORw0KGgo=' })
    const result = await captureScreenshot(session, { ref: 'e1' })
    expect(result.data).toBe('iVBORw0KGgo=')
    expect(releaseCalls(sessionSend)).toEqual(['obj'])
  })

  it('inspect batch releases every target handle independently', async () => {
    const { session, send, sessionSend, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    mockRefResolution(send, 'obj-1')
    send.mockResolvedValueOnce(inspectValue({ text: 'One' }))
    mockRefResolution(send, 'obj-2')
    send.mockResolvedValueOnce(inspectValue({ text: 'Two' }))
    const result = await inspectMany(session, [{ ref: 'e1' }, { ref: 'e1' }])
    expect(result.results).toHaveLength(2)
    expect(releaseCalls(sessionSend)).toEqual(['obj-1', 'obj-2'])
  })

  it('releases on every postcondition poll attempt', async () => {
    const { session, send, sessionSend, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    // attempt 1: resolved o1, value still 'pending' -> not satisfied
    mockRefResolution(send, 'o1')
    send.mockResolvedValueOnce({ result: { value: { kind: 'field', value: 'pending' } } })
    // attempt 2: resolved o2, value 'done' -> satisfied
    mockRefResolution(send, 'o2')
    send.mockResolvedValueOnce({ result: { value: { kind: 'field', value: 'done' } } })
    const outcome = await pollPostcondition(
      session,
      { kind: 'value', ref: 'e1', equals: 'done' },
      { timeoutMs: 1_000, pollMs: 10 },
    )
    expect(outcome.satisfied).toBe(true)
    expect(outcome.attempts).toBe(2)
    // A long-running poll must not accumulate handles: every attempt
    // released the handle it resolved.
    expect(releaseCalls(sessionSend)).toEqual(['o1', 'o2'])
  })

  it('releases even when a poll attempt fails to read the element', async () => {
    const { session, send, sessionSend, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    mockRefResolution(send, 'o1')
    // callOn rejects mid-read (element detached); the attempt counts as not
    // satisfied and the handle is still released.
    send.mockRejectedValueOnce(new Error('Could not find object with given id'))
    const outcome = await pollPostcondition(
      session,
      { kind: 'checked', ref: 'e1', equals: true },
      { timeoutMs: 1, pollMs: 10 },
    )
    expect(outcome.satisfied).toBe(false)
    expect(releaseCalls(sessionSend)).toEqual(['o1'])
  })
})
