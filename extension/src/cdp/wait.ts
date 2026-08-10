/**
 * `browser_wait`: bounded condition polling at 100 ms. DOM stability means
 * no `DOM.documentUpdated`, lifecycle, or main-frame navigation event during
 * the quiet window — it is not a claim that network activity ended.
 */
import { bridgeError } from '@dsh-external/dsh-browser-bridge-protocol'
import type { TabSession } from './session-manager.ts'

export type WaitCondition =
  | { kind: 'selector'; selector: string; state: 'attached' | 'visible' | 'hidden' }
  | { kind: 'text'; text: string; state: 'present' | 'absent' }
  | { kind: 'url'; pattern: string }
  | { kind: 'ready'; state: 'interactive' | 'complete' }
  | { kind: 'stable'; quietMs: number }

export interface WaitResult {
  url: string
  elapsedMs: number
}

export interface WaitOptions {
  timeoutMs: number
  signal?: AbortSignal
  now?: () => number
  /** Test seam: called whenever the page reports a change event. */
  onChange?: () => void
}

const POLL_MS = 100

const SELECTOR_EVALUATE = `function (selector, wanted) {
  const el = document.querySelector(selector)
  if (el === null) return { found: false, visible: false }
  const style = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  const visible = style.display !== 'none' && style.visibility !== 'hidden'
    && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
  return { found: true, visible }
}`

const TEXT_EVALUATE = `function () {
  return { text: document.body ? document.body.innerText : '' }
}`

const URL_EVALUATE = `function () {
  return { url: location.href }
}`

const READY_EVALUATE = `function () {
  return { readyState: document.readyState }
}`

/**
 * Evaluate one function as an IIFE with inline JSON arguments. A bare
 * function expression is a SyntaxError in `Runtime.evaluate`, so the
 * expression must be an invoked call.
 */
async function evaluate(session: TabSession, fn: string, args: unknown[] = []): Promise<unknown> {
  const expression = `(${fn})(${args.map(arg => JSON.stringify(arg)).join(', ')})`
  const response = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  })
  return (response as { result?: { value?: unknown } }).result?.value
}

export async function waitForCondition(
  session: TabSession,
  condition: WaitCondition,
  options: WaitOptions,
): Promise<WaitResult> {
  const now = options.now ?? Date.now
  const started = now()
  const timeoutAt = started + options.timeoutMs

  const check = async (): Promise<boolean> => {
    switch (condition.kind) {
      case 'selector': {
        const value = await evaluate(session, SELECTOR_EVALUATE, [
          condition.selector,
        ]) as { found: boolean; visible: boolean } | undefined
        if (value === undefined) return false
        if (condition.state === 'attached') return value.found
        if (condition.state === 'visible') return value.found && value.visible
        return value.found && !value.visible
      }
      case 'text': {
        const value = await evaluate(session, TEXT_EVALUATE) as { text?: string } | undefined
        const present = (value?.text ?? '').includes(condition.text)
        return condition.state === 'present' ? present : !present
      }
      case 'url': {
        const value = await evaluate(session, URL_EVALUATE) as { url?: string } | undefined
        const url = value?.url ?? ''
        return url.includes(condition.pattern)
      }
      case 'ready': {
        const value = await evaluate(session, READY_EVALUATE) as { readyState?: string } | undefined
        return value?.readyState === condition.state
      }
      case 'stable': {
        let quietFrom = now()
        while (true) {
          const lastChange = session.lastChangeAt ?? 0
          if (lastChange > quietFrom) {
            // A change landed inside the quiet window: restart it.
            quietFrom = lastChange
            continue
          }
          if (now() >= quietFrom + condition.quietMs) return true
          await delay(POLL_MS, options.signal)
          options.onChange?.()
        }
      }
      default:
        return false
    }
  }

  while (true) {
    if (options.signal?.aborted === true) {
      throw bridgeError('bridge_disconnected', 'browser wait cancelled', false)
    }
    if (now() >= timeoutAt) {
      throw bridgeError('timeout', `${condition.kind} condition not met within the time budget`, true)
    }
    let satisfied = false
    try {
      satisfied = await check()
    } catch (error) {
      if (options.signal?.aborted) {
        throw bridgeError('bridge_disconnected', 'browser wait cancelled', false)
      }
      throw error
    }
    if (satisfied) break
    if (condition.kind === 'stable') continue
    await delay(POLL_MS, options.signal)
  }
  return { url: session.currentUrl, elapsedMs: now() - started }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
