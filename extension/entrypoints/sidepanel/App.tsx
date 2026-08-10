import { useEffect, useRef, useState } from 'react'
import {
  DSH_ORIGIN_STORAGE_KEY,
  loadDshOrigin,
  normalizeDshOrigin,
  saveDshOrigin,
  type SettingsStorage,
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

function chromeSettingsStorage(): SettingsStorage {
  return {
    get: async (key: string) => (await chrome.storage.local.get(key))[key] as string | undefined,
    set: async (key: string, value: string) => {
      await chrome.storage.local.set({ [key]: value })
    },
  }
}

export default function App() {
  const [origin, setOrigin] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<BridgeClientState>('idle')
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const portRef = useRef<chrome.runtime.Port | null>(null)

  useEffect(() => {
    void loadDshOrigin(chromeSettingsStorage()).then(loaded => {
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
    portRef.current?.postMessage({ type: 'panel.forward', payload: event.data })
  }

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
      const normalized = await saveDshOrigin(chromeSettingsStorage(), draft)
      setOrigin(normalized)
    } catch {
      setOrigin(null)
    }
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
        ref={iframeRef}
        className="min-h-0 flex-1 border-0"
        src={validOrigin}
        title="DSH Web"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </div>
  )
}
