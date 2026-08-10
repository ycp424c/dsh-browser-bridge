import { useEffect, useRef, useState } from 'react'
import {
  chromeSettingsStorage,
  loadDshOrigin,
  normalizeDshOrigin,
  saveDshOrigin,
} from '../../src/settings.ts'
import { Button } from '../../src/components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../src/components/ui/card.tsx'
import { Input } from '../../src/components/ui/input.tsx'
import type { BridgeClientState } from '../../src/bridge/client.ts'

const STATUS_LABEL: Record<BridgeClientState, string> = {
  idle: 'Bridge idle',
  connecting: 'Connecting to DSH…',
  connected: 'Connected to DSH',
  reconnecting: 'Reconnecting…',
  closed: 'Bridge closed',
}

export default function App() {
  const [origin, setOrigin] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<BridgeClientState>('idle')
  const [clientReady, setClientReady] = useState(false)
  const [readinessExpired, setReadinessExpired] = useState(false)
  const [iframeEpoch, setIframeEpoch] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const portRef = useRef<chrome.runtime.Port | null>(null)

  useEffect(() => {
    void loadDshOrigin(chromeSettingsStorage(chrome.storage.local)).then(loaded => {
      setOrigin(loaded)
      setDraft(loaded)
    })
    const port = chrome.runtime.connect({ name: 'sidepanel' })
    portRef.current = port
    port.onMessage.addListener((message: unknown) => {
      const payload = message as { type?: string; state?: BridgeClientState }
      if (payload.type === 'bridge.status' && payload.state !== undefined) {
        setStatus(payload.state)
      } else if (payload.type === 'panel.reply') {
        // Replies to iframe requests are forwarded with the exact origin.
        iframeRef.current?.contentWindow?.postMessage(payload, origin ?? '')
      }
    })
    return () => {
      port.disconnect()
      portRef.current = null
    }
  }, [origin])

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframeRef.current?.contentWindow) return
    if (event.origin !== origin) return
    const data = event.data as { type?: string }
    if (data.type === 'bridge.client-ready') {
      setClientReady(true)
      return
    }
    portRef.current?.postMessage({ type: 'panel.forward', payload: event.data })
  }

  // Five-second readiness window after the iframe loads: no client-ready
  // event means DSH Web may be offline or blocking extension framing.
  useEffect(() => {
    if (clientReady || origin === null) return
    const timer = setTimeout(() => {
      setReadinessExpired(true)
    }, 5_000)
    return () => clearTimeout(timer)
  }, [clientReady, origin, iframeEpoch])

  useEffect(() => {
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })

  const validOrigin = origin === null ? null : (() => {
    try {
      return normalizeDshOrigin(origin)
    } catch {
      return null
    }
  })()

  const save = async () => {
    try {
      const normalized = await saveDshOrigin(chromeSettingsStorage(chrome.storage.local), draft)
      setOrigin(normalized)
    } catch {
      setOrigin(null)
    }
  }

  const retry = () => {
    setClientReady(false)
    setReadinessExpired(false)
    setIframeEpoch(epoch => epoch + 1)
  }

  if (validOrigin === null) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>DSH Browser Bridge</CardTitle>
            <CardDescription>
              Configure the local DSH Web origin. Only loopback HTTP(S) origins are supported.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              aria-label="DSH Web origin"
              value={draft}
              placeholder="http://127.0.0.1:3080"
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void save() }}
            />
            {origin !== null && (
              <p className="mt-2 text-sm text-muted-foreground">
                The saved value is invalid; enter a local DSH origin such as http://127.0.0.1:3080.
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button onClick={() => void save()}>Save origin</Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  if (readinessExpired) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>DSH Web did not respond</CardTitle>
            <CardDescription>
              The bridge client did not report ready within five seconds. DSH Web may be offline, or
              it may block being embedded in the extension side panel (X-Frame-Options / CSP
              frame-ancestors). The extension frame is configured for {validOrigin}.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex gap-2">
            <Button onClick={retry}>Retry</Button>
            <Button variant="outline" onClick={() => setOrigin(null)}>Edit local origin</Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className={`flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs ${
          status === 'connected' ? 'text-green-700' : 'text-muted-foreground'
        }`}
      >
        <span>{STATUS_LABEL[status]}</span>
        <span className="truncate font-mono">{validOrigin}</span>
      </div>
      <iframe
        key={iframeEpoch}
        ref={iframeRef}
        className="min-h-0 flex-1 border-0"
        src={validOrigin}
        title="DSH Web"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </div>
  )
}
