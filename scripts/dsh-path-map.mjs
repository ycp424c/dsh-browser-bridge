/**
 * Shared DSH source discovery for the bridge workspace tooling.
 *
 * Returns a name → source-entry map for every package in the linked DSH
 * checkout (two-level packages tree and vendor tree), used by:
 *   - scripts/sync-dsh-tsconfig.mjs (tsconfig `paths` for typechecking),
 *   - vitest configs (`resolve.alias` so unit/e2e tests execute against DSH
 *     source without building the checkout).
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..')

/** Resolve the linked checkout, or null when the link has not been created. */
export function dshSourceRoot() {
  const link = resolve(REPO_ROOT, '.dsh/source/current')
  try {
    const stat = statSync(link)
    if (!stat.isDirectory()) return null
    return link
  } catch {
    return null
  }
}

/** Guess the source entry of one package directory (index.ts preferred). */
function sourceEntry(dir) {
  for (const candidate of ['index.ts', 'src/index.ts', 'src/index.tsx', 'src']) {
    const full = join(dir, candidate)
    try {
      const stat = statSync(full)
      return stat.isDirectory() ? full : full
    } catch {
      // keep scanning
    }
  }
  return null
}

/** Rewrite one DSH-root-relative target to a repo-relative tsconfig path. */
function relativeToRepo(sourceRoot, target) {
  const rel = target.startsWith(sourceRoot)
    ? target.slice(sourceRoot.length).replace(/^[\\/]+/, '')
    : target
  return `.dsh/source/current/${rel}`
}

/**
 * Build the full path map for the linked checkout. Bare package names map to
 * their source entry; wildcard/subpath keys are copied verbatim from the
 * checkout's own tsconfig paths so subpath specifiers resolve identically.
 */
export function buildDshPathMap(sourceRoot) {
  const paths = {}
  const add = (name, dir) => {
    const entry = sourceEntry(dir)
    if (entry !== null) paths[name] = [relativeToRepo(sourceRoot, entry)]
  }
  const packagesDir = join(sourceRoot, 'packages')
  let groups = []
  try { groups = readdirSync(packagesDir) } catch { /* missing */ }
  for (const group of groups) {
    const groupDir = join(packagesDir, group)
    let stat
    try { stat = statSync(groupDir) } catch { continue }
    if (!stat.isDirectory()) continue
    for (const pkg of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, pkg)
      let pkgStat
      try { pkgStat = statSync(pkgDir) } catch { continue }
      if (!pkgStat.isDirectory()) continue
      const manifestPath = join(pkgDir, 'package.json')
      let manifest
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
      if (typeof manifest.name !== 'string' || manifest.name === '') continue
      add(manifest.name, pkgDir)
    }
  }
  const vendorDir = join(sourceRoot, 'vendor')
  let vendorPkgs = []
  try { vendorPkgs = readdirSync(vendorDir) } catch { /* missing */ }
  for (const pkg of vendorPkgs) {
    const pkgDir = join(vendorDir, pkg)
    let stat
    try { stat = statSync(pkgDir) } catch { continue }
    if (!stat.isDirectory()) continue
    const manifestPath = join(pkgDir, 'package.json')
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
    if (typeof manifest.name !== 'string' || manifest.name === '') continue
    add(manifest.name, pkgDir)
  }
  // Wildcards the checkout itself relies on (subpaths and group globs): reuse
  // its own tsconfig paths so subpath specifiers resolve identically.
  const dshBase = join(sourceRoot, 'tsconfig.base.json')
  try {
    const base = JSON.parse(stripJsonComments(readFileSync(dshBase, 'utf8')))
    const own = base.compilerOptions?.paths
    if (typeof own === 'object' && own !== null) {
      for (const [name, targets] of Object.entries(own)) {
        if (paths[name] !== undefined) continue
        paths[name] = targets.map((target) => {
          if (target.startsWith('./')) return `.dsh/source/current/${target.slice(2)}`
          return target
        })
      }
    }
  } catch {
    // No checkout tsconfig — keep the scanned map.
  }
  return paths
}

/** Minimal JSONC stripper for tsconfig files (comments + trailing commas). */
function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (inString) {
      out += char
      if (char === '\\') { out += next ?? ''; i += 1 }
      else if (char === '"') inString = false
      continue
    }
    if (inLine) {
      if (char === '\n') { inLine = false; out += char }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') { inBlock = false; i += 1 }
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && next === '/') { inLine = true; i += 1; continue }
    if (char === '/' && next === '*') { inBlock = true; i += 1; continue }
    out += char
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

/** Absolute aliases for vitest: every mapped name → its first source entry. */
export function dshAliasMap(sourceRoot) {
  const map = {}
  for (const [name, targets] of Object.entries(buildDshPathMap(sourceRoot))) {
    const first = targets[0]
    if (first === undefined) continue
    if (map[name] === undefined) map[name] = resolve(REPO_ROOT, first)
  }
  return map
}

/** Write `.dsh/tsconfig.paths.json` for the current link. */
export function writeDshTsconfigPaths() {
  const sourceRoot = dshSourceRoot()
  if (sourceRoot === null) {
    throw new Error('no DSH link at .dsh/source/current — run `pnpm link:dsh -- /absolute/path/to/dsh` first')
  }
  const paths = buildDshPathMap(sourceRoot)
  const output = resolve(REPO_ROOT, '.dsh/tsconfig.paths.json')
  mkdirSync(resolve(REPO_ROOT, '.dsh'), { recursive: true })
  writeFileSync(output, `${JSON.stringify({ compilerOptions: { paths } }, null, 2)}\n`)
  return output
}
