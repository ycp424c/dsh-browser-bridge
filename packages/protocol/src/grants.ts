/**
 * Grant and request types carried over the bridge: immutable tab snapshots,
 * grant offers, and browser tool requests.
 */
import { z } from 'zod'
import type { GrantId, RequestId } from './ids.ts'

export const BROWSER_OPERATIONS = [
  'observe', 'inspect', 'screenshot', 'act', 'navigate', 'wait', 'console', 'network',
] as const

export type BrowserOperation = typeof BROWSER_OPERATIONS[number]

/** One exact Chrome tab captured at grant-issue time (immutable). */
export interface TabDescriptor {
  tabId: number
  windowId: number
  title: string
  url: string
  favIconUrl?: string
}

export const tabDescriptorSchema = z.strictObject({
  tabId: z.number().int().nonnegative(),
  windowId: z.number().int().nonnegative(),
  title: z.string(),
  url: z.string(),
  favIconUrl: z.string().optional(),
})

/**
 * Server-side offer of one prompt-scoped grant (never model-visible).
 * `expiresAt` is the provider's immutable hard upper bound; a provider may
 * enforce a shorter idle lease and revoke the grant before this deadline.
 */
export interface GrantOffer {
  grantId: GrantId
  sessionId: string
  tab: TabDescriptor
  expiresAt: number
}

/** One tool request forwarded from the host plugin to the extension. */
export interface BrowserToolRequest {
  requestId: RequestId
  grantId: GrantId
  operation: BrowserOperation
  /** Lossless JSON arguments; schemas live in the extension tool layer. */
  args: JsonValue
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Recursive JSON value schema (Zod 4 compatible). */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]))
