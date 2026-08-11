/**
 * Activation state machine: dormant, probing, available, connecting,
 * connected, failed. The panel display policy is orthogonal to the bridge:
 *
 * - `panel.enabled=false` creates no UI at all; the bridge pipeline keeps
 *   running and stays reachable from standalone DSH Web.
 * - `panel.visible=false` keeps the UI hidden: no launcher entry and no
 *   drawer ever appear from automatic activation.
 * - `panel.visible=true` permits the launcher entry, but only after a
 *   successful local health probe; it never opens the drawer by itself.
 * - The drawer opens only on explicit user activation (shortcut, `?dsh=1`,
 *   or a launcher click) — never automatically. `?dsh=1` wins over every
 *   mode default and over the persisted switch. A persisted local
 *   activation switch resumes the bridge silently: it re-probes and
 *   re-connects on later loads but opens no drawer and shows no failure UI.
 *
 * Mode matrix (bridge.enabled=true):
 *
 * | mode        | automatic start behavior                        | explicit activation |
 * |-------------|-------------------------------------------------|---------------------|
 * | development | probe -> connect/register; no drawer; launcher  | probe -> connect/   |
 * |             | only after probe success when panel.visible     | register -> open    |
 * |             |                                                 | drawer (if enabled) |
 * | production  | dormant (zero network) unless autoConnectInBuild| probe -> connect/   |
 * |             | (probe -> connect/register) or panel.visible    | register -> open    |
 * |             | (probe-only -> launcher after probe success)    | drawer (if enabled) |
 *
 * In production the default is zero-network dormancy; only an explicit
 * user activation (shortcut, query parameter, or the persisted local
 * switch) or an explicit deployment choice (autoConnectInBuild /
 * panel.visible) produces any loopback request.
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

export interface ActivationMeta {
  /** True when this activation pipeline was started by explicit user
   *  action (shortcut, query parameter, or launcher click). Automatic
   *  activations (development start, autoConnectInBuild, probe-only)
   *  never carry this flag. */
  explicit?: boolean
}

export interface ActivatorOptions {
  config: PageRuntimeConfig
  probe(): Promise<boolean>
  connect(): Promise<void>
  openPanel(): void
  onState?(state: ActivationState, meta?: ActivationMeta): void
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
    // Explicit URL intent (?dsh=1) wins over every mode default and over
    // the persisted switch, in development and production alike.
    if (this.hasQueryActivation(config)) {
      this.userActivate({ openPanel: config.panel.enabled })
      return
    }
    if (config.mode === 'development') {
      // Development auto-activates (probe, connect, register), but never
      // opens the panel: panel.visible only permits the launcher entry
      // after a successful probe, and the drawer opens solely through
      // explicit user activation (shortcut, ?dsh=1, launcher click).
      void this.activate({})
      return
    }
    if (this.storage?.getItem(ACTIVATION_STORAGE_KEY) === '1') {
      // Persisted activation resumes the bridge silently: it re-probes and
      // re-connects, but opens no drawer and shows no failure UI.
      void this.activate({})
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
    this.userActivate()
  }

  /**
   * Explicit user activation (launcher, shortcut, query): persists the
   * local activation switch and runs the probe/connect/open-panel pipeline.
   */
  userActivate(options: { openPanel?: boolean } = {}): void {
    this.persistActivation()
    void this.activate({
      openPanel: options.openPanel ?? this.options.config.panel.enabled,
      explicit: true,
    })
  }

  /** Probe, connect/register, and open the panel when requested. */
  async activate(options: { openPanel?: boolean; explicit?: boolean } = {}): Promise<void> {
    if (this.disposed) return
    const explicit = options.explicit === true
    this.setState('probing', { explicit })
    let ok = false
    try {
      ok = await this.options.probe()
    } catch {
      ok = false
    }
    if (this.disposed) return
    if (!ok) {
      this.setState('failed', { explicit })
      return
    }
    // The launcher entry may appear only after a successful health probe
    // and only when the deployment chose panel.visible=true; it is an
    // entry point, never an automatic drawer.
    if (this.options.config.panel.visible) {
      this.setState('available', { explicit })
    }
    this.setState('connecting', { explicit })
    try {
      await this.options.connect()
    } catch {
      if (!this.disposed) this.setState('failed', { explicit })
      return
    }
    if (this.disposed) return
    this.setState('connected', { explicit })
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

  private setState(state: ActivationState, meta?: ActivationMeta): void {
    this.state = state
    this.options.onState?.(state, meta)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeKeyListener?.()
  }
}
