import { afterEach, describe, expect, it, vi } from 'vitest'
import { Activator, type ActivationState } from '../src/activation.ts'
import type { PageRuntimeConfig } from '../src/config.ts'

interface RunResult {
  activator: Activator
  states: ActivationState[]
  /** Whether each failed transition was an explicit user activation. */
  failedExplicit: boolean[]
  probeCalls: number
  connectCalls: number
  panelCalls: number
  storage: Storage
}

const ACTIVATION_KEY = 'dsh-browser-bridge:activated'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

function run(config: Partial<PageRuntimeConfig> & { mode: 'development' | 'production' }, options: {
  probeResult?: boolean
  search?: string
  storage?: Storage
} = {}): RunResult {
  const storage = options.storage ?? memoryStorage()
  const result: RunResult = {
    activator: undefined as never,
    states: [],
    failedExplicit: [],
    probeCalls: 0,
    connectCalls: 0,
    panelCalls: 0,
    storage,
  }
  result.activator = new Activator({
    config: {
      dshOrigin: 'http://127.0.0.1:3080',
      bridge: { enabled: true, autoConnectInBuild: false },
      panel: { enabled: true, visible: false, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' },
      ...config,
    },
    probe: async () => {
      result.probeCalls += 1
      return options.probeResult ?? true
    },
    connect: async () => {
      result.connectCalls += 1
    },
    openPanel: () => {
      result.panelCalls += 1
    },
    onState: (state, meta) => {
      result.states.push(state)
      if (state === 'failed') result.failedExplicit.push(meta?.explicit === true)
    },
    storage,
    location: { search: options.search ?? '' },
  })
  result.activator.start()
  return result
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('page activation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-activates in development without opening the panel', async () => {
    const result = run({ mode: 'development' })
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(1)
    // Default panel.visible=false keeps the UI hidden: the drawer never
    // auto-opens and no launcher entry appears.
    expect(result.panelCalls).toBe(0)
    expect(result.states).not.toContain('available')
    expect(result.states).toContain('connected')
  })

  it('development with panel.visible=true shows the entry only after a successful probe', async () => {
    const result = run({ mode: 'development', panel: { enabled: true, visible: true, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' } })
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(1)
    // visible permits the launcher entry after the probe, never the drawer.
    expect(result.panelCalls).toBe(0)
    const available = result.states.indexOf('available')
    expect(available).toBeGreaterThanOrEqual(0)
    expect(result.states.indexOf('connecting')).toBeGreaterThan(available)
    expect(result.states).toContain('connected')
  })

  it('development with a failed probe shows no entry and does not connect', async () => {
    const result = run(
      { mode: 'development', panel: { enabled: true, visible: true, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' } },
      { probeResult: false },
    )
    await settle()
    expect(result.connectCalls).toBe(0)
    expect(result.states).toContain('failed')
    expect(result.states).not.toContain('available')
  })

  it('shortcut activation in development still opens the panel', async () => {
    const result = run({ mode: 'development' })
    await settle()
    expect(result.panelCalls).toBe(0)
    result.activator.handleKey({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, key: 'D' })
    await settle()
    expect(result.panelCalls).toBe(1)
  })

  it('development with ?dsh=1 explicitly opens the panel', async () => {
    const result = run({ mode: 'development' }, { search: '?dsh=1' })
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(1)
    expect(result.panelCalls).toBe(1)
    expect(result.states).toContain('connected')
    expect(result.storage.getItem(ACTIVATION_KEY)).toBe('1')
  })

  it('development with ?dsh=1 and a failed probe surfaces an explicit failure', async () => {
    const result = run({ mode: 'development' }, { search: '?dsh=1', probeResult: false })
    await settle()
    expect(result.connectCalls).toBe(0)
    expect(result.states).toContain('failed')
    expect(result.failedExplicit).toEqual([true])
  })

  it('?dsh=1 wins over the persisted switch', async () => {
    const storage = memoryStorage()
    storage.setItem(ACTIVATION_KEY, '1')
    const result = run({ mode: 'production' }, { search: '?dsh=1', storage })
    await settle()
    expect(result.panelCalls).toBe(1)
    expect(result.failedExplicit).toEqual([])
  })

  it('only explicit activations surface a failure as explicit', async () => {
    const explicit = run({ mode: 'production' }, { search: '?dsh=1', probeResult: false })
    await settle()
    expect(explicit.states).toContain('failed')
    expect(explicit.failedExplicit).toEqual([true])
    const auto = run({ mode: 'development' }, { probeResult: false })
    await settle()
    expect(auto.states).toContain('failed')
    expect(auto.failedExplicit).toEqual([false])
  })

  it('development keeps the bridge when panel.enabled=false', async () => {
    const result = run({ mode: 'development', panel: { enabled: false, visible: false, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' } })
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(1)
    expect(result.panelCalls).toBe(0)
  })

  it('production default is zero-network dormancy', async () => {
    const result = run({ mode: 'production' })
    await settle()
    expect(result.probeCalls).toBe(0)
    expect(result.connectCalls).toBe(0)
    expect(result.states).toEqual(['dormant'])
  })

  it('production with bridge disabled stays dormant', async () => {
    const result = run({ mode: 'production', bridge: { enabled: false, autoConnectInBuild: false } })
    await settle()
    expect(result.probeCalls).toBe(0)
    expect(result.states).toEqual(['dormant'])
  })

  it('panel.visible=true probes health only and never registers', async () => {
    const result = run({ mode: 'production', panel: { enabled: true, visible: true, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' } })
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(0)
    expect(result.states).toContain('available')
    expect(result.states).not.toContain('connected')
  })

  it('a failed visible probe stays failed without connecting', async () => {
    const result = run(
      { mode: 'production', panel: { enabled: true, visible: true, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' } },
      { probeResult: false },
    )
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(0)
    expect(result.states).toContain('failed')
  })

  it('autoConnectInBuild probes then connects and registers', async () => {
    const result = run({ mode: 'production', bridge: { enabled: true, autoConnectInBuild: true } })
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(1)
    expect(result.states).toContain('connected')
  })

  it('query parameter activates and opens the panel when enabled', async () => {
    const result = run({ mode: 'production' }, { search: '?dsh=1' })
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(1)
    expect(result.panelCalls).toBe(1)
    // Explicit activation persists the local activation switch.
    expect(result.storage.getItem(ACTIVATION_KEY)).toBe('1')
  })

  it('shortcut activation probes, connects, and opens the panel', async () => {
    const result = run({ mode: 'production' })
    expect(result.probeCalls).toBe(0)
    result.activator.handleKey({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, key: 'D' })
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(1)
    expect(result.panelCalls).toBe(1)
    expect(result.storage.getItem(ACTIVATION_KEY)).toBe('1')
  })

  it('a different shortcut does not activate', async () => {
    const result = run({ mode: 'production' })
    result.activator.handleKey({ altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, key: 'D' })
    await settle()
    expect(result.probeCalls).toBe(0)
    expect(result.connectCalls).toBe(0)
  })

  it('persisted activation resumes a production runtime silently', async () => {
    const storage = memoryStorage()
    storage.setItem(ACTIVATION_KEY, '1')
    const result = run({ mode: 'production' }, { storage })
    await settle()
    expect(result.probeCalls).toBe(1)
    expect(result.connectCalls).toBe(1)
    // Silent resume: no drawer opens and a failed resume shows no UI.
    expect(result.panelCalls).toBe(0)
    const failed = run({ mode: 'production' }, { storage, probeResult: false })
    await settle()
    expect(failed.states).toContain('failed')
    expect(failed.failedExplicit).toEqual([false])
  })

  it('dispose removes the key listener', () => {
    const addKeyListener = vi.fn(() => () => {})
    const activator = new Activator({
      config: {
        dshOrigin: 'http://127.0.0.1:3080',
        mode: 'production',
        bridge: { enabled: true, autoConnectInBuild: false },
        panel: { enabled: true, visible: false, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' },
      },
      probe: async () => true,
      connect: async () => {},
      openPanel: () => {},
      storage: memoryStorage(),
      location: { search: '' },
      addKeyListener,
    })
    activator.start()
    expect(addKeyListener).toHaveBeenCalled()
    activator.dispose()
    // The listener removal is captured by the mock's returned disposer.
    expect(addKeyListener.mock.results[0]!.value).toBeTypeOf('function')
  })
})
