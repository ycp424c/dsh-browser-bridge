import { describe, expect, it, vi } from 'vitest'
import { ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from '../src/cdp/session-manager.ts'
import { NodeRegistry } from '../src/cdp/nodes.ts'
import { observePage } from '../src/cdp/observe.ts'

const FIXTURE_URL = 'http://127.0.0.1:4173/'

function axNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId: 'n',
    ignored: false,
    role: { value: 'generic' },
    name: { value: '' },
    ...overrides,
  }
}

function fakeSession(): { session: TabSession; send: ReturnType<typeof vi.fn>; refs: NodeRegistry } {
  let next = 0
  const refs = new NodeRegistry({ randomId: () => ElementRef(`e${++next}`) })
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
      send,
    } as unknown as TabSession,
    send,
    refs,
  }
}

describe('browser_observe', () => {
  it('returns page identity, viewport, semantic nodes, and text', async () => {
    const { session, send, refs } = fakeSession()
    send.mockResolvedValueOnce({
      result: {
        value: {
          url: FIXTURE_URL,
          title: 'Fixture',
          readyState: 'complete',
          viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
        },
      },
    })
    send.mockResolvedValueOnce({
      nodes: [
        axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 42, childIds: ['2', '3'] }),
        axNode({ nodeId: '2', role: { value: 'heading' }, name: { value: 'Welcome' } }),
        axNode({ nodeId: '3', role: { value: 'none' }, ignored: true }),
      ],
    })
    const result = await observePage(session, {})
    expect(result.page).toMatchObject({ url: FIXTURE_URL, title: 'Fixture', generation: 1 })
    expect(result.viewport).toEqual({ width: 800, height: 600, scrollX: 0, scrollY: 0 })
    expect(result.nodes).toContainEqual(expect.objectContaining({ ref: 'e1', role: 'button', name: 'Save' }))
    expect(result.text).toContain('Save')
    expect(result.text).toContain('Welcome')
    expect(refs.resolve('e1', 1).backendNodeId).toBe(42)
    expect(send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ returnByValue: true }))
    expect(send).toHaveBeenCalledWith('Accessibility.getFullAXTree', {})
  })

  it('never returns password or secret values', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({
      result: { value: { url: FIXTURE_URL, title: 'T', readyState: 'complete', viewport: { width: 1, height: 1, scrollX: 0, scrollY: 0 } } },
    })
    send.mockResolvedValueOnce({
      nodes: [
        axNode({ nodeId: '1', role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'secret-value' }, childIds: ['2', '3'] }),
        axNode({ nodeId: '2', role: { value: 'textbox' }, name: { value: 'Card number' }, value: { value: '4111' } }),
        axNode({ nodeId: '3', role: { value: 'textbox' }, name: { value: 'Name' }, value: { value: 'public-name' } }),
      ],
    })
    const result = await observePage(session, {})
    expect(JSON.stringify(result)).not.toContain('secret-value')
    expect(JSON.stringify(result)).not.toContain('4111')
    expect(result.nodes.find(node => node.name === 'Name')?.value).toBe('public-name')
  })

  it('descends through ignored wrapper nodes to expose their children', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({
      result: { value: { url: FIXTURE_URL, title: 'T', readyState: 'complete', viewport: { width: 1, height: 1, scrollX: 0, scrollY: 0 } } },
    })
    send.mockResolvedValueOnce({
      nodes: [
        axNode({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'T' }, childIds: ['2'] }),
        // A presentational wrapper marked ignored sits between the root and
        // the interactive child; the walk must not skip its subtree.
        axNode({ nodeId: '2', role: { value: 'none' }, ignored: true, childIds: ['3'] }),
        axNode({ nodeId: '3', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 42 }),
      ],
    })
    const result = await observePage(session, {})
    expect(result.nodes).toContainEqual(expect.objectContaining({ role: 'button', name: 'Save' }))
    expect(result.nodes).not.toContainEqual(expect.objectContaining({ role: 'none' }))
    expect(result.text).toContain('Save')
  })

  it('does not publish unusable refs for semantic nodes without a DOM backend', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({
      result: { value: { url: FIXTURE_URL, title: 'T', readyState: 'complete', viewport: { width: 1, height: 1, scrollX: 0, scrollY: 0 } } },
    })
    send.mockResolvedValueOnce({
      nodes: [
        axNode({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'T' }, backendDOMNodeId: 1, childIds: ['2'] }),
        // Chrome can expose synthetic AX controls without a backend DOM id.
        // They remain useful semantic context, but cannot support ref actions.
        axNode({ nodeId: '2', role: { value: 'combobox' }, name: { value: 'Search' } }),
      ],
    })

    const result = await observePage(session, {})
    const search = result.nodes.find(node => node.role === 'combobox')
    expect(search).toMatchObject({ role: 'combobox', name: 'Search' })
    expect(search).not.toHaveProperty('ref')
  })

  it('registers refs only for positive backend DOM ids', async () => {
    const { session, send, refs } = fakeSession()
    send.mockResolvedValueOnce({
      result: { value: { url: FIXTURE_URL, title: 'T', readyState: 'complete', viewport: { width: 1, height: 1, scrollX: 0, scrollY: 0 } } },
    })
    send.mockResolvedValueOnce({
      nodes: [
        axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'Zero' }, backendDOMNodeId: 0, childIds: ['2', '3'] }),
        axNode({ nodeId: '2', role: { value: 'button' }, name: { value: 'Negative' }, backendDOMNodeId: -3 }),
        axNode({ nodeId: '3', role: { value: 'button' }, name: { value: 'Valid' }, backendDOMNodeId: 7 }),
      ],
    })

    const result = await observePage(session, {})
    const zero = result.nodes.find(node => node.name === 'Zero')
    const negative = result.nodes.find(node => node.name === 'Negative')
    const valid = result.nodes.find(node => node.name === 'Valid')
    expect(zero).toMatchObject({ role: 'button', name: 'Zero' })
    expect(zero).not.toHaveProperty('ref')
    expect(negative).toMatchObject({ role: 'button', name: 'Negative' })
    expect(negative).not.toHaveProperty('ref')
    expect(valid).toMatchObject({ role: 'button', name: 'Valid' })
    expect(valid).toHaveProperty('ref')
    // Positive ids keep the existing resolvable-ref contract.
    expect(refs.resolve(valid!.ref!, session.generation).backendNodeId).toBe(7)
    expect(refs.resolve(valid!.ref!, session.generation).generation).toBe(1)
  })

  it('caps nodes and text with truncation counts', async () => {
    const { session, send } = fakeSession()
    send.mockResolvedValueOnce({
      result: { value: { url: FIXTURE_URL, title: 'T', readyState: 'complete', viewport: { width: 1, height: 1, scrollX: 0, scrollY: 0 } } },
    })
    send.mockResolvedValueOnce({
      nodes: [
        axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'One' }, backendDOMNodeId: 1, childIds: ['2', '3'] }),
        axNode({ nodeId: '2', role: { value: 'button' }, name: { value: 'Two' }, backendDOMNodeId: 2 }),
        axNode({ nodeId: '3', role: { value: 'button' }, name: { value: 'Three' }, backendDOMNodeId: 3 }),
      ],
    })
    const result = await observePage(session, { maxNodes: 2, maxChars: 10 })
    expect(result.nodes).toHaveLength(2)
    expect(result.truncated.nodes).toBe(1)
    expect(result.truncated.textChars).toBeGreaterThan(0)
    expect(result.text.length).toBeLessThanOrEqual(10)
  })

  it('reports a failed evaluate as a bridge error', async () => {
    const { session, send } = fakeSession()
    send.mockRejectedValueOnce({ code: 'debugger_detached', message: 'gone', retryable: false })
    await expect(observePage(session, {})).rejects.toMatchObject({ code: 'debugger_detached' })
  })
})
