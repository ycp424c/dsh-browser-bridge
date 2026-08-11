/**
 * Same-origin Vite target API of DSH Web: lists connected Vite pages from
 * the local host and issues one prompt-scoped grant per target. Requests go
 * to the exact local DSH origin without credentials; only the non-secret
 * handle ever crosses back into the client.
 */
import type { BrowserTargetDescriptor, TargetId } from '@dsh-external/dsh-browser-bridge-protocol'

export interface ViteTargetApi {
  listTargets(signal?: AbortSignal): Promise<BrowserTargetDescriptor[]>
  issueGrant(sessionId: string, targetId: TargetId, signal?: AbortSignal): Promise<{ handle: string }>
}

export function createViteTargetApi(dshOrigin: string): ViteTargetApi {
  const listTargets = async (signal?: AbortSignal): Promise<BrowserTargetDescriptor[]> => {
    const response = await fetch(`${dshOrigin}/dsh-browser-bridge/vite/targets`, {
      credentials: 'omit',
      signal,
    })
    if (!response.ok) {
      throw new Error(`dsh-browser-bridge: vite targets failed (${response.status})`)
    }
    return (await response.json()) as BrowserTargetDescriptor[]
  }

  const issueGrant = async (
    sessionId: string,
    targetId: TargetId,
    signal?: AbortSignal,
  ): Promise<{ handle: string }> => {
    const response = await fetch(`${dshOrigin}/dsh-browser-bridge/vite/grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ sessionId, targetId }),
      signal,
    })
    if (!response.ok) {
      throw new Error(`dsh-browser-bridge: vite grant failed (${response.status})`)
    }
    return (await response.json()) as { handle: string }
  }

  return { listTargets, issueGrant }
}
