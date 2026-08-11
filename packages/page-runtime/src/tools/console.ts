/**
 * Bounded console capture: wraps the console methods while preserving the
 * original `this` binding and return values, records window error and
 * unhandledrejection after injection, tags every row with the current
 * generation, caps the buffer, masks sensitive patterns, and restores every
 * original on dispose. Captured evidence is never persisted.
 */
import { boundField, maskText } from './sanitize.ts'

export interface ConsoleRow {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  generation: number
}

export interface ConsoleCaptureOptions {
  generation: () => number
  maxRows?: number
}

const ROW_CAP = 200

function primitiveSafe(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value)
  }
  if (value instanceof Error) return value.message
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? String(value) : serialized
  } catch {
    return String(value)
  }
}

export class ConsoleCapture {
  private readonly generation: () => number
  private readonly maxRows: number
  private readonly buffer: ConsoleRow[] = []
  private readonly originals = new Map<string, unknown>()
  private readonly listeners: Array<{ target: Window; type: string; handler: EventListener }> = []
  private started = false
  private disposed = false

  constructor(options: ConsoleCaptureOptions) {
    this.generation = options.generation
    this.maxRows = options.maxRows ?? ROW_CAP
  }

  start(): void {
    if (this.started) return
    this.started = true
    const consoleObject = console
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = consoleObject[level]
      if (typeof original !== 'function') continue
      this.originals.set(level, original)
      const wrapped = (...args: unknown[]): unknown => {
        // Preserve the original this binding and return value.
        const result = original.apply(consoleObject, args)
        const text = args.map(primitiveSafe).join(' ')
        this.push(level, text)
        return result
      }
      consoleObject[level] = wrapped as typeof consoleObject[typeof level]
    }
    const onError = (event: Event): void => {
      const errorEvent = event as ErrorEvent
      this.push('error', errorEvent.message || String(errorEvent.error ?? ''))
    }
    const onRejection = (event: Event): void => {
      const reason = (event as PromiseRejectionEvent).reason
      this.push('error', reason instanceof Error ? reason.message : primitiveSafe(reason))
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    this.listeners.push({ target: window, type: 'error', handler: onError })
    this.listeners.push({ target: window, type: 'unhandledrejection', handler: onRejection })
  }

  private push(level: ConsoleRow['level'], text: string): void {
    const masked = boundField(maskText(text))
    this.buffer.push({ level, text: masked, generation: this.generation() })
    if (this.buffer.length > this.maxRows) this.buffer.splice(0, this.buffer.length - this.maxRows)
  }

  rows(): ConsoleRow[] {
    return [...this.buffer]
  }

  /** Clear the buffer (target revoke, termination, dispose). */
  clear(): void {
    this.buffer.length = 0
  }

  /** Restore every original method and remove every listener. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [level, original] of this.originals) {
      ;(console as unknown as Record<string, unknown>)[level] = original
    }
    this.originals.clear()
    for (const { target, type, handler } of this.listeners) {
      target.removeEventListener(type, handler)
    }
    this.listeners.length = 0
    this.clear()
  }
}
