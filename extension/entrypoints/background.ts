import { defineBackground } from 'wxt/utils/define-background'
import { createWsBridgeClient } from '../src/bridge/ws-socket.ts'
import { BridgeRouter } from '../src/bridge/router.ts'
import { GrantVault } from '../src/grants/vault.ts'
import { TabCatalog } from '../src/tabs/catalog.ts'
import { chromeSettingsStorage, DSH_ORIGIN_STORAGE_KEY, loadDshOrigin } from '../src/settings.ts'
import { CdpSessionManager, type TabSession } from '../src/cdp/session-manager.ts'
import { ChromeDebugger } from '../src/cdp/chrome-debugger.ts'
import { observePage, type ObserveArgs } from '../src/cdp/observe.ts'
import { inspectElement, type InspectArgs } from '../src/cdp/inspect.ts'
import { bridgeError, type BrowserOperation, type JsonValue } from '@dsh-external/dsh-browser-bridge-protocol'
import type { BridgeClientState } from '../src/bridge/client.ts'
import type { ToolExecutor } from '../src/bridge/router.ts'

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
  const toolExecutor: ToolExecutor = async (
    session: TabSession,
    operation: BrowserOperation,
    args: JsonValue,
  ): Promise<JsonValue> => {
    switch (operation) {
      case 'observe':
        return observePage(session, (args ?? {}) as ObserveArgs)
      case 'inspect':
        return inspectElement(session, (args ?? {}) as InspectArgs)
      default:
        throw bridgeError('internal', `browser operation ${operation} is not wired yet`, false)
    }
  }
  const router = new BridgeRouter({ bridge: client, vault, catalog, sessionManager, toolExecutor })
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
