import { afterEach, describe, expect, it, vi } from 'vitest'
import { createViteTargetApi, type ViteTargetApi } from '../src/client/vite-api.ts'

const DSH_ORIGIN = 'http://127.0.0.1:3080'
const TARGET_ID = 't'.repeat(43)

const TARGET = {
  targetId: TARGET_ID,
  provider: 'vite' as const,
  title: 'Vite Page',
  url: 'http://127.0.0.1:5173/',
  origin: 'http://127.0.0.1:5173',
  projectId: 'app',
  generation: 0,
  capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const value = await handler(String(url), init)
    return {
      ok: true,
      status: 200,
      json: async () => value,
    } as unknown as Response
  }))
}

describe('vite target api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists targets from the exact local DSH origin without credentials', async () => {
    let seen: { url: string; init?: RequestInit } | undefined
    stubFetch(async (url, init) => {
      seen = { url, init }
      return [TARGET]
    })
    const api = createViteTargetApi(DSH_ORIGIN)
    const targets = await api.listTargets()
    expect(seen!.url).toBe(`${DSH_ORIGIN}/dsh-browser-bridge/vite/targets`)
    expect(seen!.init?.credentials).toBe('omit')
    expect(targets[0]).toMatchObject({ targetId: TARGET_ID, provider: 'vite' })
  })

  it('issues one grant for a session and target', async () => {
    let body: unknown
    let method = ''
    stubFetch(async (_url, init) => {
      method = init?.method ?? ''
      body = init?.body
      return { handle: 'h'.repeat(32) }
    })
    const api = createViteTargetApi(DSH_ORIGIN)
    const { handle } = await api.issueGrant('session-a', TARGET_ID as never)
    expect(method).toBe('POST')
    expect(String(body)).toContain('"sessionId":"session-a"')
    expect(String(body)).toContain(`"targetId":"${TARGET_ID}"`)
    expect(handle).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
  })

  it('propagates non-OK responses as errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response))
    const api = createViteTargetApi(DSH_ORIGIN)
    await expect(api.listTargets()).rejects.toThrow(/403/)
    await expect(api.issueGrant('s', TARGET_ID as never)).rejects.toThrow(/403/)
  })

  it('propagates abort signals', async () => {
    stubFetch(async (_url, init) => {
      expect(init?.signal).toBeDefined()
      return []
    })
    const api: ViteTargetApi = createViteTargetApi(DSH_ORIGIN)
    const controller = new AbortController()
    await api.listTargets(controller.signal)
  })
})
