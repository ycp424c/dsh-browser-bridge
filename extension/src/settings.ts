/**
 * Local DSH Web origin configuration: validation, normalization, and
 * storage. Only loopback HTTP(S) origins are accepted in the first release.
 */
export const DEFAULT_DSH_ORIGIN = 'http://127.0.0.1:3080'

export const DSH_ORIGIN_STORAGE_KEY = 'dshOrigin'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Normalize a user-supplied DSH Web origin. Accepts only loopback HTTP(S)
 * origins; any path/search/hash is stripped. Throws for anything else.
 */
export function normalizeDshOrigin(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error(`not a local DSH origin: ${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`not a local DSH origin: ${input}`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`not a local DSH origin: ${input}`)
  }
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.origin
}

/** Minimal storage face so unit tests never touch `chrome.storage`. */
export interface SettingsStorage {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

export async function loadDshOrigin(storage: SettingsStorage): Promise<string> {
  const saved = await storage.get(DSH_ORIGIN_STORAGE_KEY)
  if (saved === undefined) return DEFAULT_DSH_ORIGIN
  try {
    return normalizeDshOrigin(saved)
  } catch {
    return DEFAULT_DSH_ORIGIN
  }
}

export async function saveDshOrigin(storage: SettingsStorage, origin: string): Promise<string> {
  const normalized = normalizeDshOrigin(origin)
  await storage.set(DSH_ORIGIN_STORAGE_KEY, normalized)
  return normalized
}
