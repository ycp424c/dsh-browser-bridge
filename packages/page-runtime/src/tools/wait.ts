/**
 * Bounded waits: selector/text/url/ready conditions via polling, a DOM
 * quiet window via MutationObserver, and the Vite generation condition via
 * the HMR manager. Every wait runs under an AbortSignal and a hard timeout,
 * and every observer/listener disconnects in `finally`.
 */
import { bridgeError } from '@dsh-external/dsh-browser-bridge-protocol'
import { bridgeFailure } from './dispatcher.ts'

export interface WaitArgs {
  condition: {
    kind: 'selector' | 'text' | 'url' | 'ready' | 'stable' | 'generation'
    selector?: string
    state?: 'attached' | 'visible' | 'hidden' | 'present' | 'absent' | 'interactive' | 'complete'
    text?: string
    pattern?: string
    quietMs?: number
    after?: number
  }
  timeoutMs?: number
}

export interface WaitContext {
  args: WaitArgs
  signal: AbortSignal
  doc?: Document
  win?: Window
  generation?: () => number
  waitForGeneration?: (after: number, signal: AbortSignal) => Promise<number>
}

const DEFAULT_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 100

function checkCondition(ctx: WaitContext): boolean {
  const doc = ctx.doc ?? document
  const win = ctx.win ?? window
  const condition = ctx.args.condition
  switch (condition.kind) {
    case 'selector': {
      const element = doc.querySelector(condition.selector ?? '')
      if (condition.state === 'attached') return element !== null
      if (element === null) return condition.state === 'hidden'
      if (element instanceof HTMLElement) {
        const style = win.getComputedStyle(element)
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden
        return condition.state === 'visible' ? visible : !visible
      }
      return condition.state === 'visible'
    }
    case 'text': {
      const text = doc.body.textContent ?? ''
      const present = text.includes(condition.text ?? '')
      return condition.state === 'present' ? present : !present
    }
    case 'url': {
      try {
        return new RegExp(condition.pattern ?? '').test(win.location.href)
      } catch {
        return win.location.href.includes(condition.pattern ?? '')
      }
    }
    case 'ready':
      return doc.readyState === condition.state
    case 'stable':
      // Handled by the MutationObserver path; the poll never satisfies it.
      return false
    case 'generation':
      return (ctx.generation?.() ?? 0) > (condition.after ?? 0)
    default:
      return false
  }
}

async function poll(ctx: WaitContext): Promise<void> {
  while (!ctx.signal.aborted) {
    if (checkCondition(ctx)) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS)
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }
  throw ctx.signal.reason
}

function waitForDomQuiet(ctx: WaitContext): Promise<void> {
  const doc = ctx.doc ?? document
  const quietMs = ctx.args.condition.quietMs ?? 200
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    const finish = (error?: unknown): void => {
      if (done) return
      done = true
      observer.disconnect()
      ctx.signal.removeEventListener('abort', onAbort)
      if (timer !== null) clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve()
    }
    const restart = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => finish(), quietMs)
    }
    const onAbort = (): void => finish(ctx.signal.reason)
    const observer = new MutationObserver(restart)
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true })
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    restart()
  })
}

export async function waitForCondition(ctx: WaitContext): Promise<Record<string, unknown>> {
  const timeoutMs = ctx.args.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let hardTimer: ReturnType<typeof setTimeout> | null = null
  // The inner signal stops the poll/observer as soon as the race settles,
  // so a losing side never keeps polling or rejects unhandled.
  const inner = new AbortController()
  try {
    const outcome: unknown = await Promise.race([
      (async () => {
        if (ctx.args.condition.kind === 'stable') {
          await waitForDomQuiet(ctx)
          return { ok: true }
        }
        if (ctx.args.condition.kind === 'generation') {
          const generation = await ctx.waitForGeneration?.(ctx.args.condition.after ?? 0, ctx.signal)
          if (generation === undefined) {
            bridgeFailure('unsupported_operation', 'hmr is unavailable on this page')
          }
          return { ok: true, generation }
        }
        await poll({ ...ctx, signal: AbortSignal.any([ctx.signal, inner.signal]) })
        return { ok: true }
      })(),
      new Promise<never>((_resolve, reject) => {
        hardTimer = setTimeout(() => {
          reject(bridgeError('timeout', 'wait exceeded its time budget', true))
        }, timeoutMs)
      }),
    ])
    return outcome as Record<string, unknown>
  } finally {
    inner.abort()
    if (hardTimer !== null) clearTimeout(hardTimer)
  }
}
