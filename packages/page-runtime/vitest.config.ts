import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace protocol from source, like the host plugin.
      '@ycp424c/dsh-browser-bridge-protocol': resolve(import.meta.dirname, '../protocol/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
  },
})
