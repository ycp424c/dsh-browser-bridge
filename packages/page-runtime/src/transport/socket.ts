/**
 * Resilient page socket: connects to the exact local DSH broker, sends
 * hello/register, maps strict incoming tool calls to the supplied
 * dispatcher (accepted before execution), correlates results, aborts the
 * exact in-flight call on tool.cancel, heartbeats, and reconnects with
 * bounded exponential backoff. Retry decisions stay Host-owned: the page
 * never self-replays a tool call, and a disconnect settles every in-flight
 * call as target_disconnected.
 */
import {
  decodeViteHostToPageFrame,
  VITE_PAGE_PROTOCOL_VERSION,
  type JsonValue,
  type ViteBrowserCapability,
  type ViteBrowserTargetDescriptor,
  type ViteHostToPageFrame,
  type VitePageToHostFrame,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { toBridgeError } from '../tools/dispatcher.ts'

/** Minimal WebSocket face (the real `WebSocket` satisfies it). */
export interface PageWebSocket {
  readonly url: string
  send(text: string): void
  close(): void
  onopen: (() => void) | null
  /** Receives MessageEvents, like the real WebSocket. */
  onmessage: ((event: MessageEvent) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

/** One browser-tool execution face supplied by the runtime. */
export interface PageDispatcher {
  execute(operation: ViteBrowserCapability, args: JsonValue, signal: AbortSignal): Promise<JsonValue>
}

export interface PageSocketOptions {
  url: string
  descriptor(): ViteBrowserTargetDescriptor
  dispatcher: PageDispatcher
  /** Page-side heartbeat interval (default 15s). */
  heartbeatMs?: number
  /** Exponential backoff bounds (defaults 250ms base, 5s cap). */
  backoffBaseMs?: number
  backoffMaxMs?: number
  connectImpl?(url: string): PageWebSocket
}

interface InFlightCall {
  requestId: string
  controller: AbortController
  /** The dispatcher execution; settled or aborted exactly once. */
  executing: Promise<unknown> | null
}

export class PageSocket {
  private readonly options: PageSocketOptions
  private socket: PageWebSocket | null = null
  private connected = false
  private closeRequested = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly inFlight = new Map<string, InFlightCall>()
  private readonly revokeHandlers = new Set<() => void>()

  constructor(options: PageSocketOptions) {
    this.options = options
  }

  /** Connect (or begin the reconnect loop). */
  connect(): void {
    this.closeRequested = false
    this.open()
  }

  /** Subscribe to a host-issued target.revoke. */
  onRevoke(handler: () => void): () => void {
    this.revokeHandlers.add(handler)
    return () => this.revokeHandlers.delete(handler)
  }

  /** Send one strict page-to-host frame (dropped while disconnected). */
  send(frame: VitePageToHostFrame): void {
    if (!this.connected || this.socket === null) return
    this.socket.send(JSON.stringify(frame))
  }

  /** Stop reconnecting, drop the heartbeat, and settle every in-flight call. */
  close(): void {
    this.closeRequested = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopHeartbeat()
    this.settleAll()
    this.socket?.close()
    this.socket = null
  }

  private open(): void {
    if (this.closeRequested) return
    const socket: PageWebSocket = this.options.connectImpl !== undefined
      ? this.options.connectImpl(this.options.url)
      : new WebSocket(this.options.url) as unknown as PageWebSocket
    this.socket = socket
    socket.onopen = () => {
      this.connected = true
      this.reconnectAttempt = 0
      this.startHeartbeat()
      this.sendFrame({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' })
      this.sendFrame({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'target.register', target: this.options.descriptor() })
    }
    socket.onmessage = (event: MessageEvent) => {
      const data = event.data
      this.receive(typeof data === 'string' ? data : String(data))
    }
    socket.onclose = () => this.handleClose()
    socket.onerror = () => {
      // The close event drives recovery.
    }
  }

  private handleClose(): void {
    this.connected = false
    this.stopHeartbeat()
    // Every in-flight call settles now; the page NEVER replays a tool call,
    // whether or not the host acknowledged it.
    this.settleAll()
    if (this.closeRequested) return
    const base = this.options.backoffBaseMs ?? 250
    const max = this.options.backoffMaxMs ?? 5_000
    const delay = Math.min(base * 2 ** this.reconnectAttempt, max)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private settleAll(): void {
    for (const call of [...this.inFlight.values()]) {
      this.inFlight.delete(call.requestId)
      call.controller.abort()
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const interval = this.options.heartbeatMs ?? 15_000
    this.heartbeatTimer = setInterval(() => {
      this.sendFrame({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'ping' })
    }, interval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private sendFrame(frame: VitePageToHostFrame): void {
    if (!this.connected || this.socket === null) return
    this.socket.send(JSON.stringify(frame))
  }

  private receive(text: string): void {
    let frame: ViteHostToPageFrame
    try {
      frame = decodeViteHostToPageFrame(text)
    } catch {
      // Strict schema: malformed or page-shaped frames are ignored.
      return
    }
    switch (frame.type) {
      case 'target.registered':
        return
      case 'ping':
        this.sendFrame({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'pong' })
        return
      case 'pong':
        return
      case 'tool.call':
        this.handleToolCall(frame)
        return
      case 'tool.cancel': {
        const call = this.inFlight.get(frame.requestId)
        if (call !== undefined) call.controller.abort()
        return
      }
      case 'target.revoke': {
        this.settleAll()
        for (const handler of [...this.revokeHandlers]) handler()
        return
      }
      case 'error': {
        // A protocol version mismatch is terminal: the host will never
        // accept this runtime, so reconnecting would only burn backoff
        // cycles without ever reaching a connected state.
        if (frame.code === 'protocol_mismatch') {
          this.closeRequested = true
          this.stopHeartbeat()
          this.settleAll()
          this.socket?.close()
        }
        return
      }
    }
  }

  private handleToolCall(frame: Extract<ViteHostToPageFrame, { type: 'tool.call' }>): void {
    if (this.inFlight.has(frame.requestId)) return
    const controller = new AbortController()
    const call: InFlightCall = { requestId: frame.requestId, controller, executing: null }
    this.inFlight.set(frame.requestId, call)
    // Acknowledge delivery BEFORE executing: the host may then cancel.
    this.sendFrame({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'tool.accepted', requestId: frame.requestId })
    call.executing = this.options.dispatcher
      .execute(frame.operation, frame.args, controller.signal)
      .then(value => {
        if (this.inFlight.get(frame.requestId) !== call) return
        this.inFlight.delete(frame.requestId)
        this.sendFrame({
          v: VITE_PAGE_PROTOCOL_VERSION,
          type: 'tool.result',
          requestId: frame.requestId,
          result: { ok: true, value },
        })
      })
      .catch(error => {
        if (this.inFlight.get(frame.requestId) !== call) return
        this.inFlight.delete(frame.requestId)
        // A cancelled call (tool.cancel or disconnect) is never answered.
        if (controller.signal.aborted) return
        this.sendFrame({
          v: VITE_PAGE_PROTOCOL_VERSION,
          type: 'tool.result',
          requestId: frame.requestId,
          result: { ok: false, error: toBridgeError(error) },
        })
      })
  }
}
