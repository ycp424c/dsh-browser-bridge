import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { captureScreenshot } from '../src/cdp/capture.ts'

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
      currentUrl: FIXTURE_URL,
      lastChangeAt: null,
      expectNavigationWindow: null,
      expectNavigation: () => {},
      onMainFrameNavigated: () => {},
      send: sessionSend,
    } as unknown as TabSession,
    send,
    sessionSend,
    refs,
  }
}

function callValue(value: unknown): Record<string, unknown> {
  return { result: { value } }
}

describe('browser_screenshot', () => {
  it('captures the viewport as a PNG with exact metadata', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({ data: 'iVBORw0KGgo=' })
    const result = await captureScreenshot(session, {})
    expect(result).toMatchObject({ mimeType: 'image/png', data: 'iVBORw0KGgo=', url: FIXTURE_URL })
    expect(send).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    expect(JSON.stringify(result)).not.toContain('consoleEntries')
  })

  it('clips to a referenced element via stable runtime resolution', async () => {
    const { session, send, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    send.mockResolvedValueOnce({ object: { objectId: 'obj' } }) // DOM.resolveNode by backend id
    send.mockResolvedValueOnce(callValue({ x: 10, y: 20, width: 120, height: 32, visible: true }))
    send.mockResolvedValueOnce({ data: 'iVBORw0KGgo=' })
    const result = await captureScreenshot(session, { ref: 'e1' })
    expect(result).toMatchObject({ mimeType: 'image/png', data: 'iVBORw0KGgo=', url: FIXTURE_URL })
    const clipCall = send.mock.calls.find(call => call[0] === 'Page.captureScreenshot')
    expect((clipCall![1] as { clip: { x: number; y: number; width: number; height: number; scale: number } }).clip)
      .toEqual({ x: 10, y: 20, width: 120, height: 32, scale: 1 })
    expect(send).not.toHaveBeenCalledWith('DOM.getBoxModel', expect.anything())
  })

  it('rejects zero-area boxes as stale', async () => {
    const { session, send, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    send.mockResolvedValueOnce({ object: { objectId: 'obj' } })
    send.mockResolvedValueOnce(callValue({ x: 0, y: 0, width: 0, height: 0, visible: false }))
    await expect(captureScreenshot(session, { ref: 'e1' })).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('rejects an unknown element reference', async () => {
    const { session } = fakeSession()
    await expect(captureScreenshot(session, { ref: 'nope' })).rejects.toMatchObject({ code: 'stale_element' })
  })
})
