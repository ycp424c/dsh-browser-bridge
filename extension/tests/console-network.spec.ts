import { describe, expect, it } from 'vitest'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { consoleEntries, networkEntries, normalizeConsoleEntry, normalizeNetworkEntry, pushBounded } from '../src/cdp/capture.ts'

const FIXTURE_URL = 'http://127.0.0.1:4173/'

function makeSession(): TabSession {
  return {
    tabId: 7,
    generation: 1,
    attached: true,
    refs: undefined as never,
    writeSuspended: false,
    consoleEntries: [],
    networkEntries: [],
    currentUrl: FIXTURE_URL,
    lastChangeAt: null,
    expectNavigationWindow: null,
    expectNavigation: () => {},
    onMainFrameNavigated: () => {},
    send: () => Promise.resolve({}),
  } as unknown as TabSession
}

describe('console and network evidence', () => {
  it('normalizes console API calls into bounded rows', () => {
    const session = makeSession()
    const row = normalizeConsoleEntry('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'fixture failed' }],
      stackTrace: { callFrames: [{ url: `${FIXTURE_URL}app.js` }] },
    })
    expect(row).toMatchObject({ level: 'error', text: 'fixture failed', url: `${FIXTURE_URL}app.js` })
    expect(typeof row!.timestamp).toBe('number')
    session.consoleEntries.push(row!)
    expect(consoleEntries(session)).toEqual([expect.objectContaining({ level: 'error', text: 'fixture failed' })])
  })

  it('normalizes log entries with their own level and url', () => {
    const row = normalizeConsoleEntry('Log.entryAdded', {
      entry: { level: 'warning', text: 'slow network', url: FIXTURE_URL },
    })
    expect(row).toMatchObject({ level: 'warning', text: 'slow network', url: FIXTURE_URL })
  })

  it('normalizes failed HTTP responses and loading failures without headers or bodies', () => {
    const session = makeSession()
    const failed = normalizeNetworkEntry('Network.responseReceived', {
      requestId: 'r1',
      response: { status: 404, url: `${FIXTURE_URL}missing` },
      type: 'Document',
    })
    expect(failed).toMatchObject({ url: `${FIXTURE_URL}missing`, status: 404 })
    session.networkEntries.push(failed!)

    const broken = normalizeNetworkEntry('Network.loadingFailed', {
      requestId: 'r2',
      errorText: 'net::ERR_CONNECTION_RESET',
    })
    expect(broken).toMatchObject({ error: 'net::ERR_CONNECTION_RESET' })
    session.networkEntries.push(broken!)

    expect(networkEntries(session)).toEqual([
      expect.objectContaining({ url: `${FIXTURE_URL}missing`, status: 404 }),
      expect.objectContaining({ error: 'net::ERR_CONNECTION_RESET' }),
    ])
    // Sensitive headers are never captured.
    const projection = JSON.stringify(networkEntries(session))
    expect(projection).not.toMatch(/authorization|cookie/i)
  })

  it('records the request method via requestWillBeSent correlation', () => {
    const session = makeSession()
    normalizeNetworkEntry('Network.requestWillBeSent', {
      requestId: 'r9',
      request: { method: 'POST', url: `${FIXTURE_URL}api` },
    })
    const row = normalizeNetworkEntry('Network.responseReceived', {
      requestId: 'r9',
      response: { status: 500, url: `${FIXTURE_URL}api` },
    })
    expect(row).toMatchObject({ method: 'POST', url: `${FIXTURE_URL}api`, status: 500 })
    void session
  })

  it('ignores successful responses', () => {
    const row = normalizeNetworkEntry('Network.responseReceived', {
      requestId: 'r3',
      response: { status: 200, url: FIXTURE_URL },
    })
    expect(row).toBeNull()
  })

  it('keeps a bounded ring buffer', () => {
    const session = makeSession()
    for (let i = 0; i < 250; i += 1) {
      pushBounded(session.consoleEntries, { timestamp: i, level: 'log', text: `line ${i}`, url: FIXTURE_URL }, 200)
    }
    expect(consoleEntries(session)).toHaveLength(200)
    expect(consoleEntries(session)[0]).toMatchObject({ text: 'line 50' })
  })
})
