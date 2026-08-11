/**
 * Safe config serialization for the virtual runtime module: less-than,
 * U+2028, and U+2029 are escaped so the JSON can never break out of the
 * inline module script, and only normalized public configuration is
 * serialized (the build-only injectInBuild switch is omitted).
 */
import type { PageRuntimeConfig } from '@dsh-external/dsh-browser-bridge-page-runtime'

export function serializeConfig(value: PageRuntimeConfig): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
