// @vitest-environment jsdom
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/contract.ts'
import { CurrentTabButton } from '../src/client/CurrentTabButton.tsx'
import { ReferenceStore } from '../src/client/reference-store.ts'
import type { TabDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'
import type { ExtensionChannel } from '../src/client/extension-channel.ts'

class FakeChannel {
  requests: Array<{ type: string; payload: unknown }> = []

  async request<T>(type: string, payload: unknown): Promise<T> {
    this.requests.push({ type, payload })
    return { tabId: 9, windowId: 3, title: 'App', url: 'http://127.0.0.1:4173/' } as T
  }
}

describe('current tab button', () => {
  it('asks for the current tab and inserts a reference at the end of the draft', async () => {
    const channel = new FakeChannel()
    const store = new ReferenceStore<TabDescriptor>()
    const bail = vi.fn((_name: string, request: unknown) => {
      capturedRequest = request
      return true
    })
    let capturedRequest: unknown
    const actx = { bail } as unknown as ClientContext
    const input = {
      draft: 'verify this',
      draftRev: 7,
      phase: 'plain',
      occurrences: [],
      queue: [],
    } as unknown as InputState
    const session = { sessionId: 's1' } as unknown as ConversationSnapshot

    const renderer = create(
      <CurrentTabButton session={session} input={input} actx={actx} channel={channel as unknown as ExtensionChannel} store={store} />,
    )
    const button = renderer.root.findByType('button')
    expect(button.props.children).toContain('@当前标签页')
    await act(async () => {
      button.props.onClick()
    })
    expect(channel.requests).toContainEqual({ type: 'tabs.current', payload: {} })
    expect(bail).toHaveBeenCalledWith(
      'slash/input-insert-reference',
      expect.objectContaining({
        span: { start: 11, end: 11, draftRev: 7 },
      }),
    )
    const reference = (capturedRequest as { reference: { source: string; label: string; clipboardText: string } }).reference
    expect(reference).toMatchObject({ source: 'browser-tabs', label: 'App', clipboardText: '@App' })
  })

  it('reports an error when the composer changed before insertion', async () => {
    const channel = new FakeChannel()
    const bail = vi.fn(() => undefined)
    const actx = { bail } as unknown as ClientContext
    const input = {
      draft: 'verify this',
      draftRev: 7,
      phase: 'plain',
      occurrences: [],
      queue: [],
    } as unknown as InputState
    const session = { sessionId: 's1' } as unknown as ConversationSnapshot
    const renderer = create(
      <CurrentTabButton session={session} input={input} actx={actx} channel={channel as unknown as ExtensionChannel} store={new ReferenceStore<TabDescriptor>()} />,
    )
    const button = renderer.root.findByType('button')
    await act(async () => {
      button.props.onClick()
    })
    const text = renderer.root.findAll(node => node.type === 'span').map(node => String(node.props.children)).join('')
    expect(text).toContain('could not be attached')
  })

  it('disables while the composer is not in the plain phase', () => {
    const channel = new FakeChannel()
    const actx = { bail: vi.fn() } as unknown as ClientContext
    const session = { sessionId: 's1' } as unknown as ConversationSnapshot
    const submitting = {
      draft: 'x',
      draftRev: 1,
      phase: 'submitting',
      occurrences: [],
      queue: [],
    } as unknown as InputState
    const renderer = create(
      <CurrentTabButton session={session} input={submitting} actx={actx} channel={channel as unknown as ExtensionChannel} store={new ReferenceStore<TabDescriptor>()} />,
    )
    const button = renderer.root.findByType('button')
    expect(button.props.disabled).toBe(true)
    expect(button.props.title).toBe('Attach current tab')
  })
})
