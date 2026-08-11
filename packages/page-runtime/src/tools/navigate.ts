/**
 * Same-origin navigation for the Vite MVP. Accepts exactly one of
 * url/history/reload; URL navigation is verified same-origin BEFORE any
 * navigation happens — a cross-origin departure is rejected with
 * navigation_requires_confirmation and never performed.
 */
import { bridgeFailure } from './dispatcher.ts'

export interface NavigateArgs {
  url?: string
  history?: 'back' | 'forward'
  reload?: boolean
}

export interface NavigateContext {
  args: NavigateArgs
  win?: Window
}

export function navigatePage(ctx: NavigateContext): Record<string, unknown> {
  const win = ctx.win ?? window
  const { url, history, reload } = ctx.args
  const modes = [url !== undefined, history !== undefined, reload === true].filter(Boolean).length
  if (modes !== 1) {
    bridgeFailure('internal', 'navigate requires exactly one of url, history, or reload')
  }
  if (url !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(url, win.location.href)
    } catch {
      bridgeFailure('internal', 'navigate url is not valid')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      bridgeFailure('internal', 'navigate url must be HTTP(S)')
    }
    if (parsed.origin !== win.location.origin) {
      bridgeFailure(
        'navigation_requires_confirmation',
        `navigation to ${parsed.origin} would leave the current origin; attach the new page explicitly`,
      )
    }
    win.location.assign(parsed.href)
    return { url: parsed.href }
  }
  if (history !== undefined) {
    if (history === 'back') win.history.back()
    else win.history.forward()
    return { history }
  }
  win.location.reload()
  return { reload: true }
}
