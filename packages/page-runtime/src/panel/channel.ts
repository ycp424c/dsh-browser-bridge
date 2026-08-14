/**
 * Exact-origin iframe channel of the embedded panel. After the iframe
 * loads, ONE init message is posted to the exact dshOrigin with a
 * transferred MessagePort carrying only the non-sensitive targetId. A ready
 * reply must arrive on the port within five seconds; a timeout maps to
 * `embedding_blocked` without disconnecting the target Runtime.
 */
import type { TargetId } from '@ycp424c/dsh-browser-bridge-protocol'

export interface PanelChannelEnv {
  postToIframe(message: unknown, targetOrigin: string, ports: unknown[]): void
  onIframeLoad(handler: () => void): void
}

export interface PanelChannelOptions {
  env: PanelChannelEnv
  dshOrigin: string
  targetId: TargetId
  timeoutMs?: number
  /** Injectable for tests; defaults to the real MessageChannel. */
  messageChannelFactory?: () => { port1: MessagePort; port2: MessagePort }
}

export class PanelChannel {
  private readonly env: PanelChannelEnv
  private readonly dshOrigin: string
  private readonly targetId: TargetId
  private readonly timeoutMs: number
  private readonly messageChannelFactory: () => { port1: MessagePort; port2: MessagePort }
  private readonly readyHandlers = new Set<() => void>()
  private readonly errorHandlers = new Set<(code: string) => void>()
  private port: MessagePort | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inited = false
  private settled = false
  disposed = false

  constructor(options: PanelChannelOptions) {
    this.env = options.env
    this.dshOrigin = options.dshOrigin
    this.targetId = options.targetId
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.messageChannelFactory = options.messageChannelFactory ?? (() => new MessageChannel())
  }

  onReady(handler: () => void): void {
    this.readyHandlers.add(handler)
  }

  onError(handler: (code: string) => void): void {
    this.errorHandlers.add(handler)
  }

  /** Wait for the iframe load, then transfer one port in one init message. */
  init(): void {
    if (this.inited) return
    this.inited = true
    // The ready reply must arrive within the bound from OPEN, not from
    // load: a CSP-blocked iframe never fires load, and the panel must still
    // surface embedding_blocked with its fallback instead of hanging.
    this.timer = setTimeout(() => {
      this.settle()
      // Embedding failed, not the target connection: the runtime keeps
      // running and the panel offers its new-tab fallback.
      for (const handler of [...this.errorHandlers]) handler('embedding_blocked')
    }, this.timeoutMs)
    this.env.onIframeLoad(() => {
      if (this.settled) return
      const channel = this.messageChannelFactory()
      this.port = channel.port1
      this.port.onmessage = (event: MessageEvent) => {
        const message = event.data as { type?: string; targetId?: string }
        if (message?.type !== 'dsh-browser-bridge.ready') return
        this.settle()
        for (const handler of [...this.readyHandlers]) handler()
      }
      // One init message, exact target origin, transferred port, and ONLY
      // the non-sensitive targetId — never a wildcard postMessage.
      this.env.postToIframe(
        { type: 'dsh-browser-bridge-init', targetId: this.targetId },
        this.dshOrigin,
        [channel.port2],
      )
    })
  }

  private settle(): void {
    this.settled = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.settle()
    this.readyHandlers.clear()
    this.errorHandlers.clear()
    if (this.port !== null) {
      this.port.close()
      this.port = null
    }
  }
}
