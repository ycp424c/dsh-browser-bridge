import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForCondition } from '../src/tools/wait.ts'
import { createHmrManager } from '../src/hmr.ts'
import { ElementRegistry } from '../src/refs/registry.ts'

function makeWaitContext(options: {
  url?: string
  readyState?: DocumentReadyState
  generation?: number
  hmr?: ReturnType<typeof createHmrManager>
} = {}) {
  const doc = {
    readyState: options.readyState ?? 'complete',
    body: document.body,
    querySelector: (selector: string) => document.querySelector(selector),
    createTreeWalker: () => null,
  } as unknown as Document
  const win = {
    location: { href: options.url ?? 'http://127.0.0.1:5173/' },
  } as unknown as Window
  return {
    wait: (condition: Record<string, unknown>, signal = new AbortController().signal, timeoutMs?: number) =>
      waitForCondition({
        doc,
        win,
        args: {
          condition: condition as never,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
        signal,
        generation: () => options.generation ?? 1,
        waitForGeneration: options.hmr === undefined
          ? async () => { throw new Error('unsupported_operation: hmr unavailable') }
          : (after: number, innerSignal: AbortSignal) => options.hmr!.waitForGeneration(after, innerSignal),
      }),
  }
}

describe('wait for condition', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves immediately when the selector is attached', async () => {
    document.body.innerHTML = '<button id="save">Save</button>'
    const { wait } = makeWaitContext()
    await expect(wait({ kind: 'selector', selector: '#save', state: 'attached' })).resolves.toMatchObject({ ok: true })
  })

  it('polls until the selector appears', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    const { wait } = makeWaitContext()
    const pending = wait({ kind: 'selector', selector: '#late', state: 'attached' })
    const button = document.createElement('button')
    button.id = 'late'
    setTimeout(() => document.body.appendChild(button), 250)
    vi.advanceTimersByTime(100)
    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('resolves when the text becomes present', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<p>Loading...</p>'
    const { wait } = makeWaitContext()
    const pending = wait({ kind: 'text', text: 'Loaded', state: 'present' })
    setTimeout(() => {
      document.body.innerHTML = '<p>Loaded</p>'
    }, 150)
    await vi.advanceTimersByTimeAsync(200)
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('resolves when the URL matches the pattern', async () => {
    document.body.innerHTML = ''
    const { wait } = makeWaitContext({ url: 'http://127.0.0.1:5173/orders/42' })
    await expect(wait({ kind: 'url', pattern: '/orders/\\d+' })).resolves.toMatchObject({ ok: true })
  })

  it('resolves when the document is ready', async () => {
    document.body.innerHTML = ''
    const { wait } = makeWaitContext({ readyState: 'complete' })
    await expect(wait({ kind: 'ready', state: 'complete' })).resolves.toMatchObject({ ok: true })
  })

  it('waits for a DOM quiet window after mutations', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="box">x</div>'
    const { wait } = makeWaitContext()
    const pending = wait({ kind: 'stable', quietMs: 200 })
    const box = document.getElementById('box')!
    // A mutation before the quiet window restarts the window.
    setTimeout(() => { box.textContent = 'y' }, 50)
    await vi.advanceTimersByTimeAsync(100)
    expect(document.getElementById('box')!.textContent).toBe('y')
    await vi.advanceTimersByTimeAsync(250)
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('waits for the next generation after HMR', async () => {
    const refs = new ElementRegistry()
    let generation = 1
    const hmr = createHmrManager({
      refs,
      available: true,
      generation: () => generation,
      setGeneration: (value: number) => { generation = value },
      sendTargetUpdate: () => {},
      doc: document,
      win: window,
      notifyHmrUpdate: () => {},
    })
    const { wait } = makeWaitContext({ hmr })
    const pending = wait({ kind: 'generation', after: 1 })
    hmr.notifyHmrUpdate()
    await expect(pending).resolves.toMatchObject({ ok: true, generation: 2 })
  })

  it('rejects generation waits when HMR is unavailable', async () => {
    document.body.innerHTML = ''
    const { wait } = makeWaitContext()
    await expect(wait({ kind: 'generation', after: 1 })).rejects.toThrowError(/unsupported_operation/)
  })

  it('times out on a hard timeout', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    const { wait } = makeWaitContext()
    // Attach the rejection handler synchronously: the hard timer rejects
    // during the timer advance, before any later await.
    const pending = wait({ kind: 'selector', selector: '#never', state: 'attached' }, new AbortController().signal, 500)
    const outcome = pending.then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error }),
    )
    await vi.advanceTimersByTimeAsync(600)
    const settled = await outcome
    expect(settled).toMatchObject({ ok: false, error: { code: 'timeout' } })
  })

  it('aborts on the signal', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    const { wait } = makeWaitContext()
    const controller = new AbortController()
    const pending = wait({ kind: 'selector', selector: '#never', state: 'attached' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeTruthy()
  })
})
