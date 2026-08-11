import { defineConfig } from 'vite'
import { dshBrowserBridge } from '@dsh-external/dsh-browser-bridge-vite'

/**
 * Shared fixture config: the harness origin, panel policy, and project id
 * come from the environment so the e2e specs can point every fixture at
 * their own broker harness instance.
 */
export default defineConfig({
  plugins: [dshBrowserBridge({
    dshOrigin: process.env.DSH_BRIDGE_ORIGIN ?? 'http://127.0.0.1:3080',
    bridge: {
      enabled: process.env.DSH_BRIDGE_DISABLED !== 'true',
    },
    panel: {
      enabled: process.env.DSH_BRIDGE_PANEL !== 'false',
      visible: process.env.DSH_BRIDGE_PANEL_VISIBLE === 'true',
    },
    ...(process.env.DSH_BRIDGE_PROJECT !== undefined
      ? { projectId: process.env.DSH_BRIDGE_PROJECT }
      : {}),
  })],
})
