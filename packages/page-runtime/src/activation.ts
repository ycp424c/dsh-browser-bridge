/**
 * Activation state machine: dormant, probing, available, connecting,
 * connected, failed. In production the default is zero-network dormancy;
 * only an explicit user activation (shortcut, query parameter, or the
 * persisted local switch) or an explicit deployment choice
 * (autoConnectInBuild / panel.visible) produces any loopback request.
 */
import type { PageRuntimeConfig } from './config.ts'

export type ActivationState = 'dormant' | 'probing' | 'available' | 'connecting' | 'connected' | 'failed'

/** The only localStorage key the runtime may write (user activation). */
export const ACTIVATION_STORAGE_KEY = 'dsh-browser-bridge:activated'

export interface KeyEventLike {
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  key: string
}

export interface ActivatorOptions {
  config: PageRuntimeConfig
  probe(): Promise<boolean>
  connect(): Promise<void>
  openPanel(): void
  onState?(state: ActivationState): void
  storage?: Storage
  location?: { search: string }
  addKeyListener?(handler: (event: KeyEventLike) => void): () => void
}

interface ShortcutSpec {
  key: string
  alt: boolean
  shift: boolean
  ctrl: boolean
  meta: boolean
}

function parseShortcut(shortcut: string): ShortcutSpec {
  const parts = shortcut.split('+').map(part => part.trim().toLowerCase()).filter(part => part !== '')
  const key = parts.pop() ?? ''
  return {
    key,
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    meta: parts.includes('meta') || parts.includes('cmd'),
  }
}

function matchesShortcut(event: KeyEventLike, shortcut: ShortcutSpec): boolean {
  return event.key.toLowerCase() === shortcut.key
    && event.altKey === shortcut.alt
    && event.shiftKey === shortcut.shift
    && event.ctrlKey === shortcut.ctrl
    && event.metaKey === shortcut.meta
}

export class Activator {
  private state: ActivationState = 'dormant'
  private started = false
  private disposed = false
  private readonly shortcut: ShortcutSpec
  private readonly removeKeyListener: (() => void) | null
  private readonly storage: Storage | null

  constructor(private readonly options: ActivatorOptions) {
    this.shortcut = parseShortcut(options.config.panel.shortcut)
    this.storage = options.storage ?? null
    this.removeKeyListener = options.addKeyListener?.(event => this.handleKey(event)) ?? null
  }

  get current(): ActivationState {
    return this.state
  }

  start(): void {
    if (this.started) return
    this.started = true
    const config = this.options.config
    if (!config.bridge.enabled) {
      this.setState('dormant')
      return
    }
    if (config.mode === 'development') {
      // Development auto-activates (probe, connect, register).
      void this.activate({ openPanel: config.panel.enabled })
      return
    }
    if (this.storage?.getItem(ACTIVATION_STORAGE_KEY) === '1') {
      // Persisted explicit activation resumes the bridge.
      void this.activate({})
      return
    }
    if (this.hasQueryActivation(config)) {
      this.persistActivation()
      void this.activate({ openPanel: config.panel.enabled })
      return
    }
    if (config.bridge.autoConnectInBuild) {
      void this.activate({})
      return
    }
    if (config.panel.visible) {
      // Probe-only: the launcher appears only after a successful probe; no
      // target registration happens before the user opens the panel or
      // explicitly activates the bridge.
      void this.probeOnly()
      return
    }
    // Production default: zero network requests until explicit activation.
    this.setState('dormant')
  }

  /** Public key event entry (shortcut activation). */
  handleKey(event: KeyEventLike): void {
    if (this.disposed || !matchesShortcut(event, this.shortcut)) return
    this.persistActivation()
    void this.activate({ openPanel: this.options.config.panel.enabled })
  }

  /** Probe, connect/register, and open the panel when requested. */
  async activate(options: { openPanel?: boolean } = {}): Promise<void> {
    if (this.disposed) return
    this.setState('probing')
    let ok = false
    try {
      ok = await this.options.probe()
    } catch {
      ok = false
    }
    if (this.disposed) return
    if (!ok) {
      this.setState('failed')
      return
    }
    this.setState('connecting')
    try {
      await this.options.connect()
    } catch {
      if (!this.disposed) this.setState('failed')
      return
    }
    if (this.disposed) return
    this.setState('connected')
    if (options.openPanel === true) this.options.openPanel()
  }

  private async probeOnly(): Promise<void> {
    if (this.disposed) return
    this.setState('probing')
    let ok = false
    try {
      ok = await this.options.probe()
    } catch {
      ok = false
    }
    if (this.disposed) return
    this.setState(ok ? 'available' : 'failed')
  }

  private hasQueryActivation(config: PageRuntimeConfig): boolean {
    const search = this.options.location?.search ?? ''
    try {
      return new URLSearchParams(search).get(config.panel.queryParameter) === '1'
    } catch {
      return false
    }
  }

  private persistActivation(): void {
    // The ONLY storage write the runtime performs: the user's explicit
    // local activation switch. Page metadata, grants, and console evidence
    // never persist anywhere.
    this.storage?.setItem(ACTIVATION_STORAGE_KEY, '1')
  }

  private setState(state: ActivationState): void {
    this.state = state
    this.options.onState?.(state)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeKeyListener?.()
  }
}
