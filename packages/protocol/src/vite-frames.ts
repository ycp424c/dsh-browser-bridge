/**
 * Separately versioned, strict wire frames for the Vite page protocol.
 * The page protocol version is independent from the Chrome extension
 * `PROTOCOL_VERSION`; direction is enforced by two distinct unions so a page
 * can never send host-shaped frames and the host can never treat a page
 * registration as a host-to-page frame.
 *
 * Security invariants enforced at this layer:
 * - every frame is a strict object: no DSH session id, grant handle,
 *   filesystem request, host method, secret, or screenshot/network payload
 *   can be attached as a frame field;
 * - `tool.call` accepts only the reliable Vite capability subset;
 * - `tool.cancel` carries only the correlated request id and a bounded,
 *   stable reason code.
 */
import { z } from 'zod'
import { BRIDGE_ERROR_CODES, bridgeErrorSchema } from './errors.ts'
import { jsonValueSchema } from './grants.ts'
import {
  VITE_BROWSER_CAPABILITIES,
  viteBrowserTargetDescriptorSchema,
  type ViteBrowserCapability,
} from './targets.ts'
import type { RequestId, TargetId } from './ids.ts'
import type { BridgeError, BridgeErrorCode } from './errors.ts'
import type { JsonValue } from './grants.ts'

/** Current Vite page protocol version (independent from PROTOCOL_VERSION). */
export const VITE_PAGE_PROTOCOL_VERSION = 1

const versionLiteral = z.literal(VITE_PAGE_PROTOCOL_VERSION)

const requestIdSchema = z.string().min(1).max(128)
const targetIdSchema = z.string().min(32).max(64)

/** Bounded, stable reasons a host may cancel one in-flight page call. */
export const VITE_CANCEL_REASONS = ['cancelled', 'timeout', 'turn_stopping', 'revoked'] as const
export const viteCancelReasonSchema = z.enum(VITE_CANCEL_REASONS)
export type ViteCancelReason = typeof VITE_CANCEL_REASONS[number]

// --- Page → Host -----------------------------------------------------------

export const viteHelloFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('hello'),
})

export const targetRegisterFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('target.register'),
  target: viteBrowserTargetDescriptorSchema,
})

export const targetUpdateFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('target.update'),
  target: viteBrowserTargetDescriptorSchema,
})

export const viteToolAcceptedFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('tool.accepted'),
  requestId: requestIdSchema,
})

export const viteToolResultFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('tool.result'),
  requestId: requestIdSchema,
  result: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value: jsonValueSchema }),
    z.strictObject({ ok: z.literal(false), error: bridgeErrorSchema }),
  ]),
})

export const vitePingFrameSchema = z.strictObject({ v: versionLiteral, type: z.literal('ping') })
export const vitePongFrameSchema = z.strictObject({ v: versionLiteral, type: z.literal('pong') })

/** Every frame a Vite page may send to the host. */
export const vitePageToHostFrameSchema = z.discriminatedUnion('type', [
  viteHelloFrameSchema,
  targetRegisterFrameSchema,
  targetUpdateFrameSchema,
  viteToolAcceptedFrameSchema,
  viteToolResultFrameSchema,
  vitePingFrameSchema,
  vitePongFrameSchema,
])

// --- Host → Page -----------------------------------------------------------

export const targetRegisteredFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('target.registered'),
  targetId: targetIdSchema,
})

export const viteToolCallFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('tool.call'),
  requestId: requestIdSchema,
  operation: z.enum(VITE_BROWSER_CAPABILITIES),
  args: jsonValueSchema,
})

export const viteToolCancelFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('tool.cancel'),
  requestId: requestIdSchema,
  reason: viteCancelReasonSchema,
})

export const targetRevokeFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('target.revoke'),
})

export const viteErrorFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('error'),
  code: z.enum(BRIDGE_ERROR_CODES),
  message: z.string().max(500),
  retryable: z.boolean(),
})

/** Every frame the host may send to a Vite page. */
export const viteHostToPageFrameSchema = z.discriminatedUnion('type', [
  targetRegisteredFrameSchema,
  viteToolCallFrameSchema,
  viteToolCancelFrameSchema,
  targetRevokeFrameSchema,
  vitePingFrameSchema,
  vitePongFrameSchema,
  viteErrorFrameSchema,
])

/** Complete Vite page protocol union (both directions). */
export const vitePageFrameSchema = z.discriminatedUnion('type', [
  viteHelloFrameSchema,
  targetRegisterFrameSchema,
  targetRegisteredFrameSchema,
  targetUpdateFrameSchema,
  viteToolCallFrameSchema,
  viteToolCancelFrameSchema,
  viteToolAcceptedFrameSchema,
  viteToolResultFrameSchema,
  targetRevokeFrameSchema,
  vitePingFrameSchema,
  vitePongFrameSchema,
  viteErrorFrameSchema,
])

// --- Types ------------------------------------------------------------------

export interface ViteHelloFrame { v: typeof VITE_PAGE_PROTOCOL_VERSION; type: 'hello' }
export interface TargetRegisterFrame {
  v: typeof VITE_PAGE_PROTOCOL_VERSION
  type: 'target.register'
  target: ViteTarget
}
export interface TargetRegisteredFrame {
  v: typeof VITE_PAGE_PROTOCOL_VERSION
  type: 'target.registered'
  targetId: TargetId
}
export interface TargetUpdateFrame {
  v: typeof VITE_PAGE_PROTOCOL_VERSION
  type: 'target.update'
  target: ViteTarget
}
export interface ViteToolCallFrame {
  v: typeof VITE_PAGE_PROTOCOL_VERSION
  type: 'tool.call'
  requestId: RequestId
  operation: ViteBrowserCapability
  args: JsonValue
}
export interface ViteToolCancelFrame {
  v: typeof VITE_PAGE_PROTOCOL_VERSION
  type: 'tool.cancel'
  requestId: RequestId
  reason: ViteCancelReason
}
export interface ViteToolAcceptedFrame {
  v: typeof VITE_PAGE_PROTOCOL_VERSION
  type: 'tool.accepted'
  requestId: RequestId
}
export interface ViteToolResultFrame {
  v: typeof VITE_PAGE_PROTOCOL_VERSION
  type: 'tool.result'
  requestId: RequestId
  result: { ok: true; value: JsonValue } | { ok: false; error: BridgeError }
}
export interface TargetRevokeFrame {
  v: typeof VITE_PAGE_PROTOCOL_VERSION
  type: 'target.revoke'
}
export interface VitePingFrame { v: typeof VITE_PAGE_PROTOCOL_VERSION; type: 'ping' }
export interface VitePongFrame { v: typeof VITE_PAGE_PROTOCOL_VERSION; type: 'pong' }
export interface ViteErrorFrame {
  v: typeof VITE_PAGE_PROTOCOL_VERSION
  type: 'error'
  code: BridgeErrorCode
  message: string
  retryable: boolean
}

export type VitePageToHostFrame =
  | ViteHelloFrame
  | TargetRegisterFrame
  | TargetUpdateFrame
  | ViteToolAcceptedFrame
  | ViteToolResultFrame
  | VitePingFrame
  | VitePongFrame

export type ViteHostToPageFrame =
  | TargetRegisteredFrame
  | ViteToolCallFrame
  | ViteToolCancelFrame
  | TargetRevokeFrame
  | VitePingFrame
  | VitePongFrame
  | ViteErrorFrame

export type VitePageFrame = VitePageToHostFrame | ViteHostToPageFrame

/** Re-exported descriptor types under the frame-local alias. */
import type {
  BrowserTargetDescriptor,
  ViteBrowserTargetDescriptor,
} from './targets.ts'
export type ViteTarget = ViteBrowserTargetDescriptor

// --- Decoders ----------------------------------------------------------------

function fail(): never {
  throw new Error('vite page protocol frame is invalid')
}

/** Parse and validate one strict page-to-host frame from raw text. */
export function decodeVitePageToHostFrame(text: string): VitePageToHostFrame {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail()
  }
  const parsed = vitePageToHostFrameSchema.safeParse(value)
  if (!parsed.success) fail()
  return parsed.data as VitePageToHostFrame
}

/** Parse and validate one strict host-to-page frame from raw text. */
export function decodeViteHostToPageFrame(text: string): ViteHostToPageFrame {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail()
  }
  const parsed = viteHostToPageFrameSchema.safeParse(value)
  if (!parsed.success) fail()
  return parsed.data as ViteHostToPageFrame
}

export type { BrowserTargetDescriptor }
