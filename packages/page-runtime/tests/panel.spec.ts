import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PageRuntimeConfig } from '../src/config.ts'
import { createPanel, type PanelChannelLike } from '../src/panel/panel.ts'

const DSH_ORIGIN = 'http://127.0.0.1:3080'
const TARGET_ID = 't'.repeat(43)

function baseConfig(overrides: Partial<PageRuntimeConfig> = {}): PageRuntimeConfig {
  return {
    dshOrigin: DSH_ORIGIN,
    mode: 'development',
    bridge: { enabled: true, autoConnectInBuild: false },
    panel: { enabled: true, visible: false, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' },
    ...overrides,
  }
}

class FakeChannel implements PanelChannelLike {
  readyHandler: (() => void) | null = null
  errorHandler: ((code: string) => void) | null = null
  inited = false
  disposed = false

  init(): void { this.inited = true }
  dispose(): void { this.disposed = true }
  onReady(handler: () => void): void { this.readyHandler = handler }
  onError(handler: (code: string) => void): void { this.errorHandler = handler }
}

function makePanel(config: PageRuntimeConfig) {
  const channel = new FakeChannel()
  const activate = vi.fn()
  const panel = createPanel({
    config,
    targetId: TARGET_ID as never,
    dshOrigin: DSH_ORIGIN,
    onActivate: activate,
    channelFactory: () => channel,
  })
  return { panel, channel, activate }
}

function hostElement(): HTMLElement | null {
  return document.getElementById('dsh-browser-bridge-panel-host')
}

function inShadow(selector: string): Element | null {
  return hostElement()?.shadowRoot?.querySelector(selector) ?? null
}

describe('shadow dom panel', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('panel.enabled=false creates no host element and keeps the bridge usable', () => {
    const { panel } = makePanel(baseConfig({ panel: { enabled: false, visible: false, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' } }))
    expect(panel).toBeNull()
    expect(hostElement()).toBeNull()
  })

  it('visible=false creates no host element or launcher before activation', () => {
    makePanel(baseConfig())
    expect(hostElement()).toBeNull()
    expect(document.querySelector('.dsh-bb-launcher')).toBeNull()
  })

  it('visible=true shows the launcher only after a successful probe', () => {
    const { panel } = makePanel(baseConfig({ panel: { enabled: true, visible: true, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' } }))
    // No launcher before the probe succeeds.
    expect(inShadow('.dsh-bb-launcher')).toBeNull()
    panel!.showLauncher()
    const launcher = inShadow('.dsh-bb-launcher') as HTMLButtonElement | null
    expect(launcher).not.toBeNull()
    expect(launcher!.textContent).toContain('DSH')
    // The probe-failed path never shows the launcher.
    panel!.hideLauncher()
    expect(inShadow('.dsh-bb-launcher')).toBeNull()
  })

  it('open creates one shadow root and a sandboxed iframe at the exact dshOrigin', () => {
    const { panel, channel } = makePanel(baseConfig())
    panel!.open()
    const host = hostElement()
    expect(host).not.toBeNull()
    expect(host!.shadowRoot).not.toBeNull()
    const iframe = host!.shadowRoot!.querySelector('iframe') as HTMLIFrameElement | null
    expect(iframe).not.toBeNull()
    expect(iframe!.src).toBe(DSH_ORIGIN + '/')
    const sandbox = iframe!.getAttribute('sandbox') ?? ''
    for (const token of ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-modals']) {
      expect(sandbox.split(/\s+/)).toContain(token)
    }
    expect(channel.inited).toBe(true)
  })

  it('shows the connection banner and a close control in the drawer', () => {
    const { panel } = makePanel(baseConfig())
    panel!.open()
    const shadow = hostElement()!.shadowRoot!
    expect(shadow.querySelector('.dsh-bb-connection')).not.toBeNull()
    expect(shadow.querySelector('.dsh-bb-close')).not.toBeNull()
    panel!.setConnection('connected')
    expect(shadow.querySelector('.dsh-bb-connection')!.textContent).toContain('connected')
    // Closing the drawer removes it; the host element stays for reopening.
    ;(shadow.querySelector('.dsh-bb-close') as HTMLButtonElement).click()
    expect(shadow.querySelector('.dsh-bb-drawer')).toBeNull()
  })

  it('an embedding failure keeps the target alive and offers an exact-origin new-tab fallback', () => {
    const { panel, channel } = makePanel(baseConfig())
    panel!.open()
    channel.errorHandler?.('embedding_blocked')
    const shadow = hostElement()!.shadowRoot!
    const fallback = shadow.querySelector('a.dsh-bb-fallback') as HTMLAnchorElement | null
    expect(fallback).not.toBeNull()
    expect(fallback!.href).toBe(DSH_ORIGIN + '/')
    expect(fallback!.target).toBe('_blank')
    // The target connection is untouched: no teardown ran, retry remains.
    expect(shadow.querySelector('.dsh-bb-retry')).not.toBeNull()
    expect(channel.disposed).toBe(false)
  })

  it('the launcher activates the bridge on click', () => {
    const { panel, activate } = makePanel(baseConfig({ panel: { enabled: true, visible: true, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' } }))
    panel!.showLauncher()
    ;(inShadow('.dsh-bb-launcher') as HTMLButtonElement).click()
    expect(activate).toHaveBeenCalled()
  })

  it('showDiagnostic reveals the exact-origin fallback', () => {
    const { panel } = makePanel(baseConfig())
    panel!.open()
    expect(inShadow('a.dsh-bb-fallback')?.hasAttribute('hidden')).toBe(true)
    panel!.setConnection('failed')
    panel!.showDiagnostic()
    const fallback = inShadow('a.dsh-bb-fallback') as HTMLAnchorElement | null
    expect(fallback?.hasAttribute('hidden')).toBe(false)
    expect(fallback!.href).toBe(DSH_ORIGIN + '/')
  })

  it('dispose removes the DOM, the channel, and every listener', () => {
    const { panel, channel } = makePanel(baseConfig())
    panel!.open()
    panel!.showLauncher()
    panel!.dispose()
    expect(hostElement()).toBeNull()
    expect(channel.disposed).toBe(true)
    expect(inShadow('.dsh-bb-launcher')).toBeNull()
  })
})
