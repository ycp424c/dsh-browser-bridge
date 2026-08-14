import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { performAct, performAction, type ActAction } from '../src/cdp/act.ts'

const FIXTURE_URL = 'http://127.0.0.1:4173/'

function fakeSession(overrides: Partial<TabSession> = {}): {
  session: TabSession
  send: ReturnType<typeof vi.fn>
  sessionSend: ReturnType<typeof vi.fn>
  refs: NodeRegistry
} {
  const refs = new NodeRegistry({ randomId: () => ElementRef('e1') })
  const send = vi.fn()
  // Best-effort releases (Runtime.releaseObject) never consume the business
  // command queue, mirroring the production contract.
  const sessionSend = vi.fn((method: string, params?: object) => {
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
    send: sessionSend,
    ...overrides,
  } as unknown as TabSession
  session.expectNavigation = (timeoutMs: number, expectedOrigin?: string) => {
    session.expectNavigationWindow = { until: Date.now() + timeoutMs, expectedOrigin: expectedOrigin ?? null }
  }
  session.onMainFrameNavigated = (url: string, opts: { expected: boolean }) => {
    session.lastChangeAt = Date.now()
    const window = session.expectNavigationWindow
    const previous = session.currentUrl
    session.expectNavigationWindow = null
    session.currentUrl = url
    if (window !== null && Date.now() <= window.until) return
    if (!opts.expected && originOf(url) !== originOf(previous)) session.writeSuspended = true
  }
  return { session, send, sessionSend, refs }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** Register a ref and mock its stable resolution (DOM.resolveNode by backend id). */
async function withRef(session: TabSession, send: ReturnType<typeof vi.fn>, objectId = 'obj'): Promise<void> {
  session.refs.register(42, 'frame-1', 1)
  send.mockResolvedValueOnce({ object: { objectId } })
}

function callValue(value: unknown): Record<string, unknown> {
  return { result: { value } }
}

function rectValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return callValue({ x: 10, y: 20, width: 100, height: 20, visible: true, ...overrides })
}

function fieldValue(value: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return callValue({
    kind: 'field', value, type: 'text', name: '', id: '', placeholder: '', autocomplete: '', ...overrides,
  })
}

describe('browser_act', () => {
  it('clicks the center of a referenced element and reads back a checkbox toggle', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ toggle: true, checked: false })) // before
    send.mockResolvedValueOnce(rectValue()) // rect
    send.mockResolvedValueOnce({}) // mousePressed
    send.mockResolvedValueOnce({}) // mouseReleased
    send.mockResolvedValueOnce(callValue({ toggle: true, checked: true })) // after
    const result = await performAction(session, { kind: 'click', ref: 'e1' })
    expect(result).toMatchObject({
      ok: true,
      action: 'click',
      url: FIXTURE_URL,
      changed: true,
      checked: true,
      readback: 'ok',
    })
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 60, y: 30 }))
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', x: 60, y: 30 }))
    // No frontend node ids anywhere: resolution is by backend id.
    expect(send).not.toHaveBeenCalledWith('DOM.pushNodesByBackendIdsToFrontend', expect.anything())
    expect(send).not.toHaveBeenCalledWith('DOM.getBoxModel', expect.anything())
  })

  it('reports no toggle state for non-toggle clicks', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ toggle: false })) // before
    send.mockResolvedValueOnce(rectValue())
    send.mockResolvedValueOnce({}) // pressed
    send.mockResolvedValueOnce({}) // released
    const result = await performAction(session, { kind: 'click', ref: 'e1' })
    expect(result.checked).toBeUndefined()
    expect(result.readback).toBeUndefined()
  })

  it('scrolls an off-viewport element into view before clicking (bounded fallback)', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ toggle: false }))
    send.mockResolvedValueOnce(rectValue({ visible: false, y: -500 })) // offscreen
    send.mockResolvedValueOnce(callValue(true)) // scrollIntoView
    send.mockResolvedValueOnce(rectValue({ x: 10, y: 10 })) // re-read after scroll
    send.mockResolvedValueOnce({}) // pressed
    send.mockResolvedValueOnce({}) // released
    const result = await performAction(session, { kind: 'click', ref: 'e1' })
    expect(result.ok).toBe(true)
    const scrollCall = send.mock.calls.find(call => call[0] === 'Runtime.callFunctionOn' && String((call[1] as { functionDeclaration?: string }).functionDeclaration).includes('scrollIntoView'))
    expect(scrollCall).toBeDefined()
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 60, y: 20 }))
  })

  it('fails a click with a stable error when the element has no layout box', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ toggle: false }))
    send.mockResolvedValueOnce(rectValue({ visible: false, width: 0, height: 0 }))
    send.mockResolvedValueOnce(callValue(true)) // scrollIntoView (no-op)
    send.mockResolvedValueOnce(rectValue({ visible: false, width: 0, height: 0 }))
    await expect(performAction(session, { kind: 'click', ref: 'e1' })).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('types by appending and reports the readback value', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(fieldValue('old')) // before
    send.mockResolvedValueOnce(callValue(true)) // focus
    send.mockResolvedValueOnce({}) // insertText
    send.mockResolvedValueOnce(fieldValue('oldX')) // after
    const result = await performAction(session, { kind: 'type', ref: 'e1', text: 'X' })
    expect(result).toMatchObject({ ok: true, action: 'type', changed: true, value: 'oldX' })
    expect(send).toHaveBeenCalledWith('Input.insertText', { text: 'X' })
  })

  it('types with replace:true overwriting the existing value', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(fieldValue('old')) // before
    send.mockResolvedValueOnce(callValue(true)) // focus
    send.mockResolvedValueOnce(callValue(true)) // select()
    send.mockResolvedValueOnce({}) // backspace down
    send.mockResolvedValueOnce({}) // backspace up
    send.mockResolvedValueOnce({}) // insertText
    send.mockResolvedValueOnce(fieldValue('new')) // after
    const result = await performAction(session, { kind: 'type', ref: 'e1', text: 'new', replace: true })
    expect(result).toMatchObject({ ok: true, action: 'type', changed: true, value: 'new' })
    const selectCall = send.mock.calls.find(call => call[0] === 'Runtime.callFunctionOn' && String((call[1] as { functionDeclaration?: string }).functionDeclaration).includes('this.select()'))
    expect(selectCall).toBeDefined()
  })

  it('fails visibly when insertText did not change the field value (no false success)', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(fieldValue('')) // before (datetime-local rejects insertText)
    send.mockResolvedValueOnce(callValue(true)) // focus
    send.mockResolvedValueOnce({}) // insertText
    send.mockResolvedValueOnce(fieldValue('')) // after: unchanged
    await expect(performAction(session, { kind: 'type', ref: 'e1', text: '2024-01-01T10:00' }))
      .rejects.toMatchObject({ code: 'input_not_applied' })
  })

  it('an idempotent replace that already holds the value is not a failure', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(fieldValue('new')) // before: already 'new'
    send.mockResolvedValueOnce(callValue(true)) // focus
    send.mockResolvedValueOnce(callValue(true)) // select()
    send.mockResolvedValueOnce({}) // backspace down
    send.mockResolvedValueOnce({}) // backspace up
    send.mockResolvedValueOnce({}) // insertText
    send.mockResolvedValueOnce(fieldValue('new')) // after: unchanged but equals expected
    const result = await performAction(session, { kind: 'type', ref: 'e1', text: 'new', replace: true })
    expect(result).toMatchObject({ ok: true, action: 'type', value: 'new' })
    expect(result.changed).toBe(false)
  })

  it('fails a type whose target was replaced by a non-field while typing', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(fieldValue('old')) // before: field
    send.mockResolvedValueOnce(callValue(true)) // focus
    send.mockResolvedValueOnce({}) // insertText
    send.mockResolvedValueOnce(callValue({ kind: 'other' })) // after: element replaced
    await expect(performAction(session, { kind: 'type', ref: 'e1', text: 'X' }))
      .rejects.toMatchObject({ code: 'stale_element' })
  })

  it('fills a text field through the native setter and returns the readback', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ applied: true, value: 'new', type: 'text' }))
    const result = await performAction(session, { kind: 'fill', ref: 'e1', value: 'new' })
    expect(result).toMatchObject({ ok: true, action: 'fill', changed: true, value: 'new' })
    const fillCall = send.mock.calls.find(call => call[0] === 'Runtime.callFunctionOn')
    const declaration = String((fillCall![1] as { functionDeclaration?: string }).functionDeclaration)
    expect(declaration).toContain('HTMLInputElement.prototype')
    expect(declaration).toContain("'input'")
    expect(declaration).toContain("'change'")
    expect(fillCall![1]).toMatchObject({ arguments: [{ value: 'new' }] })
  })

  it('fills a datetime-local field and validates the normalized readback', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ applied: true, value: '2024-01-01T10:30', type: 'datetime-local' }))
    const result = await performAction(session, { kind: 'fill', ref: 'e1', value: '2024-01-01T10:30' })
    expect(result.value).toBe('2024-01-01T10:30')
  })

  it('fails a fill the field rejected (invalid datetime value)', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ applied: false, reason: 'rejected' }))
    await expect(performAction(session, { kind: 'fill', ref: 'e1', value: 'not-a-date' }))
      .rejects.toMatchObject({ code: 'input_not_applied' })
  })

  it('fails a fill on a non-field target', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ applied: false, reason: 'not-a-field' }))
    await expect(performAction(session, { kind: 'fill', ref: 'e1', value: 'x' }))
      .rejects.toMatchObject({ code: 'unsupported_operation' })
  })

  it('fails a fill whose select option does not exist', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ applied: false, reason: 'no-option' }))
    await expect(performAction(session, { kind: 'fill', ref: 'e1', value: 'zz' }))
      .rejects.toMatchObject({ code: 'invalid_value' })
  })

  it('selects an option and reports selected values', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ ok: true, selectedValues: ['de'], type: 'select', name: 'country' }))
    const result = await performAction(session, { kind: 'select', ref: 'e1', value: 'de' })
    expect(result).toMatchObject({ ok: true, action: 'select', selectedValues: ['de'] })
  })

  it('masks the selected values of a sensitive select', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(callValue({ ok: true, selectedValues: ['cvv-99'], type: 'select', name: 'card_cvv' }))
    const result = await performAction(session, { kind: 'select', ref: 'e1', value: 'cvv-99' })
    expect(result.masked).toBe(true)
    expect(result.selectedValues).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('cvv-99')
  })

  it('masks the readback value of a password field', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(fieldValue('old', { type: 'password', name: 'password' })) // before
    send.mockResolvedValueOnce(callValue(true)) // focus
    send.mockResolvedValueOnce({}) // insertText
    send.mockResolvedValueOnce(fieldValue('oldX', { type: 'password', name: 'password' })) // after
    const result = await performAction(session, { kind: 'type', ref: 'e1', text: 'X' })
    expect(result.value).toBeUndefined()
    expect(result.masked).toBe(true)
    expect(JSON.stringify(result)).not.toContain('oldX')
  })

  it('refuses writes after an unexpected cross-origin navigation', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    session.onMainFrameNavigated('https://unexpected.example/', { expected: false })
    await expect(performAction(session, { kind: 'click', ref: 'e1' })).rejects.toMatchObject({ code: 'navigation_requires_confirmation' })
  })

  it('fails a stale reference', async () => {
    const { session } = fakeSession()
    await expect(performAction(session, { kind: 'click', ref: 'nope' })).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('hovers, focuses, presses keys, and scrolls', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce(rectValue()) // hover rect
    send.mockResolvedValueOnce({}) // mouseMoved
    await expect(performAction(session, { kind: 'hover', ref: 'e1' })).resolves.toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved', x: 60, y: 30 }))

    send.mockResolvedValueOnce({ object: { objectId: 'obj2' } })
    send.mockResolvedValueOnce(callValue(true))
    await expect(performAction(session, { kind: 'focus', ref: 'e1' })).resolves.toMatchObject({ ok: true })

    send.mockResolvedValueOnce({})
    send.mockResolvedValueOnce({})
    await expect(performAction(session, { kind: 'press', key: 'Enter' })).resolves.toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', key: 'Enter' }))

    send.mockResolvedValueOnce({ object: { objectId: 'obj3' } })
    send.mockResolvedValueOnce(rectValue())
    send.mockResolvedValueOnce({})
    await expect(performAction(session, { kind: 'scroll', ref: 'e1', deltaY: 100 })).resolves.toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseWheel', deltaY: 100 }))
  })

  describe('batch actions', () => {
    it('runs actions sequentially and returns per-item results', async () => {
      const { session, send } = fakeSession()
      session.refs.register(42, 'frame-1', 1)
      // action 0: click checkbox
      send.mockResolvedValueOnce({ object: { objectId: 'o0' } })
      send.mockResolvedValueOnce(callValue({ toggle: true, checked: false }))
      send.mockResolvedValueOnce(rectValue())
      send.mockResolvedValueOnce({})
      send.mockResolvedValueOnce({})
      send.mockResolvedValueOnce(callValue({ toggle: true, checked: true }))
      // action 1: fill text
      send.mockResolvedValueOnce({ object: { objectId: 'o1' } })
      send.mockResolvedValueOnce(callValue({ applied: true, value: 'new', type: 'text' }))
      const result = await performAct(session, {
        actions: [
          { kind: 'click', ref: 'e1' },
          { kind: 'fill', ref: 'e1', value: 'new' },
        ],
      })
      expect(result.ok).toBe(true)
      const batch = result as { actions: Array<Record<string, unknown>>; failedIndex: number | null }
      expect(batch.actions).toHaveLength(2)
      expect(batch.actions[0]).toMatchObject({ index: 0, ok: true, action: 'click', checked: true })
      expect(batch.actions[1]).toMatchObject({ index: 1, ok: true, action: 'fill', value: 'new' })
      expect(batch.failedIndex).toBeNull()
    })

    it('stops at the first failure (fail-fast) and reports the failed index', async () => {
      const { session, send } = fakeSession()
      session.refs.register(42, 'frame-1', 1)
      send.mockResolvedValueOnce({ object: { objectId: 'o0' } })
      send.mockResolvedValueOnce(fieldValue('old'))
      send.mockResolvedValueOnce(callValue(true))
      send.mockResolvedValueOnce({})
      send.mockResolvedValueOnce(fieldValue('old'))
      // action 1 fails: type did not apply -> input_not_applied. action 2 must not run.
      const result = await performAct(session, {
        actions: [
          { kind: 'type', ref: 'e1', text: 'X' },
          { kind: 'type', ref: 'e1', text: 'Y' },
        ],
      }) as { actions: Array<Record<string, unknown>>; failedIndex: number | null }
      expect(result.failedIndex).toBe(0)
      expect(result.actions).toHaveLength(1)
      expect((result.actions[0] as { error: { code: string } }).error.code).toBe('input_not_applied')
      expect(send).toHaveBeenCalledTimes(5)
    })

    it('rejects a batch above the action cap', async () => {
      const { session } = fakeSession()
      await expect(performAct(session, {
        actions: Array.from({ length: 21 }, () => ({ kind: 'press', key: 'Enter' } as ActAction)),
      })).rejects.toMatchObject({ code: 'internal' })
    })

    it('rejects passing both action and actions', async () => {
      const { session } = fakeSession()
      await expect(performAct(session, {
        action: { kind: 'press', key: 'Enter' },
        actions: [{ kind: 'press', key: 'Enter' }],
      })).rejects.toMatchObject({ code: 'internal' })
    })

    it('marks a declared postcondition as skipped when an action fails', async () => {
      const { session, send } = fakeSession()
      session.refs.register(42, 'frame-1', 1)
      send.mockResolvedValueOnce({ object: { objectId: 'o0' } })
      send.mockResolvedValueOnce(fieldValue(''))
      send.mockResolvedValueOnce(callValue(true))
      send.mockResolvedValueOnce({})
      send.mockResolvedValueOnce(fieldValue(''))
      const result = await performAct(session, {
        actions: [{ kind: 'type', ref: 'e1', text: 'X' }],
        expect: { kind: 'value', ref: 'e1', equals: 'X' },
      }) as { failedIndex: number | null; expectSkipped?: boolean }
      expect(result.failedIndex).toBe(0)
      expect(result.expectSkipped).toBe(true)
    })
  })

  describe('postconditions', () => {
    it('polls a value postcondition to success after the action', async () => {
      const { session, send } = fakeSession()
      session.refs.register(42, 'frame-1', 1)
      // action: click (non-toggle)
      send.mockResolvedValueOnce({ object: { objectId: 'o0' } })
      send.mockResolvedValueOnce(callValue({ toggle: false }))
      send.mockResolvedValueOnce(rectValue())
      send.mockResolvedValueOnce({})
      send.mockResolvedValueOnce({})
      // postcondition: resolve target once, then poll value
      send.mockResolvedValueOnce({ object: { objectId: 'o1' } })
      send.mockResolvedValueOnce(fieldValue('expected'))
      const result = await performAct(session, {
        action: { kind: 'click', ref: 'e1' },
        expect: { kind: 'value', ref: 'e1', equals: 'expected' },
      }) as { postcondition: { satisfied: boolean; attempts: number } }
      expect(result.postcondition).toMatchObject({ satisfied: true, attempts: 1 })
    })

    it('throws postcondition_failed when the condition never holds, without leaking values', async () => {
      const { session, send } = fakeSession()
      session.refs.register(42, 'frame-1', 1)
      // action: click
      send.mockResolvedValueOnce({ object: { objectId: 'o0' } })
      send.mockResolvedValueOnce(callValue({ toggle: false }))
      send.mockResolvedValueOnce(rectValue())
      send.mockResolvedValueOnce({})
      send.mockResolvedValueOnce({})
      // postcondition: resolve + one poll that fails (short poll budget)
      send.mockResolvedValueOnce({ object: { objectId: 'o1' } })
      send.mockResolvedValueOnce(fieldValue('actual-secret'))
      const failure = await performAct(session, {
        action: { kind: 'click', ref: 'e1' },
        expect: { kind: 'value', ref: 'e1', equals: 'expected-secret' },
      }, { postconditionTimeoutMs: 1 }).then(() => null, error => error as { code: string })
      expect(failure?.code).toBe('postcondition_failed')
      expect(JSON.stringify(failure)).not.toContain('actual-secret')
      expect(JSON.stringify(failure)).not.toContain('expected-secret')
    })

    it('checks a checked postcondition after a toggle click', async () => {
      const { session, send } = fakeSession()
      session.refs.register(42, 'frame-1', 1)
      send.mockResolvedValueOnce({ object: { objectId: 'o0' } })
      send.mockResolvedValueOnce(callValue({ toggle: true, checked: false }))
      send.mockResolvedValueOnce(rectValue())
      send.mockResolvedValueOnce({})
      send.mockResolvedValueOnce({})
      send.mockResolvedValueOnce(callValue({ toggle: true, checked: true }))
      // postcondition checked equals true
      send.mockResolvedValueOnce({ object: { objectId: 'o1' } })
      send.mockResolvedValueOnce(callValue({ toggle: true, checked: true }))
      const result = await performAct(session, {
        action: { kind: 'click', ref: 'e1' },
        expect: { kind: 'checked', ref: 'e1', equals: true },
      }) as { postcondition: { satisfied: boolean } }
      expect(result.postcondition.satisfied).toBe(true)
    })

    it('polls a visible postcondition using the inspect visibility semantics', async () => {
      const { session, send } = fakeSession()
      session.refs.register(42, 'frame-1', 1)
      // action: click
      send.mockResolvedValueOnce({ object: { objectId: 'o0' } })
      send.mockResolvedValueOnce(callValue({ toggle: false }))
      send.mockResolvedValueOnce(rectValue())
      send.mockResolvedValueOnce({})
      send.mockResolvedValueOnce({})
      // postcondition: resolve + one poll where opacity 0 means not visible
      send.mockResolvedValueOnce({ object: { objectId: 'o1' } })
      send.mockResolvedValueOnce(callValue({ visible: false }))
      const failure = await performAct(session, {
        action: { kind: 'click', ref: 'e1' },
        expect: { kind: 'visible', ref: 'e1', equals: true },
      }, { postconditionTimeoutMs: 1 }).then(() => null, error => error as { code: string })
      expect(failure?.code).toBe('postcondition_failed')
      // the visible check reads display/visibility/opacity + rect
      const visibleCall = send.mock.calls.find(call => call[0] === 'Runtime.callFunctionOn'
        && String((call[1] as { functionDeclaration?: string }).functionDeclaration).includes('getComputedStyle'))
      expect(visibleCall).toBeDefined()
    })
  })
})
