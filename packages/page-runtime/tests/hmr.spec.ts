import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmrManager } from '../src/hmr.ts'
import { ElementRegistry } from '../src/refs/registry.ts'

function makeManager(options: { available?: boolean } = {}) {
  let generation = 1
  const refs = new ElementRegistry()
  const button = document.createElement('button')
  document.body.appendChild(button)
  const ref = refs.capture(button, generation)
  const updates: Array<{ generation: number }> = []
  const manager = createHmrManager({
    refs,
    available: options.available ?? true,
    generation: () => generation,
    setGeneration: (value: number) => {
      generation = value
    },
    sendTargetUpdate: (current: number) => {
      updates.push({ generation: current })
    },
    doc: document,
    win: window,
    notifyHmrUpdate: () => {},
    quietMs: 100,
    timeoutMs: 1_000,
  })
  return { manager, refs, ref, updates, generation: () => generation }
}

describe('hmr generation manager', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('increments the generation, clears refs, and wakes generation waiters', async () => {
    vi.useFakeTimers()
    const { manager, refs, ref, updates, generation } = makeManager()
    const pending = manager.waitForGeneration(1, new AbortController().signal)
    manager.notifyHmrUpdate()
    expect(generation()).toBe(2)
    expect(() => refs.resolve(ref, 1)).toThrowError(/stale_element/)
    // The bounded DOM quiet window elapses, then target.update is sent.
    await vi.advanceTimersByTimeAsync(150)
    expect(updates).toEqual([{ generation: 2 }])
    await expect(pending).resolves.toBe(2)
  })

  it('sends no target.update before the quiet window elapses', async () => {
    vi.useFakeTimers()
    const { manager, updates } = makeManager()
    manager.notifyHmrUpdate()
    await vi.advanceTimersByTimeAsync(50)
    expect(updates).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(updates).toHaveLength(1)
  })

  it('generation waits fail when HMR is unavailable (production)', async () => {
    const { manager } = makeManager({ available: false })
    await expect(manager.waitForGeneration(1, new AbortController().signal))
      .rejects.toThrowError(/unsupported_operation/)
  })

  it('dispose aborts pending waits and pending quiet windows', async () => {
    vi.useFakeTimers()
    const { manager, updates } = makeManager()
    manager.notifyHmrUpdate()
    manager.dispose()
    await vi.advanceTimersByTimeAsync(500)
    expect(updates).toHaveLength(0)
  })
})
