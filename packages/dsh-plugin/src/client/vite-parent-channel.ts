/**
 * Exact-parent MessageChannel handshake for DSH Web embedded in a Vite
 * page. The Vite parent posts ONE init message with a transferred port; the
 * client accepts it only when `event.source === window.parent` and the
 * event origin is exact HTTP(S), then verifies the parent-provided targetId
 * plus origin against the local host through the Vite API before exposing
 * the current-page button. The chrome-extension channel is never reused.
 */
import type { BrowserTargetDescriptor, TargetId } from '@ycp424c/dsh-browser-bridge-protocol'
import type { ViteTargetApi } from './vite-api.ts'

export interface ViteParentChannelEnv {
  /** The parent browsing context; message `event.source` must equal it. */
  parent: object
  addMessageListener(handler: (event: MessageEvent) => void): void
  removeMessageListener(handler: (event: MessageEvent) => void): void
}

export interface ViteParentInit {
  targetId: TargetId
  /** The exact parent origin recorded from the init event. */
  origin: string
  port: MessagePort
}

export interface VerifiedViteTarget {
  targetId: TargetId
  origin: string
}

export interface ViteParentChannelOptions {
  env: ViteParentChannelEnv
  api: ViteTargetApi
}

const INIT_TYPE = 'dsh-browser-bridge-init'
const READY_TYPE = 'dsh-browser-bridge.ready'
const ERROR_TYPE = 'dsh-browser-bridge.error'

function isHttpOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

export class ViteParentChannel {
  private readonly env: ViteParentChannelEnv
  private readonly api: ViteTargetApi
  private readonly initHandlers = new Set<(init: ViteParentInit) => void>()
  private readonly verifiedHandlers = new Set<(target: VerifiedViteTarget) => void>()
  private state: 'idle' | 'pending' | 'verified' | 'rejected' = 'idle'
  private port: MessagePort | null = null
  private verifiedTarget: VerifiedViteTarget | null = null
  private disposed = false
  private readonly onMessage = (event: MessageEvent): void => {
    if (this.disposed) return
    if (event.source !== this.env.parent) return
    const data = event.data as { type?: unknown; targetId?: unknown }
    if (typeof data !== 'object' || data === null || data.type !== INIT_TYPE) return
    const targetId = data.targetId
    if (typeof targetId !== 'string' || targetId.length < 32 || targetId.length > 64) return
    const port = event.ports?.[0]
    if (port === undefined) return
    if (!isHttpOrigin(event.origin)) return
    if (this.state !== 'idle') {
      // Duplicate init: reject the new port and keep the first handshake.
      port.postMessage({ type: ERROR_TYPE, code: 'permission_denied' })
      port.close()
      return
    }
    this.state = 'pending'
    this.port = port
    this.port.onmessage = () => {}
    const init: ViteParentInit = {
      targetId: targetId as TargetId,
      origin: event.origin,
      port,
    }
    for (const handler of [...this.initHandlers]) handler(init)
    // The channel owns verification: the host must confirm the targetId
    // plus exact origin before the current-page identity is exposed.
    void this.verify(init)
  }

  constructor(options: ViteParentChannelOptions) {
    this.env = options.env
    this.api = options.api
    this.env.addMessageListener(this.onMessage)
  }

  /**
   * Subscribe to a parent init (called once per handshake). The handler
   * receives the non-secret targetId, the exact recorded origin, and the
   * transferred port.
   */
  onInit(handler: (init: ViteParentInit) => void): () => void {
    this.initHandlers.add(handler)
    return () => this.initHandlers.delete(handler)
  }

  /** Subscribe to a successful host verification of the parent identity. */
  onVerified(handler: (target: VerifiedViteTarget) => void): () => void {
    this.verifiedHandlers.add(handler)
    if (this.state === 'verified' && this.verifiedTarget !== null) {
      handler(this.verifiedTarget)
    }
    return () => this.verifiedHandlers.delete(handler)
  }

  /**
   * The verified current-page identity, or null before (or without)
   * verification. Only the host can confirm identity: the parent-provided
   * targetId must resolve to a registered target with the exact origin.
   */
  getVerified(): VerifiedViteTarget | null {
    return this.verifiedTarget
  }

  /** Run the host verification for the latest init; called by the owner. */
  async verify(init: ViteParentInit): Promise<void> {
    if (this.state !== 'pending' || this.disposed) return
    let match: BrowserTargetDescriptor | undefined
    try {
      const targets = await this.api.listTargets()
      match = targets.find(target =>
        target.targetId === init.targetId && target.origin === init.origin)
    } catch {
      match = undefined
    }
    if (this.disposed || this.state !== 'pending') return
    if (match === undefined) {
      this.state = 'rejected'
      init.port.postMessage({ type: ERROR_TYPE, code: 'permission_denied' })
      return
    }
    this.state = 'verified'
    this.verifiedTarget = { targetId: init.targetId, origin: init.origin }
    init.port.postMessage({ type: READY_TYPE, targetId: init.targetId })
    for (const handler of [...this.verifiedHandlers]) handler(this.verifiedTarget)
  }

  /** Remove the listener, close the port, and clear verification. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.env.removeMessageListener(this.onMessage)
    this.initHandlers.clear()
    this.verifiedHandlers.clear()
    if (this.port !== null) {
      this.port.close()
      this.port = null
    }
    this.verifiedTarget = null
    this.state = 'idle'
  }
}
