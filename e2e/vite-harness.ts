/**
 * Deterministic emulation of the local DSH Vite broker for browser tests:
 * health/targets/grants over HTTP and the page WebSocket protocol, with
 * redacted frame recording per target. The harness is a test double of the
 * host's `ViteTargetBroker` + routes: it never executes page code itself
 * and only records/forwards frames.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import {
  newRequestId,
  VITE_PAGE_PROTOCOL_VERSION,
  type JsonValue,
} from '@dsh-external/dsh-browser-bridge-protocol'

export interface RecordedTarget {
  targetId: string
  origin: string
  url: string
  title: string
  projectId?: string
  generation: number
  capabilities: string[]
}

export interface RecordedFrame {
  targetId: string
  frame: Record<string, unknown>
}

/** Every frame kind a page may legitimately send to the broker. */
const ALLOWED_PAGE_FRAME_TYPES = new Set([
  'hello', 'target.register', 'target.update', 'tool.accepted', 'tool.result', 'ping', 'pong',
])

interface PendingCall {
  resolve(value: JsonValue): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
}

export interface ViteBrokerHarnessOptions {
  /** When true, /health answers 302 to a remote origin (redirect probe). */
  redirectHealth?: boolean
  now?: () => number
}

export class ViteBrokerHarness {
  readonly host = '127.0.0.1'
  private http: Server | undefined
  private wss: WebSocketServer | undefined
  private readonly redirectHealth: boolean
  private readonly now: () => number
  private readonly connections = new Map<WebSocket, RecordedTarget | null>()
  private readonly frames: RecordedFrame[] = []
  private readonly pending = new Map<string, PendingCall>()
  private readonly healthHits: number[] = []
  port = 0

  constructor(options: ViteBrokerHarnessOptions = {}) {
    this.redirectHealth = options.redirectHealth ?? false
    this.now = options.now ?? Date.now
  }

  get origin(): string {
    return `http://${this.host}:${this.port}`
  }

  get wsUrl(): string {
    return `ws://${this.host}:${this.port}/dsh-browser-bridge/vite/ws`
  }

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/dsh-browser-bridge/vite/health') {
        this.healthHits.push(this.now())
        if (this.redirectHealth) {
          res.writeHead(302, { location: 'https://evil.example/health' })
          res.end()
          return
        }
        const origin = req.headers.origin
        res.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': origin ?? '*',
          vary: 'Origin',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ ok: true, protocol: 'vite-page', version: VITE_PAGE_PROTOCOL_VERSION }))
        return
      }
      if (url.pathname === '/dsh-browser-bridge/vite/targets') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(this.targets()))
        return
      }
      if (url.pathname === '/dsh-browser-bridge/vite/grants' && req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          let parsed: { targetId?: unknown } = {}
          try {
            parsed = JSON.parse(body) as { targetId?: unknown }
          } catch {
            // Rejected below.
          }
          const target = this.targets().find(candidate => candidate.targetId === parsed.targetId)
          if (target === undefined) {
            res.writeHead(404)
            res.end()
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ handle: 'h'.repeat(32) }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(resolve => {
      this.http!.listen(0, this.host, () => resolve())
    })
    this.port = (this.http!.address() as AddressInfo).port

    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on('connection', (socket: WebSocket) => {
      this.connections.set(socket, null)
      socket.on('message', data => {
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(data.toString()) as Record<string, unknown>
        } catch {
          socket.close()
          return
        }
        const target = this.connections.get(socket)
        const targetId = target?.targetId ?? 'unregistered'
        this.frames.push({ targetId, frame })
        this.handlePageFrame(socket, frame)
      })
      socket.on('close', () => {
        this.connections.delete(socket)
      })
    })
    this.http.on('upgrade', (req, socket, head) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== '/dsh-browser-bridge/vite/ws') {
        socket.destroy()
        return
      }
      this.wss!.handleUpgrade(req, socket, head, ws => {
        this.wss!.emit('connection', ws, req)
      })
    })
  }

  private handlePageFrame(socket: WebSocket, frame: Record<string, unknown>): void {
    if (frame.type === 'target.register') {
      const target = frame.target as Record<string, unknown>
      const descriptor: RecordedTarget = {
        targetId: String(target.targetId),
        origin: String(target.origin),
        url: String(target.url),
        title: String(target.title),
        generation: Number(target.generation),
        capabilities: Array.isArray(target.capabilities) ? target.capabilities.map(String) : [],
        ...(typeof target.projectId === 'string' ? { projectId: target.projectId } : {}),
      }
      this.connections.set(socket, descriptor)
      socket.send(JSON.stringify({
        v: VITE_PAGE_PROTOCOL_VERSION,
        type: 'target.registered',
        targetId: descriptor.targetId,
      }))
      return
    }
    if (frame.type === 'tool.result') {
      const pending = this.pending.get(String(frame.requestId))
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(String(frame.requestId))
      const result = frame.result as { ok?: boolean; value?: unknown; error?: unknown }
      if (result?.ok === true) {
        pending.resolve(result.value as JsonValue)
      } else {
        pending.reject(result?.error ?? new Error('page reported failure'))
      }
      return
    }
    if (frame.type === 'ping') {
      socket.send(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'pong' }))
    }
  }

  /** Redacted registrations of every connected target. */
  targets(): RecordedTarget[] {
    return [...this.connections.values()].filter((target): target is RecordedTarget => target !== null)
  }

  /** All recorded frames (redacted parsed objects, never raw payloads). */
  allFrames(): RecordedFrame[] {
    return [...this.frames]
  }

  /** The frame kinds a page actually sent (must stay inside the allowlist). */
  pageFrameKinds(): string[] {
    return this.frames.map(entry => entry.frame.type as string)
  }

  /** Assert-style helper: every page frame is an allowed page-to-host kind. */
  hasOnlyAllowedPageFrames(): boolean {
    return this.pageFrameKinds().every(kind => ALLOWED_PAGE_FRAME_TYPES.has(kind))
  }

  healthRequestCount(): number {
    return this.healthHits.length
  }

  async waitForAnyTarget(timeoutMs = 15_000): Promise<RecordedTarget> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const targets = this.targets()
      if (targets.length > 0) return targets[0]!
      if (Date.now() > deadline) throw new Error('harness: no target registered')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  async waitForTarget(targetId: string, timeoutMs = 15_000): Promise<RecordedTarget> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const target = this.targets().find(candidate => candidate.targetId === targetId)
      if (target !== undefined) return target
      if (Date.now() > deadline) throw new Error(`harness: target ${targetId} did not register`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  async waitForFrame(targetId: string, predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const frame = this.frames.find(entry =>
        entry.targetId === targetId && predicate(entry.frame))?.frame
      if (frame !== undefined) return frame
      if (Date.now() > deadline) throw new Error(`harness: frame predicate not satisfied for ${targetId}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  /** Send one tool call to the exact target and await its result. */
  async call(targetId: string, operation: string, args: JsonValue, timeoutMs = 15_000): Promise<JsonValue> {
    const entry = [...this.connections.entries()].find(([, target]) => target?.targetId === targetId)
    if (entry === undefined) throw new Error(`harness: target ${targetId} is not connected`)
    const [socket, target] = entry
    // Mirror the real host: the capability check rejects before any frame
    // is forwarded (the wire schema would reject a non-Vite operation).
    if (target !== null && !target.capabilities.includes(operation)) {
      return Promise.reject({
        code: 'unsupported_operation',
        message: `${target.provider ?? 'vite'} target does not support ${operation}`,
        retryable: false,
      })
    }
    const requestId = newRequestId()
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`harness: tool.call ${operation} timed out`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      socket.send(JSON.stringify({
        v: VITE_PAGE_PROTOCOL_VERSION,
        type: 'tool.call',
        requestId,
        operation,
        args,
      }))
    })
  }

  close(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
    this.wss?.close()
    this.http?.close()
    this.connections.clear()
  }
}
