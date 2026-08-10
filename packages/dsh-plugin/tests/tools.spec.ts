import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { GrantId, type BrowserOperation, type JsonValue, type TabDescriptor } from '@dsh-external/dsh-browser-bridge-protocol'
import { createBrowserTools, type BrowserToolsDeps, type PageAlias } from '../src/tools/definitions.ts'

const TAB: TabDescriptor = { tabId: 7, windowId: 2, title: 'Fixture', url: 'http://127.0.0.1:4173/' }
const TAB2: TabDescriptor = { tabId: 8, windowId: 2, title: 'Other', url: 'http://127.0.0.1:4174/' }

const signal = new AbortController().signal

function makeDeps(
  pages: PageAlias[],
  request: (grantId: GrantId, operation: BrowserOperation, args: JsonValue, signal: AbortSignal) => Promise<JsonValue> =
    async () => ({ ok: true }),
): BrowserToolsDeps {
  return {
    resolvePage: (page?: string) => {
      const target = page === undefined || page === ''
        ? (pages.length === 1 ? pages[0]! : undefined)
        : pages.find(candidate => candidate.alias === page)
      if (target === undefined) {
        throw new Error('multiple pages attached; pass one of page=...')
      }
      return target
    },
    request,
  }
}

describe('browser tool definitions', () => {
  it('exposes exactly the eight stable tool names', () => {
    const tools = createBrowserTools(makeDeps([]))
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'browser_act', 'browser_console', 'browser_inspect', 'browser_navigate',
      'browser_network', 'browser_observe', 'browser_screenshot', 'browser_wait',
    ])
  })

  it('declares explicit JSON Schema parameters with an optional page', () => {
    const tools = createBrowserTools(makeDeps([]))
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: 'object' })
      expect((tool.parameters as { properties: Record<string, unknown> }).properties.page).toMatchObject({ type: 'string' })
    }
  })

  it('browser_inspect requires ref or selector', () => {
    const inspect = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_inspect')!
    const parameters = inspect.parameters as { oneOf: unknown[] }
    expect(parameters.oneOf).toHaveLength(2)
    expect(JSON.stringify(parameters.oneOf)).toContain('ref')
    expect(JSON.stringify(parameters.oneOf)).toContain('selector')
  })

  it('browser_act uses a discriminated action', () => {
    const act = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_act')!
    const parameters = act.parameters as { properties: { action: { oneOf: Array<{ properties: { kind: { const: string } } }> } }; required: string[] }
    expect(parameters.required).toContain('action')
    const kinds = parameters.properties.action.oneOf.map(schema => schema.properties.kind.const)
    expect(kinds).toEqual(['click', 'type', 'select', 'hover', 'focus', 'press', 'scroll'])
  })

  it('browser_wait uses a discriminated condition', () => {
    const wait = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_wait')!
    const parameters = wait.parameters as { properties: { condition: { oneOf: Array<{ properties: { kind: { const: string } } }> } }; required: string[] }
    expect(parameters.required).toContain('condition')
    const kinds = parameters.properties.condition.oneOf.map(schema => schema.properties.kind.const)
    expect(kinds).toEqual(['selector', 'text', 'url', 'ready', 'stable'])
  })

  it('declares reads concurrency-safe and writes exclusive', () => {
    const tools = createBrowserTools(makeDeps([]))
    const reads = new Set(['browser_observe', 'browser_inspect', 'browser_screenshot', 'browser_console', 'browser_network'])
    for (const tool of tools) {
      if (reads.has(tool.name)) {
        expect(tool.isConcurrencySafe?.({})).toBe(true)
      } else {
        expect(tool.isConcurrencySafe).toBeUndefined()
      }
    }
  })

  it('omits page only when exactly one page is attached', async () => {
    const pages: PageAlias[] = [
      { alias: 'page_1', grantId: GrantId('g1'), tab: TAB },
      { alias: 'page_2', grantId: GrantId('g2'), tab: TAB2 },
    ]
    const called: string[] = []
    const tools = createBrowserTools(makeDeps(pages, async (_grantId, operation) => {
      called.push(operation)
      return { ok: true }
    }))
    const observe = tools.find(tool => tool.name === 'browser_observe')!
    await expect(observe.execute({}, { signal } as never)).rejects.toThrow(/multiple pages/)
    expect(called).toEqual([])
  })

  it('routes execute through the resolved page and request carrier', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), tab: TAB }]
    const calls: Array<{ operation: BrowserOperation; args: JsonValue }> = []
    const tools = createBrowserTools(makeDeps(pages, async (grantId, operation, args) => {
      expect(grantId).toBe('g1')
      calls.push({ operation, args })
      return { ok: true, page: { url: 'http://x/' } }
    }))
    const observe = tools.find(tool => tool.name === 'browser_observe')!
    const result = await observe.execute({ maxNodes: 50 }, { signal } as never)
    expect(result).toEqual({ ok: true, page: { url: 'http://x/' } })
    expect(calls[0]).toMatchObject({ operation: 'observe', args: { maxNodes: 50 } })
  })

  it('strips the page argument before forwarding to the extension', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), tab: TAB }]
    let forwarded: JsonValue = {}
    const tools = createBrowserTools(makeDeps(pages, async (_grantId, _operation, args) => {
      forwarded = args
      return {}
    }))
    const inspect = tools.find(tool => tool.name === 'browser_inspect')!
    await inspect.execute({ page: 'page_1', selector: '#save', properties: ['color'] }, { signal } as never)
    expect(forwarded).toEqual({ selector: '#save', properties: ['color'] })
  })

  it('renders non-image outputs as JSON text blocks', () => {
    const tools = createBrowserTools(makeDeps([]))
    const observe = tools.find(tool => tool.name === 'browser_observe')!
    const blocks = observe.output.render({}, { page: { url: 'http://x/' }, nodes: [] })
    expect(blocks).toEqual([expect.objectContaining({ type: 'text' })])
  })

  it('renders screenshots as metadata text plus an image block', () => {
    const tools = createBrowserTools(makeDeps([]))
    const screenshot = tools.find(tool => tool.name === 'browser_screenshot')!
    const blocks = screenshot.output.render({}, {
      mimeType: 'image/png', data: 'iVBOR', url: 'http://127.0.0.1:4173/', width: 800, height: 600,
    })
    expect(blocks).toEqual([
      { type: 'text', text: 'Screenshot: http://127.0.0.1:4173/ (800x600)' },
      { type: 'image', data: 'iVBOR', mimeType: 'image/png' },
    ])
  })

  it('tools are registerable on an agent-scoped tool registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const agent = { ctx } as unknown as Agent
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), tab: TAB }]
    const disposers = createBrowserTools(makeDeps(pages)).map(definition => agent.ctx.tools.register(definition))
    expect(agent.ctx.tools.get('browser_observe')).toBeDefined()
    for (const dispose of disposers) dispose()
    expect(agent.ctx.tools.get('browser_observe')).toBeUndefined()
  })
})
