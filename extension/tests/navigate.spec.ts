import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@dsh-external/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { navigatePage } from '../src/cdp/navigate.ts'

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

describe('browser_navigate', () => {
  it('navigates to an absolute HTTP(S) URL with an expected-navigation window', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({ frameId: 'frame-1' })
    const result = await navigatePage(session, { url: 'http://127.0.0.1:4173/next' })
    expect(result).toMatchObject({ ok: true, url: 'http://127.0.0.1:4173/next' })
    expect(send).toHaveBeenCalledWith('Page.navigate', { url: 'http://127.0.0.1:4173/next' })
    expect(session.expectNavigationWindow).not.toBeNull()
  })

  it('rejects non-HTTP(S) and relative URLs', async () => {
    const { session } = fakeSession()
    await expect(navigatePage(session, { url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(navigatePage(session, { url: '/relative' })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(navigatePage(session, { url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('goes back and forward through navigation history', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({
      entries: [
        { id: 1, url: 'http://a.test/' },
        { id: 2, url: 'http://b.test/' },
        { id: 3, url: 'http://c.test/' },
      ],
      currentIndex: 1,
    })
    await navigatePage(session, { history: 'back' })
    expect(send).toHaveBeenCalledWith('Page.navigateToHistoryEntry', { entryId: 1 })

    send.mockResolvedValueOnce({
      entries: [
        { id: 1, url: 'http://a.test/' },
        { id: 2, url: 'http://b.test/' },
      ],
      currentIndex: 0,
    })
    await navigatePage(session, { history: 'forward' })
    expect(send).toHaveBeenCalledWith('Page.navigateToHistoryEntry', { entryId: 2 })
  })

  it('reloads the current page', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({})
    const result = await navigatePage(session, { reload: true })
    expect(result).toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledWith('Page.reload', { ignoreCache: false })
  })

  it('refuses navigation after an unexpected cross-origin transition', async () => {
    const { session } = fakeSession()
    session.onMainFrameNavigated('https://unexpected.example/', { expected: false })
    await expect(navigatePage(session, { url: 'http://127.0.0.1:4173/next' }))
      .rejects.toMatchObject({ code: 'navigation_requires_confirmation' })
  })
})
