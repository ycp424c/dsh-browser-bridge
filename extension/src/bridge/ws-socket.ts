/**
 * Bridge WebSocket transport adapter: maps a browser `WebSocket` onto the
 * socket face the BridgeClient drives.
 */
import { BridgeClient, type BridgeSocket } from './client.ts'

export class WsBridgeSocket implements BridgeSocket {
  private readonly ws: WebSocket
  private closed = false

  constructor(url: string) {
    this.ws = new WebSocket(url)
  }

  send(text: string): void {
    if (this.closed) return
    this.ws.send(text)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.ws.close()
  }

  onOpen(handler: () => void): void {
    this.ws.addEventListener('open', handler)
  }

  onMessage(handler: (text: string) => void): void {
    this.ws.addEventListener('message', event => {
      if (typeof event.data === 'string') handler(event.data)
    })
  }

  onClose(handler: () => void): void {
    this.ws.addEventListener('close', () => {
      if (this.closed) return
      this.closed = true
      handler()
    })
  }
}

export function createWsBridgeClient(): BridgeClient {
  return new BridgeClient({ createSocket: url => new WsBridgeSocket(url) })
}
