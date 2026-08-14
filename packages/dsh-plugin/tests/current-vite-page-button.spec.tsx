// @vitest-environment jsdom
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/contract.ts'
import type { BrowserTargetDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'
import { CurrentVitePageButton } from '../src/client/CurrentVitePageButton.tsx'
import { ReferenceStore } from '../src/client/reference-store.ts'
import type { ViteTargetApi } from '../src/client/vite-api.ts'

const TARGET_ID = 't'.repeat(43)
const PAGE_ORIGIN = 'http://127.0.0.1:5173'

const DESCRIPTOR: BrowserTargetDescriptor = {
  targetId: TARGET_ID as never,
  provider: 'vite',
  title: 'Vite Page',
  url: 'http://127.0.0.1:5173/',
  origin: PAGE_ORIGIN,
  projectId: 'app',
  generation: 0,
  capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
}

class FakeApi {
  lists: BrowserTargetDescriptor[] = [DESCRIPTOR]

  async listTargets(): Promise<BrowserTargetDescriptor[]> {
    return this.lists
  }

  async issueGrant(): Promise<{ handle: string }> {
    return { handle: 'h'.repeat(32) }
  }
}

describe('current vite page button', () => {
  it('attaches the verified current page at the end of the draft', async () => {
    const api = new FakeApi()
    const store = new ReferenceStore<BrowserTargetDescriptor>()
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
      <CurrentVitePageButton
        session={session}
        input={input}
        actx={actx}
        api={api as unknown as ViteTargetApi}
        store={store}
        verified={{ targetId: TARGET_ID as never, origin: PAGE_ORIGIN }}
      />,
    )
    const button = renderer.root.findByType('button')
    expect(button.props.children).toContain('@当前开发页')
    await act(async () => {
      button.props.onClick()
    })
    expect(bail).toHaveBeenCalledWith(
      'slash/input-insert-reference',
      expect.objectContaining({
        span: { start: 11, end: 11, draftRev: 7 },
      }),
    )
    const reference = (capturedRequest as { reference: { source: string; label: string; clipboardText: string } }).reference
    expect(reference).toMatchObject({ source: 'vite-pages', label: 'Vite Page', clipboardText: '@Vite Page' })
  })

  it('reports an error when the current page is no longer registered', async () => {
    const api = new FakeApi()
    api.lists = []
    const bail = vi.fn(() => true)
    const actx = { bail } as unknown as ClientContext
    const input = {
      draft: 'x',
      draftRev: 0,
      phase: 'plain',
      occurrences: [],
      queue: [],
    } as unknown as InputState
    const session = { sessionId: 's1' } as unknown as ConversationSnapshot
    const renderer = create(
      <CurrentVitePageButton
        session={session}
        input={input}
        actx={actx}
        api={api as unknown as ViteTargetApi}
        store={new ReferenceStore<BrowserTargetDescriptor>()}
        verified={{ targetId: TARGET_ID as never, origin: PAGE_ORIGIN }}
      />,
    )
    const button = renderer.root.findByType('button')
    await act(async () => {
      button.props.onClick()
    })
    expect(bail).not.toHaveBeenCalled()
    const text = renderer.root.findAll(node => node.type === 'span').map(node => String(node.props.children)).join('')
    expect(text).toContain('current page')
  })
})
