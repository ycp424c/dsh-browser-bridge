/**
 * Deterministic browser fixture servers on 127.0.0.1 with OS-assigned ports.
 *
 * - `app` mode serves the target-tab fixture app, its CSS, a same-origin
 *   navigation target, and a 404 route.
 * - `dsh` mode serves a "DSH Web" iframe fixture page that speaks the exact
 *   parent-frame RPC against the extension side panel: it pairs with the
 *   BridgeHarness, connects the bridge, and reports readiness.
 */
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const FIXTURES = join(import.meta.dirname, 'fixtures')

export interface FixtureStyle {
  color: string
  padding: string
}

export type FixtureServerMode = 'app' | 'dsh'

export interface DshFixtureOptions {
  /** Base URL of the running BridgeHarness (pairing endpoint + WebSocket). */
  bridgeBaseUrl: string
}

/** A deterministic server serving one fixture role on 127.0.0.1. */
export class FixtureServer {
  private server: Server | undefined
  private style: FixtureStyle = { color: 'rgb(0, 0, 255)', padding: '8px' }
  readonly host = '127.0.0.1'
  private readonly mode: FixtureServerMode
  private readonly dshOptions: DshFixtureOptions | undefined

  constructor(mode: FixtureServerMode = 'app', dshOptions?: DshFixtureOptions) {
    this.mode = mode
    this.dshOptions = dshOptions
  }

  async start(): Promise<void> {
    if (this.mode === 'dsh' && this.dshOptions === undefined) {
      throw new Error('dsh mode requires bridgeBaseUrl')
    }
    const appHtml = readFileSync(join(FIXTURES, 'app.html'), 'utf8')
    const dshHtml = this.mode === 'dsh' ? this.renderDshFixture(this.dshOptions!.bridgeBaseUrl) : ''
    const otherHtml = '<!doctype html><html><body><h1>Other origin</h1></body></html>'
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (this.mode === 'dsh') {
        if (path === '/') {
          res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
          res.end(dshHtml)
          return
        }
        res.writeHead(404)
        res.end()
        return
      }
      if (path === '/style.css') {
        res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' })
        res.end(this.css())
        return
      }
      if (path === '/other') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(otherHtml)
        return
      }
      if (path === '/missing') {
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (path === '/' || path === '/same') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(appHtml)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, this.host, () => resolve())
    })
  }

  get origin(): string {
    const address = this.server!.address() as AddressInfo
    return `http://${this.host}:${address.port}`
  }

  get port(): number {
    return (this.server!.address() as AddressInfo).port
  }

  /** Change the served CSS version without reloading the extension. */
  setStyle(style: FixtureStyle): void {
    this.style = style
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => (error === undefined ? resolve() : reject(error)))
    })
  }

  private css(): string {
    const { color, padding } = this.style
    return `#save {\n  color: ${color};\n  padding: ${padding};\n}\n`
  }

  /**
   * The "DSH Web" fixture: a page that speaks the exact parent-frame RPC
   * against the extension side panel, pairs with the bridge harness, and
   * reports readiness. On iframe (re)load it re-pairs with a fresh nonce.
   */
  private renderDshFixture(bridgeBaseUrl: string): string {
    const escaped = bridgeBaseUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>DSH Fixture</title></head>
  <body>
    <h1>DSH Fixture</h1>
    <p id="bridge-state">dsh-browser-bridge connecting…</p>
    <script>
      const BRIDGE = '${escaped}'
      const pending = new Map()
      let nextId = 1
      function request(type, payload = {}) {
        return new Promise((resolve, reject) => {
          const requestId = 'f' + nextId++
          pending.set(requestId, { resolve, reject })
          parent.postMessage({ type, requestId, ...payload }, '*')
          setTimeout(() => {
            if (pending.delete(requestId)) reject(new Error('iframe rpc timeout: ' + type))
          }, 15000)
        })
      }
      function setState(text) {
        const el = document.getElementById('bridge-state')
        if (el) el.textContent = text
      }
      async function pairAndConnect() {
        const extensionOrigin = (location.ancestorOrigins && location.ancestorOrigins[0])
          || new URL(document.referrer || 'about:blank').origin
        const res = await fetch(BRIDGE + '/dsh-browser-bridge/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ extensionOrigin }),
        })
        if (!res.ok) throw new Error('pairing failed: HTTP ' + res.status)
        const { nonce } = await res.json()
        const wsUrl = BRIDGE.replace(/^http/, 'ws') + '/dsh-browser-bridge/ws'
        await request('bridge.connect', { wsUrl, pairingNonce: nonce })
      }
      window.__dshBridgeTest = {
        request,
        async attachCurrentTab() {
          const tab = (await request('tabs.current')).value
          const reply = await request('grant.create', { sessionId: 'e2e-session', tab })
          return { tab, handle: reply.value.handle }
        },
      }
      window.addEventListener('message', (event) => {
        const data = event.data
        if (data && data.type === 'panel.reply' && pending.has(data.requestId)) {
          const entry = pending.get(data.requestId)
          pending.delete(data.requestId)
          if (data.ok === true) entry.resolve(data)
          else entry.reject(new Error((data.error && data.error.message) || 'rpc failed'))
        }
      })
      pairAndConnect().then(() => {
        parent.postMessage({ type: 'bridge.client-ready' }, '*')
        setState('dsh-browser-bridge ready')
      }).catch(error => {
        setState('dsh-browser-bridge failed: ' + error.message)
      })
    </script>
  </body>
</html>
`
  }
}
