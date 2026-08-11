/**
 * Low-authority health probe of the exact local DSH endpoint. Probes ONLY
 * `{dshOrigin}/dsh-browser-bridge/vite/health` — no port scanning — with a
 * bounded timeout, credentials omitted, and manual redirect handling so a
 * non-loopback redirect is never followed.
 */

export interface ProbeOptions {
  dshOrigin: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
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
    // false, so a remote redirect fails the probe.
    return response.ok && response.type !== 'opaqueredirect'
  } catch {
    // Network errors, timeouts, and blocked local access all fail closed.
    return false
  }
}
