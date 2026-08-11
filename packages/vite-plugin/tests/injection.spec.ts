import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { dshBrowserBridge } from '../src/index.ts'

const INDEX_HTML = '<!doctype html><html><head><title>App</title></head><body><h1>App</h1></body></html>'

let server: ViteDevServer | null = null

async function makeServer(options: Parameters<typeof dshBrowserBridge>[0]): Promise<ViteDevServer> {
  const instance = await createServer({
    configFile: false,
    root: import.meta.dirname,
    logLevel: 'silent',
    plugins: [dshBrowserBridge(options)],
    server: { middlewareMode: true },
  })
  server = instance
  return instance
}

async function transform(instance: ViteDevServer, html = INDEX_HTML): Promise<string> {
  const result = await instance.transformIndexHtml('/index.html', html)
  if (typeof result === 'string') return result
  return (result as { html: string }).html
}

describe('vite dev injection', () => {
  afterEach(async () => {
    await server?.close()
    server = null
  })

  it('injects exactly one module script referencing the virtual runtime by default', async () => {
    const instance = await makeServer({ dshOrigin: 'http://127.0.0.1:3080' })
    const html = await transform(instance)
    const scripts = html.match(/<script[^>]*type="module"[^>]*>/g) ?? []
    // Vite injects its own client; the plugin adds exactly ONE runtime tag.
    expect(scripts.filter(script => script.includes('virtual:dsh-browser-bridge/runtime'))).toHaveLength(1)
  })

  it('injects nothing when bridge.enabled=false', async () => {
    const instance = await makeServer({ dshOrigin: 'http://127.0.0.1:3080', bridge: { enabled: false } })
    const html = await transform(instance)
    expect(html).not.toContain('dsh-browser-bridge')
    expect(html).not.toContain('virtual:dsh-browser-bridge')
  })

  it('serves the virtual runtime module with the serialized config', async () => {
    const instance = await makeServer({
      dshOrigin: 'http://127.0.0.1:3080',
      projectId: 'fixture',
      panel: { enabled: false },
    })
    const html = await transform(instance)
    const match = html.match(/src="([^"]*virtual:dsh-browser-bridge\/runtime[^"]*)"/)
    expect(match).not.toBeNull()
    const module = await instance.transformRequest(match![1]!)
    const code = module?.code ?? ''
    expect(code).toContain('startPageRuntime')
    expect(code).toContain('"mode":"development"')
    expect(code).toContain('"projectId":"fixture"')
    expect(code).toContain('"enabled":false')
    expect(code).toContain('import.meta.hot')
  })
})
