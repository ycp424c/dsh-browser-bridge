/**
 * @dsh-external/dsh-browser-bridge-vite — injects the DSH browser bridge
 * page runtime into Vite pages. Dev serves inject by default; production
 * builds inject only when `bridge.injectInBuild` is explicitly true, and
 * the serialized config keeps the production default of zero-network
 * dormancy. Library mode and non-HTML SSR output are never injected.
 */
import type { Plugin, ResolvedConfig } from 'vite'
import type { PageRuntimeConfig } from '@dsh-external/dsh-browser-bridge-page-runtime'
import { resolveOptions, type DshBrowserBridgeOptions } from './options.ts'
import { VIRTUAL_RUNTIME_ID, VIRTUAL_RUNTIME_INTERNAL_ID, runtimeModuleSource } from './virtual-entry.ts'

export { resolveOptions, type DshBrowserBridgeOptions, type ResolvedPluginOptions } from './options.ts'
export { serializeConfig } from './serialize.ts'
export { VIRTUAL_RUNTIME_ID, VIRTUAL_RUNTIME_INTERNAL_ID, runtimeModuleSource } from './virtual-entry.ts'

export function dshBrowserBridge(options: DshBrowserBridgeOptions): Plugin {
  const resolved = resolveOptions(options)
  let mode: 'development' | 'production' = 'development'
  let inject = false

  const pageConfig = (): PageRuntimeConfig => ({
    dshOrigin: resolved.dshOrigin,
    mode,
    bridge: {
      enabled: resolved.bridge.enabled,
      autoConnectInBuild: resolved.bridge.autoConnectInBuild,
    },
    panel: resolved.panel,
    ...(resolved.projectId !== undefined ? { projectId: resolved.projectId } : {}),
  })

  return {
    name: 'dsh-browser-bridge',
    configResolved(config: ResolvedConfig) {
      mode = config.command === 'serve' ? 'development' : 'production'
      // Serve always injects (when enabled); builds only with the explicit
      // injectInBuild switch. Library mode and SSR output are never touched.
      inject = resolved.bridge.enabled
        && (config.command === 'serve' || resolved.bridge.injectInBuild)
        && !config.build.lib
        && !config.build.ssr
    },
    resolveId(id) {
      if (id === VIRTUAL_RUNTIME_ID) return VIRTUAL_RUNTIME_INTERNAL_ID
      return null
    },
    load(id) {
      if (id === VIRTUAL_RUNTIME_INTERNAL_ID) return runtimeModuleSource(pageConfig())
      return null
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (!inject) return html
        // One module script per HTML entry. The virtual id is NOT a loadable
        // URL, so the script imports it inline and Vite resolves it.
        return {
          html,
          tags: [
            {
              tag: 'script',
              attrs: { type: 'module' },
              children: `import '${VIRTUAL_RUNTIME_ID}'`,
              injectTo: 'head-prepend',
            },
          ],
        }
      },
    },
  }
}
