/**
 * Authenticated WebSocket client for the extension side of the bridge.
 * Every inbound frame is validated by the protocol package; the client emits
 * typed state, forwards decoded frames, answers host pings, keeps the
 * service worker alive with heartbeat pings, and asks for a FRESH pairing
 * nonce (never a replay) after a dropped connection.
 */
import {
  bridgeError,
  decodeFrame,
  encodeFrame,
  PROTOCOL_VERSION,
  type BridgeFrame,
  type PairingNonce,
} from '@dsh-external/dsh-browser-bridge-protocol'

/** Socket face driven by the client; the real transport wraps a `ws`-style socket. */
export interface BridgeSocket {
  send(text: string): void
  close(): void
  onOpen(handler: () => void): void
  onMessage(handler: (text: string) => void): void
  onClose(handler: () => void): void
}

export type BridgeClientState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface BridgeClientOptions {
  createSocket: (url: string) => BridgeSocket
  heartbeatMs?: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

export class BridgeClient {
  private readonly createSocket: (url: string) => BridgeSocket
  private readonly heartbeatMs: number
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private socket: BridgeSocket | null = null
  private url = ''
  private pairingNonce: PairingNonce | null = null
  private currentState: BridgeClientState = 'idle'
  private owned = false
  private reconnectAttempt = 0
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** The connection id of the last authenticated logical session. */
  private lastConnectionId: string | null = null
  private readonly stateHandlers = new Set<(state: BridgeClientState) => void>()
  private readonly frameHandlers = new Set<(frame: BridgeFrame) => void>()
  private readonly pairingRequiredHandlers = new Set<(delayMs: number) => void>()
  private readonly sessionChangedHandlers = new Set<() => void>()

  constructor(options: BridgeClientOptions) {
    this.createSocket = options.createSocket
    this.heartbeatMs = options.heartbeatMs ?? 20_000
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500
    this.reconnectMaxMs = options.reconnectMaxMs ?? 10_000
  }

  get state(): BridgeClientState {
    return this.currentState
  }

  onState(handler: (state: BridgeClientState) => void): () => void {
    this.stateHandlers.add(handler)
    return () => this.stateHandlers.delete(handler)
  }

  onFrame(handler: (frame: BridgeFrame) => void): () => void {
    this.frameHandlers.add(handler)
    return () => this.frameHandlers.delete(handler)
  }

  /** Called after the reconnect backoff when a fresh nonce is required. */
  onPairingRequired(handler: (delayMs: number) => void): () => void {
    this.pairingRequiredHandlers.add(handler)
    return () => this.pairingRequiredHandlers.delete(handler)
  }

  /**
   * Called when a new `hello.ok` carries a DIFFERENT connection id than the
   * previous logical session (the host process restarted or another session
   * took over). Every grant of the old session must be revoked locally.
   */
  onSessionChanged(handler: () => void): () => void {
    this.sessionChangedHandlers.add(handler)
    return () => this.sessionChangedHandlers.delete(handler)
  }

  /**
   * Open a connection with one fresh single-use pairing nonce. A later
   * reconnect MUST supply a new nonce; this method never reuses the old one.
   */
  connect(url: string, pairingNonce: string): void {
    this.url = url
    this.pairingNonce = pairingNonce as PairingNonce
    this.owned = true
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    this.openSocket()
  }

  /**
   * Stop the client; no reconnect or pairing-required event follows. This is
   * the TERMINAL loss path (the panel port closed): the owner revokes every
   * grant and CDP session before calling this.
   */
  close(): void {
    this.owned = false
    this.lastConnectionId = null
    this.clearReconnectTimer()
    this.clearHeartbeat()
    if (this.socket !== null) {
      const socket = this.socket
      this.socket = null
      socket.close()
    }
    this.setState('closed')
  }

  /** Send one validated frame over the live connection. */
  send(frame: BridgeFrame): void {
    const socket = this.socket
    if (this.currentState !== 'connected' || socket === null) {
      throw bridgeError('bridge_disconnected', 'browser bridge is not connected', true)
    }
    socket.send(encodeFrame(frame))
  }

  private openSocket(): void {
    const socket = this.createSocket(this.url)
    this.socket = socket
    this.setState('connecting')
    socket.onOpen(() => {
      if (this.socket !== socket) return
      const nonce = this.pairingNonce
      if (nonce === null) return
      socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: nonce }))
    })
    socket.onMessage(text => this.handleFrame(text, socket))
    socket.onClose(() => this.handleClose(socket))
  }

  private handleFrame(text: string, socket: BridgeSocket): void {
    let frame: BridgeFrame
    try {
      frame = decodeFrame(text)
    } catch {
      // Invalid frames never echo their payload; a broken peer is dropped.
      socket.close()
      return
    }
    if (frame.type === 'hello.ok') {
      // A different connection id means the old logical session is gone
      // (the host restarted or was replaced): local grants of that session
      // must be revoked before any new work can use them.
      if (this.lastConnectionId !== null && frame.connectionId !== this.lastConnectionId) {
        for (const handler of this.sessionChangedHandlers) handler()
      }
      this.lastConnectionId = frame.connectionId
      this.setState('connected')
      this.startHeartbeat()
      return
    }
    if (frame.type === 'ping') {
      socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'pong' }))
    }
    for (const handler of this.frameHandlers) handler(frame)
  }

  private handleClose(socket: BridgeSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.clearHeartbeat()
    if (!this.owned) return
    this.setState('reconnecting')
    const delay = this.nextReconnectDelay()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      for (const handler of this.pairingRequiredHandlers) handler(delay)
    }, delay)
  }

  /** Exponential backoff (base 500 ms, cap 10 s) with 0.5–1.0 jitter. */
  private nextReconnectDelay(): number {
    const attempt = this.reconnectAttempt
    this.reconnectAttempt += 1
    const exponential = Math.min(this.reconnectBaseMs * 2 ** attempt, this.reconnectMaxMs)
    const jitter = 0.5 + Math.random() * 0.5
    return Math.round(exponential * jitter)
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null
      if (this.currentState !== 'connected' || this.socket === null) return
      try {
        this.socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'ping' }))
      } catch {
        // The socket may be closing; the close handler owns recovery.
      }
      this.startHeartbeat()
    }, this.heartbeatMs)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setState(state: BridgeClientState): void {
    if (this.currentState === state) return
    this.currentState = state
    for (const handler of this.stateHandlers) handler(state)
  }
}
