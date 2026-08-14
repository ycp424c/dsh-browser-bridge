import { describe, expect, it } from 'vitest'
import type { TabDescriptor } from '@ycp424c/dsh-browser-bridge-protocol'
import { TabCatalog, type TabsApi } from '../src/tabs/catalog.ts'

class FakeTabs implements TabsApi {
  tabs: Array<Partial<chrome.tabs.Tab> & { id: number; url?: string }> = []

  async query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
    return this.tabs
      .filter(tab => {
        if (queryInfo.active !== undefined && tab.active !== queryInfo.active) return false
        if (queryInfo.windowId !== undefined && tab.windowId !== queryInfo.windowId) return false
        return true
      })
      .map(tab => ({ ...tab, active: tab.active ?? false, windowId: tab.windowId ?? 1, index: tab.index ?? 0 })) as chrome.tabs.Tab[]
  }
}

const DSH_ORIGIN = 'http://127.0.0.1:3080'

function fixtureTabs(): Array<Partial<chrome.tabs.Tab> & { id: number; url?: string }> {
  return [
    { id: 9, windowId: 3, index: 0, active: true, title: 'App', url: 'http://127.0.0.1:4173/', favIconUrl: 'icon.png' },
    { id: 10, windowId: 3, index: 1, active: false, title: 'Settings', url: 'chrome://settings/' },
    { id: 11, windowId: 2, index: 0, active: true, title: 'DSH', url: 'http://127.0.0.1:3080/chat' },
    { id: 12, windowId: 3, index: 2, active: false, title: 'Docs', url: 'https://example.com/docs' },
    { id: 13, windowId: 1, index: 0, active: false, title: 'Bridge', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html' },
  ]
}

describe('tab catalog', () => {
  it('resolves the current tab of the last focused window', async () => {
    const tabs = new FakeTabs()
    tabs.tabs = fixtureTabs()
    const catalog = new TabCatalog(tabs, [DSH_ORIGIN])
    const current = await catalog.current()
    expect(current).toEqual({ tabId: 9, windowId: 3, title: 'App', url: 'http://127.0.0.1:4173/', favIconUrl: 'icon.png' })
  })

  it('lists only HTTP(S) tabs, excluding the DSH origin and extension pages', async () => {
    const tabs = new FakeTabs()
    tabs.tabs = fixtureTabs()
    const catalog = new TabCatalog(tabs, [DSH_ORIGIN])
    const list = await catalog.list()
    expect(list).not.toContainEqual(expect.objectContaining({ url: 'chrome://settings/' }))
    expect(list).not.toContainEqual(expect.objectContaining({ url: 'http://127.0.0.1:3080/chat' }))
    expect(list).not.toContainEqual(expect.objectContaining({ url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html' }))
    expect(list).toContainEqual(expect.objectContaining({ tabId: 9 }))
    expect(list).toContainEqual(expect.objectContaining({ tabId: 12 }))
  })

  it('sorts active tabs first, then by window and index', async () => {
    const tabs = new FakeTabs()
    tabs.tabs = [
      { id: 20, windowId: 3, index: 3, active: false, title: 'A', url: 'https://a.test/' },
      { id: 21, windowId: 2, index: 1, active: true, title: 'B', url: 'https://b.test/' },
      { id: 22, windowId: 3, index: 1, active: false, title: 'C', url: 'https://c.test/' },
      { id: 23, windowId: 2, index: 0, active: true, title: 'D', url: 'https://d.test/' },
    ]
    const catalog = new TabCatalog(tabs, [])
    const list = await catalog.list()
    expect(list.map(item => item.tabId)).toEqual([23, 21, 22, 20])
  })

  it('re-reads a tab by exact id for grant validation', async () => {
    const tabs = new FakeTabs()
    tabs.tabs = fixtureTabs()
    const catalog = new TabCatalog(tabs, [DSH_ORIGIN])
    expect(await catalog.byId(9)).toEqual(expect.objectContaining({ tabId: 9 }))
    expect(await catalog.byId(999)).toBeUndefined()
  })

  it('returns copied descriptors that do not change with the live tab', async () => {
    const tabs = new FakeTabs()
    tabs.tabs = fixtureTabs()
    const catalog = new TabCatalog(tabs, [DSH_ORIGIN])
    const first = await catalog.current()
    tabs.tabs[0]!.url = 'http://other.example/'
    const second = await catalog.current()
    expect(second.url).toBe('http://other.example/')
    expect(first.url).toBe('http://127.0.0.1:4173/')
  })
})
