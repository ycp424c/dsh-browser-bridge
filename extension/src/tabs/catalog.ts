/**
 * Eligible-tab resolution: exact send-time snapshots of current/attachable
 * Chrome tabs. Only HTTP(S) tabs are eligible; the configured DSH origin and
 * extension pages are excluded. Descriptors are copies — never live tab
 * objects — so a grant stays bound to what the user actually attached.
 */
import type { TabDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'

export interface TabsApi {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>
}

export function toDescriptor(tab: chrome.tabs.Tab): TabDescriptor | undefined {
  if (tab.id === undefined || tab.windowId === undefined) return undefined
  const url = tab.url ?? tab.pendingUrl
  if (url === undefined) return undefined
  const descriptor: TabDescriptor = {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url,
    ...(tab.favIconUrl !== undefined ? { favIconUrl: tab.favIconUrl } : {}),
  }
  return descriptor
}

function isEligible(url: string, excludedOrigins: ReadonlySet<string>): boolean {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false
  try {
    return !excludedOrigins.has(new URL(url).origin)
  } catch {
    return false
  }
}

export class TabCatalog {
  private readonly tabs: TabsApi
  private excludedOrigins: ReadonlySet<string>

  constructor(tabs: TabsApi, excludedOrigins: readonly string[]) {
    this.tabs = tabs
    this.excludedOrigins = new Set(excludedOrigins)
  }

  /** Replace the excluded origins (the configured DSH origin may change). */
  setExcludedOrigins(origins: readonly string[]): void {
    this.excludedOrigins = new Set(origins)
  }

  /** The active tab of the last focused window (must be eligible). */
  async current(): Promise<TabDescriptor> {
    const [tab] = await this.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab === undefined) throw new Error('tab catalog: no active tab')
    const descriptor = toDescriptor(tab)
    if (descriptor === undefined || !isEligible(descriptor.url, this.excludedOrigins)) {
      throw new Error('tab catalog: active tab is not eligible')
    }
    return descriptor
  }

  /** Every eligible tab, active-first then by window/index. */
  async list(): Promise<TabDescriptor[]> {
    const tabs = await this.tabs.query({})
    const sorted = [...tabs].sort((a, b) => {
      const activeDelta = (b.active === true ? 1 : 0) - (a.active === true ? 1 : 0)
      if (activeDelta !== 0) return activeDelta
      const windowDelta = (a.windowId ?? 0) - (b.windowId ?? 0)
      if (windowDelta !== 0) return windowDelta
      return (a.index ?? 0) - (b.index ?? 0)
    })
    const descriptors: TabDescriptor[] = []
    for (const tab of sorted) {
      const descriptor = toDescriptor(tab)
      if (descriptor === undefined) continue
      if (!isEligible(descriptor.url, this.excludedOrigins)) continue
      descriptors.push(descriptor)
    }
    return descriptors
  }

  /** Re-read one exact tab by id for grant validation; undefined when closed. */
  async byId(tabId: number): Promise<TabDescriptor | undefined> {
    const tabs = await this.tabs.query({})
    const tab = tabs.find(candidate => candidate.id === tabId)
    return tab === undefined ? undefined : toDescriptor(tab)
  }
}
