import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
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
    server: { host: '127.0.0.1', port: 0 },
  })
  await instance.listen()
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
    // Vite injects its own client plus one html-proxy for the plugin's
    // inline runtime import.
    expect(scripts.filter(script => script.includes('/@vite/client'))).toHaveLength(1)
    expect(scripts.filter(script => script.includes('/@id/'))).toHaveLength(1)
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
    // Vite rewrites the inline import into an html-proxy script tag.
    expect(html).toMatch(/src="[^"]*\/\@id\/[^"]*html-proxy[^"]*"/)
    // The virtual runtime module serves the serialized config through the
    // real dev-server resolution pipeline.
    const address = instance.httpServer!.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/@id/virtual:dsh-browser-bridge/runtime`)
    expect(response.ok).toBe(true)
    const code = await response.text()
    expect(code).toContain('startPageRuntime')
    expect(code).toContain('"mode":"development"')
    expect(code).toContain('"projectId":"fixture"')
    expect(code).toContain('"enabled":false')
    expect(code).toContain('import.meta.hot')
  })
})
