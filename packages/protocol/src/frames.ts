/**
 * Versioned, strict wire frames for the authenticated extension/host bridge.
 * Every frame carries the protocol version and a discriminant; unknown keys,
 * unknown versions, and malformed JSON are rejected without echoing payloads.
 */
import { z } from 'zod'
import { BRIDGE_ERROR_CODES, bridgeErrorSchema } from './errors.ts'
import { BROWSER_OPERATIONS, jsonValueSchema, tabDescriptorSchema } from './grants.ts'
import type { BridgeError } from './errors.ts'
import type { BrowserOperation, JsonValue, TabDescriptor } from './grants.ts'
import type { ConnectionId, GrantHandle, GrantId, PairingNonce, RequestId } from './ids.ts'

/** Current bridge protocol version (bump on any incompatible frame change). */
export const PROTOCOL_VERSION = 1

const versionLiteral = z.literal(PROTOCOL_VERSION)

export const helloFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('hello'),
  pairingNonce: z.string().min(32).max(128),
})
export const helloOkFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('hello.ok'),
  connectionId: z.string().min(1),
})
export const pingFrameSchema = z.strictObject({ v: versionLiteral, type: z.literal('ping') })
export const pongFrameSchema = z.strictObject({ v: versionLiteral, type: z.literal('pong') })
export const grantPutFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('grant.put'),
  grantId: z.string().min(1),
  sessionId: z.string().min(1),
  tab: tabDescriptorSchema,
  expiresAt: z.number().nonnegative(),
})
export const grantAcceptedFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('grant.accepted'),
  grantId: z.string().min(1),
  handle: z.string().min(32).max(64),
})
export const grantRevokeFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('grant.revoke'),
  grantId: z.string().min(1),
})
export const toolCallFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('tool.call'),
  requestId: z.string().min(1),
  grantId: z.string().min(1),
  operation: z.enum(BROWSER_OPERATIONS),
  args: jsonValueSchema,
})
export const toolAcceptedFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('tool.accepted'),
  requestId: z.string().min(1),
})
export const toolResultFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('tool.result'),
  requestId: z.string().min(1),
  result: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value: jsonValueSchema }),
    z.strictObject({ ok: z.literal(false), error: bridgeErrorSchema }),
  ]),
})
export const errorFrameSchema = z.strictObject({
  v: versionLiteral,
  type: z.literal('error'),
  code: z.enum(BRIDGE_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
})

export const bridgeFrameSchema = z.discriminatedUnion('type', [
  helloFrameSchema,
  helloOkFrameSchema,
  pingFrameSchema,
  pongFrameSchema,
  grantPutFrameSchema,
  grantAcceptedFrameSchema,
  grantRevokeFrameSchema,
  toolCallFrameSchema,
  toolAcceptedFrameSchema,
  toolResultFrameSchema,
  errorFrameSchema,
])

export interface HelloFrame {
  v: typeof PROTOCOL_VERSION
  type: 'hello'
  pairingNonce: PairingNonce
}
export interface HelloOkFrame {
  v: typeof PROTOCOL_VERSION
  type: 'hello.ok'
  connectionId: ConnectionId
}
export interface PingFrame { v: typeof PROTOCOL_VERSION; type: 'ping' }
export interface PongFrame { v: typeof PROTOCOL_VERSION; type: 'pong' }
export interface GrantPutFrame {
  v: typeof PROTOCOL_VERSION
  type: 'grant.put'
  grantId: GrantId
  sessionId: string
  tab: TabDescriptor
  expiresAt: number
}
export interface GrantAcceptedFrame {
  v: typeof PROTOCOL_VERSION
  type: 'grant.accepted'
  grantId: GrantId
  handle: GrantHandle
}
export interface GrantRevokeFrame {
  v: typeof PROTOCOL_VERSION
  type: 'grant.revoke'
  grantId: GrantId
}
export interface ToolCallFrame {
  v: typeof PROTOCOL_VERSION
  type: 'tool.call'
  requestId: RequestId
  grantId: GrantId
  operation: BrowserOperation
  args: JsonValue
}
export interface ToolAcceptedFrame {
  v: typeof PROTOCOL_VERSION
  type: 'tool.accepted'
  requestId: RequestId
}
export interface ToolResultFrame {
  v: typeof PROTOCOL_VERSION
  type: 'tool.result'
  requestId: RequestId
  result: { ok: true; value: JsonValue } | { ok: false; error: BridgeError }
}
export interface ErrorFrame extends BridgeError {
  v: typeof PROTOCOL_VERSION
  type: 'error'
}

export type BridgeFrame =
  | HelloFrame
  | HelloOkFrame
  | PingFrame
  | PongFrame
  | GrantPutFrame
  | GrantAcceptedFrame
  | GrantRevokeFrame
  | ToolCallFrame
  | ToolAcceptedFrame
  | ToolResultFrame
  | ErrorFrame

/**
 * Serialize one frame. `JSON.stringify` cannot throw for the plain JSON
 * payloads every frame type declares.
 */
export function encodeFrame(frame: BridgeFrame): string {
  return JSON.stringify(frame)
}

/**
 * Parse and validate one inbound frame. Any failure — malformed JSON, wrong
 * shape, unknown version, extra fields, unknown discriminant — throws a
 * generic error that never echoes the received payload.
 */
export function decodeFrame(text: string): BridgeFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('protocol frame is invalid')
  }
  const result = bridgeFrameSchema.safeParse(parsed)
  if (!result.success) throw new Error('protocol frame is invalid')
  return result.data as BridgeFrame
}
