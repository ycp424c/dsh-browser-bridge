/**
 * Real versioned bridge protocol peer that stands in for the DSH host plugin
 * during unpacked-extension tests. Serves the pairing endpoint and the
 * authenticated WebSocket, answers grant offers, forwards tool calls, and
 * records frames with nonces and page data redacted from diagnostics.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import {
  newPairingNonce,
  PROTOCOL_VERSION,
  type BridgeFrame,
  type GrantAcceptedFrame,
  type GrantPutFrame,
  type JsonValue,
  type TabDescriptor,
  type ToolCallFrame,
  type ToolResultFrame,
} from '@ycp424c/dsh-browser-bridge-protocol'

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/

export interface AttachedGrant {
  grantId: string
  handle: string
  sessionId: string
  tab: TabDescriptor
}

interface Waiter {
  predicate: (frame: BridgeFrame) => boolean
  resolve: (frame: BridgeFrame) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** The host side of the bridge for Playwright-driven extension tests. */
export class BridgeHarness {
  private server: Server | undefined
  private wss: WebSocketServer | undefined
  private socket: WebSocket | undefined
  private readonly inbox: BridgeFrame[] = []
  private readonly waiters: Waiter[] = []
  private readonly acceptWaiters: Array<{
    resolve: (grant: AttachedGrant) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private autoAccept = false
  readonly frames: BridgeFrame[] = []
  private nonces = new Map<string, string>()
  private readonly grants = new Map<string, AttachedGrant>()

  async start(): Promise<void> {
    const self = this
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    }
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      // The pairing endpoint is called cross-origin from the DSH iframe
      // fixture (a chrome-extension:// page framing a loopback origin), so
      // the harness answers the simple CORS preflight. The nonce remains
      // single-use: the WebSocket handshake re-validates the exact origin
      // that the nonce was bound to.
      if (req.method === 'OPTIONS' && path === '/dsh-browser-bridge/pair') {
        res.writeHead(204, corsHeaders)
        res.end()
        return
      }
      if (req.method !== 'POST' || path !== '/dsh-browser-bridge/pair') {
        res.writeHead(404)
        res.end()
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        let origin = ''
        try {
          const parsed = JSON.parse(body) as { extensionOrigin?: unknown }
          if (typeof parsed.extensionOrigin === 'string') origin = parsed.extensionOrigin
        } catch {
          // invalid body
        }
        res.setHeader('Cache-Control', 'no-store')
        if (!EXTENSION_ORIGIN.test(origin)) {
          res.writeHead(400, { 'content-type': 'application/json', ...corsHeaders })
          res.end(JSON.stringify({ error: 'invalid extension origin' }))
          return
        }
        const nonce = newPairingNonce()
        self.nonces.set(nonce, origin)
        res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders })
        res.end(JSON.stringify({ nonce }))
      })
    })
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin ?? ''
      this.wss!.handleUpgrade(req, socket, head, ws => {
        this.attach(ws, origin)
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
  }

  get baseUrl(): string {
    const address = this.server!.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  get wsUrl(): string {
    const address = this.server!.address() as AddressInfo
    return `ws://127.0.0.1:${address.port}/dsh-browser-bridge/ws`
  }

  async stop(): Promise<void> {
    this.socket?.close()
    this.wss?.close()
    if (this.server !== undefined) {
      const server = this.server
      this.server = undefined
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close(error => (error === undefined ? resolve() : reject(error)))
      })
    }
  }

  send(frame: BridgeFrame): void {
    this.socket?.send(JSON.stringify(frame))
  }

  /**
   * Arm automatic acceptance of the next `grant.put`, mirroring the real
   * host plugin which accepts valid grant offers on its own. The returned
   * promise resolves with the accepted grant record.
   */
  acceptNextGrant(): Promise<AttachedGrant> {
    this.autoAccept = true
    return new Promise((resolve, reject) => {
      const waiter: { resolve: (grant: AttachedGrant) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } = {
        resolve,
        reject,
        timer: setTimeout(() => reject(new Error('harness: no grant put arrived')), 15_000),
      }
      this.acceptWaiters.push(waiter)
    })
  }

  /** Wait for the extension to offer a grant and accept it. */
  async acceptGrant(attached: { sessionId: string; tab: TabDescriptor }): Promise<AttachedGrant> {
    const put = await this.nextFrame(frame => frame.type === 'grant.put') as GrantPutFrame
    const grantId = put.grantId
    const handle = `h${'x'.repeat(31)}`
    const record: AttachedGrant = { grantId, handle, sessionId: put.sessionId, tab: put.tab }
    this.grants.set(grantId, record)
    const accepted: GrantAcceptedFrame = { v: PROTOCOL_VERSION, type: 'grant.accepted', grantId, handle }
    this.send(accepted)
    return record
  }

  /** Drive one tool call through the extension and wait for its result. */
  async call(grantId: string, operation: string, args: JsonValue, timeoutMs?: number): Promise<JsonValue> {
    const frame: ToolCallFrame = {
      v: PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: `c${this.frames.length + 1}` as never,
      grantId: grantId as never,
      operation: operation as never,
      args,
    }
    this.send(frame)
    let result: ToolResultFrame
    try {
      result = await this.nextFrame(frame => frame.type === 'tool.result', timeoutMs ?? 15_000) as ToolResultFrame
    } catch (error) {
      throw new Error(`${operation} call failed: ${(error as Error).message}`)
    }
    if (!result.result.ok) throw new Error(`${result.result.error.code}: ${result.result.error.message}`)
    return result.result.value
  }

  nextFrame(predicate: (frame: BridgeFrame) => boolean, timeoutMs = 15_000): Promise<BridgeFrame> {
    const queued = this.inbox.findIndex(predicate)
    if (queued !== -1) {
      const [frame] = this.inbox.splice(queued, 1)
      return Promise.resolve(frame!)
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => reject(new Error('harness: frame timeout')), timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  grantOf(grantId: string): AttachedGrant | undefined {
    return this.grants.get(grantId)
  }

  private attach(socket: WebSocket, origin: string): void {
    let handshaken = false
    socket.on('message', data => {
      let frame: BridgeFrame
      try {
        frame = JSON.parse(data.toString()) as BridgeFrame
      } catch {
        socket.close()
        return
      }
      if (!handshaken) {
        if (frame.type !== 'hello') {
          socket.close()
          return
        }
        const bound = this.nonces.get(frame.pairingNonce)
        if (bound !== origin) {
          socket.close()
          return
        }
        this.nonces.delete(frame.pairingNonce)
        handshaken = true
        this.socket = socket
        this.send({ v: PROTOCOL_VERSION, type: 'hello.ok', connectionId: 'harness-connection' as never })
        return
      }
      this.record(frame)
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined
    })
  }

  /** Record a frame, settling matching waiters, with diagnostics redacted. */
  private record(frame: BridgeFrame): void {
    this.frames.push(frame)
    // Auto-accept grant offers like the real host plugin does.
    if (frame.type === 'grant.put' && this.autoAccept) {
      const record: AttachedGrant = {
        grantId: frame.grantId,
        handle: `h${'x'.repeat(31)}`,
        sessionId: frame.sessionId,
        tab: frame.tab,
      }
      this.grants.set(record.grantId, record)
      const accepted: GrantAcceptedFrame = {
        v: PROTOCOL_VERSION,
        type: 'grant.accepted',
        grantId: record.grantId,
        handle: record.handle,
      }
      this.send(accepted)
      const acceptor = this.acceptWaiters.shift()
      if (acceptor !== undefined) {
        clearTimeout(acceptor.timer)
        acceptor.resolve(record)
      }
    }
    const waiterIndex = this.waiters.findIndex(waiter => waiter.predicate(frame))
    if (waiterIndex !== -1) {
      const [waiter] = this.waiters.splice(waiterIndex, 1)
      clearTimeout(waiter!.timer)
      waiter!.resolve(frame)
      return
    }
    this.inbox.push(frame)
  }
}
