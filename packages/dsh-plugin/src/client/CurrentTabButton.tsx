import { useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/contract.ts'
import type { ReferenceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/src/types.ts'
import type { TabDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'
import type { ExtensionChannel } from './extension-channel.ts'
import { ReferenceStore } from './reference-store.ts'
import cssText from './current-tab-button.css'

// Inject the button styles once; the DSH module loader owns plugin styles.
if (typeof document !== 'undefined' && document.head !== null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-browser-bridge'
  tag.textContent = cssText
  document.head.appendChild(tag)
}

/** Injected by the slot registration; stable per session scope. */
export interface CurrentTabButtonInjected {
  actx: ClientContext
  channel: ExtensionChannel
  store: ReferenceStore<TabDescriptor>
}

export interface CurrentTabButtonProps extends CurrentTabButtonInjected {
  session: ConversationSnapshot
  input: InputState
}

/** One-click current-tab attachment for the DSH composer. */
export function CurrentTabButton({ session, input, actx, channel, store }: CurrentTabButtonProps): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const frozen = input.phase !== 'plain'

  const attach = async (): Promise<void> => {
    if (frozen || pending) return
    setPending(true)
    setError(null)
    try {
      const tab = await channel.request<{
        tabId: number
        windowId: number
        title: string
        url: string
        favIconUrl?: string
      }>('tabs.current', {})
      const record = store.allocate(String(session.sessionId), tab, tab.title)
      const reference: ReferenceInsert = {
        source: 'browser-tabs',
        ref: record.ref,
        label: tab.title,
        clipboardText: `@${tab.title}`,
      }
      const applied = actx.bail('slash/input-insert-reference', {
        reference,
        span: {
          start: input.draft.length,
          end: input.draft.length,
          draftRev: input.draftRev,
        },
      })
      if (applied !== true) {
        throw new Error('current tab could not be attached because the composer changed')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'current tab could not be attached')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="dsh-bb-current-tab-row">
      <button
        type="button"
        className="dsh-bb-current-tab"
        title="Attach current tab"
        disabled={frozen || pending}
        onClick={() => { void attach() }}
      >
        @当前标签页
        {error !== null && <span className="dsh-bb-current-tab-error">{error}</span>}
      </button>
    </div>
  )
}
