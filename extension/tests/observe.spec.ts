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

function mockPageEvaluate(send: ReturnType<typeof vi.fn>): void {
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
}

function mockAxTree(send: ReturnType<typeof vi.fn>, nodes: Array<Record<string, unknown>>): void {
  send.mockResolvedValueOnce({ nodes })
}

describe('browser_observe', () => {
  it('returns page identity, viewport, semantic nodes, and refs', async () => {
    const { session, send, refs } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 42, childIds: ['2', '3'] }),
      axNode({ nodeId: '2', role: { value: 'heading' }, name: { value: 'Welcome' } }),
      axNode({ nodeId: '3', role: { value: 'none' }, ignored: true }),
    ])
    const result = await observePage(session, {})
    expect(result.page).toMatchObject({ url: FIXTURE_URL, title: 'Fixture', generation: 1 })
    expect(result.viewport).toEqual({ width: 800, height: 600, scrollX: 0, scrollY: 0 })
    expect(result.nodes).toContainEqual(expect.objectContaining({ ref: 'e1', role: 'button', name: 'Save' }))
    expect(refs.resolve('e1', 1).backendNodeId).toBe(42)
    expect(send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ returnByValue: true }))
    expect(send).toHaveBeenCalledWith('Accessibility.getFullAXTree', {})
  })

  it('does not include the joined text digest by default, only on explicit text:true', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 42 }),
    ])
    const plain = await observePage(session, {})
    expect(plain.text).toBeUndefined()
    expect(JSON.stringify(plain)).not.toContain('"text"')

    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 42 }),
    ])
    const withText = await observePage(session, { text: true })
    expect(withText.text).toBe('Save')
  })

  it('filters InlineTextBox nodes entirely', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'StaticText' }, name: { value: 'Hello world' }, backendDOMNodeId: 42, childIds: ['2', '3'] }),
      axNode({ nodeId: '2', role: { value: 'InlineTextBox' }, name: { value: 'Hello' } }),
      axNode({ nodeId: '3', role: { value: 'InlineTextBox' }, name: { value: ' world' } }),
    ])
    const result = await observePage(session, { text: true })
    expect(result.nodes.some(node => node.role === 'InlineTextBox')).toBe(false)
    expect(result.nodes).toHaveLength(1)
    expect(result.text).toBe('Hello world')
  })

  it('drops StaticText that duplicates an enclosing interactive node name', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 42, childIds: ['2'] }),
      // The StaticText "Save" is pure duplication of the button's name.
      axNode({ nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Save' } }),
    ])
    const result = await observePage(session, { text: true })
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.role).toBe('button')
    expect(result.text).toBe('Save')
  })

  it('keeps unique StaticText (page copy) that is not duplicated by an ancestor', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'paragraph' }, name: { value: '' }, backendDOMNodeId: 42, childIds: ['2'] }),
      axNode({ nodeId: '2', role: { value: 'StaticText' }, name: { value: 'The quick brown fox' } }),
    ])
    const result = await observePage(session, {})
    // The ancestor paragraph is a non-interactive presentational wrapper; the
    // StaticText carries the actual copy, so it stays observable.
    expect(result.nodes.some(node => node.role === 'StaticText')).toBe(true)
  })

  it('never returns password or secret values', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'secret-value' }, childIds: ['2', '3'] }),
      axNode({ nodeId: '2', role: { value: 'textbox' }, name: { value: 'Card number' }, value: { value: '4111' } }),
      axNode({ nodeId: '3', role: { value: 'textbox' }, name: { value: 'Name' }, value: { value: 'public-name' } }),
    ])
    const result = await observePage(session, {})
    expect(JSON.stringify(result)).not.toContain('secret-value')
    expect(JSON.stringify(result)).not.toContain('4111')
    expect(result.nodes.find(node => node.name === 'Name')?.value).toBe('public-name')
  })

  it('masks totp/authorization-named fields with the shared sensitive vocabulary', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'textbox' }, name: { value: 'totp_code' }, value: { value: '482913' }, childIds: ['2'] }),
      axNode({ nodeId: '2', role: { value: 'textbox' }, name: { value: 'authorization' }, value: { value: 'Bearer xyz' } }),
    ])
    const result = await observePage(session, {})
    expect(JSON.stringify(result)).not.toContain('482913')
    expect(JSON.stringify(result)).not.toContain('Bearer xyz')
  })

  it('descends through ignored wrapper nodes to expose their children', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'T' }, childIds: ['2'] }),
      axNode({ nodeId: '2', role: { value: 'none' }, ignored: true, childIds: ['3'] }),
      axNode({ nodeId: '3', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 42 }),
    ])
    const result = await observePage(session, {})
    expect(result.nodes).toContainEqual(expect.objectContaining({ role: 'button', name: 'Save' }))
    expect(result.nodes).not.toContainEqual(expect.objectContaining({ role: 'none' }))
  })

  it('does not publish unusable refs for semantic nodes without a DOM backend', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'T' }, backendDOMNodeId: 1, childIds: ['2'] }),
      axNode({ nodeId: '2', role: { value: 'combobox' }, name: { value: 'Search' } }),
    ])
    const result = await observePage(session, {})
    const search = result.nodes.find(node => node.role === 'combobox')
    expect(search).toMatchObject({ role: 'combobox', name: 'Search' })
    expect(search).not.toHaveProperty('ref')
  })

  it('caps nodes and text with truncation counts', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'One' }, backendDOMNodeId: 1, childIds: ['2', '3'] }),
      axNode({ nodeId: '2', role: { value: 'button' }, name: { value: 'Two' }, backendDOMNodeId: 2 }),
      axNode({ nodeId: '3', role: { value: 'button' }, name: { value: 'Three' }, backendDOMNodeId: 3 }),
    ])
    const result = await observePage(session, { maxNodes: 2, maxChars: 10, text: true })
    expect(result.nodes).toHaveLength(2)
    expect(result.truncated.nodes).toBe(1)
    // The maxNodes-dropped node ("Three") never entered the digest, and the
    // two emitted nodes fit inside maxChars, so no chars were cut at all.
    expect(result.text).toBe('One Two')
    expect(result.text).not.toContain('Three')
    expect(result.truncated.textChars).toBe(0)
    expect(result.text!.length).toBeLessThanOrEqual(10)
  })

  it('maxNodes-dropped nodes never enter the text digest', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'Alpha' }, backendDOMNodeId: 1, childIds: ['2', '3', '4'] }),
      axNode({ nodeId: '2', role: { value: 'button' }, name: { value: 'Beta' }, backendDOMNodeId: 2 }),
      axNode({ nodeId: '3', role: { value: 'button' }, name: { value: 'Gamma' }, backendDOMNodeId: 3 }),
      axNode({ nodeId: '4', role: { value: 'button' }, name: { value: 'Delta' }, backendDOMNodeId: 4 }),
    ])
    const result = await observePage(session, { maxNodes: 2, maxChars: 1_000, text: true })
    expect(result.nodes).toHaveLength(2)
    expect(result.truncated.nodes).toBe(2)
    // The digest is derived strictly from emitted nodes: the dropped
    // "Gamma"/"Delta" text is absent, and their absence did not consume any
    // maxChars budget (no chars were cut inside the emitted nodes).
    expect(result.text).toBe('Alpha Beta')
    expect(result.text).not.toContain('Gamma')
    expect(result.text).not.toContain('Delta')
    expect(result.truncated.textChars).toBe(0)
  })

  it('maxChars still truncates inside emitted nodes with an exact char count', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'button' }, name: { value: 'One' }, backendDOMNodeId: 1, childIds: ['2'] }),
      axNode({ nodeId: '2', role: { value: 'button' }, name: { value: 'Two' }, backendDOMNodeId: 2 }),
    ])
    // Both nodes are emitted (node cap 10); maxChars cuts "Two" down to "T"
    // after the "One" + separator budget, so 2 characters are dropped.
    const result = await observePage(session, { maxNodes: 10, maxChars: 5, text: true })
    expect(result.nodes).toHaveLength(2)
    expect(result.truncated.nodes).toBe(0)
    expect(result.text).toBe('One T')
    expect(result.truncated.textChars).toBe(2)
  })

  it('compact mode lowers the default node budget', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    mockAxTree(send, [
      axNode({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2'] }),
      axNode({ nodeId: '2', role: { value: 'generic' }, name: { value: '' }, childIds: Array.from({ length: 120 }, (_, i) => `c${i}`) }),
      ...Array.from({ length: 120 }, (_, i) =>
        axNode({ nodeId: `c${i}`, role: { value: 'button' }, name: { value: `Item ${i}` }, backendDOMNodeId: i + 10 })),
    ])
    const result = await observePage(session, { compact: true })
    expect(result.nodes.length).toBeLessThanOrEqual(40)
    expect(result.text).toBeUndefined()
  })

  it('volume regression: duplicated inline/static text no longer doubles output', async () => {
    const { session, send } = fakeSession()
    mockPageEvaluate(send)
    // 60 buttons, each followed by an InlineTextBox child duplicating its
    // name: the pre-fix shape emitted ~120 nodes PLUS a joined text string.
    const nodes: Array<Record<string, unknown>> = [
      axNode({ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2'] }),
      axNode({ nodeId: '2', role: { value: 'generic' }, name: { value: '' }, childIds: Array.from({ length: 120 }, (_, i) => `n${i}`) }),
    ]
    for (let i = 0; i < 60; i++) {
      nodes.push(axNode({ nodeId: `n${i * 2}`, role: { value: 'button' }, name: { value: `Item ${i}` }, backendDOMNodeId: i + 100, childIds: [`n${i * 2 + 1}`] }))
      nodes.push(axNode({ nodeId: `n${i * 2 + 1}`, role: { value: 'InlineTextBox' }, name: { value: `Item ${i}` } }))
    }
    mockAxTree(send, nodes)
    const result = await observePage(session, {})
    expect(result.nodes).toHaveLength(60)
    expect(JSON.stringify(result)).not.toContain('InlineTextBox')
    expect(JSON.stringify(result).length).toBeLessThan(10_000)
  })

  it('reports a failed evaluate as a bridge error', async () => {
    const { session, send } = fakeSession()
    send.mockRejectedValueOnce({ code: 'debugger_detached', message: 'gone', retryable: false })
    await expect(observePage(session, {})).rejects.toMatchObject({ code: 'debugger_detached' })
  })
})
