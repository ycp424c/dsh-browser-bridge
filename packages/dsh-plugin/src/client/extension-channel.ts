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
  readonly extensionOrigin: string

  constructor(env: ExtensionChannelEnv, options: ExtensionChannelOptions = {}) {
    this.env = env
    // URL.origin is opaque for non-special schemes, so the extension origin
    // is parsed directly from the referrer.
    const match = /^(chrome-extension:\/\/[a-p]{32})(?:\/|$)/.exec(env.referrer)
    if (match === null) {
      throw new Error('extension channel: parent must be a chrome-extension page')
    }
    this.extensionOrigin = match[1]!
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.randomId = options.randomId ?? newRequestId
    env.addMessageListener(event => this.onMessage(event))
  }

  /** Send one request and wait for its correlated reply. */
  request<T>(type: string, payload: object, signal?: AbortSignal): Promise<T> {
    const requestId = this.randomId()
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(requestId)
      }
      const onAbort = () => {
        finish()
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
    this.env.postToParent(message, this.extensionOrigin)
  }

  /** Subscribe to unsolicited parent messages (pairing-required, ...). */
  onParentMessage(handler: (message: unknown) => void): () => void {
    this.parentHandlers.add(handler)
    return () => this.parentHandlers.delete(handler)
  }

  private onMessage(event: MessageEvent): void {
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
}

/** Build the channel for the real DSH Web iframe environment. */
export function channelFromWindow(window: Window): ExtensionChannel {
  return new ExtensionChannel({
    referrer: window.document.referrer,
    parent: window.parent,
    addMessageListener: handler => window.addEventListener('message', handler),
    removeMessageListener: handler => window.removeEventListener('message', handler),
    postToParent: (message, target) => window.parent.postMessage(message, target),
  })
}
