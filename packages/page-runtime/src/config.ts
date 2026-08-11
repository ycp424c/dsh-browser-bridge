/**
 * Strict, serializable page runtime configuration. Only loopback DSH
 * origins are accepted (localhost, *.localhost, 127/8, ::1); credentials,
 * non-HTTP(S) schemes, and remote hosts are rejected. There is no
 * secret-bearing configuration key.
 */
import { z } from 'zod'

export interface PageRuntimeConfig {
  /** Exact loopback DSH origin the page may reach. */
  dshOrigin: string
  mode: 'development' | 'production'
  bridge: {
    enabled: boolean
    /** Production builds only: allow every visitor to probe+connect. */
    autoConnectInBuild: boolean
  }
  panel: {
    enabled: boolean
    visible: boolean
    shortcut: string
    queryParameter: string
  }
  /** Sanitized Vite project identifier (optional). */
  projectId?: string
}

export const pageRuntimeConfigSchema = z.strictObject({
  dshOrigin: z.string().min(1).max(2048),
  mode: z.enum(['development', 'production']),
  bridge: z.strictObject({
    enabled: z.boolean(),
    autoConnectInBuild: z.boolean(),
  }),
  panel: z.strictObject({
    enabled: z.boolean(),
    visible: z.boolean(),
    shortcut: z.string().min(1).max(64),
    queryParameter: z.string().min(1).max(32),
  }),
  projectId: z.string().max(100).optional(),
})

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4 === null) return false
  for (const octet of ipv4.slice(1)) {
    if (Number(octet) > 255) return false
  }
  return ipv4[1] === '127'
}

/**
 * Validate one configured DSH origin and return its exact origin
 * (scheme://host[:port]) without path, query, or fragment. Credentials,
 * non-HTTP(S) schemes, and non-loopback hosts are rejected.
 */
export function normalizeDshOrigin(origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error('dsh origin is not a valid URL')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('dsh origin must not contain credentials')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('dsh origin must be HTTP(S)')
  }
  if (!isLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('dsh origin must be loopback-only (localhost, *.localhost, 127/8, ::1)')
  }
  return parsed.origin
}
