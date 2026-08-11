/**
 * HMR generation management: one update bumps the generation, clears every
 * element reference, waits for a bounded DOM quiet window, sends the
 * target.update, and wakes every generation waiter. Generation waits fail
 * with unsupported_operation when HMR is unavailable (production).
 */
import { bridgeError } from '@dsh-external/dsh-browser-bridge-protocol'
import { bridgeFailure } from './tools/dispatcher.ts'
import type { ElementRegistry } from './refs/registry.ts'

/** Bounded budget of one generation wait (default 30s). */
export const GENERATION_WAIT_TIMEOUT_MS = 30_000

export interface HmrManagerOptions {
  refs: ElementRegistry
  /** Whether the runtime has an HMR listener (development only). */
  available: boolean
  generation: () => number
  setGeneration(generation: number): void
  sendTargetUpdate(generation: number): void
  doc?: Document
  win?: Window
  /** Bounded DOM quiet window after an update (default 200ms). */
  quietMs?: number
  timeoutMs?: number
  /** Bounded generation-wait budget (default 30s). */
  generationWaitTimeoutMs?: number
  notifyHmrUpdate: () => void
}

interface GenerationWaiter {
  after: number
  signal: AbortSignal
  resolve(generation: number): void
  reject(error: unknown): void
  finish(): void
}

export interface HmrManager {
  /** One HMR update: bump, clear refs, quiet wait, report, wake waiters. */
  notifyHmrUpdate(): void
  /** Resolve when the generation exceeds `after` (or fail when HMR is off). */
  waitForGeneration(after: number, signal: AbortSignal): Promise<number>
  dispose(): void
}

export function createHmrManager(options: HmrManagerOptions): HmrManager {
  const doc = options.doc ?? document
  const win = options.win ?? window
  const quietMs = options.quietMs ?? 200
  const timeoutMs = options.timeoutMs ?? 5_000
  const waiters = new Set<GenerationWaiter>()
  const generationWaitTimeoutMs = options.generationWaitTimeoutMs ?? GENERATION_WAIT_TIMEOUT_MS
  let disposed = false

  const wakeWaiters = (generation: number): void => {
    for (const waiter of [...waiters]) {
      if (generation > waiter.after) {
        waiter.finish()
        waiter.resolve(generation)
      }
    }
  }

  const waitForDomQuiet = (): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let hardTimer: ReturnType<typeof setTimeout> | null = null
      let done = false
      const finish = (error?: unknown): void => {
        if (done) return
        done = true
        observer.disconnect()
        if (timer !== null) clearTimeout(timer)
        if (hardTimer !== null) clearTimeout(hardTimer)
        if (error !== undefined) reject(error)
        else resolve()
      }
      const restart = (): void => {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => finish(), quietMs)
      }
      hardTimer = setTimeout(() => finish(bridgeFailure('timeout', 'dom quiet window timed out')), timeoutMs)
      const observer = new MutationObserver(restart)
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true })
      restart()
    })
  }

  const notifyHmrUpdate = (): void => {
    if (disposed) return
    const next = options.generation() + 1
    options.setGeneration(next)
    options.refs.clear()
    // Fire-and-forget: the bounded quiet window then the target update.
    void waitForDomQuiet().then(() => {
      if (disposed) return
      options.sendTargetUpdate(next)
    }).catch(() => {
      // The quiet window failing must not break the generation bump.
    })
    wakeWaiters(next)
  }

  const waitForGeneration = (after: number, signal: AbortSignal): Promise<number> => {
    if (!options.available) {
      return Promise.reject(
        Object.assign(new Error('unsupported_operation: hmr is unavailable on this page'), { code: 'unsupported_operation' }),
      )
    }
    if (options.generation() > after) return Promise.resolve(options.generation())
    return new Promise<number>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const waiter: GenerationWaiter = {
        after,
        signal,
        resolve,
        reject,
        finish: () => {
          if (timer !== null) clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          waiters.delete(waiter)
        },
      }
      const onAbort = (): void => {
        waiter.finish()
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      waiters.add(waiter)
      // Bounded: a generation wait can never outlive its budget.
      timer = setTimeout(() => {
        waiter.finish()
        reject(bridgeError('timeout', 'generation wait timed out', true))
      }, generationWaitTimeoutMs)
    })
  }

  return {
    notifyHmrUpdate,
    waitForGeneration,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const waiter of [...waiters]) {
        waiter.finish()
        waiter.reject(
          Object.assign(new Error('internal: hmr manager disposed'), { code: 'internal' }),
        )
      }
    },
  }
}
