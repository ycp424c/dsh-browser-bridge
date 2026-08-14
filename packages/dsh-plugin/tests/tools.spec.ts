import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { GrantId, type BrowserOperation, type BrowserTargetDescriptor, type JsonValue, type TabDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'
import { createBrowserTools, type BrowserToolsDeps, type PageAlias } from '../src/tools/definitions.ts'

const TAB: TabDescriptor = { tabId: 7, windowId: 2, title: 'Fixture', url: 'http://127.0.0.1:4173/' }
const TAB2: TabDescriptor = { tabId: 8, windowId: 2, title: 'Other', url: 'http://127.0.0.1:4174/' }

const CHROME_TARGET: BrowserTargetDescriptor = {
  targetId: 'c'.repeat(43) as never,
  provider: 'chrome-extension',
  title: 'Fixture',
  url: 'http://127.0.0.1:4173/',
  origin: 'http://127.0.0.1:4173',
  generation: 0,
  capabilities: ['observe', 'inspect', 'screenshot', 'act', 'navigate', 'wait', 'console', 'network'],
}

const VITE_TARGET: BrowserTargetDescriptor = {
  targetId: 'v'.repeat(43) as never,
  provider: 'vite',
  title: 'Vite Page',
  url: 'http://127.0.0.1:5173/',
  origin: 'http://127.0.0.1:5173',
  projectId: 'app',
  generation: 0,
  capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
}

const SHOT_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId('shot-1'),
  mediaType: 'image/png',
  bytes: 5,
  width: 800,
  height: 600,
  name: 'browser-screenshot.png',
}

const signal = new AbortController().signal
const VISION_AGENT = {
  options: {},
  session: {
    requestHeader: () => ({ config: { provider: 'visual', model: 'vision-model' } }),
  },
} as unknown as Agent
const imageExecution = { signal, agent: VISION_AGENT } as never

function makeDeps(
  pages: PageAlias[],
  request: (grantId: GrantId, operation: BrowserOperation, args: JsonValue, signal: AbortSignal) => Promise<JsonValue> =
    async () => ({ ok: true }),
  saveImage: (input: SaveImageAttachment) => Promise<ImageAttachmentRef> = async () => SHOT_REF,
  resolveModelInfo: (
    provider: string,
    model: string,
    signal: AbortSignal,
  ) => Promise<{ inputModalities?: readonly ('text' | 'image')[] }> =
    async () => ({ inputModalities: ['text', 'image'] }),
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
    attachments: { saveImage } as unknown as AttachmentStore,
    resolveModelInfo,
  } as BrowserToolsDeps
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

  it('browser_inspect requires ref, selector, or targets', () => {
    const inspect = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_inspect')!
    const parameters = inspect.parameters as { oneOf: unknown[] }
    expect(parameters.oneOf).toHaveLength(3)
    expect(JSON.stringify(parameters.oneOf)).toContain('ref')
    expect(JSON.stringify(parameters.oneOf)).toContain('selector')
    expect(JSON.stringify(parameters.oneOf)).toContain('targets')
  })

  it('browser_act uses a discriminated action (singular) or an actions batch', () => {
    const act = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_act')!
    const parameters = act.parameters as {
      properties: { action: { oneOf: Array<{ properties: { kind: { const: string } } }> } }
      oneOf: unknown[]
    }
    expect(parameters.oneOf).toHaveLength(2)
    expect(JSON.stringify(parameters.oneOf)).toContain('"action"')
    expect(JSON.stringify(parameters.oneOf)).toContain('"actions"')
    const kinds = parameters.properties.action.oneOf.map(schema => schema.properties.kind.const)
    expect(kinds).toEqual(['click', 'type', 'fill', 'select', 'hover', 'focus', 'press', 'scroll'])
  })

  it('browser_wait uses a discriminated condition', () => {
    const wait = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_wait')!
    const parameters = wait.parameters as { properties: { condition: { oneOf: Array<{ properties: { kind: { const: string } } }> } }; required: string[] }
    expect(parameters.required).toContain('condition')
    const kinds = parameters.properties.condition.oneOf.map(schema => schema.properties.kind.const)
    expect(kinds).toEqual(['selector', 'text', 'url', 'ready', 'stable', 'generation'])
    const generation = parameters.properties.condition.oneOf.find(schema => schema.properties.kind.const === 'generation')!
    expect(JSON.stringify(generation)).toContain('"after"')
    expect(JSON.stringify(generation)).toContain('"integer"')
    expect(JSON.stringify(generation)).toContain('"required":["kind","after"]')
  })

  it('declares only stateless reads concurrency-safe; inspect is exclusive after the DOM node race fix', () => {
    const tools = createBrowserTools(makeDeps([]))
    // observe/screenshot/console/network are pure stateless reads. inspect
    // resolves DOM nodes and was revoked from the concurrent set after the
    // parallel-inspect frontend-node race (browser_inspect is NOT declared).
    const reads = new Set(['browser_observe', 'browser_screenshot', 'browser_console', 'browser_network'])
    for (const tool of tools) {
      if (reads.has(tool.name)) {
        expect(tool.isConcurrencySafe?.({}), `${tool.name} should be concurrency-safe`).toBe(true)
      } else {
        expect(tool.isConcurrencySafe, `${tool.name} must not be marked concurrency-safe`).toBeUndefined()
      }
    }
  })

  it('browser_inspect supports batch targets in one call', () => {
    const inspect = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_inspect')!
    const parameters = inspect.parameters as { properties: { targets: { items: unknown; maxItems: number } }; oneOf: unknown[] }
    expect(parameters.properties.targets).toMatchObject({ type: 'array', maxItems: 20 })
    expect(parameters.oneOf).toHaveLength(3)
    expect(JSON.stringify(parameters.oneOf)).toContain('"targets"')
  })

  it('browser_act schema covers fill, batch actions, and postconditions', () => {
    const act = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_act')!
    const parameters = act.parameters as {
      properties: {
        action: { oneOf: Array<{ properties: { kind: { const: string } } }> }
        actions: { items: unknown; maxItems: number }
        expect: { oneOf: Array<{ properties: { kind: { const: string } } }> }
      }
    }
    const kinds = parameters.properties.action.oneOf.map(schema => schema.properties.kind.const)
    expect(kinds).toEqual(['click', 'type', 'fill', 'select', 'hover', 'focus', 'press', 'scroll'])
    expect(parameters.properties.actions).toMatchObject({ type: 'array', maxItems: 20 })
    expect(parameters.properties.expect).toBeDefined()
    const expectKinds = parameters.properties.expect.oneOf.map(schema => schema.properties.kind.const)
    expect(expectKinds).toEqual(['value', 'checked', 'visible', 'text', 'url'])
  })

  it('browser_act type documents append/replace behavior and fill as the overwrite path', () => {
    const act = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_act')!
    const json = JSON.stringify(act.parameters)
    expect(json).toContain('append')
    expect(json).toContain('replace')
    expect(json).toContain('fill')
  })

  it('value and url postconditions require an equals or contains assertion', () => {
    const act = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_act')!
    const parameters = act.parameters as {
      properties: { expect: { oneOf: Array<{ properties: { kind: { const: string } }; oneOf: unknown[] }> } }
    }
    const expectKinds = new Map(parameters.properties.expect.oneOf.map(schema => [schema.properties.kind.const, schema]))
    for (const kind of ['value', 'url']) {
      const schema = expectKinds.get(kind)!
      expect(JSON.stringify(schema.oneOf)).toContain('equals')
      expect(JSON.stringify(schema.oneOf)).toContain('contains')
    }
  })

  it('Vite-only turns keep the legacy surface (no fill/batch/expect/targets/text/compact, plain click)', () => {
    const deps = makeDeps([])
    deps.providers = new Set(['vite'])
    const tools = createBrowserTools(deps)
    const act = tools.find(tool => tool.name === 'browser_act')!
    const actJson = JSON.stringify(act.parameters)
    expect(actJson).not.toContain('fill')
    expect(actJson).not.toContain('actions')
    expect(actJson).not.toContain('expect')
    // The legacy click schema must match the Vite runtime's strict schema:
    // no button/clickCount arguments it would reject.
    const clickSchema = (act.parameters as {
      properties: { action: { oneOf: Array<{ properties: Record<string, unknown> }> } }
    }).properties.action.oneOf.find(schema => (schema.properties.kind as { const: string }).const === 'click')!
    expect(clickSchema.properties.button).toBeUndefined()
    expect(clickSchema.properties.clickCount).toBeUndefined()
    const inspect = tools.find(tool => tool.name === 'browser_inspect')!
    const inspectJson = JSON.stringify(inspect.parameters)
    expect(inspectJson).not.toContain('targets')
    const observe = tools.find(tool => tool.name === 'browser_observe')!
    const observeJson = JSON.stringify(observe.parameters)
    expect(observeJson).not.toContain('"text"')
    expect(observeJson).not.toContain('compact')
  })

  it('mixed Chrome+Vite turns expose the legacy surface for every shared tool', () => {
    const deps = makeDeps([])
    deps.providers = new Set(['chrome-extension', 'vite'])
    const tools = createBrowserTools(deps)
    const act = tools.find(tool => tool.name === 'browser_act')!
    expect(JSON.stringify(act.parameters)).not.toContain('actions')
  })

  it('browser_observe exposes text opt-in and compact mode', () => {
    const observe = createBrowserTools(makeDeps([])).find(tool => tool.name === 'browser_observe')!
    const parameters = observe.parameters as { properties: Record<string, unknown> }
    expect(parameters.properties.text).toMatchObject({ type: 'boolean' })
    expect(parameters.properties.compact).toMatchObject({ type: 'boolean' })
    expect(JSON.stringify(observe.description)).toContain('text')
  })

  it('renders non-image outputs as compact JSON without pretty whitespace', () => {
    const tools = createBrowserTools(makeDeps([]))
    const observe = tools.find(tool => tool.name === 'browser_observe')!
    const blocks = observe.output.render({}, { page: { url: 'http://x/' }, nodes: [{ role: 'button' }] })
    const text = (blocks[0] as { text: string }).text
    expect(text).toBe(JSON.stringify({ page: { url: 'http://x/' }, nodes: [{ role: 'button' }] }))
    expect(text).not.toContain('\n')
    expect(text).not.toContain('  ')
  })

  it('omits page only when exactly one page is attached', async () => {
    const pages: PageAlias[] = [
      { alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET },
      { alias: 'page_2', grantId: GrantId('g2'), target: CHROME_TARGET },
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
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
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

  it('preserves structured bridge errors that crossed the WebSocket boundary', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
    const tools = createBrowserTools(makeDeps(pages, async () => {
      throw {
        code: 'stale_element',
        message: 'element reference could not be resolved',
        retryable: false,
      }
    }))
    const act = tools.find(tool => tool.name === 'browser_act')!

    await expect(act.execute({
      action: { kind: 'press', key: 'Enter' },
    }, { signal } as never)).rejects.toMatchObject({
      name: 'HarnessError',
      code: 'stale_element',
      message: 'stale_element: element reference could not be resolved',
    })
  })

  it('rethrows plain Error instances untouched when they carry no stable code', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
    const tools = createBrowserTools(makeDeps(pages, async () => {
      throw new Error('plain failure')
    }))
    const act = tools.find(tool => tool.name === 'browser_act')!
    await expect(act.execute({ action: { kind: 'press', key: 'Enter' } }, { signal } as never))
      .rejects.toMatchObject({ name: 'Error', message: 'plain failure' })
  })

  it('falls back to a readable message for primitive throws', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
    const tools = createBrowserTools(makeDeps(pages, async () => {
      throw 'boom'
    }))
    const act = tools.find(tool => tool.name === 'browser_act')!
    await expect(act.execute({ action: { kind: 'press', key: 'Enter' } }, { signal } as never))
      .rejects.toMatchObject({ name: 'Error', message: 'boom' })
  })

  it('normalizes local Error instances tagged with a stable code', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
    const tools = createBrowserTools(makeDeps(pages, async () => {
      const failure = new Error('grant is gone')
      Object.assign(failure, { code: 'grant_expired' })
      throw failure
    }))
    const act = tools.find(tool => tool.name === 'browser_act')!
    await expect(act.execute({ action: { kind: 'press', key: 'Enter' } }, { signal } as never))
      .rejects.toMatchObject({ name: 'HarnessError', code: 'grant_expired', message: 'grant_expired: grant is gone' })
  })

  it('does not misread partial objects as bridge errors', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
    const tools = createBrowserTools(makeDeps(pages, async () => {
      // A look-alike that lacks the retryable flag is not a stable bridge error.
      throw { code: 'stale_element', message: 'incomplete' }
    }))
    const act = tools.find(tool => tool.name === 'browser_act')!
    await expect(act.execute({ action: { kind: 'press', key: 'Enter' } }, { signal } as never))
      .rejects.toMatchObject({ name: 'Error' })
  })

  it('strips the page argument before forwarding to the extension', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
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

  it('renders screenshots as metadata text plus an attachment image block', () => {
    const tools = createBrowserTools(makeDeps([]))
    const screenshot = tools.find(tool => tool.name === 'browser_screenshot')!
    const blocks = screenshot.output.render({}, {
      url: 'http://127.0.0.1:4173/', width: 800, height: 600, attachment: SHOT_REF,
    } as never)
    expect(blocks).toEqual([
      { type: 'text', text: 'Screenshot: http://127.0.0.1:4173/ (800x600)' },
      { type: 'image', attachment: SHOT_REF },
    ])
  })

  it('screenshot execute decodes base64 and commits via attachments.saveImage', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
    const saved: SaveImageAttachment[] = []
    const tools = createBrowserTools(makeDeps(pages, async () => ({
      mimeType: 'image/png',
      data: 'aGVsbG8=',
      url: 'http://127.0.0.1:4173/',
      width: 800,
      height: 600,
    }), async input => {
      saved.push(input)
      return SHOT_REF
    }))
    const screenshot = tools.find(tool => tool.name === 'browser_screenshot')!
    const result = await screenshot.execute({}, imageExecution) as Record<string, unknown>

    expect(saved).toHaveLength(1)
    expect(saved[0]!.mediaType).toBe('image/png')
    expect(saved[0]!.name).toBe('browser-screenshot.png')
    expect(saved[0]!.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(saved[0]!.data)).toEqual([104, 101, 108, 108, 111])
    expect(result).toEqual({ url: 'http://127.0.0.1:4173/', width: 800, height: 600, attachment: SHOT_REF })
    // Canonical JSON carries only the durable reference — no base64 bytes.
    const json = JSON.stringify(result)
    expect(json).not.toContain('aGVsbG8=')
    expect(json).not.toContain('"data"')
  })

  it('refuses screenshots before browser I/O when the current model is text-only', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
    const requested: BrowserOperation[] = []
    const saved: SaveImageAttachment[] = []
    const tools = createBrowserTools(makeDeps(
      pages,
      async (_grantId, operation) => {
        requested.push(operation)
        return {
          mimeType: 'image/png', data: 'aGVsbG8=', url: TAB.url, width: 800, height: 600,
        }
      },
      async input => {
        saved.push(input)
        return SHOT_REF
      },
      async (provider, model) => {
        expect(provider).toBe('deepseek-official')
        expect(model).toBe('deepseek-v4-flash')
        return { inputModalities: ['text'] }
      },
    ))
    const screenshot = tools.find(tool => tool.name === 'browser_screenshot')!
    const agent = {
      options: {},
      session: {
        requestHeader: () => ({
          config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        }),
      },
    } as unknown as Agent

    await expect(screenshot.execute({}, { signal, agent } as never))
      .rejects.toThrow(/does not declare image input/)
    expect(requested).toEqual([])
    expect(saved).toEqual([])
  })

  it('screenshot execute rejects unsupported media types before saving', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
    const saved: SaveImageAttachment[] = []
    const tools = createBrowserTools(makeDeps(pages, async () => ({
      mimeType: 'image/bmp',
      data: 'aGVsbG8=',
      url: 'http://127.0.0.1:4173/',
      width: 800,
      height: 600,
    }), async input => {
      saved.push(input)
      return SHOT_REF
    }))
    const screenshot = tools.find(tool => tool.name === 'browser_screenshot')!
    await expect(screenshot.execute({}, imageExecution)).rejects.toThrow(/unsupported media type/)
    expect(saved).toHaveLength(0)
  })

  it('rejects screenshot and network against a Vite alias before dispatch', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: VITE_TARGET }]
    const called: string[] = []
    const tools = createBrowserTools(makeDeps(pages, async (_grantId, operation) => {
      called.push(operation)
      return {}
    }))
    const screenshot = tools.find(tool => tool.name === 'browser_screenshot')!
    const network = tools.find(tool => tool.name === 'browser_network')!
    await expect(screenshot.execute({ page: 'page_1' }, imageExecution))
      .rejects.toMatchObject({ name: 'HarnessError', code: 'unsupported_operation' })
    await expect(network.execute({ page: 'page_1' }, { signal } as never))
      .rejects.toMatchObject({ name: 'HarnessError', code: 'unsupported_operation' })
    expect(called).toEqual([])
  })

  it('accepts every reliable Vite operation against a Vite alias', async () => {
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: VITE_TARGET }]
    const called: string[] = []
    const tools = createBrowserTools(makeDeps(pages, async (_grantId, operation) => {
      called.push(operation)
      return { ok: true }
    }))
    for (const operation of ['observe', 'inspect', 'act', 'navigate', 'wait', 'console']) {
      const tool = tools.find(candidate => candidate.name === `browser_${operation}`)!
      await tool.execute({ page: 'page_1' }, { signal } as never)
    }
    expect(called).toEqual(['observe', 'inspect', 'act', 'navigate', 'wait', 'console'])
  })

  it('a mixed turn keeps screenshot and guards it per alias', async () => {
    const pages: PageAlias[] = [
      { alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET },
      { alias: 'page_2', grantId: GrantId('g2'), target: VITE_TARGET },
    ]
    const called: string[] = []
    const tools = createBrowserTools(makeDeps(pages, async (_grantId, operation): Promise<JsonValue> => {
      called.push(operation)
      if (operation === 'screenshot') {
        return { mimeType: 'image/png', data: 'aGVsbG8=', url: 'http://x/', width: 1, height: 1 }
      }
      return {}
    }))
    const screenshot = tools.find(tool => tool.name === 'browser_screenshot')!
    await screenshot.execute({ page: 'page_1' }, imageExecution)
    expect(called).toEqual(['screenshot'])
    await expect(screenshot.execute({ page: 'page_2' }, imageExecution))
      .rejects.toMatchObject({ code: 'unsupported_operation' })
    expect(called).toEqual(['screenshot'])
  })

  it('tools are registerable on an agent-scoped tool registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const agent = { ctx } as unknown as Agent
    const pages: PageAlias[] = [{ alias: 'page_1', grantId: GrantId('g1'), target: CHROME_TARGET }]
    const disposers = createBrowserTools(makeDeps(pages)).map(definition => agent.ctx.tools.register(definition))
    expect(agent.ctx.tools.get('browser_observe')).toBeDefined()
    for (const dispose of disposers) dispose()
    expect(agent.ctx.tools.get('browser_observe')).toBeUndefined()
  })
})
