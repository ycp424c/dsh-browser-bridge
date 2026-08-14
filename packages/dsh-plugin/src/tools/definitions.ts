/**
 * Model-facing browser tool definitions. Schemas stay stable and explicit;
 * every tool optionally accepts `page` (omitted only when one page is
 * attached) and forwards `exec.signal` to the bridge request. Tools are
 * constructed per operation so a turn registers only the union of its
 * attached targets' capabilities, and every execute path re-checks the
 * selected alias's capability before forwarding.
 */
import { Buffer } from 'node:buffer'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  bridgeErrorSchema,
  type BrowserOperation,
  type BrowserProviderKind,
  type BrowserTargetDescriptor,
  type GrantId,
  type JsonValue,
} from '@ycp424c/dsh-browser-bridge-protocol'

export interface PageAlias {
  alias: string
  grantId: GrantId
  /** The normalized target descriptor the alias resolves to. */
  target: BrowserTargetDescriptor
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
  /** Durable attachment store; screenshot bytes commit through `saveImage`. */
  attachments: AttachmentStore
  /** Resolve the exact active model route before emitting durable image content. */
  resolveModelInfo(
    provider: string,
    model: string,
    signal: AbortSignal,
  ): Promise<{ inputModalities?: readonly ('text' | 'image')[] }>
  /**
   * Providers attached this turn. Advanced argument surfaces (fill, batch
   * actions, postconditions, batch targets, observe text/compact) are exposed
   * ONLY when every attached target is a Chrome-extension page; the Vite
   * provider validates strict schemas and keeps its original surface.
   * Undefined (tests) means the full Chrome surface.
   */
  providers?: ReadonlySet<BrowserProviderKind>
}

/**
 * Whether the full (Chrome) argument surface may be advertised. A turn that
 * includes any Vite page shares one schema across aliases, so the least
 * capable provider wins: new arguments are only exposed for Chrome-only
 * turns, keeping the Vite page-runtime schema gap closed.
 */
function supportsAdvancedSurface(deps: BrowserToolsDeps): boolean {
  return deps.providers === undefined || (deps.providers.has('chrome-extension') && !deps.providers.has('vite'))
}

/** Every model-facing browser tool name, keyed by wire operation. */
export const BROWSER_TOOL_OPERATIONS: readonly BrowserOperation[] = [
  'observe', 'inspect', 'screenshot', 'act', 'navigate', 'wait', 'console', 'network',
]

const PAGE_PROPERTY = {
  type: 'string',
  description: 'Page alias from browser_observe (page_1, page_2, ...); omit only when exactly one page is attached.',
} as const

const READ_OPERATIONS = new Set<BrowserOperation>(['observe', 'inspect', 'screenshot', 'console', 'network'])

/** Normalize a bridge error into a HarnessError carrying the stable code. */
function bridgeFailure(error: unknown): never {
  // Bridge errors cross the WebSocket boundary as plain structured objects,
  // so structural validation (not instanceof) recognizes them.
  const parsed = bridgeErrorSchema.safeParse(error)
  if (parsed.success) {
    throw new HarnessError(`${parsed.data.code}: ${parsed.data.message}`, parsed.data.code)
  }
  // Local failures may be Error instances tagged with a stable code.
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const tagged = error as { code: string }
    throw new HarnessError(`${tagged.code}: ${error.message}`, tagged.code)
  }
  // Unstructured throws keep their identity; otherwise fall back to a
  // readable message instead of crashing on "[object Object]".
  throw error instanceof Error ? error : new Error(String(error))
}

export const SCREENSHOT_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['url', 'width', 'height', 'attachment'],
  properties: {
    url: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    attachment: {
      type: 'object',
      required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        name: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

const SCREENSHOT_MEDIA_TYPES: ReadonlySet<ImageMediaType> = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
])

const JSON_TEXT_RENDER = (_args: unknown, value: JsonValue): ContentBlock[] => [
  // Compact single-line JSON: no pretty whitespace, machine-readable, and
  // minimal token cost in tool history.
  { type: 'text', text: JSON.stringify(value) },
]

/**
 * Discriminated action schemas shared by the singular `action` property and
 * the sequential `actions` batch. `type` appends by default; pass
 * `replace: true` to overwrite the existing text. `fill` reliably overwrites
 * any input/textarea/select (including datetime-local) through the native
 * value setter plus input/change events, and must be used when `type` cannot
 * change the field value.
 */
const ACT_ACTION_SCHEMAS: readonly Record<string, unknown>[] = [
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'click' },
      ref: { type: 'string', description: 'Element reference from browser_observe.' },
      selector: { type: 'string', description: 'CSS selector under the main document.' },
      button: { enum: ['left', 'right', 'middle'] },
      clickCount: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['kind'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'type' },
      ref: { type: 'string', description: 'Element reference from browser_observe.' },
      selector: { type: 'string', description: 'CSS selector under the main document.' },
      text: { type: 'string', description: 'Text to insert into a text field (appends unless replace is true).' },
      replace: { type: 'boolean', description: 'true replaces the existing value; false (default) appends to it.' },
    },
    required: ['kind', 'text'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'fill' },
      ref: { type: 'string', description: 'Element reference from browser_observe.' },
      selector: { type: 'string', description: 'CSS selector under the main document.' },
      value: { type: 'string', description: 'New value; overwrites the field (text, textarea, select, datetime-local, date, etc.).' },
    },
    required: ['kind', 'value'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'select' },
      ref: { type: 'string' },
      selector: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['kind', 'value'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { const: 'hover' }, ref: { type: 'string' }, selector: { type: 'string' } },
    required: ['kind'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { const: 'focus' }, ref: { type: 'string' }, selector: { type: 'string' } },
    required: ['kind'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { const: 'press' }, key: { type: 'string' } },
    required: ['kind', 'key'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'scroll' },
      ref: { type: 'string' },
      selector: { type: 'string' },
      deltaX: { type: 'number' },
      deltaY: { type: 'number' },
    },
    required: ['kind'],
  },
]

/**
 * Legacy action set for providers that do not implement fill (the Vite
 * page-runtime validates strict schemas and keeps its original surface):
 * fill is dropped, and click reverts to the original ref/selector-only shape
 * because the Vite runtime does not accept button/clickCount either.
 */
const LEGACY_ACT_ACTION_SCHEMAS: readonly Record<string, unknown>[] = ACT_ACTION_SCHEMAS
  .filter(schema => (schema.properties as { kind: { const: string } }).kind.const !== 'fill')
  .map(schema => {
    if ((schema.properties as { kind: { const: string } }).kind.const !== 'click') return schema
    const { button: _button, clickCount: _clickCount, ...rest } = schema.properties as Record<string, unknown>
    return { ...schema, properties: rest }
  })

/**
 * Bounded postcondition union polled after an action (or an actions batch)
 * inside the SAME tool call. Sensitive values never appear in failure text.
 */
const POSTCONDITION_SCHEMAS: readonly Record<string, unknown>[] = [
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'value' },
      ref: { type: 'string' },
      selector: { type: 'string' },
      equals: { type: 'string' },
      contains: { type: 'string' },
    },
    required: ['kind'],
    oneOf: [{ required: ['equals'] }, { required: ['contains'] }],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { const: 'checked' }, ref: { type: 'string' }, selector: { type: 'string' }, equals: { type: 'boolean' } },
    required: ['kind', 'equals'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { const: 'visible' }, ref: { type: 'string' }, selector: { type: 'string' }, equals: { type: 'boolean' } },
    required: ['kind', 'equals'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { const: 'text' }, ref: { type: 'string' }, selector: { type: 'string' }, contains: { type: 'string' } },
    required: ['kind', 'contains'],
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { const: 'url' }, equals: { type: 'string' }, contains: { type: 'string' } },
    required: ['kind'],
    oneOf: [{ required: ['equals'] }, { required: ['contains'] }],
  },
]

/** Resolve and authorize one page operation without dispatching browser I/O. */
function prepareRequest(
  deps: BrowserToolsDeps,
  operation: BrowserOperation,
  args: unknown,
): { grantId: GrantId; args: JsonValue } {
  const raw = (args ?? {}) as Record<string, unknown>
  const page = typeof raw.page === 'string' ? raw.page : undefined
  const resolved = deps.resolvePage(page)
  // The selected alias's capability is authoritative: a target that does
  // not advertise an operation fails here, before any dispatch.
  if (!(resolved.target.capabilities as readonly string[]).includes(operation)) {
    throw new HarnessError(
      `unsupported_operation: ${resolved.target.provider} target does not support ${operation}`,
      'unsupported_operation',
    )
  }
  const { grantId } = resolved
  const { page: _page, ...rest } = raw
  return { grantId, args: rest as JsonValue }
}

/** Dispatch one already-authorized page operation; bridge failures normalize to HarnessError. */
async function dispatchRequest(
  deps: BrowserToolsDeps,
  operation: BrowserOperation,
  prepared: { grantId: GrantId; args: JsonValue },
  signal: AbortSignal,
): Promise<unknown> {
  try {
    return await deps.request(prepared.grantId, operation, prepared.args, signal)
  } catch (error) {
    return bridgeFailure(error)
  }
}

/** Forward one resolved-page operation. */
async function forwardRequest(
  deps: BrowserToolsDeps,
  operation: BrowserOperation,
  args: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  return dispatchRequest(deps, operation, prepareRequest(deps, operation, args), signal)
}

type ToolBuilder = (deps: BrowserToolsDeps) => ToolDefinition

/** Build one browser tool for one operation (turn unions pick the subset). */
export function createBrowserTool(operation: BrowserOperation, deps: BrowserToolsDeps): ToolDefinition {
  return TOOL_BUILDERS[operation](deps)
}

/** Build every browser tool (full Chrome-capable surface). */
export function createBrowserTools(deps: BrowserToolsDeps): ToolDefinition[] {
  return BROWSER_TOOL_OPERATIONS.map(operation => createBrowserTool(operation, deps))
}

const execute =
  (deps: BrowserToolsDeps, operation: BrowserOperation) =>
  (args: unknown, exec: { signal: AbortSignal }): Promise<unknown> =>
    forwardRequest(deps, operation, args, exec.signal)

/** Refuse durable screenshot output unless the exact calling route accepts images. */
async function assertImageCapableRoute(deps: BrowserToolsDeps, exec: ToolExecution): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) {
    throw new Error('browser_screenshot: the current model route could not be resolved')
  }
  const active = await deps.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `browser_screenshot: model "${model}" does not declare image input; switch to an image-capable model or use browser_observe`,
    )
  }
}

const TOOL_BUILDERS: Record<BrowserOperation, ToolBuilder> = {
    observe: deps => {
      const advanced = supportsAdvancedSurface(deps)
      const properties: Record<string, unknown> = {
        page: PAGE_PROPERTY,
        maxNodes: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap on returned element nodes.' },
        maxChars: { type: 'integer', minimum: 100, maximum: 100_000, description: 'Cap on returned text characters (only when text:true).' },
      }
      if (advanced) {
        properties.text = { type: 'boolean', description: 'Include a joined text digest derived from the emitted nodes (off by default; compact mode never includes it).' }
        properties.compact = { type: 'boolean', description: 'Lower the default output budget (fewer nodes, no text) for minimal contexts.' }
      }
      return {
        name: 'browser_observe',
        description: advanced
          ? 'Observe the attached page: identity, lifecycle state, semantic DOM, and short-lived element references. Duplicate inline/static text is filtered; pass text:true for a joined text digest (off by default — nodes carry the semantic content).'
          : 'Observe the attached page: identity, lifecycle state, semantic DOM, and short-lived element references.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: JSON_TEXT_RENDER,
        },
        isConcurrencySafe: () => true,
        execute: execute(deps, 'observe'),
      }
    },
    inspect: deps => {
      const advanced = supportsAdvancedSurface(deps)
      const properties: Record<string, unknown> = {
        page: PAGE_PROPERTY,
        ref: { type: 'string', description: 'Element reference from browser_observe.' },
        selector: { type: 'string', description: 'CSS selector under the main document.' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Requested computed CSS property names (only these are returned).' },
      }
      if (advanced) {
        properties.targets = {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: 'Batch of targets inspected sequentially in one call; each reports success or failure independently.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ref: { type: 'string', description: 'Element reference from browser_observe.' },
              selector: { type: 'string', description: 'CSS selector under the main document.' },
            },
            oneOf: [{ required: ['ref'] }, { required: ['selector'] }],
          },
        }
      }
      return {
        name: 'browser_inspect',
        description: advanced
          ? 'Inspect a referenced element, selector, or a batch of `targets` in one call: attributes, text, form state (value, checked, selected), geometry, and visibility. Password/secret fields return no plaintext value. Computed style is returned only for explicitly requested `properties`. Not concurrency-safe: DOM reads are exclusive per call.'
          : 'Inspect a referenced element or selector: attributes, text, computed style, geometry, and visibility.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties,
          oneOf: advanced
            ? [{ required: ['ref'] }, { required: ['selector'] }, { required: ['targets'] }]
            : [{ required: ['ref'] }, { required: ['selector'] }],
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: JSON_TEXT_RENDER,
        },
        execute: execute(deps, 'inspect'),
      }
    },
    screenshot: deps => ({
      name: 'browser_screenshot',
      description: 'Capture the current viewport or a referenced element as a PNG screenshot. Requires the current model to accept image input.',
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
          const shot = value as unknown as { url: string; width: number; height: number; attachment: ImageAttachmentRef }
          return [
            { type: 'text', text: `Screenshot: ${shot.url} (${shot.width}x${shot.height})` },
            { type: 'image', attachment: shot.attachment },
          ]
        },
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        // Resolve the page capability first so Vite targets retain their
        // precise unsupported-operation error without browser I/O.
        const prepared = prepareRequest(deps, 'screenshot', args)
        // A screenshot result is persisted in tool history. Gate before any
        // browser I/O so a text-only route can continue with a text error
        // instead of poisoning all later requests with image content.
        await assertImageCapableRoute(deps, exec)
        // The bridge returns encoded bytes; commit them to the attachment
        // store so the model-visible result carries only the durable ref.
        const shot = await dispatchRequest(deps, 'screenshot', prepared, exec.signal) as {
          url: string
          width: number
          height: number
          data: string
          mimeType: string
        }
        if (!SCREENSHOT_MEDIA_TYPES.has(shot.mimeType as ImageMediaType)) {
          throw new Error(`browser_screenshot: unsupported media type ${shot.mimeType}`)
        }
        const attachment = await deps.attachments.saveImage({
          data: Buffer.from(shot.data, 'base64'),
          mediaType: shot.mimeType as ImageMediaType,
          name: 'browser-screenshot.png',
        })
        return { url: shot.url, width: shot.width, height: shot.height, attachment }
      },
    }),
    act: deps => {
      const advanced = supportsAdvancedSurface(deps)
      if (!advanced) {
        // Vite-inclusive turns keep the legacy surface: the page-runtime
        // validates strict schemas and does not implement fill/batch/expect.
        return {
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
                oneOf: LEGACY_ACT_ACTION_SCHEMAS,
              },
            },
            required: ['action'],
          },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: JSON_TEXT_RENDER,
          },
          execute: execute(deps, 'act'),
        }
      }
      return {
        name: 'browser_act',
        description: 'Interact with the page: click, type (appends to a text field, or replaces with replace:true), fill (reliably overwrites input/textarea/select values including datetime-local via the native setter), select, hover, focus, press keys, or scroll. Pass `actions` to run up to 20 actions sequentially in one call with per-item results, and `expect` to poll a postcondition after the action(s) inside the same call.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: PAGE_PROPERTY,
            action: { type: 'object', additionalProperties: false, oneOf: [...ACT_ACTION_SCHEMAS] },
            actions: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              description: 'Sequential batch of actions executed in one call on the same tab; stops at the first failure (fail-fast) and reports per-item results with the failed index.',
              items: { type: 'object', additionalProperties: false, oneOf: [...ACT_ACTION_SCHEMAS] },
            },
            expect: { type: 'object', additionalProperties: false, oneOf: [...POSTCONDITION_SCHEMAS] },
          },
          oneOf: [{ required: ['action'] }, { required: ['actions'] }],
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: JSON_TEXT_RENDER,
        },
        execute: execute(deps, 'act'),
      }
    },
    navigate: deps => ({
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
      execute: execute(deps, 'navigate'),
    }),
    wait: deps => ({
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
              { type: 'object', properties: { kind: { const: 'generation' }, after: { type: 'integer', minimum: 0 } }, required: ['kind', 'after'] },
            ],
          },
        },
        required: ['condition'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: JSON_TEXT_RENDER,
      },
      execute: execute(deps, 'wait'),
    }),
    console: deps => ({
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
      execute: execute(deps, 'console'),
    }),
    network: deps => ({
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
      execute: execute(deps, 'network'),
    }),
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
