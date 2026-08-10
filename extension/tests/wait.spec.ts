import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@dsh-external/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { waitForCondition, type WaitCondition } from '../src/cdp/wait.ts'

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

function evaluateResult(value: unknown): Record<string, unknown> {
  return { result: { value } }
}

describe('browser_wait', () => {
  it('waits for a visible selector', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce(evaluateResult({ found: true, visible: false }))
    send.mockResolvedValueOnce(evaluateResult({ found: true, visible: true }))
    const result = await waitForCondition(session, { kind: 'selector', selector: '#save', state: 'visible' }, { timeoutMs: 5_000 })
    expect(result).toMatchObject({ url: FIXTURE_URL })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(send.mock.calls.filter(call => call[0] === 'Runtime.evaluate')).toHaveLength(2)
  })

  it('times out with a stable error and observes abort', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValue(evaluateResult({ found: false, visible: false }))
    await expect(waitForCondition(session, { kind: 'selector', selector: '#missing', state: 'attached' }, { timeoutMs: 120 }))
      .rejects.toMatchObject({ code: 'timeout' })

    const controller = new AbortController()
    const pending = waitForCondition(session, { kind: 'text', text: 'never', state: 'present' }, { timeoutMs: 5_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('waits for text presence and absence', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce(evaluateResult({ text: 'loading…' }))
    send.mockResolvedValueOnce(evaluateResult({ text: 'done!' }))
    await expect(waitForCondition(session, { kind: 'text', text: 'done', state: 'present' }, { timeoutMs: 5_000 })).resolves.toBeDefined()

    send.mockResolvedValueOnce(evaluateResult({ text: 'spinner' }))
    send.mockResolvedValueOnce(evaluateResult({ text: '' }))
    await expect(waitForCondition(session, { kind: 'text', text: 'spinner', state: 'absent' }, { timeoutMs: 5_000 })).resolves.toBeDefined()
  })

  it('waits for URL patterns and ready states', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce(evaluateResult({ url: 'http://127.0.0.1:4173/loading' }))
    send.mockResolvedValueOnce(evaluateResult({ url: 'http://127.0.0.1:4173/done' }))
    await expect(waitForCondition(session, { kind: 'url', pattern: '/done' }, { timeoutMs: 5_000 })).resolves.toBeDefined()

    send.mockResolvedValueOnce(evaluateResult({ readyState: 'loading' }))
    send.mockResolvedValueOnce(evaluateResult({ readyState: 'complete' }))
    await expect(waitForCondition(session, { kind: 'ready', state: 'complete' }, { timeoutMs: 5_000 })).resolves.toBeDefined()
  })

  it('waits for a bounded stability window', async () => {
    const { session } = fakeSession()
    const result = await waitForCondition(session, { kind: 'stable', quietMs: 50 }, { timeoutMs: 5_000 })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(50)
  })

  it('restarts the stability window when the DOM changes', async () => {
    let now = 1_000
    const { session } = fakeSession()
    session.lastChangeAt = 1_000
    let changes = 0
    const result = await waitForCondition(session, { kind: 'stable', quietMs: 100 }, {
      timeoutMs: 5_000,
      now: () => now,
      onChange: () => {
        changes += 1
        if (changes === 1) session.lastChangeAt = 1_200
        now += 200
      },
    })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100)
    expect(changes).toBeGreaterThan(1)
  })
})
