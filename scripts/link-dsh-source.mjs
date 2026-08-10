import { lstat, mkdir, readlink, symlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

// pnpm 11 forwards a leading `--` verbatim to run scripts; accept both
// `pnpm link:dsh -- /path` and `pnpm link:dsh /path`.
let source = process.argv[2]
if (source === '--') source = process.argv[3]
if (source === undefined || !isAbsolute(source)) throw new Error('usage: pnpm link:dsh -- /absolute/path/to/dsh')
const root = resolve(import.meta.dirname, '..')
for (const required of ['AGENTS.md', 'packages/client/runtime', 'vendor/cordis']) {
  await lstat(resolve(source, required))
}
const link = resolve(root, '.dsh/source/current')
await mkdir(resolve(root, '.dsh/source'), { recursive: true })
try {
  const current = await readlink(link)
  if (resolve(resolve(link, '..'), current) !== resolve(source)) {
    throw new Error(`existing DSH link points to ${current}`)
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  await symlink(resolve(source), link, 'dir')
}
console.log(`${link} -> ${resolve(source)}`)
