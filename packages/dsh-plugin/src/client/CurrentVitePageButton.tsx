import { useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/contract.ts'
import type { ReferenceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/src/types.ts'
import type { BrowserTargetDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'
import type { ViteTargetApi } from './vite-api.ts'
import type { VerifiedViteTarget } from './vite-parent-channel.ts'
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
export interface CurrentVitePageButtonInjected {
  actx: ClientContext
  api: ViteTargetApi
  store: ReferenceStore<BrowserTargetDescriptor>
  /** The host-verified current-page identity of this embedded DSH Web. */
  verified: VerifiedViteTarget
}

export interface CurrentVitePageButtonProps extends CurrentVitePageButtonInjected {
  session: ConversationSnapshot
  input: InputState
}

/** One-click current-page attachment for DSH Web embedded in a Vite page. */
export function CurrentVitePageButton({ session, input, actx, api, store, verified }: CurrentVitePageButtonProps): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const frozen = input.phase !== 'plain'

  const attach = async (): Promise<void> => {
    if (frozen || pending) return
    setPending(true)
    setError(null)
    try {
      // The host is authoritative: re-read the live target list and match
      // the verified targetId plus exact origin.
      const targets = await api.listTargets()
      const current = targets.find(target =>
        target.targetId === verified.targetId && target.origin === verified.origin)
      if (current === undefined) {
        throw new Error('current page is no longer registered')
      }
      const record = store.allocate(String(session.sessionId), current, current.title)
      const reference: ReferenceInsert = {
        source: 'vite-pages',
        ref: record.ref,
        label: current.title,
        clipboardText: `@${current.title}`,
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
        throw new Error('current page could not be attached because the composer changed')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'current page could not be attached')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="dsh-bb-current-tab-row">
      <button
        type="button"
        className="dsh-bb-current-tab dsh-bb-current-vite-page"
        title="Attach current dev page"
        disabled={frozen || pending}
        onClick={() => { void attach() }}
      >
        @当前开发页
        {error !== null && <span className="dsh-bb-current-tab-error">{error}</span>}
      </button>
    </div>
  )
}
