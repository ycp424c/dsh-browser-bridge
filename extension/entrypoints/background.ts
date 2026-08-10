import { defineBackground } from 'wxt/utils/define-background'
import { createWsBridgeClient } from '../src/bridge/ws-socket.ts'
import { BridgeRouter } from '../src/bridge/router.ts'
import { GrantVault } from '../src/grants/vault.ts'
import { TabCatalog } from '../src/tabs/catalog.ts'
import { chromeSettingsStorage, DSH_ORIGIN_STORAGE_KEY, loadDshOrigin } from '../src/settings.ts'
import { CdpSessionManager } from '../src/cdp/session-manager.ts'
import { ChromeDebugger } from '../src/cdp/chrome-debugger.ts'
import type { BridgeClientState } from '../src/bridge/client.ts'

export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

  const client = createWsBridgeClient()
  const vault = new GrantVault()
  const catalog = new TabCatalog(chrome.tabs, [])
  const sessionManager = new CdpSessionManager({
    debuggerApi: new ChromeDebugger(chrome.debugger),
    onDetach: () => {
      // Pending tool calls already receive the stable error; the host is
      // notified through their tool.result failures.
    },
  })
  const router = new BridgeRouter({ bridge: client, vault, catalog, sessionManager })
  const panels = new Set<chrome.runtime.Port>()

  // The configured DSH origin is never attachable; refresh on settings change.
  const syncExcludedOrigins = async (): Promise<void> => {
    const origin = await loadDshOrigin(chromeSettingsStorage(chrome.storage.local))
    catalog.setExcludedOrigins([origin])
  }
  void syncExcludedOrigins()
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[DSH_ORIGIN_STORAGE_KEY] !== undefined) {
      void syncExcludedOrigins()
    }
  })

  const broadcastStatus = (state: BridgeClientState): void => {
    for (const port of panels) {
      port.postMessage({ type: 'bridge.status', state })
    }
  }
  client.onState(broadcastStatus)

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'sidepanel') return
    panels.add(port)
    port.postMessage({ type: 'bridge.status', state: client.state })
    router.connectPanel(port)
    port.onDisconnect.addListener(() => {
      panels.delete(port)
    })
  })
})
