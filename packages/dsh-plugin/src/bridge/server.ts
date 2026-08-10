/**
 * Authenticated WebSocket carrier and request correlation. The server owns
 * exactly one authenticated extension connection; requests are correlated by
 * random request id and settled by `tool.result` frames, cancellation, the
 * tool timeout, or connection loss.
 */
import {
  bridgeError,
  ConnectionId,
  decodeFrame,
  encodeFrame,
  GrantId,
  PROTOCOL_VERSION,
  RequestId,
  type BridgeFrame,
  type BridgeError,
  type BrowserOperation,
  type ConnectionId as ConnectionIdBrand,
  type JsonValue,
} from '@dsh-external/dsh-browser-bridge-protocol'
import type { WebSocket } from 'ws'
import { GrantStore } from './grant-store.ts'
import { PairingStore } from './pairing-store.ts'

/** Socket face the server drives; the real transport wraps a `ws` socket. */
export interface BridgeSocket {
  send(text: string): void
  close(): void
  onMessage(handler: (text: string) => void): void
  onClose(handler: () => void): void
}

export interface BridgeServerOptions {
  pairing: PairingStore
  grants: GrantStore
  now?: () => number
  randomId?: () => string
  toolTimeoutMs?: number
}

/** Adapter over a `ws` socket for the real DSH host transport. */
export function attachWebSocket(server: BridgeServer, socket: WebSocket, origin: string): void {
  const adapter: BridgeSocket = {
    send: text => {
      if (socket.readyState === socket.OPEN) socket.send(text)
    },
    close: () => socket.close(),
    onMessage: handler => {
      socket.on('message', data => {
        handler(typeof data === 'string' ? data : data.toString())
      })
    },
    onClose: handler => {
      socket.on('close', () => handler())
    },
  }
  server.attach(adapter, origin)
}

interface PendingCall {
  resolve(value: JsonValue): void
  reject(error: unknown): void
  finish(): void
}

interface LiveConnection {
  id: ConnectionIdBrand
  socket: BridgeSocket
}

export class BridgeServer {
  private readonly pairing: PairingStore
  private readonly grants: GrantStore
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly toolTimeoutMs: number
  private connection: LiveConnection | null = null
  private readonly pending = new Map<string, PendingCall>()
  private readonly connectionLostHandlers = new Set<() => void>()

  constructor(options: BridgeServerOptions) {
    this.pairing = options.pairing
    this.grants = options.grants
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => {
      const buffer = new Uint8Array(32)
      globalThis.crypto.getRandomValues(buffer)
      let out = ''
      for (const byte of buffer) out += byte.toString(16).padStart(2, '0')
      return out
    })
    this.toolTimeoutMs = options.toolTimeoutMs ?? 60_000
  }

  /** The currently authenticated connection id, or undefined. */
  get connectionId(): ConnectionIdBrand | undefined {
    return this.connection?.id
  }

  /**
   * Attach one socket and run the pairing handshake: the first frame must be
   * a `hello` whose nonce was issued for this exact extension origin. After
   * a valid handshake the socket becomes the live connection, replacing and
   * closing any prior one.
   */
  attach(socket: BridgeSocket, origin: string): void {
    let handshaken = false
    socket.onMessage(text => {
      let frame: BridgeFrame
      try {
        frame = decodeFrame(text)
      } catch {
        this.fail(socket, 'protocol_mismatch', 'received an invalid bridge frame')
        return
      }
      if (!handshaken) {
        if (frame.type !== 'hello') {
          this.fail(socket, 'protocol_mismatch', 'expected a hello frame first')
          return
        }
        try {
          this.pairing.consume(frame.pairingNonce, origin)
        } catch (error) {
          this.fail(socket, 'permission_denied', error instanceof Error ? error.message : 'pairing rejected')
          return
        }
        handshaken = true
        const id = ConnectionId(this.randomId())
        this.acceptAuthenticated(socket, id)
        return
      }
      this.receive(frame, socket)
    })
    socket.onClose(() => {
      if (this.connection?.socket !== socket) return
      this.connection = null
      this.rejectAllPending(bridgeError('bridge_disconnected', 'browser extension connection closed', true))
      for (const handler of this.connectionLostHandlers) handler()
    })
  }

  /**
   * Promote a socket to the live connection (used by the handshake and by
   * tests that pre-authenticate). A replacement closes the prior connection
   * and rejects its pending calls.
   */
  acceptAuthenticated(socket: BridgeSocket, connectionId: ConnectionIdBrand = ConnectionId(this.randomId())): void {
    const prior = this.connection
    if (prior != null && prior.socket !== socket) {
      this.connection = null
      prior.socket.close()
      this.rejectAllPending(bridgeError('bridge_disconnected', 'browser extension connection replaced', true))
      for (const handler of this.connectionLostHandlers) handler()
    }
    this.connection = { id: connectionId, socket }
    socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'hello.ok', connectionId }))
  }

  /**
   * Send one tool request and wait for its correlated result. The pending
   * entry is stored before the frame is sent and removed on every settlement
   * path (result, abort, timeout, disconnect, replacement).
   */
  request(
    grantId: GrantId,
    operation: BrowserOperation,
    args: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const connection = this.connection
    if (connection === null) {
      throw bridgeError('bridge_disconnected', 'browser extension is not connected', true)
    }
    if (signal.aborted) throw signal.reason
    const requestId = RequestId(this.randomId())
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(requestId)
      }
      const onAbort = () => { finish(); reject(bridgeError('bridge_disconnected', 'browser call cancelled', false)) }
      const timer = setTimeout(() => { finish(); reject(bridgeError('timeout', `${operation} timed out`, true)) }, this.toolTimeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, { resolve, reject, finish })
      connection.socket.send(encodeFrame({
        v: PROTOCOL_VERSION, type: 'tool.call', requestId, grantId, operation, args,
      }))
    })
  }

  /** Revoke every grant of a connection and notify the extension. */
  revokeConnection(connectionId: string): GrantId[] {
    const affected = this.grants.revokeConnection(connectionId)
    if (this.connection !== null) {
      for (const grantId of affected) {
        this.connection.socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'grant.revoke', grantId }))
      }
    }
    return affected
  }

  /** Revoke the grants of one turn and notify the extension. */
  revokeTurn(connectionId: string, sessionId: string, turn: number): GrantId[] {
    const affected = this.grants.revokeTurn(connectionId, sessionId, turn)
    if (this.connection !== null) {
      for (const grantId of affected) {
        this.connection.socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'grant.revoke', grantId }))
      }
    }
    return affected
  }

  /** Register a handler for live-connection loss (close or replacement). */
  onConnectionLost(handler: () => void): () => void {
    this.connectionLostHandlers.add(handler)
    return () => this.connectionLostHandlers.delete(handler)
  }

  /** Close the connection and reject everything pending. */
  dispose(): void {
    if (this.connection !== null) {
      const socket = this.connection.socket
      this.connection = null
      socket.close()
    }
    this.rejectAllPending(bridgeError('bridge_disconnected', 'browser bridge disposed', true))
  }

  /** Handle one authenticated inbound frame from the live connection. */
  private receive(frame: BridgeFrame, socket: BridgeSocket): void {
    switch (frame.type) {
      case 'pong':
      case 'hello.ok':
      case 'tool.accepted':
        return
      case 'ping':
        socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'pong' }))
        return
      case 'grant.put': {
        if (this.connection?.socket !== socket) return
        try {
          const record = this.grants.offer(this.connection.id, {
            grantId: frame.grantId,
            sessionId: frame.sessionId,
            expiresAt: frame.expiresAt,
            tab: frame.tab,
          })
          socket.send(encodeFrame({
            v: PROTOCOL_VERSION, type: 'grant.accepted', grantId: record.grantId, handle: record.handle,
          }))
        } catch (error) {
          socket.send(encodeFrame({
            v: PROTOCOL_VERSION,
            type: 'error',
            code: 'internal',
            message: error instanceof Error ? error.message : 'grant offer rejected',
            retryable: false,
          }))
        }
        return
      }
      case 'grant.revoke':
        this.grants.revoke(frame.grantId)
        return
      case 'tool.result': {
        const pending = this.pending.get(frame.requestId)
        if (pending === undefined) return
        pending.finish()
        if (frame.result.ok) {
          pending.resolve(frame.result.value)
        } else {
          pending.reject(frame.result.error)
        }
        return
      }
      case 'error':
        return
      case 'hello':
        return
    }
  }

  private fail(socket: BridgeSocket, code: BridgeError['code'], message: string): void {
    socket.send(encodeFrame({ v: PROTOCOL_VERSION, type: 'error', code, message, retryable: false }))
    socket.close()
  }

  private rejectAllPending(error: BridgeError): void {
    for (const pending of this.pending.values()) {
      pending.finish()
      pending.reject(error)
    }
    this.pending.clear()
  }
}
