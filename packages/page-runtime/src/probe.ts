/**
 * Low-authority health probe of the exact local DSH endpoint. Probes ONLY
 * `{dshOrigin}/dsh-browser-bridge/vite/health` — no port scanning — with a
 * bounded timeout, credentials omitted, and manual redirect handling so a
 * non-loopback redirect is never followed.
 *
 * The probe does NOT trust the status line alone: it reads the response
 * body with a hard size bound and validates the exact host health contract
 * (`ok:true`, `protocol:"vite-page"`, `version` equal to
 * VITE_PAGE_PROTOCOL_VERSION). A DSH SPA fallback that answers any unknown
 * path with 200 + HTML therefore fails the probe instead of showing a fake
 * launcher. Content-Type is an additional constraint, never the source of
 * truth: a missing header still falls through to body validation, and an
 * explicitly non-JSON type fails immediately.
 */
import { VITE_PAGE_PROTOCOL_VERSION } from '@dsh-external/dsh-browser-bridge-protocol'

export interface ProbeOptions {
  dshOrigin: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Hard bound on the health body; the real payload is ~80 bytes. */
export const MAX_HEALTH_BODY_BYTES = 4_096

/** Read the response body up to MAX_HEALTH_BODY_BYTES, or null when it is
 *  absent, oversized, or undecodable. The reader is cancelled (the body
 *  stops being consumed) the moment the bound is exceeded. */
async function readHealthBody(response: Response): Promise<string | null> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_HEALTH_BODY_BYTES) return null
  if (response.body == null) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > MAX_HEALTH_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** Strict check of the exact host health contract in the decoded body. */
function isViteHealthPayload(text: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.ok === true
    && record.protocol === 'vite-page'
    && record.version === VITE_PAGE_PROTOCOL_VERSION
}

export async function probeLocalDsh(options: ProbeOptions): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 2_000
  try {
    const response = await fetchImpl(`${options.dshOrigin}/dsh-browser-bridge/vite/health`, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    })
    // A manual redirect never follows: its type is opaqueredirect and ok is
    // false, so a remote redirect fails the probe. Any non-2xx fails too,
    // even when the body happens to look like health JSON.
    if (!response.ok || response.type === 'opaqueredirect') return false
    // Content-Type is a coarse gate only: an explicitly non-JSON type (for
    // example the DSH SPA fallback's text/html) fails without parsing, and
    // a missing type still falls through to strict body validation.
    const type = response.headers.get('content-type')
    if (type !== null && !type.toLowerCase().startsWith('application/json')) return false
    const body = await readHealthBody(response)
    if (body === null) return false
    return isViteHealthPayload(body)
  } catch {
    // Network errors, timeouts, and blocked local access all fail closed.
    return false
  }
}
