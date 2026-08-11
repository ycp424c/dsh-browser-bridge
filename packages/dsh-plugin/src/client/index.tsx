/**
 * DSH browser bridge client plugin, browser half. Registers the `@` tab
 * source and the current-tab button, pairs with the host over
 * `/dsh-browser-bridge/pair`, and forwards fresh pairing nonces to the
 * extension when the bridge asks for one.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap declaration for `conversation.input.dock`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts'
import { CurrentTabButton, type CurrentTabButtonInjected } from './CurrentTabButton.tsx'
import { channelFromWindow } from './extension-channel.ts'
import { ReferenceStore } from './reference-store.ts'
import { createTabSource } from './tab-source.ts'

export const inject = ['slash', 'sessions', 'slots']

export function apply(ctx: ClientContext): void {
  let channel: ReturnType<typeof channelFromWindow>
  try {
    channel = channelFromWindow(window)
  } catch (error) {
    // DSH Web opened outside the extension side panel: the bridge is inert.
    console.warn('[dsh-browser-bridge] not embedded in the extension side panel', error)
    return
  }
  const store = new ReferenceStore()

  const pairAndConnect = async (): Promise<void> => {
    const response = await fetch(`${window.location.origin}/dsh-browser-bridge/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extensionOrigin: channel.extensionOrigin }),
    })
    if (!response.ok) throw new Error(`dsh-browser-bridge: pairing failed (${response.status})`)
    const { nonce } = (await response.json()) as { nonce: string }
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${protocol}://${window.location.host}/dsh-browser-bridge/ws`
    await channel.request('bridge.connect', { wsUrl, pairingNonce: nonce })
  }

  ctx.effect(() => {
    void pairAndConnect().catch(error => {
      console.warn('[dsh-browser-bridge] initial pairing failed', error)
    })
    // Pairing nonces are single-use: reconnect always obtains a fresh one.
    const offPairingRequired = channel.onParentMessage(message => {
      const payload = message as { type?: string }
      if (payload.type !== 'bridge.pairing-required') return
      void pairAndConnect().catch(error => {
        console.warn('[dsh-browser-bridge] re-pairing failed', error)
      })
    })
    const offSource = ctx.slash.registerSource(createTabSource(channel, store))
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
          return { actx, channel, store }
        },
      }, CurrentTabButton))
    })
    channel.post({ type: 'bridge.client-ready' })
    return () => {
      offPairingRequired()
      offSource()
      offSlot.dispose()
      // Unload/reload must remove the window message listener, or the old
      // channel keeps receiving parent traffic.
      channel.dispose()
    }
  }, 'dsh-browser-bridge: client plugin')
}
