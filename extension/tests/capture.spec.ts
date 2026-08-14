import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { captureScreenshot } from '../src/cdp/capture.ts'

const FIXTURE_URL = 'http://127.0.0.1:4173/'

function fakeSession(): { session: TabSession; send: ReturnType<typeof vi.fn>; refs: NodeRegistry } {
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
      currentUrl: FIXTURE_URL,
      lastChangeAt: null,
      expectNavigationWindow: null,
      expectNavigation: () => {},
      onMainFrameNavigated: () => {},
      send,
    } as unknown as TabSession,
    send,
    refs,
  }
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

  it('clips to a referenced element', async () => {
    const { session, send, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    send.mockResolvedValueOnce({ nodeIds: [100] })
    send.mockResolvedValueOnce({
      model: { content: [10, 20, 130, 20, 130, 52, 10, 52] },
    })
    send.mockResolvedValueOnce({ data: 'iVBORw0KGgo=' })
    const result = await captureScreenshot(session, { ref: 'e1' })
    expect(result).toMatchObject({ mimeType: 'image/png', data: 'iVBORw0KGgo=', url: FIXTURE_URL })
    const clipCall = send.mock.calls.find(call => call[0] === 'Page.captureScreenshot')
    expect((clipCall![1] as { clip: { x: number; y: number; width: number; height: number; scale: number } }).clip)
      .toEqual({ x: 10, y: 20, width: 120, height: 32, scale: 1 })
  })

  it('rejects zero-area or off-document boxes as stale', async () => {
    const { session, send, refs } = fakeSession()
    refs.register(42, 'frame-1', 1)
    send.mockResolvedValueOnce({ nodeIds: [100] })
    send.mockResolvedValueOnce({
      model: { content: [0, 0, 0, 0, 0, 0, 0, 0] },
    })
    await expect(captureScreenshot(session, { ref: 'e1' })).rejects.toMatchObject({ code: 'stale_element' })
  })

  it('rejects an unknown element reference', async () => {
    const { session } = fakeSession()
    await expect(captureScreenshot(session, { ref: 'nope' })).rejects.toMatchObject({ code: 'stale_element' })
  })
})
