import { defineBackground } from 'wxt/utils/define-background'
import { createWsBridgeClient } from '../src/bridge/ws-socket.ts'
import type { BridgeClientState } from '../src/bridge/client.ts'

export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

  const client = createWsBridgeClient()
  const panels = new Set<chrome.runtime.Port>()

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
    port.onMessage.addListener((message: unknown) => {
      const payload = message as { type?: string }
      if (payload.type === 'panel.forward') {
        // Routed in a later task; the bridge stays inert until a router exists.
      }
    })
    port.onDisconnect.addListener(() => {
      panels.delete(port)
      client.close()
    })
  })
})
