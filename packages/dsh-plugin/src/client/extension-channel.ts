/**
 * Exact-origin parent-frame RPC for the DSH Web iframe. The parent must be a
 * `chrome-extension://<id>` page; requests are correlated by random id with a
 * bounded timeout and abort support, and only replies from the exact parent
 * source and origin are accepted.
 */
import {
  bridgeError,
  newRequestId,
  type BridgeErrorCode,
} from '@dsh-external/dsh-browser-bridge-protocol'

export interface ExtensionChannelEnv {
  /** `document.referrer` of the embedding page. */
  referrer: string
  /**
   * Optional parent-origin candidates from `location.ancestorOrigins`
   * (Chromium-only), checked before `referrer`. Used when the embedding page
   * suppresses the referrer, e.g. in a sandboxed iframe.
   */
  ancestorOrigin?: string | string[]
  /** The parent browsing context; message `event.source` must equal it. */
  parent: object
  addMessageListener(handler: (event: MessageEvent) => void): void
  removeMessageListener(handler: (event: MessageEvent) => void): void
  postToParent(message: unknown, targetOrigin: string): void
}

export interface ExtensionChannelOptions {
  timeoutMs?: number
  randomId?: () => string
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: unknown): void
  finish(): void
}

export class ExtensionChannel {
  private readonly env: ExtensionChannelEnv
  private readonly timeoutMs: number
  private readonly randomId: () => string
  private readonly pending = new Map<string, PendingRequest>()
  private readonly parentHandlers = new Set<(message: unknown) => void>()
  private disposed = false
  readonly extensionOrigin: string
  /** Bound once so the constructor's listener can be removed on dispose. */
  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.env.parent) return
    if (event.origin !== this.extensionOrigin) return
    const data = event.data as {
      type?: string
      requestId?: string
      ok?: boolean
      value?: unknown
      error?: { code?: string; message?: string }
    }
    if (data?.type === 'panel.reply' && typeof data.requestId === 'string') {
      const pending = this.pending.get(data.requestId)
      if (pending === undefined) return
      pending.finish()
      if (data.ok === true) {
        pending.resolve(data.value)
      } else {
        pending.reject(bridgeError(
          (data.error?.code as BridgeErrorCode | undefined) ?? 'internal',
          data.error?.message ?? 'extension rejected the request',
          false,
        ))
      }
      return
    }
    for (const handler of this.parentHandlers) handler(event.data)
  }

  constructor(env: ExtensionChannelEnv, options: ExtensionChannelOptions = {}) {
    this.env = env
    // URL.origin is opaque for non-special schemes, so the extension origin
    // is parsed directly from the first candidate that matches the strict
    // extension-origin format: `ancestorOrigin` before `referrer`.
    const candidates = [env.ancestorOrigin, env.referrer].flatMap(candidate =>
      candidate === undefined ? [] : typeof candidate === 'string' ? [candidate] : candidate,
    )
    const match = candidates
      .map(candidate => /^(chrome-extension:\/\/[a-p]{32})(?:\/|$)/.exec(candidate))
      .find(candidate => candidate !== null)
    if (match === undefined) {
      throw new Error('extension channel: parent must be a chrome-extension page')
    }
    this.extensionOrigin = match[1]!
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.randomId = options.randomId ?? newRequestId
    env.addMessageListener(this.onMessage)
  }

  /**
   * Remove the window listener and reject every pending request. Plugin
   * unload/reload must call this, or the old channel keeps receiving parent
   * messages and leaks its correlation state.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.env.removeMessageListener(this.onMessage)
    for (const pending of [...this.pending.values()]) {
      pending.finish()
      pending.reject(bridgeError('bridge_disconnected', 'extension channel disposed', false))
    }
  }

  /** Send one request and wait for its correlated reply. */
  request<T>(type: string, payload: object, signal?: AbortSignal): Promise<T> {
    if (this.disposed) {
      return Promise.reject(bridgeError('bridge_disconnected', 'extension channel disposed', false))
    }
    const requestId = this.randomId()
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(requestId)
      }
      const onAbort = () => {
        finish()
        // A grant.create abort must revoke the offer the background may
        // already have sent: notify it with a minimal cancel message so the
        // grant, its CDP binding, and the host offer die immediately instead
        // of lingering until the TTL.
        if (type === 'grant.create') {
          this.env.postToParent({ type: 'grant.cancel', requestId }, this.extensionOrigin)
        }
        reject(bridgeError('bridge_disconnected', 'request cancelled', false))
      }
      const timer = setTimeout(() => {
        finish()
        reject(bridgeError('timeout', `${type} timed out`, true))
      }, this.timeoutMs)
      if (signal !== undefined) {
        if (signal.aborted) {
          finish()
          reject(bridgeError('bridge_disconnected', 'request cancelled', false))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
        finish,
      })
      this.env.postToParent({ type, requestId, ...payload }, this.extensionOrigin)
    })
  }

  /** Fire-and-forget message to the parent (no reply expected). */
  post(message: unknown): void {
    if (this.disposed) return
    this.env.postToParent(message, this.extensionOrigin)
  }

  /** Subscribe to unsolicited parent messages (pairing-required, ...). */
  onParentMessage(handler: (message: unknown) => void): () => void {
    this.parentHandlers.add(handler)
    return () => this.parentHandlers.delete(handler)
  }
}

/** Build the channel for the real DSH Web iframe environment. */
export function channelFromWindow(window: Window): ExtensionChannel {
  // Chromium-only; absent (and thus undefined) in other engines and jsdom.
  const ancestorOrigins = window.location.ancestorOrigins as DOMStringList | undefined
  const ancestorOrigin = ancestorOrigins?.item(0) ?? ancestorOrigins?.[0]
  return new ExtensionChannel({
    referrer: window.document.referrer,
    ancestorOrigin: ancestorOrigin ?? undefined,
    parent: window.parent,
    addMessageListener: handler => window.addEventListener('message', handler),
    removeMessageListener: handler => window.removeEventListener('message', handler),
    postToParent: (message, target) => window.parent.postMessage(message, target),
  })
}
