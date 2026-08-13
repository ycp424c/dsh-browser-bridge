/**
 * DSH browser bridge client plugin, browser half. Registers the `@`
 * browser-tabs source (extension side panel), the `@` vite-pages source
 * (always), the current-tab button (extension), and the `@当前开发页`
 * button (embedded Vite page, only after the host verifies the parent
 * identity). Providers initialize independently: Vite discovery stays
 * active outside the extension iframe, and the extension channel never
 * weakens.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap declaration for `conversation.input.dock`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts'
import type { TabDescriptor, BrowserTargetDescriptor } from '@dsh-external/dsh-browser-bridge-protocol'
import { CurrentTabButton, type CurrentTabButtonInjected } from './CurrentTabButton.tsx'
import { CurrentVitePageButton, type CurrentVitePageButtonInjected } from './CurrentVitePageButton.tsx'
import { channelFromWindow } from './extension-channel.ts'
import { ReferenceStore } from './reference-store.ts'
import { createTabSource } from './tab-source.ts'
import { createViteTargetApi } from './vite-api.ts'
import { createViteSource } from './vite-source.ts'
import { ViteParentChannel } from './vite-parent-channel.ts'

export const inject = ['inputTriggers', 'sessions', 'slots']

export function apply(ctx: ClientContext): void {
  const tabStore = new ReferenceStore<TabDescriptor>()
  const viteStore = new ReferenceStore<BrowserTargetDescriptor>()
  // The DSH Web origin is the local DSH origin; the same-origin Vite API
  // serves target discovery and grant issuance.
  const viteApi = createViteTargetApi(window.location.origin)

  let channel: ReturnType<typeof channelFromWindow> | undefined
  try {
    channel = channelFromWindow(window)
  } catch (error) {
    // DSH Web opened outside the extension side panel: the extension
    // provider is inert, but Vite discovery keeps running.
    console.warn('[dsh-browser-bridge] not embedded in the extension side panel', error)
  }

  const pairAndConnect = async (extensionOrigin: string): Promise<void> => {
    const response = await fetch(`${window.location.origin}/dsh-browser-bridge/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extensionOrigin }),
    })
    if (!response.ok) throw new Error(`dsh-browser-bridge: pairing failed (${response.status})`)
    const { nonce } = (await response.json()) as { nonce: string }
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${protocol}://${window.location.host}/dsh-browser-bridge/ws`
    await channel!.request('bridge.connect', { wsUrl, pairingNonce: nonce })
  }

  ctx.effect(() => {
    // Vite pages are discovered in every mode (standalone DSH Web, the
    // extension side panel, and the embedded Vite panel).
    const offViteSource = ctx.inputTriggers.registerSource(createViteSource(viteApi, viteStore))

    // Vite parent channel: the page hosting this DSH Web iframe may post
    // one init message with a transferred port; the current-page button is
    // exposed only after the host verifies targetId plus origin.
    const viteParent = new ViteParentChannel({
      env: {
        parent: window.parent,
        addMessageListener: handler => window.addEventListener('message', handler),
        removeMessageListener: handler => window.removeEventListener('message', handler),
      },
      api: viteApi,
    })
    const disposers: Array<() => void> = []
    let offViteSlot: (() => void) | undefined
    const offViteInit = viteParent.onInit(init => {
      void viteParent.verify(init).catch(error => {
        console.warn('[dsh-browser-bridge] vite parent verification failed', error)
      })
    })
    disposers.push(offViteInit)
    const offViteVerified = viteParent.onVerified(verified => {
      if (offViteSlot !== undefined) return
      const off = ctx.inject(['slots', 'sessions'], (scope: ClientContext) => {
        const sessions = scope.sessions
        // Order 31 keeps the embedded current-page button directly below
        // the extension current-tab button (30), closest to the input card.
        return scope.slots.inject('conversation.input.dock', () => scope.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-browser-bridge-current-vite-page',
          order: 31,
          inject: (sessionId): CurrentVitePageButtonInjected => {
            const actx = sessions.scope(sessionId)
            if (actx === undefined) throw new Error('dsh-browser-bridge: session scope missing')
            return { actx, api: viteApi, store: viteStore, verified }
          },
        }, CurrentVitePageButton))
      })
      disposers.push(off.dispose)
      offViteSlot = off.dispose
    })
    disposers.push(offViteVerified)
    disposers.push(() => viteParent.dispose())

    if (channel !== undefined) {
      void pairAndConnect(channel.extensionOrigin).catch(error => {
        console.warn('[dsh-browser-bridge] initial pairing failed', error)
      })
      // Pairing nonces are single-use: reconnect always obtains a fresh one.
      const offPairingRequired = channel.onParentMessage(message => {
        const payload = message as { type?: string }
        if (payload.type !== 'bridge.pairing-required') return
        void pairAndConnect(channel!.extensionOrigin).catch(error => {
          console.warn('[dsh-browser-bridge] re-pairing failed', error)
        })
      })
      const offSource = ctx.inputTriggers.registerSource(createTabSource(channel, tabStore))
      const offSlot = ctx.inject(['slots', 'sessions'], (scope: ClientContext) => {
        const sessions = scope.sessions
        // The official `conversation.input.dock` strip above the input card
        // (rendered in both the blank hero and active conversations). Order 30
        // sorts after the host's Todo(0)/Goal(10)/Queue(20) rows, so the button
        // is the entry closest to the input card.
        return scope.slots.inject('conversation.input.dock', () => scope.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-browser-bridge-current-tab',
          order: 30,
          inject: (sessionId): CurrentTabButtonInjected => {
            const actx = sessions.scope(sessionId)
            if (actx === undefined) throw new Error('dsh-browser-bridge: session scope missing')
            return { actx, channel: channel!, store: tabStore }
          },
        }, CurrentTabButton))
      })
      channel.post({ type: 'bridge.client-ready' })
      disposers.push(offPairingRequired, offSource, offSlot.dispose, () => channel!.dispose())
    }

    return () => {
      offViteSource()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // A disposer must not break the remaining cleanup.
        }
      }
    }
  }, 'dsh-browser-bridge: client plugin')
}
