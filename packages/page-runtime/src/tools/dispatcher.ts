/**
 * The page tool dispatcher: validates operation arguments with strict
 * schemas before calling the registered handler, returns JSON-only values,
 * and maps local failures to stable BridgeError objects. Handlers register
 * per operation (observe/inspect now; act/navigate/wait/console later);
 * unregistered operations return unsupported_operation.
 */
import {
  bridgeError,
  type BridgeError,
  type JsonValue,
  type ViteBrowserCapability,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { z } from 'zod'
import type { PageDispatcher as PageDispatcherContract } from '../transport/socket.ts'

export interface OperationHandler {
  (args: JsonValue, signal: AbortSignal): Promise<JsonValue> | JsonValue
}

/** Strict argument schemas of the reliable tool subset. */
export const OBSERVE_ARGS_SCHEMA: z.ZodType<JsonValue> = z.strictObject({
  maxNodes: z.number().int().min(1).max(500).optional(),
  maxChars: z.number().int().min(100).max(100_000).optional(),
}) as unknown as z.ZodType<JsonValue>

export const INSPECT_ARGS_SCHEMA: z.ZodType<JsonValue> = z.strictObject({
  ref: z.string().min(1).max(128).optional(),
  selector: z.string().min(1).max(500).optional(),
  properties: z.array(z.string().min(1).max(64)).max(20).optional(),
}) as unknown as z.ZodType<JsonValue>

export const ACT_ARGS_SCHEMA: z.ZodType<JsonValue> = z.strictObject({
  action: z.strictObject({
    kind: z.enum(['click', 'type', 'select', 'hover', 'focus', 'press', 'scroll']),
    ref: z.string().min(1).max(128).optional(),
    selector: z.string().min(1).max(500).optional(),
    text: z.string().max(10_000).optional(),
    replace: z.boolean().optional(),
    value: z.string().max(10_000).optional(),
    key: z.string().min(1).max(64).optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    requireTrusted: z.boolean().optional(),
  }),
}) as unknown as z.ZodType<JsonValue>

export const NAVIGATE_ARGS_SCHEMA: z.ZodType<JsonValue> = z.strictObject({
  url: z.string().max(2048).optional(),
  history: z.enum(['back', 'forward']).optional(),
  reload: z.boolean().optional(),
}) as unknown as z.ZodType<JsonValue>

export const WAIT_ARGS_SCHEMA: z.ZodType<JsonValue> = z.strictObject({
  condition: z.strictObject({
    kind: z.enum(['selector', 'text', 'url', 'ready', 'stable', 'generation']),
    selector: z.string().min(1).max(500).optional(),
    state: z.enum(['attached', 'visible', 'hidden', 'present', 'absent', 'interactive', 'complete']).optional(),
    text: z.string().max(5_000).optional(),
    pattern: z.string().max(500).optional(),
    quietMs: z.number().int().min(50).max(10_000).optional(),
    after: z.number().int().nonnegative().optional(),
  }),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
}) as unknown as z.ZodType<JsonValue>

export const CONSOLE_ARGS_SCHEMA: z.ZodType<JsonValue> = z.strictObject({}) as unknown as z.ZodType<JsonValue>

/** Throw one stable tagged failure whose message carries the code. */
export function bridgeFailure(code: BridgeError['code'], message: string): never {
  const error = new Error(`${code}: ${message}`)
  Object.assign(error, { code })
  throw error
}

/** Normalize any execution failure into a stable BridgeError. */
export function toBridgeError(error: unknown): BridgeError {
  if (typeof error === 'object' && error !== null
    && 'code' in error && typeof (error as { code: unknown }).code === 'string'
    && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    const structured = error as { code: string; message: string; retryable?: boolean }
    return bridgeError(
      structured.code as BridgeError['code'],
      structured.message,
      structured.retryable === true,
    )
  }
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const tagged = error as { code: string; message: string }
    return bridgeError(tagged.code as BridgeError['code'], tagged.message, false)
  }
  return bridgeError('internal', error instanceof Error ? error.message : 'page tool execution failed', false)
}

export class PageDispatcher implements PageDispatcherContract {
  private readonly handlers = new Map<string, { schema: z.ZodType<JsonValue>; handler: OperationHandler }>()

  /** Register one strict schema and handler for one operation. */
  register(operation: ViteBrowserCapability, schema: z.ZodType<JsonValue>, handler: OperationHandler): void {
    this.handlers.set(operation, { schema, handler })
  }

  async execute(operation: ViteBrowserCapability, args: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    const entry = this.handlers.get(operation)
    if (entry === undefined) {
      throw bridgeError('unsupported_operation', `${operation} is not supported by this page runtime`, false)
    }
    const parsed = entry.schema.safeParse(args)
    if (!parsed.success) {
      throw bridgeError('internal', `invalid arguments for ${operation}`, false)
    }
    try {
      return await entry.handler(parsed.data as JsonValue, signal)
    } catch (error) {
      throw toBridgeError(error)
    }
  }
}
