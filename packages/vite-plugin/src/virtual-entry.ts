/**
 * The virtual runtime module: starts the page runtime with the serialized
 * public config and wires the official Vite HMR events. The internal id
 * carries a null byte so no file on disk can collide with it.
 */
import type { PageRuntimeConfig } from '@dsh-external/dsh-browser-bridge-page-runtime'
import { serializeConfig } from './serialize.ts'

export const VIRTUAL_RUNTIME_ID = 'virtual:dsh-browser-bridge/runtime'
export const VIRTUAL_RUNTIME_INTERNAL_ID = '\0virtual:dsh-browser-bridge/runtime'

export function runtimeModuleSource(config: PageRuntimeConfig): string {
  return `import { startPageRuntime } from '@dsh-external/dsh-browser-bridge-page-runtime'

const runtime = startPageRuntime(${serializeConfig(config)})

if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', () => runtime.notifyHmrUpdate())
  import.meta.hot.dispose(() => runtime.dispose())
}
`
}
