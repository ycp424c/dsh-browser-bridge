/**
 * Stable bridge error codes and payloads. Every failure crossing the bridge
 * is normalized into this union so the model and the UI see one vocabulary.
 */
import { z } from 'zod'

export const BRIDGE_ERROR_CODES = [
  'bridge_disconnected', 'grant_expired', 'tab_closed', 'unsupported_page',
  'debugger_busy', 'debugger_detached', 'navigation_requires_confirmation',
  'stale_element', 'timeout', 'protocol_mismatch', 'permission_denied', 'internal',
] as const

export type BridgeErrorCode = typeof BRIDGE_ERROR_CODES[number]

export interface BridgeError {
  code: BridgeErrorCode
  message: string
  retryable: boolean
}

export const bridgeErrorSchema = z.strictObject({
  code: z.enum(BRIDGE_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
})

/** Build one stable, serializable bridge error. */
export function bridgeError(
  code: BridgeErrorCode,
  message: string,
  retryable: boolean,
): BridgeError {
  return { code, message, retryable }
}

/** Recoverability guidance attached to the stable error codes. */
export const BRIDGE_ERROR_RECOVERY: Record<BridgeErrorCode, string> = {
  bridge_disconnected: 'The extension connection was lost; the host retries reads once after reconnection and rejects writes.',
  grant_expired: 'The prompt grant expired; attach the tab again in a new prompt.',
  tab_closed: 'The attached tab was closed; attach the tab again in a new prompt.',
  unsupported_page: 'The page is not an HTTP(S) page and cannot be controlled.',
  debugger_busy: 'Another debugger (for example DevTools) is attached to the tab; close it and retry.',
  debugger_detached: 'The CDP session detached (for example DevTools was opened); reattach by using the tool again.',
  navigation_requires_confirmation: 'The page navigated to an unexpected origin; attach the new page explicitly in a new prompt.',
  stale_element: 'The element reference is stale after navigation or DOM replacement; observe the page again.',
  timeout: 'The operation exceeded its time budget; retry with a narrower request.',
  protocol_mismatch: 'The extension and host speak different protocol versions; update one of them.',
  permission_denied: 'The operation was refused by the grant or extension boundary.',
  internal: 'An internal failure occurred; check the host log for the stable error code.',
}
