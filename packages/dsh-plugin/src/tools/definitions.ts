/**
 * Model-facing browser tool definitions. Schemas stay stable and explicit;
 * every tool optionally accepts `page` (omitted only when one page is
 * attached) and forwards `exec.signal` to the bridge request.
 */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

// Screenshot evidence renders as an image block. ContentBlockMap is the
// documented merge-extensible block vocabulary; adapters that do not know
// 'image' treat it as an unknown block type.
declare module '@deepseek-ai/dsh-llm/types' {
  interface ContentBlockMap {
    'image': { type: 'image'; data: string; mimeType: string }
  }
}
import type {
  BrowserOperation,
  GrantId,
  JsonValue,
  TabDescriptor,
} from '@dsh-external/dsh-browser-bridge-protocol'

export interface PageAlias {
  alias: string
  grantId: GrantId
  tab: TabDescriptor
}

export interface BrowserToolsDeps {
  /** Resolve the page alias (or the single attached page) to a capability. */
  resolvePage(page?: string): PageAlias
  request(
    grantId: GrantId,
    operation: BrowserOperation,
    args: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue>
}

const PAGE_PROPERTY = {
  type: 'string',
  description: 'Page alias from browser_observe (page_1, page_2, ...); omit only when exactly one page is attached.',
} as const

const READ_OPERATIONS = new Set<BrowserOperation>(['observe', 'inspect', 'screenshot', 'console', 'network'])

/** Normalize a bridge error into a HarnessError carrying the stable code. */
function bridgeFailure(error: unknown): never {
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const bridge = error as { code: string; message: string }
    throw new HarnessError(`${bridge.code}: ${bridge.message}`, bridge.code)
  }
  throw error instanceof Error ? error : new Error(String(error))
}

export const SCREENSHOT_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['mimeType', 'data', 'url', 'width', 'height'],
  properties: {
    mimeType: { type: 'string' },
    data: { type: 'string' },
    url: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
  additionalProperties: false,
}

const JSON_TEXT_RENDER = (_args: unknown, value: JsonValue): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

export function createBrowserTools(deps: BrowserToolsDeps): ToolDefinition[] {
  const execute =
    (operation: BrowserOperation) =>
    async (args: unknown, exec: { signal: AbortSignal }): Promise<unknown> => {
      const raw = (args ?? {}) as Record<string, unknown>
      const page = typeof raw.page === 'string' ? raw.page : undefined
      const { grantId } = deps.resolvePage(page)
      const { page: _page, ...rest } = raw
      try {
        return await deps.request(grantId, operation, rest as JsonValue, exec.signal)
      } catch (error) {
        return bridgeFailure(error)
      }
    }

  const tools: Array<Omit<ToolDefinition, 'execute'> & { execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown> }> = [
    {
      name: 'browser_observe',
      description: 'Observe the attached page: identity, lifecycle state, semantic DOM, and short-lived element references.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: PAGE_PROPERTY,
          maxNodes: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap on returned element nodes.' },
          maxChars: { type: 'integer', minimum: 100, maximum: 100_000, description: 'Cap on returned text characters.' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: JSON_TEXT_RENDER,
      },
      isConcurrencySafe: () => true,
      execute: execute('observe'),
    },
    {
      name: 'browser_inspect',
      description: 'Inspect a referenced element or selector: attributes, text, computed style, geometry, and visibility.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: PAGE_PROPERTY,
          ref: { type: 'string', description: 'Element reference from browser_observe.' },
          selector: { type: 'string', description: 'CSS selector under the main document.' },
          properties: { type: 'array', items: { type: 'string' }, description: 'Requested computed CSS property names.' },
        },
        oneOf: [{ required: ['ref'] }, { required: ['selector'] }],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: JSON_TEXT_RENDER,
      },
      isConcurrencySafe: () => true,
      execute: execute('inspect'),
    },
    {
      name: 'browser_screenshot',
      description: 'Capture the current viewport or a referenced element as a PNG screenshot.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: PAGE_PROPERTY,
          ref: { type: 'string' },
          selector: { type: 'string' },
        },
      },
      output: {
        schema: SCREENSHOT_RESULT_SCHEMA,
        render: (_args: unknown, value: JsonValue): ContentBlock[] => {
          const shot = value as { url: string; width: number; height: number; data: string; mimeType: string }
          return [
            { type: 'text', text: `Screenshot: ${shot.url} (${shot.width}x${shot.height})` },
            { type: 'image', data: shot.data, mimeType: shot.mimeType },
          ]
        },
      },
      isConcurrencySafe: () => true,
      execute: execute('screenshot'),
    },
    {
      name: 'browser_act',
      description: 'Interact with the page: click, type, select, hover, focus, press keys, or scroll.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: PAGE_PROPERTY,
          action: {
            type: 'object',
            additionalProperties: false,
            oneOf: [
              { type: 'object', properties: { kind: { const: 'click' }, ref: { type: 'string' }, selector: { type: 'string' } }, required: ['kind'] },
              { type: 'object', properties: { kind: { const: 'type' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, replace: { type: 'boolean' } }, required: ['kind', 'text'] },
              { type: 'object', properties: { kind: { const: 'select' }, ref: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['kind', 'value'] },
              { type: 'object', properties: { kind: { const: 'hover' }, ref: { type: 'string' }, selector: { type: 'string' } }, required: ['kind'] },
              { type: 'object', properties: { kind: { const: 'focus' }, ref: { type: 'string' }, selector: { type: 'string' } }, required: ['kind'] },
              { type: 'object', properties: { kind: { const: 'press' }, key: { type: 'string' } }, required: ['kind', 'key'] },
              { type: 'object', properties: { kind: { const: 'scroll' }, ref: { type: 'string' }, selector: { type: 'string' }, deltaX: { type: 'number' }, deltaY: { type: 'number' } }, required: ['kind'] },
            ],
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: JSON_TEXT_RENDER,
      },
      execute: execute('act'),
    },
    {
      name: 'browser_navigate',
      description: 'Navigate the attached tab: open an absolute HTTP(S) URL, go back or forward, or reload.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: PAGE_PROPERTY,
          url: { type: 'string', description: 'Absolute HTTP(S) URL.' },
          history: { enum: ['back', 'forward'] },
          reload: { type: 'boolean' },
        },
        oneOf: [{ required: ['url'] }, { required: ['history'] }, { required: ['reload'] }],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: JSON_TEXT_RENDER,
      },
      execute: execute('navigate'),
    },
    {
      name: 'browser_wait',
      description: 'Wait for an element, text, URL, lifecycle condition, or a bounded page stability window.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: PAGE_PROPERTY,
          condition: {
            type: 'object',
            additionalProperties: false,
            oneOf: [
              { type: 'object', properties: { kind: { const: 'selector' }, selector: { type: 'string' }, state: { enum: ['attached', 'visible', 'hidden'] } }, required: ['kind', 'selector', 'state'] },
              { type: 'object', properties: { kind: { const: 'text' }, text: { type: 'string' }, state: { enum: ['present', 'absent'] } }, required: ['kind', 'text', 'state'] },
              { type: 'object', properties: { kind: { const: 'url' }, pattern: { type: 'string' } }, required: ['kind', 'pattern'] },
              { type: 'object', properties: { kind: { const: 'ready' }, state: { enum: ['interactive', 'complete'] } }, required: ['kind', 'state'] },
              { type: 'object', properties: { kind: { const: 'stable' }, quietMs: { type: 'integer', minimum: 50, maximum: 10_000 } }, required: ['kind', 'quietMs'] },
            ],
          },
        },
        required: ['condition'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: JSON_TEXT_RENDER,
      },
      execute: execute('wait'),
    },
    {
      name: 'browser_console',
      description: 'Console errors and relevant log entries observed since the tab was attached.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { page: PAGE_PROPERTY },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: JSON_TEXT_RENDER,
      },
      isConcurrencySafe: () => true,
      execute: execute('console'),
    },
    {
      name: 'browser_network',
      description: 'Failed HTTP responses and loading failures observed since the tab was attached (no headers or bodies).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { page: PAGE_PROPERTY },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: JSON_TEXT_RENDER,
      },
      isConcurrencySafe: () => true,
      execute: execute('network'),
    },
  ]
  return tools
}

export function resolvePageAlias(pages: readonly PageAlias[], page?: string): PageAlias {
  const target = page === undefined || page === ''
    ? (pages.length === 1 ? pages[0] : undefined)
    : pages.find(candidate => candidate.alias === page)
  if (target === undefined) {
    const names = pages.map(candidate => candidate.alias).join(', ')
    throw new Error(page === undefined || page === ''
      ? `browser tool: multiple pages attached (${names}); pass one of page=...`
      : `browser tool: unknown page ${page}; attached pages: ${names}`)
  }
  return target
}

export function isReadOperation(operation: BrowserOperation): boolean {
  return READ_OPERATIONS.has(operation)
}
