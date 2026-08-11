import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { dshBrowserBridge } from '../src/index.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'multi-page')

let outDir: string | null = null

type BuildOutput = { output: Array<{ fileName: string }> }

async function runBuild(options: Parameters<typeof dshBrowserBridge>[0]): Promise<BuildOutput> {
  outDir = await mkdtemp(join(tmpdir(), 'dsh-bridge-vite-'))
  const result = await build({
    configFile: false,
    root: FIXTURES,
    logLevel: 'silent',
    plugins: [dshBrowserBridge(options)],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      minify: false,
      rollupOptions: {
        input: {
          main: join(FIXTURES, 'index.html'),
          admin: join(FIXTURES, 'admin.html'),
        },
      },
    },
  })
  return result as unknown as BuildOutput
}

async function readAsset(name: string): Promise<string> {
  return readFile(join(outDir!, name), 'utf8')
}

async function jsAssets(): Promise<string[]> {
  const { stat } = await import('node:fs/promises')
  const all: string[] = []
  for (const name of await readdir(outDir!)) {
    const path = join(outDir!, name)
    if ((await stat(path)).isDirectory()) {
      for (const inner of await readdir(path)) {
        if (inner.endsWith('.js')) all.push(join(name, inner))
      }
    } else if (name.endsWith('.js')) {
      all.push(name)
    }
  }
  return all
}

describe('vite build injection', () => {
  afterEach(async () => {
    if (outDir !== null) await rm(outDir, { recursive: true, force: true })
    outDir = null
  })

  it('does not inject by default in production builds', async () => {
    const result = await runBuild({ dshOrigin: 'http://127.0.0.1:3080' })
    const html = await readAsset('index.html')
    expect(html).not.toContain('dsh-browser-bridge')
    expect(html).not.toContain('<script')
    expect(result.output.every(entry => !entry.fileName.includes('dsh-browser-bridge'))).toBe(true)
  })

  it('injects exactly one module script into EVERY HTML entry with injectInBuild=true', async () => {
    await runBuild({ dshOrigin: 'http://127.0.0.1:3080', bridge: { injectInBuild: true } })
    for (const name of ['index.html', 'admin.html']) {
      const html = await readAsset(name)
      const scripts = html.match(/<script[^>]*type="module"[^>]*>/g) ?? []
      expect(scripts).toHaveLength(1)
      // In production the virtual entry is bundled into a hashed asset.
      expect(scripts[0]).toMatch(/src="\/assets\/[^"]+\.js"/)
    }
  })

  it('builds the runtime bundle with a production-dormant serialized config', async () => {
    await runBuild({
      dshOrigin: 'http://127.0.0.1:3080',
      bridge: { injectInBuild: true },
      projectId: 'fixture',
    })
    const jsFiles = await jsAssets()
    expect(jsFiles.length).toBeGreaterThan(0)
    const bundle = await Promise.all(jsFiles.map(name => readAsset(name)))
    const all = bundle.join('\n')
    const runtimeIndex = all.indexOf('startPageRuntime')
    const runtimeSource = runtimeIndex === -1 ? '' : all.slice(runtimeIndex, runtimeIndex + 1_500)
    expect(all).toContain('"mode": "production"')
    expect(all).toContain('"projectId": "fixture"')
    expect(all).toContain('"autoConnectInBuild": false')
  })

  it('never leaks absolute repository paths or secret-like fields into assets', async () => {
    await runBuild({
      dshOrigin: 'http://127.0.0.1:3080',
      bridge: { injectInBuild: true },
    })
    const jsFiles = await jsAssets()
    const all = (await Promise.all(jsFiles.map(name => readAsset(name)))).join('\n')
    expect(all).not.toContain(import.meta.dirname)
    expect(all).not.toContain('/Users/')
    expect(all).not.toContain('"token"')
    expect(all).not.toContain('"secret"')
  })
})
