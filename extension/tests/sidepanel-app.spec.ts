// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({
  loadOrigin: vi.fn<() => Promise<string>>(),
}))

vi.mock('../src/settings.ts', () => ({
  chromeSettingsStorage: () => ({}),
  loadDshOrigin: () => settings.loadOrigin(),
  normalizeDshOrigin: (value: string) => value,
  saveDshOrigin: async (_storage: unknown, value: string) => value,
}))

import App from '../entrypoints/sidepanel/App.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Listener<T> = (value: T) => void

class FakeEvent<T> {
  private readonly listeners = new Set<Listener<T>>()

  addListener = (listener: Listener<T>): void => { this.listeners.add(listener) }
  removeListener = (listener: Listener<T>): void => { this.listeners.delete(listener) }
  emit(value: T): void { for (const listener of this.listeners) listener(value) }
}

class FakePort {
  readonly onMessage = new FakeEvent<unknown>()
  readonly onDisconnect = new FakeEvent<chrome.runtime.Port>()
  disconnected = false

  postMessage(): void {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object')
  }

  disconnect(): void {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object')
    this.disconnected = true
    this.onDisconnect.emit(this as unknown as chrome.runtime.Port)
  }

  fail(): void {
    this.disconnected = true
    this.onDisconnect.emit(this as unknown as chrome.runtime.Port)
  }
}

describe('side panel runtime port', () => {
  let root: Root | undefined
  let container: HTMLDivElement
  let ports: FakePort[]

  beforeEach(() => {
    vi.useFakeTimers()
    settings.loadOrigin.mockResolvedValue('http://127.0.0.1:3080')
    ports = []
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          connect: vi.fn(() => {
            const port = new FakePort()
            ports.push(port)
            return port
          }),
        },
        storage: { local: {} },
      },
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root !== undefined) {
      await act(async () => { root?.unmount() })
    }
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reconnects after the MV3 runtime port disconnects', async () => {
    await act(async () => { root?.render(createElement(App)) })
    expect(ports).toHaveLength(1)

    ports[0]!.fail()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(ports).toHaveLength(2)
  })

  it('does not disconnect an already disconnected port during cleanup', async () => {
    await act(async () => { root?.render(createElement(App)) })
    const port = ports.at(-1)!
    port.fail()

    let cleanupError: unknown
    try {
      await act(async () => { root?.unmount() })
    } catch (error) {
      cleanupError = error
    } finally {
      root = undefined
    }

    expect(cleanupError).toBeUndefined()
  })

  it('forwards pairing-required notifications to the embedded DSH client', async () => {
    await act(async () => { root?.render(createElement(App)) })
    const iframe = container.querySelector('iframe')
    expect(iframe?.contentWindow).not.toBeNull()
    const postMessage = vi.spyOn(iframe!.contentWindow!, 'postMessage')
    const notification = { type: 'bridge.pairing-required', delayMs: 375 }

    act(() => { ports[0]!.onMessage.emit(notification) })

    expect(postMessage).toHaveBeenCalledWith(notification, 'http://127.0.0.1:3080')
  })
})
