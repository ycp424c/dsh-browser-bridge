import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

const pluginDir = import.meta.dirname

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Explicit aliases from the linked DSH tsconfig paths (exact keys only).
 * Exact anchors are required: without them, `@deepseek-ai/dsh-session` would
 * prefix-match `@deepseek-ai/dsh-session/types`.
 */
function dshAliases(): Array<{ find: RegExp; replacement: string }> {
  const pathsFile = resolve(pluginDir, '../../.dsh/tsconfig.paths.json')
  const paths = JSON.parse(readFileSync(pathsFile, 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> }
  }
  const aliases: Array<{ find: RegExp; replacement: string }> = []
  for (const [name, targets] of Object.entries(paths.compilerOptions.paths)) {
    const target = targets[0]
    if (target === undefined) continue
    if (name.includes('*')) continue
    aliases.push({
      find: new RegExp(`^${escapeRegExp(name)}$`),
      replacement: resolve(pluginDir, '../../.dsh', target),
    })
  }
  return aliases
}

export default defineConfig({
  resolve: {
    alias: dshAliases(),
  },
  plugins: [tsconfigPaths({ projects: ['tsconfig.host.json', 'tsconfig.client.json'] })],
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    restoreMocks: true,
    clearMocks: true,
  },
})
