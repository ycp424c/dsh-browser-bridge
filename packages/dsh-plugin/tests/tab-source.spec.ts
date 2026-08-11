import { describe, expect, it, vi } from 'vitest'
import type { SlashCandidate, SlashPick, TokenSpan } from '@deepseek-ai/dsh-client-ui-slash/src/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TabDescriptor } from '@dsh-external/dsh-browser-bridge-protocol'
import { ReferenceStore } from '../src/client/reference-store.ts'
import { createTabSource } from '../src/client/tab-source.ts'
import type { ExtensionChannel } from '../src/client/extension-channel.ts'

const s = (value: string): SessionId => value as unknown as SessionId

const TABS: TabDescriptor[] = [
  { tabId: 1, windowId: 1, title: 'Dashboard', url: 'http://127.0.0.1:4173/' },
  { tabId: 2, windowId: 1, title: 'Dashboard', url: 'http://127.0.0.1:4174/' },
  { tabId: 3, windowId: 1, title: 'Dashboard', url: 'http://127.0.0.1:4173/settings' },
]

class FakeChannel {
  requests: Array<{ type: string; payload: unknown }> = []
  replies = new Map<string, unknown>()
  parentMessages: unknown[] = []

  async request<T>(type: string, payload: unknown): Promise<T> {
    this.requests.push({ type, payload })
    const reply = this.replies.get(type)
    if (reply instanceof Error) throw reply
    return reply as T
  }

  post(message: unknown): void {
    this.parentMessages.push(message)
  }
}

function pick(candidate: SlashCandidate, span: TokenSpan = { start: 1, end: 1, draftRev: 0 }): SlashPick {
  return { candidate, session: { sessionId: s('s1') }, position: 'leading', via: 'menu', span }
}

function request(query: string): { query: string; position: 'leading'; signal: AbortSignal } {
  return { query, position: 'leading', signal: new AbortController().signal }
}

describe('browser-tabs source', () => {
  it('lists eligible tabs with human-readable duplicate-title names', async () => {
    const channel = new FakeChannel()
    channel.replies.set('tabs.list', TABS)
    const store = new ReferenceStore<TabDescriptor>()
    const source = createTabSource(channel as unknown as ExtensionChannel, store)
    expect(source.trigger).toBe('@')
    expect(source.name).toBe('browser-tabs')
    expect(source.order).toBe(-20)
    const candidates = await source.candidates({ sessionId: s('s1') }, request(''))
    expect(candidates.map(item => item.name)).toEqual([
      'Dashboard — 127.0.0.1:4173',
      'Dashboard — 127.0.0.1:4174',
      'Dashboard — 127.0.0.1:4173 (2)',
    ])
  })

  it('allocates a reference on pick and serializes a grant marker on submit', async () => {
    const channel = new FakeChannel()
    channel.replies.set('tabs.list', TABS)
    channel.replies.set('grant.create', { handle: 'h'.repeat(32) })
    const store = new ReferenceStore<TabDescriptor>()
    const source = createTabSource(channel as unknown as ExtensionChannel, store)
    const candidates = await source.candidates({ sessionId: s('s1') }, request(''))
    const outcome = source.onPick(pick(candidates[0]!))
    expect(outcome).toMatchObject({ insert: { source: 'browser-tabs', label: 'Dashboard', clipboardText: '@Dashboard' } })
    const ref = (outcome as { insert: { ref: string } }).insert.ref
    const marker = await source.codec!.serialize(ref, new AbortController().signal)
    expect(marker).toMatch(/^\[\[dsh-browser-context:[A-Za-z0-9_-]{32,64}\]\]$/)
    const grantRequest = channel.requests.find(item => item.type === 'grant.create')
    expect(grantRequest).toMatchObject({ payload: { sessionId: 's1', tab: { tabId: 1 } } })
  })

  it('rejects submit when the grant cannot be created', async () => {
    const channel = new FakeChannel()
    channel.replies.set('tabs.list', TABS)
    channel.replies.set('grant.create', new Error('tab closed'))
    const source = createTabSource(channel as unknown as ExtensionChannel, new ReferenceStore<TabDescriptor>())
    const candidates = await source.candidates({ sessionId: s('s1') }, request(''))
    const outcome = source.onPick(pick(candidates[0]!))
    const ref = (outcome as { insert: { ref: string } }).insert.ref
    await expect(source.codec!.serialize(ref, new AbortController().signal)).rejects.toThrow('tab closed')
  })

  it('binds the reference to the session that picked it', async () => {
    const channel = new FakeChannel()
    channel.replies.set('tabs.list', TABS)
    const store = new ReferenceStore<TabDescriptor>()
    const source = createTabSource(channel as unknown as ExtensionChannel, store)
    const candidates = await source.candidates({ sessionId: s('s1') }, request(''))
    const outcome = source.onPick(pick(candidates[0]!))
    const ref = (outcome as { insert: { ref: string } }).insert.ref
    expect(store.get(ref, s('s1'))?.target.tabId).toBe(1)
    expect(store.get(ref, s('other'))).toBeUndefined()
  })

  it('evicts stale references and caps entries per session', () => {
    let now = 1_000
    const store = new ReferenceStore<TabDescriptor>({ now: () => now, maxEntries: 2, maxAgeMs: 10 * 60_000 })
    const a = store.allocate(s('s1'), TABS[0]!, 'Dashboard')
    const b = store.allocate(s('s1'), TABS[1]!, 'Dashboard')
    store.allocate(s('s1'), TABS[2]!, 'Dashboard')
    expect(store.get(a.ref, s('s1'))).toBeUndefined()
    expect(store.get(b.ref, s('s1'))?.target.tabId).toBe(2)
    now = 1_000 + 11 * 60_000
    expect(store.get(b.ref, s('s1'))).toBeUndefined()
  })
})
