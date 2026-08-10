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
import { performAction, type ActAction } from '../src/cdp/act.ts'
import { navigatePage, type NavigateArgs } from '../src/cdp/navigate.ts'
import { waitForCondition, type WaitCondition } from '../src/cdp/wait.ts'
import { captureScreenshot } from '../src/cdp/capture.ts'
import { bridgeError, type BrowserOperation, type GrantId, type JsonValue } from '@dsh-external/dsh-browser-bridge-protocol'
import type { BridgeClientState } from '../src/bridge/client.ts'
import type { ToolExecutor } from '../src/bridge/router.ts'

/** Non-secret ownership ledger in chrome.storage.session (startup cleanup). */
const OWNED_LEDGER_KEY = 'dshBrowserBridge.owned'

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
        // Results are plain JSON-shaped data; the interface lacks an index
        // signature, so the lossless conversion is explicit at the boundary.
        return (await observePage(session, (args ?? {}) as ObserveArgs)) as unknown as JsonValue
      case 'inspect':
        return (await inspectElement(session, (args ?? {}) as InspectArgs)) as unknown as JsonValue
      case 'act':
        return (await performAction(session, (args as { action: ActAction }).action)) as unknown as JsonValue
      case 'navigate':
        return (await navigatePage(session, (args ?? {}) as NavigateArgs)) as unknown as JsonValue
      case 'wait':
        return (await waitForCondition(session, (args as { condition: WaitCondition }).condition, {
          timeoutMs: 30_000,
        })) as unknown as JsonValue
      case 'screenshot':
        return (await captureScreenshot(session, (args ?? {}) as { ref?: string; selector?: string })) as unknown as JsonValue
      case 'console':
        return { entries: session.consoleEntries } as unknown as JsonValue
      case 'network':
        return { entries: session.networkEntries } as unknown as JsonValue
      default:
        throw bridgeError('internal', `browser operation ${operation} is not wired yet`, false)
    }
  }
  const router = new BridgeRouter({ bridge: client, vault, catalog, sessionManager, toolExecutor })
  const panels = new Set<chrome.runtime.Port>()
  // One disposer registry for every background listener so recreation never
  // leaves duplicates behind.
  const disposers: Array<() => void> = []

  /** Notify the host about one revoked grant. */
  const notifyHostRevoke = (grantId: GrantId): void => {
    try {
      client.send({ v: 1, type: 'grant.revoke', grantId })
    } catch {
      // The bridge may be down; the host drops grants on disconnect anyway.
    }
  }

  /** Revoke one grant everywhere (vault, CDP, host). */
  const revokeGrant = (grantId: GrantId): void => {
    vault.revoke(grantId)
    sessionManager.revoke(grantId)
    notifyHostRevoke(grantId)
  }

  // Startup reconciliation: detach ONLY the tab ids our previous session
  // owned, clear the ledger, then accept new work.
  const reconcileStartup = async (): Promise<void> => {
    const storage = chromeSettingsStorage(chrome.storage.session)
    const ledger = await storage.get(OWNED_LEDGER_KEY)
    if (ledger !== undefined) {
      try {
        const entries = JSON.parse(ledger) as Array<{ tabId: number }>
        await sessionManager.cleanupOwned(entries.map(entry => entry.tabId))
      } catch {
        // A malformed ledger is discarded; cleanup is best-effort.
      }
    }
    await chrome.storage.session.remove(OWNED_LEDGER_KEY)
  }
  disposers.push(() => { void chrome.storage.session.remove(OWNED_LEDGER_KEY) })

  // Ownership ledger mirror (non-secret { grantId, tabId } pairs only).
  const writeLedger = (): void => {
    void chrome.storage.session.set({ [OWNED_LEDGER_KEY]: vault.serializeLedger() })
  }
  disposers.push(vault.subscribe(writeLedger))

  // Expiry: one timer for the nearest deadline, revoking on the way out.
  disposers.push(vault.startExpirySweep(expired => {
    for (const grantId of expired) {
      sessionManager.revoke(grantId)
      notifyHostRevoke(grantId)
    }
  }))

  // Tab closure revokes every grant bound to that tab.
  const onTabRemoved = (tabId: number): void => {
    for (const grantId of vault.grantIdsOfTab(tabId)) revokeGrant(grantId)
  }
  chrome.tabs.onRemoved.addListener(onTabRemoved)
  disposers.push(() => chrome.tabs.onRemoved.removeListener(onTabRemoved))

  // The configured DSH origin is never attachable; refresh on settings change.
  const syncExcludedOrigins = async (): Promise<void> => {
    const origin = await loadDshOrigin(chromeSettingsStorage(chrome.storage.local))
    catalog.setExcludedOrigins([origin])
  }
  void syncExcludedOrigins()
  const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'local' && changes[DSH_ORIGIN_STORAGE_KEY] !== undefined) {
      void syncExcludedOrigins()
    }
  }
  chrome.storage.onChanged.addListener(onStorageChanged)
  disposers.push(() => chrome.storage.onChanged.removeListener(onStorageChanged))

  const broadcastStatus = (state: BridgeClientState): void => {
    for (const port of panels) {
      port.postMessage({ type: 'bridge.status', state })
    }
  }
  disposers.push(client.onState(broadcastStatus))

  const onConnect = (port: chrome.runtime.Port): void => {
    if (port.name !== 'sidepanel') return
    panels.add(port)
    port.postMessage({ type: 'bridge.status', state: client.state })
    router.connectPanel(port)
    port.onDisconnect.addListener(() => {
      panels.delete(port)
    })
  }
  chrome.runtime.onConnect.addListener(onConnect)
  disposers.push(() => chrome.runtime.onConnect.removeListener(onConnect))

  void reconcileStartup()
})
