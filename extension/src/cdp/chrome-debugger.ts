/**
 * Injected wrapper around `chrome.debugger` so unit tests never patch global
 * Chrome APIs. All calls use promise semantics over the callback surface.
 */
export interface ChromeDebuggerApi {
  attach(target: chrome.debugger.Debuggee, requiredVersion: string): Promise<void>
  detach(target: chrome.debugger.Debuggee): Promise<void>
  sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object): Promise<unknown>
  getTargets(): Promise<chrome.debugger.TargetInfo[]>
  onEvent: chrome.debugger.DebuggerEventEvent
  onDetach: chrome.debugger.DebuggerDetachedEvent
}

export interface ChromeDebuggerOptions {
  /** Last-error reader (defaults to `chrome.runtime.lastError`). */
  lastError?: () => { message?: string } | undefined
}

export class ChromeDebugger implements ChromeDebuggerApi {
  private readonly lastError: () => { message?: string } | undefined

  constructor(
    private readonly api: typeof chrome.debugger,
    options: ChromeDebuggerOptions = {},
  ) {
    this.lastError = options.lastError ?? (() => {
      const error = chrome.runtime.lastError
      if (error === undefined) return undefined
      const message = error.message
      return message === undefined ? {} : { message }
    })
  }

  attach(target: chrome.debugger.Debuggee, requiredVersion: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.api.attach(target, requiredVersion, () => {
        const error = this.lastError()
        if (error !== undefined) reject(new Error(error.message ?? 'debugger attach failed'))
        else resolve()
      })
    })
  }

  detach(target: chrome.debugger.Debuggee): Promise<void> {
    return new Promise((resolve, reject) => {
      this.api.detach(target, () => {
        const error = this.lastError()
        if (error !== undefined) reject(new Error(error.message ?? 'debugger detach failed'))
        else resolve()
      })
    })
  }

  sendCommand(target: chrome.debugger.Debuggee, method: string, params?: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.api.sendCommand(target, method, params, (result?: unknown) => {
        const error = this.lastError()
        if (error !== undefined) reject(new Error(error.message ?? `debugger command failed: ${method}`))
        else resolve(result)
      })
    })
  }

  getTargets(): Promise<chrome.debugger.TargetInfo[]> {
    return new Promise((resolve, reject) => {
      this.api.getTargets(targets => {
        const error = this.lastError()
        if (error !== undefined) reject(new Error(error.message ?? 'debugger getTargets failed'))
        else resolve(targets)
      })
    })
  }

  get onEvent(): chrome.debugger.DebuggerEventEvent {
    return this.api.onEvent
  }

  get onDetach(): chrome.debugger.DebuggerDetachedEvent {
    return this.api.onDetach
  }
}
