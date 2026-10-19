import { defineConfig } from 'vitest/config'
import { testAliases } from '../../scripts/dsh-sdk.mjs'

import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: [{ find: /^@ycp424c\/dsh-browser-bridge-protocol$/, replacement: fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)) }, ...testAliases()] },
  test: {
    environment: 'node', include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    server: { deps: { inline: [/dsh-client-store/, /zustand/, /immer/] } },
    restoreMocks: true, clearMocks: true,
  },
})
