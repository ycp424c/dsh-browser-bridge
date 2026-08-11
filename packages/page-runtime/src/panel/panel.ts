/**
 * Optional Shadow DOM panel: one fixed host element with a Shadow Root and
 * isolated styles, a launcher, a resizable drawer, a connection banner, a
 * close control, a retry diagnostic, and an open-local-DSH fallback. The
 * iframe loads the exact local DSH origin with the minimal sandbox and
 * speaks over the exact-origin MessageChannel. `panel.enabled=false`
 * creates nothing while the bridge activation pipeline keeps running.
 */
import type { PageRuntimeConfig } from '../config.ts'
import type { TargetId } from '@dsh-external/dsh-browser-bridge-protocol'
import { PanelChannel } from './channel.ts'
import { PANEL_STYLES } from './styles.ts'

export const PANEL_HOST_ID = 'dsh-browser-bridge-panel-host'

export type PanelConnectionState = 'idle' | 'connecting' | 'connected' | 'failed'

export interface PanelChannelLike {
  init(): void
  dispose(): void
  onReady(handler: () => void): void
  onError(handler: (code: string) => void): void
}

export interface PanelOptions {
  config: PageRuntimeConfig
  targetId: TargetId
  dshOrigin: string
  /** User clicked the launcher / retry: activate the bridge. */
  onActivate: () => void
  /** Injectable for tests; defaults to the real MessageChannel panel. */
  channelFactory?: (iframe: HTMLIFrameElement) => PanelChannelLike
  doc?: Document
  win?: Window
}

export interface Panel {
  showLauncher(): void
  hideLauncher(): void
  open(): void
  setConnection(state: PanelConnectionState, error?: string): void
  dispose(): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function createPanel(options: PanelOptions): Panel | null {
  const config = options.config
  if (!config.panel.enabled) return null
  const doc = options.doc ?? document
  let host: HTMLElement | null = null
  let shadow: ShadowRoot | null = null
  let channel: PanelChannelLike | null = null
  let drawer: HTMLElement | null = null
  let launcher: HTMLButtonElement | null = null
  let disposed = false

  const ensureHost = (): ShadowRoot => {
    if (host !== null && shadow !== null) return shadow
    host = doc.createElement('div')
    host.id = PANEL_HOST_ID
    shadow = host.attachShadow({ mode: 'open' })
    const style = doc.createElement('style')
    style.textContent = PANEL_STYLES
    shadow.appendChild(style)
    doc.body.appendChild(host)
    return shadow
  }

  const panel: Panel = {
    showLauncher: () => {
      if (disposed) return
      if (launcher !== null) return
      const root = ensureHost()
      launcher = el('button', 'dsh-bb-launcher', 'DSH')
      launcher.addEventListener('click', () => options.onActivate())
      root.appendChild(launcher)
    },
    hideLauncher: () => {
      launcher?.remove()
      launcher = null
    },
    open: () => {
      if (disposed) return
      const root = ensureHost()
      if (drawer !== null) return
      drawer = el('div', 'dsh-bb-drawer')
      const header = el('div', 'dsh-bb-drawer-header', 'Local DSH')
      const close = el('button', 'dsh-bb-close', '×')
      close.setAttribute('aria-label', 'Close panel')
      close.addEventListener('click', () => {
        drawer?.remove()
        drawer = null
      })
      header.appendChild(close)
      drawer.appendChild(header)

      const banner = el('div', 'dsh-bb-connection', 'idle')
      banner.dataset.state = 'idle'
      drawer.appendChild(banner)

      const actions = el('div', 'dsh-bb-actions')
      const retry = el('button', 'dsh-bb-retry', 'Retry')
      retry.addEventListener('click', () => options.onActivate())
      const fallback = el('a', 'dsh-bb-fallback', 'Open local DSH in a new tab')
      fallback.href = options.dshOrigin
      fallback.target = '_blank'
      fallback.rel = 'noopener noreferrer'
      fallback.hidden = true
      actions.appendChild(retry)
      actions.appendChild(fallback)
      drawer.appendChild(actions)

      const frame = el('div', 'dsh-bb-frame')
      const iframe = doc.createElement('iframe')
      iframe.src = options.dshOrigin
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals')
      iframe.setAttribute('title', 'Local DSH')
      frame.appendChild(iframe)
      drawer.appendChild(frame)

      root.appendChild(drawer)

      channel = options.channelFactory !== undefined
        ? options.channelFactory(iframe)
        : new PanelChannel({
            env: {
              postToIframe: (message, targetOrigin, ports) => {
                iframe.contentWindow?.postMessage(message, targetOrigin, ports as never[])
              },
              onIframeLoad: handler => {
                iframe.addEventListener('load', () => handler())
              },
            },
            dshOrigin: options.dshOrigin,
            targetId: options.targetId,
          })
      const wired = channel
      wired.onReady(() => panel.setConnection('connected'))
      wired.onError(code => {
        panel.setConnection('failed', code)
        fallback.hidden = false
      })
      wired.init()
    },
    setConnection: (state, error) => {
      if (disposed || drawer === null) return
      const banner = drawer.querySelector('.dsh-bb-connection') as HTMLElement | null
      if (banner === null) return
      banner.dataset.state = state
      banner.textContent = error === undefined
        ? `local DSH: ${state}`
        : `local DSH: ${state} (${error})`
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      channel?.dispose()
      channel = null
      host?.remove()
      host = null
      shadow = null
      drawer = null
      launcher = null
    },
  }
  return panel
}
