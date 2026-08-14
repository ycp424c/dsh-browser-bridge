import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { inspectElement, inspectMany } from '../src/cdp/inspect.ts'

const FIXTURE_URL = 'http://127.0.0.1:4173/'

function fakeSession(): { session: TabSession; send: ReturnType<typeof vi.fn>; sessionSend: ReturnType<typeof vi.fn>; refs: NodeRegistry } {
  const refs = new NodeRegistry({ randomId: () => ElementRef('e1') })
  const send = vi.fn()
  // Best-effort releases (Runtime.releaseObject) never consume the business
  // command queue, mirroring the production contract.
  const sessionSend = vi.fn((method: string, params?: object) => {
    if (method === 'Runtime.releaseObject') return Promise.resolve({})
    return send(method, params)
  })
  return {
    session: {
      tabId: 7,
      generation: 1,
      attached: true,
      refs,
      writeSuspended: false,
      consoleEntries: [],
      networkEntries: [],
      send: sessionSend,
    } as unknown as TabSession,
    send,
    sessionSend,
    refs,
  }
}

/** Mock the ref resolution round trip (DOM.resolveNode by backend id). */
function mockRefResolution(send: ReturnType<typeof vi.fn>, objectId = 'obj-1'): void {
  send.mockResolvedValueOnce({ object: { objectId } })
}

/** Mock the selector resolution round trip (Runtime.evaluate querySelector). */
function mockSelectorResolution(send: ReturnType<typeof vi.fn>, objectId?: string): void {
  send.mockResolvedValueOnce(objectId === undefined
    ? { result: { type: 'object', subtype: 'null', value: null } }
    : { result: { objectId } })
}

function callFunctionValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result: {
      value: {
        attributes: { id: 'save', class: 'btn' },
        text: 'Save',
        tag: 'button',
        rect: { x: 10, y: 20, width: 120, height: 32 },
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        viewportIntersects: true,
        disabled: false,
        ...overrides,
      },
    },
  }
}

describe('browser_inspect', () => {
  it('returns form state for a text input without any frontend node id dependency', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    mockRefResolution(send)
    send.mockResolvedValueOnce(callFunctionValue({
      tag: 'input',
      inputType: 'text',
      value: 'hello',
      readOnly: false,
      disabled: true,
    }))
    const inspected = await inspectElement(session, { ref: 'e1' })
    expect(inspected).toMatchObject({
      ref: 'e1',
      tag: 'input',
      inputType: 'text',
      value: 'hello',
      disabled: true,
      readOnly: false,
      visible: true,
      rect: { x: 10, y: 20, width: 120, height: 32 },
    })
    // Resolution is stable: backend node id straight to a runtime object id,
    // never pushNodesByBackendIdsToFrontend / DOM.querySelector.
    expect(send).toHaveBeenCalledWith('DOM.resolveNode', { backendNodeId: 42 })
    expect(send).not.toHaveBeenCalledWith('DOM.pushNodesByBackendIdsToFrontend', expect.anything())
    expect(send).not.toHaveBeenCalledWith('DOM.getDocument', expect.anything())
  })

  it('returns checked state for checkbox/radio inputs', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    mockRefResolution(send)
    send.mockResolvedValueOnce(callFunctionValue({
      tag: 'input', inputType: 'checkbox', value: 'on', checked: true,
    }))
    const inspected = await inspectElement(session, { ref: 'e1' })
    expect(inspected.checked).toBe(true)
    expect(inspected.inputType).toBe('checkbox')
  })

  it('returns selected state and options for a select', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    mockRefResolution(send)
    send.mockResolvedValueOnce(callFunctionValue({
      tag: 'select',
      selected: 1,
      selectedValues: ['de'],
      options: [
        { value: 'us', label: 'US', selected: false, disabled: false },
        { value: 'de', label: 'DE', selected: true, disabled: false },
      ],
    }))
    const inspected = await inspectElement(session, { ref: 'e1' })
    expect(inspected.selected).toBe(1)
    expect(inspected.selectedValues).toEqual(['de'])
    expect(inspected.options).toHaveLength(2)
  })

  it('never leaks plaintext for password or secret/token fields', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    mockRefResolution(send)
    send.mockResolvedValueOnce(callFunctionValue({
      tag: 'input', inputType: 'password', value: 'hunter2',
      attributes: { name: 'password', value: 'hunter2' },
    }))
    const password = await inspectElement(session, { ref: 'e1' })
    expect(password.value).toBeUndefined()
    expect(password.masked).toBe(true)
    expect(JSON.stringify(password)).not.toContain('hunter2')

    // A text input whose name marks it as a token field is masked too.
    send.mockResolvedValueOnce({ object: { objectId: 'obj-2' } })
    send.mockResolvedValueOnce(callFunctionValue({
      tag: 'input', inputType: 'text', value: 'sk_live_abc',
      attributes: { name: 'api_key' },
    }))
    const token = await inspectElement(session, { ref: 'e1' })
    expect(token.value).toBeUndefined()
    expect(token.masked).toBe(true)
    expect(JSON.stringify(token)).not.toContain('sk_live_abc')
  })

  it('redacts secret-named attributes on any element and does not mislabel non-form elements', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    mockRefResolution(send)
    send.mockResolvedValueOnce(callFunctionValue({
      tag: 'div',
      attributes: { 'data-token': 'tok_live_abc', class: 'card-layout', id: 'panel' },
    }))
    const inspected = await inspectElement(session, { ref: 'e1' })
    expect(inspected.attributes['data-token']).toBe('[REDACTED]')
    expect(inspected.masked).toBeUndefined()
    expect(JSON.stringify(inspected)).not.toContain('tok_live_abc')
    expect(inspected.attributes['class']).toBe('card-layout')
  })

  it('masks a sensitive textarea content and a sensitive select option values', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    mockRefResolution(send)
    send.mockResolvedValueOnce(callFunctionValue({
      tag: 'textarea', text: 'sk_live_default', value: '',
      attributes: { name: 'token' },
    }))
    const textarea = await inspectElement(session, { ref: 'e1' })
    expect(textarea.masked).toBe(true)
    expect(textarea.text).toBe('')
    expect(JSON.stringify(textarea)).not.toContain('sk_live_default')

    mockRefResolution(send, 'obj-2')
    send.mockResolvedValueOnce(callFunctionValue({
      tag: 'select', selected: 0, selectedValues: ['cvv-1234'],
      options: [{ value: 'cvv-1234', label: 'CVV', selected: true, disabled: false }],
      attributes: { name: 'card_cvv' },
    }))
    const select = await inspectElement(session, { ref: 'e1' })
    expect(select.masked).toBe(true)
    expect(select.selectedValues).toBeUndefined()
    expect(select.options).toBeUndefined()
    expect(select.selected).toBeUndefined()
    expect(JSON.stringify(select)).not.toContain('cvv-1234')
  })

  it('returns computed style ONLY for explicitly requested properties', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    mockRefResolution(send)
    send.mockResolvedValueOnce(callFunctionValue())
    const plain = await inspectElement(session, { ref: 'e1' })
    expect(plain.computedStyle).toBeUndefined()
    expect(JSON.stringify(plain)).not.toContain('computedStyle')

    mockRefResolution(send, 'obj-2')
    send.mockResolvedValueOnce({ result: { value: { color: 'rgb(0, 0, 255)' } } }) // style fill
    send.mockResolvedValueOnce(callFunctionValue())
    const styled = await inspectElement(session, { ref: 'e1', properties: ['color'] })
    expect(styled.computedStyle).toEqual({ color: 'rgb(0, 0, 255)' })
  })

  it('resolves selectors through page evaluation and fails a non-match', async () => {
    const { session, send } = fakeSession()
    mockSelectorResolution(send, 'obj-9')
    send.mockResolvedValueOnce(callFunctionValue({ attributes: { id: 'save' } }))
    const inspected = await inspectElement(session, { selector: '#save' })
    expect(inspected).toMatchObject({ selector: '#save' })
    expect(send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ expression: 'document.querySelector("#save")' }))

    mockSelectorResolution(send)
    await expect(inspectElement(session, { selector: '#missing' })).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('fails a stale reference', async () => {
    const { session } = fakeSession()
    await expect(inspectElement(session, { ref: 'nope' })).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('computes visibility from display, visibility, opacity, and viewport intersection', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    mockRefResolution(send)
    send.mockResolvedValueOnce(callFunctionValue({ display: 'none' }))
    const hidden = await inspectElement(session, { ref: 'e1' })
    expect(hidden.visible).toBe(false)

    mockRefResolution(send, 'obj-2')
    send.mockResolvedValueOnce(callFunctionValue({ viewportIntersects: false }))
    const offscreen = await inspectElement(session, { ref: 'e1' })
    expect(offscreen.visible).toBe(false)
  })

  it('inspects a batch of targets in one call, reporting per-target success and failure', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    // target 0: ref -> ok
    mockRefResolution(send, 'obj-a')
    send.mockResolvedValueOnce(callFunctionValue({ attributes: { id: 'first' } }))
    // target 1: selector -> no match (fails independently)
    mockSelectorResolution(send)
    // target 2: selector -> ok
    mockSelectorResolution(send, 'obj-c')
    send.mockResolvedValueOnce(callFunctionValue({ attributes: { id: 'third' } }))

    const batch = await inspectMany(session, [
      { ref: 'e1' },
      { selector: '#missing' },
      { selector: '#third' },
    ])
    expect(batch).toMatchObject({ ok: true, failedCount: 1, generation: 1 })
    expect(batch.results).toHaveLength(3)
    expect(batch.results[0]).toMatchObject({ index: 0, ok: true })
    expect((batch.results[0] as { result: { attributes: Record<string, string> } }).result.attributes.id).toBe('first')
    expect(batch.results[1]).toMatchObject({ index: 1, ok: false })
    expect((batch.results[1] as { error: { code: string } }).error.code).toBe('stale_element')
    expect(batch.results[2]).toMatchObject({ index: 2, ok: true })
    expect((batch.results[2] as { result: { attributes: Record<string, string> } }).result.attributes.id).toBe('third')
  })

  it('forwards requested properties to every batch target', async () => {
    const { session, send } = fakeSession()
    mockSelectorResolution(send, 'obj-a')
    send.mockResolvedValueOnce({ result: { value: { color: 'rgb(0, 0, 255)' } } }) // style fill
    send.mockResolvedValueOnce(callFunctionValue({ attributes: { id: 'a' } }))
    const batch = await inspectMany(session, [{ selector: '#a' }], ['color'])
    expect(batch.results[0]).toMatchObject({ ok: true })
    expect((batch.results[0] as { result: { computedStyle: Record<string, string> } }).result.computedStyle)
      .toEqual({ color: 'rgb(0, 0, 255)' })
  })

  it('rejects more than the batch target cap', async () => {
    const { session } = fakeSession()
    await expect(inspectMany(session, Array.from({ length: 21 }, () => ({ selector: '#x' }))))
      .rejects.toMatchObject({ code: 'internal' })
  })
})
