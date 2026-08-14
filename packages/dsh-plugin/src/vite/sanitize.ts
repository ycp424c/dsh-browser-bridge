/**
 * Host-side sanitization for Vite page data: page metadata (URL, title,
 * project id), page tool results, and error text are all treated as
 * untrusted input and normalized, bounded, and masked before any model
 * exposure. Page data is sanitized AGAIN here even though the page runtime
 * already masks it, because the wire is untrusted.
 */
import { VITE_BROWSER_CAPABILITIES, type JsonValue, type ViteBrowserTargetDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'

/** Default host resource limits for the Vite broker (spec §12). */
export const MAX_VITE_TARGETS = 32
export const MAX_VITE_TARGETS_PER_ORIGIN = 8
export const MAX_VITE_FRAME_BYTES = 1024 * 1024
export const MAX_VITE_CONCURRENT_CALLS = 4
export const MAX_VITE_FRAMES_PER_SECOND = 16
export const MAX_VITE_HEARTBEAT_MS = 15_000
export const MAX_VITE_DISCONNECT_MS = 45_000
export const MAX_VITE_RECONNECT_WINDOW_MS = 45_000

export const MAX_VITE_TITLE = 200
export const MAX_VITE_URL = 2048
export const MAX_VITE_PROJECT_ID = 100
/** Per-field string cap applied to page results before model exposure. */
export const MAX_RESULT_STRING = 2_000

const SENSITIVE_KEY = /password|passwd|token|secret|api[_-]?key|authorization|cookie|pin|cvv/i

/** Strip query and fragment from one page URL and bound its length. */
export function sanitizeViteUrl(url: string): string {
  let clean = url
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    clean = parsed.href
  } catch {
    // Keep the raw value; it is length-bounded below and never trusted.
  }
  return clean.length > MAX_VITE_URL ? clean.slice(0, MAX_VITE_URL) : clean
}

/** The exact origin (scheme://host[:port]) of one URL, or '' when invalid. */
export function exactOriginOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * Sanitize one registered Vite descriptor: strip query/fragment from the
 * URL, bound title/projectId, keep the origin exact, and cross-validate the
 * declared origin against the sanitized URL's real origin. Throws on
 * cross-origin mismatches or invalid shapes.
 */
export function sanitizeViteTarget(target: ViteBrowserTargetDescriptor): ViteBrowserTargetDescriptor {
  const url = sanitizeViteUrl(target.url)
  const realOrigin = exactOriginOf(url)
  if (realOrigin === '' || target.origin !== realOrigin) {
    throw new Error('vite target origin does not match its URL origin')
  }
  return {
    ...target,
    title: target.title.length > MAX_VITE_TITLE ? target.title.slice(0, MAX_VITE_TITLE) : target.title,
    url,
    origin: realOrigin,
    projectId: target.projectId === undefined
      ? undefined
      : target.projectId.length > MAX_VITE_PROJECT_ID
        ? target.projectId.slice(0, MAX_VITE_PROJECT_ID)
        : target.projectId,
    capabilities: [...VITE_BROWSER_CAPABILITIES].filter(capability =>
      target.capabilities.includes(capability)),
  }
}

function maskOne(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(maskOne)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : maskOne(item)
    }
    return out
  }
  if (typeof value === 'string') {
    return value.length > MAX_RESULT_STRING ? value.slice(0, MAX_RESULT_STRING) : value
  }
  return value
}

/**
 * Mask sensitive values (password/token/secret/... keys) and bound every
 * string field of one page tool result before model exposure.
 */
export function sanitizePageResultValue(value: JsonValue): JsonValue {
  return maskOne(value)
}

/** Bound and mask one page error message before model exposure. */
export function sanitizePageErrorText(message: string): string {
  const masked = message.replace(
    /(password|passwd|token|secret|api[_-]?key|authorization|cookie|pin|cvv)\s*[:=]\s*[^\s,;]+/gi,
    '$1: [REDACTED]',
  )
  return masked.length > 500 ? masked.slice(0, 500) : masked
}

/**
 * Whether one origin is a loopback-only HTTP(S) DSH origin: localhost,
 * *.localhost, 127.0.0.0/8, or ::1, without credentials. Remote DSH is
 * never allowed.
 */
export function isLoopbackDshOrigin(origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '') return false
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.search !== '' || parsed.hash !== '') return false
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4 === null) return false
  for (const octet of ipv4.slice(1)) {
    if (Number(octet) > 255) return false
  }
  return ipv4[1] === '127'
}
