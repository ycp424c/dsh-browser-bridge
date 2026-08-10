/**
 * Safe non-secret prompt marker encoding for attached tabs. A marker carries
 * only a syntactically valid correlation handle; no label, token, tab id, or
 * URL ever enters prompt text through this module.
 */
import type { GrantHandle } from './ids.ts'

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{32,64}$/

const MARKER = /\[\[dsh-browser-context:([A-Za-z0-9_-]{32,64})\]\]/g

export const encodeMarker = (handle: string): string => {
  if (!HANDLE_PATTERN.test(handle)) throw new Error('invalid grant handle')
  return `[[dsh-browser-context:${handle}]]`
}

export interface MarkerMatch {
  handle: GrantHandle
  marker: string
}

export const extractMarkers = (text: string): MarkerMatch[] =>
  [...text.matchAll(MARKER)].map(match => ({ handle: match[1] as GrantHandle, marker: match[0] }))
