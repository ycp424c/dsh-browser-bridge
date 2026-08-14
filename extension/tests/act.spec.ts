import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { click, focus, hover, performAction, press, scroll, select, typeText, type ActAction } from '../src/cdp/act.ts'

const FIXTURE_URL = 'http://127.0.0.1:4173/'

function fakeSession(overrides: Partial<TabSession> = {}): { session: TabSession; send: ReturnType<typeof vi.fn>; refs: NodeRegistry } {
  const refs = new NodeRegistry({ randomId: () => ElementRef('e1') })
  const send = vi.fn()
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
    send,
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
  return { session, send, refs }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

async function withRef(session: TabSession, send: ReturnType<typeof vi.fn>): Promise<void> {
  session.refs.register(42, 'frame-1', 1)
  send.mockResolvedValueOnce({ nodeIds: [100] }) // pushNodesByBackendIdsToFrontend
}

describe('browser_act', () => {
  it('clicks the center of a referenced element', async () => {
    const { session, send, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    send.mockResolvedValueOnce({ nodeIds: [100] })
    send.mockResolvedValueOnce({
      model: { content: [10, 20, 130, 20, 130, 52, 10, 52] },
    })
    send.mockResolvedValueOnce({})
    send.mockResolvedValueOnce({})
    const result = await click(session, 'e1')
    expect(result).toMatchObject({ ok: true, url: FIXTURE_URL })
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 70, y: 36 }))
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', x: 70, y: 36 }))
    void session
  })

  it('fails a stale reference', async () => {
    const { session } = fakeSession()
    await expect(click(session, 'nope')).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('refuses writes after an unexpected cross-origin navigation', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    session.onMainFrameNavigated('https://unexpected.example/', { expected: false })
    await expect(click(session, 'e1')).rejects.toMatchObject({ code: 'navigation_requires_confirmation' })
  })

  it('types by replacing or appending text', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // resolveNode for selection
    send.mockResolvedValueOnce({ result: { value: true } }) // select-all
    send.mockResolvedValueOnce({}) // backspace down
    send.mockResolvedValueOnce({}) // backspace up
    send.mockResolvedValueOnce({}) // insertText
    const replace = { kind: 'type', ref: 'e1', text: 'hello', replace: true } as const
    await expect(typeText(session, replace)).resolves.toMatchObject({ ok: true })
    const selectCall = send.mock.calls.find(call => call[0] === 'Runtime.callFunctionOn')
    expect(selectCall).toBeDefined()
    expect(String((selectCall![1] as { functionDeclaration?: string }).functionDeclaration)).toContain('this.select()')
    expect(send).toHaveBeenCalledWith('Input.insertText', { text: 'hello' })
  })

  it('selects an option and dispatches input/change events', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce({ object: { objectId: 'obj' } })
    send.mockResolvedValueOnce({ result: { value: true } })
    const action: ActAction = { kind: 'select', ref: 'e1', value: 'b' }
    await expect(select(session, action)).resolves.toMatchObject({ ok: true })
    const call = send.mock.calls.find(call => call[0] === 'Runtime.callFunctionOn')
    expect(call).toBeDefined()
    const declaration = String((call![1] as { functionDeclaration?: string }).functionDeclaration)
    expect(declaration).toContain('input')
    expect(declaration).toContain('change')
  })

  it('hovers, focuses, presses keys, and scrolls', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } })
    await expect(hover(session, 'e1')).resolves.toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved', x: 5, y: 5 }))

    send.mockResolvedValueOnce({ nodeIds: [100] })
    send.mockResolvedValueOnce({})
    await expect(focus(session, 'e1')).resolves.toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith('DOM.focus', { nodeId: 100 })

    send.mockResolvedValueOnce({})
    send.mockResolvedValueOnce({})
    await expect(press(session, 'Enter')).resolves.toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', key: 'Enter' }))

    send.mockResolvedValueOnce({ nodeIds: [100] })
    send.mockResolvedValueOnce({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } })
    send.mockResolvedValueOnce({})
    await expect(scroll(session, 'e1', { deltaY: 100 })).resolves.toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseWheel', deltaY: 100 }))
  })

  it('routes every action through performAction', async () => {
    const { session, send } = fakeSession()
    await withRef(session, send)
    send.mockResolvedValueOnce({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } })
    send.mockResolvedValueOnce({})
    send.mockResolvedValueOnce({})
    await expect(performAction(session, { kind: 'click', ref: 'e1' })).resolves.toMatchObject({ ok: true })
    void session
  })
})
