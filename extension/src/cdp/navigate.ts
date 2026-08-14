/**
 * `browser_navigate`: open an absolute HTTP(S) URL, go back or forward, or
 * reload. Every navigation arms an expected-navigation window so the
 * resulting main-frame transition is authorized and its URL recorded.
 */
import { bridgeError } from '@ycp424c/dsh-browser-bridge-protocol'
import type { TabSession } from './session-manager.ts'

export interface NavigateResult {
  ok: true
  url: string
  generation: number
}

export interface NavigateArgs {
  url?: string
  history?: 'back' | 'forward'
  reload?: boolean
}

function assertWritable(session: TabSession): void {
  if (session.writeSuspended) {
    throw bridgeError(
      'navigation_requires_confirmation',
      'the page navigated to an unexpected origin; attach the new page explicitly in a new prompt',
      false,
    )
  }
}

function validateHttpUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw bridgeError('permission_denied', `navigation requires an absolute HTTP(S) URL, got ${input}`, false)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw bridgeError('permission_denied', `navigation requires an absolute HTTP(S) URL, got ${input}`, false)
  }
  return url.href
}

export async function navigatePage(session: TabSession, args: NavigateArgs): Promise<NavigateResult> {
  assertWritable(session)
  if (args.url !== undefined) {
    const target = validateHttpUrl(args.url)
    session.expectNavigation(5_000, new URL(target).origin)
    await session.send('Page.navigate', { url: target })
    return { ok: true, url: target, generation: session.generation }
  }
  if (args.history !== undefined) {
    const history = await session.send('Page.getNavigationHistory', {})
    const entries = (history as { entries?: Array<{ id: number; url: string }> }).entries ?? []
    const currentIndex = (history as { currentIndex?: number }).currentIndex ?? 0
    const targetIndex = args.history === 'back' ? currentIndex - 1 : currentIndex + 1
    const entry = entries[targetIndex]
    if (entry === undefined) {
      throw bridgeError('internal', `no ${args.history} history entry`, false)
    }
    session.expectNavigation(5_000)
    await session.send('Page.navigateToHistoryEntry', { entryId: entry.id })
    return { ok: true, url: entry.url, generation: session.generation }
  }
  if (args.reload === true) {
    session.expectNavigation(5_000)
    await session.send('Page.reload', { ignoreCache: false })
    return { ok: true, url: session.currentUrl, generation: session.generation }
  }
  throw bridgeError('permission_denied', 'navigation requires url, history, or reload', false)
}
