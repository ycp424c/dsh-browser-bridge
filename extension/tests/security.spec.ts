import { describe, expect, it } from 'vitest'
import { GrantId, PROTOCOL_VERSION, type BridgeFrame } from '@dsh-external/dsh-browser-bridge-protocol'
import type { TabDescriptor } from '@dsh-external/dsh-browser-bridge-protocol'
import { BridgeRouter } from '../src/bridge/router.ts'
import type { BridgeClient } from '../src/bridge/client.ts'
import type { TabCatalog } from '../src/tabs/catalog.ts'
import { GrantVault } from '../src/grants/vault.ts'
import { CdpSessionManager } from '../src/cdp/session-manager.ts'
import { ChromeDebugger, type ChromeDebuggerApi } from '../src/cdp/chrome-debugger.ts'
import { decodeFrame } from '@dsh-external/dsh-browser-bridge-protocol'
import { BridgeClient as RealBridgeClient, type BridgeSocket } from '../src/bridge/client.ts'

const TAB: TabDescriptor = { tabId: 9, windowId: 3, title: 'App', url: 'http://127.0.0.1:4173/' }

describe('security boundaries', () => {
  it('keeps browser-derived data out of the ownership ledger', () => {
    const vault = new GrantVault()
    vault.create({ sessionId: 's1', tab: TAB })
    const ledger = vault.serializeLedger()
    expect(ledger).toContain('"tabId":9')
    expect(ledger).not.toContain('http://127.0.0.1:4173')
    expect(ledger).not.toContain('App')
    expect(ledger).not.toContain('consoleEntries')
  })

  it('rejects protocol frames without echoing their payload', () => {
    const payload = '<script>alert(1)</script>secret-token'
    expect(() => decodeFrame(payload)).toThrow(/protocol frame/)
    try {
      decodeFrame(payload)
    } catch (error) {
      expect(String(error)).not.toContain('secret-token')
    }
  })

  it('rejects unknown protocol versions', () => {
    expect(() => decodeFrame(JSON.stringify({ v: 99, type: 'pong' }))).toThrow(/protocol frame/)
  })

  it('drops invalid inbound bridge frames without forwarding them', () => {
    class FakeSocket implements BridgeSocket {
      sent: string[] = []
      closed = false
      private messageHandlers: ((text: string) => void)[] = []
      private closeHandlers: (() => void)[] = []
      onOpen(): void {}
      onMessage(h: (text: string) => void): void { this.messageHandlers.push(h) }
      onClose(h: () => void): void { this.closeHandlers.push(h) }
      send(text: string): void { this.sent.push(text) }
      close(): void {
        this.closed = true
        for (const handler of this.closeHandlers) handler()
      }
      open(): void {}
      receive(text: string): void { for (const handler of this.messageHandlers) handler(text) }
    }
    const socket = new FakeSocket()
    const client = new RealBridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
    const frames: BridgeFrame[] = []
    client.onFrame(frame => frames.push(frame))
    client.connect('ws://x', 'n'.repeat(32))
    socket.receive(JSON.stringify({ v: 99, type: 'pong' }))
    expect(frames).toEqual([])
  })

})
