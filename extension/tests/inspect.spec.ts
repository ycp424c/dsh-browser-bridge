import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@dsh-external/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { inspectElement } from '../src/cdp/inspect.ts'

const FIXTURE_URL = 'http://127.0.0.1:4173/'

function fakeSession(): { session: TabSession; send: ReturnType<typeof vi.fn> } {
  const refs = new NodeRegistry({ randomId: () => ElementRef('e1') })
  const send = vi.fn()
  return {
    session: {
      tabId: 7,
      generation: 1,
      attached: true,
      refs,
      writeSuspended: false,
      consoleEntries: [],
      networkEntries: [],
      send,
    } as unknown as TabSession,
    send,
  }
}

function callFunctionValue(): Record<string, unknown> {
  return {
    result: {
      value: {
        attributes: { id: 'save', class: 'btn' },
        text: 'Save',
        rect: { x: 10, y: 20, width: 120, height: 32 },
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        viewportIntersects: true,
      },
    },
  }
}

describe('browser_inspect', () => {
  it('inspects a referenced element with computed style, geometry, and visibility', async () => {
    const { session, send, } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    send.mockResolvedValueOnce({ nodeIds: [100] }) // pushNodesByBackendIdsToFrontend
    send.mockResolvedValueOnce({
      computedStyle: [
        { name: 'color', value: 'rgb(0, 0, 255)' },
        { name: 'padding', value: '16px' },
      ],
    })
    send.mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // resolveNode
    send.mockResolvedValueOnce(callFunctionValue())
    const inspected = await inspectElement(session, { ref: 'e1' })
    expect(inspected).toMatchObject({
      ref: 'e1',
      visible: true,
      rect: { x: 10, y: 20, width: 120, height: 32 },
      computedStyle: { color: 'rgb(0, 0, 255)', padding: '16px' },
    })
    expect(inspected.attributes).toMatchObject({ id: 'save' })
    expect(inspected.text).toBe('Save')
    expect(send).toHaveBeenCalledWith('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [42] })
  })

  it('resolves selectors under the main document', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({ root: { nodeId: 1 } }) // getDocument
    send.mockResolvedValueOnce({ nodeId: 200 }) // querySelector
    send.mockResolvedValueOnce({
      computedStyle: [{ name: 'color', value: 'rgb(255, 0, 0)' }],
    })
    send.mockResolvedValueOnce({ object: { objectId: 'obj-2' } })
    send.mockResolvedValueOnce({
      result: {
        value: {
          attributes: { id: 'save' },
          text: 'Save',
          rect: { x: 0, y: 0, width: 10, height: 10 },
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          viewportIntersects: true,
        },
      },
    })
    const inspected = await inspectElement(session, { selector: '#save', properties: ['color'] })
    expect(inspected).toMatchObject({ selector: '#save', computedStyle: { color: 'rgb(255, 0, 0)' } })
    expect(send).toHaveBeenCalledWith('DOM.querySelector', { nodeId: 1, selector: '#save' })
  })

  it('resolves requested shorthand properties through the page getComputedStyle', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    send.mockResolvedValueOnce({ nodeIds: [100] })
    // CDP returns longhands only: the requested `padding` shorthand is absent.
    send.mockResolvedValueOnce({ computedStyle: [{ name: 'color', value: 'rgb(0, 0, 255)' }] })
    send.mockResolvedValueOnce({ object: { objectId: 'obj-5' } })
    send.mockResolvedValueOnce({
      result: {
        value: {
          attributes: { id: 'save' },
          text: 'Save',
          rect: { x: 0, y: 0, width: 10, height: 10 },
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          viewportIntersects: true,
        },
      },
    })
    send.mockResolvedValueOnce({
      result: { value: { padding: '8px' } },
    })
    const inspected = await inspectElement(session, { ref: 'e1', properties: ['color', 'padding'] })
    expect(inspected.computedStyle).toEqual({ color: 'rgb(0, 0, 255)', padding: '8px' })
  })

  it('fails a stale reference', async () => {
    const { session } = fakeSession()
    await expect(inspectElement(session, { ref: 'nope' })).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('fails a selector that matches nothing', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({ root: { nodeId: 1 } })
    send.mockResolvedValueOnce({ nodeId: 0 })
    await expect(inspectElement(session, { selector: '#missing' })).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('computes visibility from display, visibility, opacity, and viewport intersection', async () => {
    const { session, send } = fakeSession()
    session.refs.register(42, 'frame-1', 1)
    send.mockResolvedValueOnce({ nodeIds: [100] })
    send.mockResolvedValueOnce({ computedStyle: [] })
    send.mockResolvedValueOnce({ object: { objectId: 'obj-3' } })
    send.mockResolvedValueOnce({
      result: {
        value: {
          attributes: {},
          text: '',
          rect: { x: 0, y: 0, width: 100, height: 100 },
          display: 'none',
          visibility: 'visible',
          opacity: '1',
          viewportIntersects: true,
        },
      },
    })
    const hidden = await inspectElement(session, { ref: 'e1' })
    expect(hidden.visible).toBe(false)

    send.mockResolvedValueOnce({ nodeIds: [101] })
    send.mockResolvedValueOnce({ computedStyle: [] })
    send.mockResolvedValueOnce({ object: { objectId: 'obj-4' } })
    send.mockResolvedValueOnce({
      result: {
        value: {
          attributes: {},
          text: '',
          rect: { x: 0, y: 0, width: 100, height: 100 },
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          viewportIntersects: false,
        },
      },
    })
    const offscreen = await inspectElement(session, { ref: 'e1' })
    expect(offscreen.visible).toBe(false)
  })
})
