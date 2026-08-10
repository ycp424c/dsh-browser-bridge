/**
 * Write .dsh/tsconfig.paths.json from the linked DSH checkout so tsconfigs in
 * this workspace can typecheck against DSH source without building it.
 * Idempotent; run from `pnpm typecheck` (root) before any package typecheck.
 */
import { dshSourceRoot, writeDshTsconfigPaths } from './dsh-path-map.mjs'

if (dshSourceRoot() === null) {
  console.warn('sync-dsh-tsconfig: no DSH link at .dsh/source/current; skipping paths file')
} else {
  console.log(`sync-dsh-tsconfig: wrote ${writeDshTsconfigPaths()}`)
}
