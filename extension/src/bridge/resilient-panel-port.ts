/**
 * MV3 runtime port treated as a disconnectable transport for the side panel.
 *
 * Chrome service workers can be torn down at any moment, taking the runtime
 * port channel with them. This class keeps one logical channel alive across
 * those teardowns:
 *
 * - `open()` creates the port; inbound messages are forwarded to `onMessage`.
 * - A disconnection — the `onDisconnect` event OR a throwing `postMessage` —
 *   drops the current port and schedules a reconnect with bounded backoff.
 * - `send()` never throws: while no port is live the message is buffered
 *   (bounded, oldest dropped) and flushed in order once a fresh port opens,
 *   so critical iframe requests (`bridge.connect`, `grant.create`) survive a
 *   channel drop.
 * - `dispose()` is terminal: it removes every listener, cancels pending
 *   reconnects, and best-effort-disconnects only a still-connected port.
 *   Every handler identity-checks its port, so late events from a dropped or
 *   disposed instance are ignored.
 */
const DEFAULT_RECONNECT_BASE_MS = 250
const DEFAULT_RECONNECT_MAX_MS = 5_000
const DEFAULT_MAX_BUFFER = 100

export interface ResilientPanelPortOptions {
  /** Factory for a fresh runtime port (normally `chrome.runtime.connect`). */
  connect: () => chrome.runtime.Port
  /** Inbound messages from the background (`bridge.status`, `panel.reply`, …). */
  onMessage?: (message: unknown) => void
  /** Fired each time a reconnect attempt is scheduled after a disconnection. */
  onReconnecting?: () => void
  /** Backoff base for the first reconnect (default 250 ms). */
  reconnectBaseMs?: number
  /** Backoff ceiling (default 5 s). */
  reconnectMaxMs?: number
  /** Maximum buffered outbound messages while disconnected (default 100). */
  maxBuffer?: number
}

export class ResilientPanelPort {
  private readonly connectFactory: () => chrome.runtime.Port
  private readonly onMessage: ((message: unknown) => void) | undefined
  private readonly onReconnecting: (() => void) | undefined
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly maxBuffer: number

  private port: chrome.runtime.Port | null = null
  private messageListener: ((message: unknown) => void) | null = null
  private disconnectListener: (() => void) | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private readonly queue: unknown[] = []
  private disposed = false

  constructor(options: ResilientPanelPortOptions) {
    this.connectFactory = options.connect
    this.onMessage = options.onMessage
    this.onReconnecting = options.onReconnecting
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  }

  /** Open the port. Idempotent; a no-op after `dispose()`. */
  open(): void {
    if (this.disposed || this.port !== null) return
    this.reconnectAttempt = 0
    this.connectNow()
  }

  /**
   * Send one message to the background. Never throws: while the port is
   * disconnected the message is buffered (bounded, oldest dropped) and
   * flushed in order once a fresh port opens.
   */
  send(message: unknown): void {
    if (this.disposed) return
    const port = this.port
    if (port === null) {
      this.enqueue(message)
      return
    }
    try {
      port.postMessage(message)
    } catch {
      // The port died underneath us (Chrome throws for disconnected ports).
      // Drop the dead instance, reconnect, and buffer the message so it is
      // retried in order on the fresh port.
      this.dropPort(port)
      this.scheduleReconnect()
      this.enqueue(message)
    }
  }

  /**
   * Terminate the transport: no reconnect, no further sends, and only a
   * best-effort disconnect of a still-connected current port. A port that is
   * already disconnected is never touched again (Chrome throws).
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearReconnectTimer()
    this.queue.length = 0
    const port = this.port
    this.port = null
    if (port === null) return
    // Detach our listeners first so the disconnect below (and any late event
    // on this port) cannot reach the handlers.
    if (this.messageListener !== null) port.onMessage.removeListener(this.messageListener)
    if (this.disconnectListener !== null) port.onDisconnect.removeListener(this.disconnectListener)
    this.messageListener = null
    this.disconnectListener = null
    try {
      port.disconnect()
    } catch {
      // Already disconnected — nothing to clean up.
    }
  }

  private connectNow(): void {
    this.clearReconnectTimer()
    if (this.disposed) return
    let port: chrome.runtime.Port
    try {
      port = this.connectFactory()
    } catch {
      // The factory itself failed (e.g. extension context invalidated);
      // retry through the same bounded backoff.
      this.scheduleReconnect()
      return
    }
    if (this.disposed) {
      // Disposed between attempts; never operate on the fresh port beyond a
      // best-effort close.
      try {
        port.disconnect()
      } catch {
        // Already disconnected — nothing to clean up.
      }
      return
    }
    this.port = port
    const onMessage = (message: unknown): void => this.handleMessage(port, message)
    const onDisconnect = (): void => this.handleDisconnect(port)
    this.messageListener = onMessage
    this.disconnectListener = onDisconnect
    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(onDisconnect)
    this.flush()
  }

  private handleMessage(port: chrome.runtime.Port, message: unknown): void {
    if (this.disposed || this.port !== port) return
    this.onMessage?.(message)
  }

  private handleDisconnect(port: chrome.runtime.Port): void {
    if (this.disposed || this.port !== port) return
    this.dropPort(port)
    this.scheduleReconnect()
  }

  /** Forget the current port without touching it; identity-guarded. */
  private dropPort(port: chrome.runtime.Port): void {
    if (this.port !== port) return
    this.port = null
    this.messageListener = null
    this.disconnectListener = null
  }

  /** Exponential backoff (base 250 ms, cap 5 s) with 0.5–1.0 jitter. */
  private scheduleReconnect(): void {
    if (this.disposed) return
    if (this.reconnectTimer !== null) return
    this.onReconnecting?.()
    const attempt = this.reconnectAttempt
    this.reconnectAttempt += 1
    const exponential = Math.min(this.reconnectBaseMs * 2 ** attempt, this.reconnectMaxMs)
    const jitter = 0.5 + Math.random() * 0.5
    const delay = Math.round(exponential * jitter)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectNow()
    }, delay)
  }

  /** Flush buffered messages in order onto the current port. */
  private flush(): void {
    if (this.disposed) return
    const port = this.port
    if (port === null) return
    while (this.queue.length > 0) {
      const message = this.queue[0]!
      try {
        port.postMessage(message)
      } catch {
        // The fresh port died mid-flush; keep the remaining queue and let
        // the disconnect path schedule the next attempt.
        this.dropPort(port)
        this.scheduleReconnect()
        return
      }
      this.queue.shift()
    }
  }

  private enqueue(message: unknown): void {
    if (this.queue.length >= this.maxBuffer) this.queue.shift()
    this.queue.push(message)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
