/**
 * The `browser-tabs` `@` source: lists eligible tabs from the extension,
 * allocates references on pick, and requests a fresh prompt grant at submit
 * time through the exact-origin iframe channel.
 */
import type {
  CandidateRequest,
  ClientSessionContext,
  PickOutcome,
  SlashCandidate,
  SlashPick,
  SlashSource,
} from '@deepseek-ai/dsh-client-ui-slash/src/types.ts'
import { encodeMarker, type TabDescriptor } from '@dsh-external/dsh-browser-bridge-protocol'
import type { ExtensionChannel } from './extension-channel.ts'
import { ReferenceStore } from './reference-store.ts'

interface HotCandidate {
  candidate: SlashCandidate
  tab: TabDescriptor
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function createTabSource(channel: ExtensionChannel, store: ReferenceStore): SlashSource {
  let hot = new Map<string, HotCandidate>()
  return {
    trigger: '@',
    name: 'browser-tabs',
    order: -20,
    candidates: async (session: ClientSessionContext, req: CandidateRequest): Promise<SlashCandidate[]> => {
      const tabs = await channel.request<TabDescriptor[]>('tabs.list', {}, req.signal)
      const seen = new Map<string, number>()
      const next: HotCandidate[] = []
      for (const tab of tabs) {
        const base = `${tab.title} — ${hostOf(tab.url)}`
        const count = seen.get(base) ?? 0
        seen.set(base, count + 1)
        // A numeric suffix disambiguates only when title AND host collide.
        const name = count === 0 ? base : `${base} (${count + 1})`
        next.push({ candidate: { name }, tab })
      }
      hot = new Map(next.map(entry => [entry.candidate.name!, entry]))
      return next.map(entry => entry.candidate)
    },
    onPick: (pick: SlashPick): PickOutcome => {
      const entry = hot.get(pick.candidate.name ?? '')
      if (entry === undefined) return undefined
      const record = store.allocate(pick.session.sessionId, entry.tab, entry.tab.title)
      return {
        insert: {
          source: 'browser-tabs',
          ref: record.ref,
          label: entry.tab.title,
          clipboardText: `@${entry.tab.title}`,
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
        if (record === undefined) throw new Error('browser-tabs: reference expired')
        const { handle } = await channel.request<{ handle: string }>(
          'grant.create',
          { sessionId: record.sessionId, tab: record.tab },
          signal,
        )
        return encodeMarker(handle)
      },
    },
  }
}
