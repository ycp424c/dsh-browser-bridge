/**
 * Write .dsh/tsconfig.paths.json from the linked DSH checkout so tsconfigs in
 * this workspace can typecheck against DSH source without building it.
 * Idempotent; run from `pnpm typecheck` (root) before any package typecheck.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dshSourceRoot, REPO_ROOT, writeDshTsconfigPaths } from './dsh-path-map.mjs'

if (dshSourceRoot() === null) {
  console.warn('sync-dsh-tsconfig: no DSH link at .dsh/source/current; skipping paths file')
} else {
  const output = writeDshTsconfigPaths()
  // Workspace-internal packages resolve to source so dependents can typecheck
  // and unit-test without a prior build of the dependency.
  const current = JSON.parse(readFileSync(output, 'utf8'))
  current.compilerOptions.paths['@dsh-external/dsh-browser-bridge-protocol'] = [
    '../packages/protocol/src/index.ts',
  ]
  writeFileSync(output, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`sync-dsh-tsconfig: wrote ${output}`)
}
