import { describe, expect, it, vi } from 'vitest'
import type { InputTriggerCandidate, InputTriggerPick, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/src/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BrowserTargetDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'
import { ReferenceStore } from '../src/client/reference-store.ts'
import { createViteSource } from '../src/client/vite-source.ts'
import type { ViteTargetApi } from '../src/client/vite-api.ts'

const s = (value: string): SessionId => value as unknown as SessionId

const TARGETS: BrowserTargetDescriptor[] = [
  {
    targetId: 'a'.repeat(43),
    provider: 'vite',
    title: 'Admin',
    url: 'http://127.0.0.1:5173/admin',
    origin: 'http://127.0.0.1:5173',
    projectId: 'admin-app',
    generation: 0,
    capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
  },
  {
    targetId: 'b'.repeat(43),
    provider: 'vite',
    title: 'Admin',
    url: 'http://127.0.0.1:5174/',
    origin: 'http://127.0.0.1:5174',
    projectId: 'admin-app',
    generation: 0,
    capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
  },
]

class FakeApi {
  lists: BrowserTargetDescriptor[] = []
  grants: Array<{ sessionId: string; targetId: string }> = []

  async listTargets(): Promise<BrowserTargetDescriptor[]> {
    return this.lists
  }

  async issueGrant(sessionId: string, targetId: string): Promise<{ handle: string }> {
    this.grants.push({ sessionId, targetId })
    return { handle: 'h'.repeat(32) }
  }
}

function pick(candidate: InputTriggerCandidate, span: TokenSpan = { start: 1, end: 1, draftRev: 0 }): InputTriggerPick {
  return { candidate, session: { sessionId: s('s1') }, position: 'leading', via: 'menu', span }
}

function request(query: string): { query: string; position: 'leading'; signal: AbortSignal } {
  return { query, position: 'leading', signal: new AbortController().signal }
}

describe('vite-pages source', () => {
  it('lists connected Vite pages with host and project id in the label', async () => {
    const api = new FakeApi()
    api.lists = TARGETS
    const source = createViteSource(api as unknown as ViteTargetApi, new ReferenceStore<BrowserTargetDescriptor>())
    expect(source.trigger).toBe('@')
    expect(source.name).toBe('vite-pages')
    const candidates = await source.candidates({ sessionId: s('s1') }, request(''))
    expect(candidates.map(item => item.name)).toEqual([
      'Admin — 127.0.0.1:5173 (admin-app)',
      'Admin — 127.0.0.1:5174 (admin-app)',
    ])
  })

  it('allocates a reference on pick and issues the grant only at submit time', async () => {
    const api = new FakeApi()
    api.lists = TARGETS
    const store = new ReferenceStore<BrowserTargetDescriptor>()
    const source = createViteSource(api as unknown as ViteTargetApi, store)
    const candidates = await source.candidates({ sessionId: s('s1') }, request(''))
    const outcome = source.onPick(pick(candidates[0]!))
    expect(outcome).toMatchObject({ insert: { source: 'vite-pages', label: 'Admin', clipboardText: '@Admin' } })
    expect(api.grants).toHaveLength(0)
    const ref = (outcome as { insert: { ref: string } }).insert.ref
    const marker = await source.codec!.serialize(ref, new AbortController().signal)
    expect(marker).toMatch(/^\[\[dsh-browser-context:[A-Za-z0-9_-]{32,64}\]\]$/)
    expect(api.grants).toEqual([{ sessionId: 's1', targetId: 'a'.repeat(43) }])
  })

  it('fails submit when the reference expired', async () => {
    const api = new FakeApi()
    api.lists = TARGETS
    const source = createViteSource(api as unknown as ViteTargetApi, new ReferenceStore<BrowserTargetDescriptor>())
    await expect(source.codec!.serialize('u'.repeat(32), new AbortController().signal))
      .rejects.toThrow(/expired/)
  })
})
