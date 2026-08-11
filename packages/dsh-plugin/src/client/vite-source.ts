/**
 * The `vite-pages` `@` source: lists connected Vite pages from the local
 * host, allocates references on pick, and requests a fresh prompt grant at
 * submit time through the same-origin Vite API. Mirrors `browser-tabs` but
 * shows the host and project id instead of tab identity.
 */
import type {
  CandidateRequest,
  ClientSessionContext,
  PickOutcome,
  SlashCandidate,
  SlashPick,
  SlashSource,
} from '@deepseek-ai/dsh-client-ui-slash/src/types.ts'
import { encodeMarker, type BrowserTargetDescriptor } from '@dsh-external/dsh-browser-bridge-protocol'
import type { ViteTargetApi } from './vite-api.ts'
import { ReferenceStore } from './reference-store.ts'

interface HotCandidate {
  candidate: SlashCandidate
  target: BrowserTargetDescriptor
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function createViteSource(api: ViteTargetApi, store: ReferenceStore<BrowserTargetDescriptor>): SlashSource {
  let hot = new Map<string, HotCandidate>()
  return {
    trigger: '@',
    name: 'vite-pages',
    order: -19,
    candidates: async (session: ClientSessionContext, req: CandidateRequest): Promise<SlashCandidate[]> => {
      const targets = await api.listTargets(req.signal)
      const seen = new Map<string, number>()
      const next: HotCandidate[] = []
      for (const target of targets) {
        const project = target.projectId === undefined ? '' : ` (${target.projectId})`
        const base = `${target.title} — ${hostOf(target.url)}${project}`
        const count = seen.get(base) ?? 0
        seen.set(base, count + 1)
        // A numeric suffix disambiguates only when the full label collides.
        const name = count === 0 ? base : `${base} (${count + 1})`
        next.push({ candidate: { name }, target })
      }
      hot = new Map(next.map(entry => [entry.candidate.name!, entry]))
      return next.map(entry => entry.candidate)
    },
    onPick: (pick: SlashPick): PickOutcome => {
      const entry = hot.get(pick.candidate.name ?? '')
      if (entry === undefined) return undefined
      const record = store.allocate(pick.session.sessionId, entry.target, entry.target.title)
      return {
        insert: {
          source: 'vite-pages',
          ref: record.ref,
          label: entry.target.title,
          clipboardText: `@${entry.target.title}`,
        },
      }
    },
    codec: {
      clipboardText: (ref: string): string => {
        const record = store.get(ref)
        return record === undefined ? ref : `@${record.label}`
      },
      serialize: async (ref: string, signal: AbortSignal): Promise<string> => {
        const record = store.get(ref)
        if (record === undefined) throw new Error('vite-pages: reference expired')
        const { handle } = await api.issueGrant(record.sessionId, record.target.targetId, signal)
        return encodeMarker(handle)
      },
    },
  }
}
