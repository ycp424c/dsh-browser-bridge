/**
 * Headed Chromium with the unpacked extension: exercises the extension
 * boundary through a real DSH iframe fixture and the real versioned bridge
 * protocol — no `chrome.tabs` or `chrome.debugger` mocks.
 *
 * Run with the repo-local browser cache:
 *   PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers" pnpm exec playwright test e2e/extension.spec.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { PROTOCOL_VERSION } from '@dsh-external/dsh-browser-bridge-protocol'
import { BridgeHarness } from './bridge-harness.ts'
import { FixtureServer } from './fixture-server.ts'
import type { AttachedGrant } from './bridge-harness.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const EXTENSION_OUT = join(REPO_ROOT, 'extension/output/chrome-mv3')
/** `HEADED=1` forces a visible window; headless new mode also runs extensions. */
const HEADED = process.env.HEADED === '1'

function buildExtension(): void {
  // Always rebuild: the E2E must exercise the current sources.
  execFileSync('pnpm', ['--filter', '@dsh-external/dsh-browser-bridge-extension', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: true,
  })
}

/**
 * Extensions only load in a persistent (user-data-dir) Chromium context.
 * The full Chromium binary is required: the headless shell cannot load
 * extensions, while the new headless mode runs the full binary.
 */
async function launchExtensionContext(): Promise<BrowserContext> {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-e2e-'))
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: !HEADED,
    args: [
      `--disable-extensions-except=${EXTENSION_OUT}`,
      `--load-extension=${EXTENSION_OUT}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
}

async function extensionIdOf(context: BrowserContext): Promise<string> {
  const worker = await context.waitForEvent('serviceworker', { timeout: 30_000 })
  return new URL(worker.url()).host
}

async function waitForSidePanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`)
  return page
}

/**
 * Point the side panel at a DSH origin. The settings card only renders
 * after a failed save, so the deterministic path is to seed
 * `chrome.storage.local` and reload the panel (origin normalization itself
 * is covered by the settings unit tests).
 */
async function configureOrigin(page: Page, origin: string): Promise<void> {
  await page.evaluate(async saved => {
    await chrome.storage.local.set({ dshOrigin: saved })
  }, origin)
  await page.reload()
}

/** Wait until the DSH iframe fixture has paired and connected the bridge. */
async function waitForDshReady(sidepanel: Page, timeoutMs = 30_000): Promise<void> {
  const dshFrame = sidepanel.frameLocator('iframe[title="DSH Web"]')
  await expect(dshFrame.locator('body')).toContainText('DSH Fixture', { timeout: timeoutMs })
  await expect(dshFrame.locator('#bridge-state')).toContainText('ready', { timeout: timeoutMs })
}

/** Attach the current tab through the iframe RPC. */
async function attachCurrentTab(sidepanel: Page): Promise<{ tab: AttachedGrant['tab']; handle: string }> {
  const dshFrame = sidepanel.frameLocator('iframe[title="DSH Web"]')
  return dshFrame.locator('body').evaluate(async () => {
    const result = await window.__dshBridgeTest.attachCurrentTab()
    return { tab: result.tab, handle: result.handle }
  })
}

/**
 * Terminate the extension service worker WITHOUT clearing its in-memory
 * storage.session ledger: browser-level `ServiceWorker.stopWorker`. The
 * worker restarts on the next extension event and runs startup
 * reconciliation against the persisted ledger.
 */
async function stopExtensionServiceWorker(context: BrowserContext, page: Page): Promise<void> {
  const session = await context.newCDPSession(page)
  await session.send('ServiceWorker.enable')
  const versionId = await new Promise<string>((resolveVersion, reject) => {
    const timer = setTimeout(() => reject(new Error('no extension service worker version')), 10_000)
    session.on('ServiceWorker.workerVersionUpdated', (event: { versions?: Array<{ versionId: string; scriptURL: string }> }) => {
      const match = event.versions?.find(version => version.scriptURL.includes('background.js'))
      if (match === undefined) return
      clearTimeout(timer)
      resolveVersion(match.versionId)
    })
  })
  await session.send('ServiceWorker.stopWorker', { versionId })
  await session.send('ServiceWorker.disable')
}

test.describe('unpacked extension', () => {
  test('emits a Chrome-valid extension CSP', () => {
    buildExtension()
    const manifest = JSON.parse(readFileSync(join(EXTENSION_OUT, 'manifest.json'), 'utf8')) as {
      content_security_policy?: { extension_pages?: string }
    }
    const csp = manifest.content_security_policy?.extension_pages ?? ''
    expect(csp).not.toContain('http://[::1]:*')
    expect(csp).not.toContain('ws://[::1]:*')
  })

  test('runs the development feedback loop over CDP', async () => {
    test.setTimeout(180_000)
    buildExtension()

    // The DSH "web" fixture (pairing + bridge) and the target app fixture
    // live on separate loopback origins so the app tab stays attachable.
    const harness = new BridgeHarness()
    await harness.start()
    const dshServer = new FixtureServer('dsh', { bridgeBaseUrl: harness.baseUrl })
    await dshServer.start()
    const appServer = new FixtureServer('app')
    await appServer.start()

    const context = await launchExtensionContext()
    try {
      const extensionId = await extensionIdOf(context)
      const sidepanel = await waitForSidePanel(context, extensionId)
      await configureOrigin(sidepanel, dshServer.origin)
      await waitForDshReady(sidepanel)

      // The target tab: the deterministic fixture app, made active.
      const fixturePage = await context.newPage()
      await fixturePage.goto(`${appServer.origin}/`)
      await fixturePage.bringToFront()
      await expect(fixturePage.locator('#save')).toBeVisible()

      // Attach the current tab through the iframe RPC; the harness accepts
      // the grant offer concurrently, exactly like the real host plugin.
      const granted = harness.acceptNextGrant()
      const attached = await attachCurrentTab(sidepanel)
      const grant = await granted

      // Inspect the computed style of #save.
      const before = await harness.call(grant.grantId, 'inspect', {
        selector: '#save',
        properties: ['color', 'padding'],
      }) as { computedStyle: Record<string, string> }
      expect(before.computedStyle).toEqual({ color: 'rgb(0, 0, 255)', padding: '8px' })

      // The development loop: change the CSS, reload, and verify the SAME tab.
      appServer.setStyle({ color: 'rgb(255, 0, 0)', padding: '16px' })
      await fixturePage.reload()
      await fixturePage.bringToFront()
      await harness.call(grant.grantId, 'wait', { condition: { kind: 'ready', state: 'complete' } })
      const after = await harness.call(grant.grantId, 'inspect', {
        selector: '#save',
        properties: ['color', 'padding'],
      }) as { computedStyle: Record<string, string> }
      expect(after.computedStyle).toEqual({ color: 'rgb(255, 0, 0)', padding: '16px' })

      // Observe semantic refs.
      const observe = await harness.call(grant.grantId, 'observe', {}) as {
        page: { url: string; title: string }
        nodes: Array<{ ref: string; role: string; name: string }>
      }
      expect(observe.page.url).toContain(appServer.origin)
      expect(observe.page.title).toBe('Fixture')
      expect(observe.nodes).toContainEqual(expect.objectContaining({ role: 'button', name: 'Save' }))

      // Interact: click the mutation button and verify the status region.
      const mutateRef = observe.nodes.find(node => node.name === 'Mutate DOM')?.ref
      expect(mutateRef).toBeTruthy()
      await harness.call(grant.grantId, 'act', {
        action: { kind: 'click', ref: mutateRef },
      })
      const status = await fixturePage.locator('#status').textContent()
      expect(status).toContain('mutated')

      // Type (focus first, then replace) and select.
      await harness.call(grant.grantId, 'act', { action: { kind: 'focus', selector: '#name' } })
      await harness.call(grant.grantId, 'act', {
        action: { kind: 'type', selector: '#name', text: 'world', replace: true },
      })
      await expect(fixturePage.locator('#name')).toHaveValue('world')
      await harness.call(grant.grantId, 'act', {
        action: { kind: 'select', selector: '#choice', value: 'b' },
      })
      await expect(fixturePage.locator('#choice')).toHaveValue('b')

      // Screenshot: PNG bytes and exact URL.
      const shot = await harness.call(grant.grantId, 'screenshot', {}) as {
        mimeType: string
        data: string
        url: string
      }
      expect(shot.mimeType).toBe('image/png')
      expect(Buffer.from(shot.data, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47')
      expect(shot.url).toContain(appServer.origin)

      // Console error and failed network capture (event-driven, so poll).
      await fixturePage.locator('#log-error').click()
      await fixturePage.locator('#fetch-404').click()
      await harness.call(grant.grantId, 'wait', { condition: { kind: 'ready', state: 'complete' } })
      const consoleEvidence = await harness.call(grant.grantId, 'console', {}) as {
        entries: Array<{ level: string; text: string }>
      }
      expect(consoleEvidence.entries).toContainEqual(expect.objectContaining({ level: 'error', text: 'fixture failed' }))
      await expect.poll(async () => {
        const evidence = await harness.call(grant.grantId, 'network', {}) as {
          entries: Array<{ url: string; status: number }>
        }
        return evidence.entries.filter(entry => entry.url.includes('/missing') && entry.status === 404).length
      }, { timeout: 20_000 }).toBeGreaterThan(0)

      // Active-tab switching does not retarget the grant.
      const otherPage = await context.newPage()
      await otherPage.goto(`${appServer.origin}/other`)
      await otherPage.bringToFront()
      const still = await harness.call(grant.grantId, 'inspect', {
        selector: '#save',
        properties: ['color'],
      }) as { computedStyle: Record<string, string> }
      expect(still.computedStyle.color).toBe('rgb(255, 0, 0)')

      // Unexpected cross-origin navigation suspends writes; reads remain.
      // A bridge-dispatched click arms an expected-navigation window (5s),
      // so the unmarked transition must be user-driven AND outside any armed
      // window: wait out the last click's deadline first.
      await sidepanel.waitForTimeout(6_000)
      await fixturePage.bringToFront()
      await fixturePage.locator('#cross-origin').click()
      await fixturePage.waitForURL('**/other')
      await harness.call(grant.grantId, 'wait', { condition: { kind: 'ready', state: 'complete' } })
      await expect(harness.call(grant.grantId, 'act', {
        action: { kind: 'click', selector: 'h1' },
      })).rejects.toThrow(/navigation_requires_confirmation/)
      const read = await harness.call(grant.grantId, 'observe', {}) as { page: { url: string } }
      expect(read.page.url).toContain('/other')

      // Ending the grant detaches the debugger: a fresh call must fail.
      await harness.send({
        v: PROTOCOL_VERSION,
        type: 'grant.revoke',
        grantId: grant.grantId as never,
      })
      await expect(harness.call(grant.grantId, 'observe', {})).rejects.toThrow(/grant_expired/)
    } finally {
      await context.close()
      await harness.stop()
      await dshServer.stop()
      await appServer.stop()
    }
  })

  test('startup reconciliation clears the ownership ledger before new work', async () => {
    test.setTimeout(180_000)
    buildExtension()

    const harness = new BridgeHarness()
    await harness.start()
    const dshServer = new FixtureServer('dsh', { bridgeBaseUrl: harness.baseUrl })
    await dshServer.start()
    const appServer = new FixtureServer('app')
    await appServer.start()

    const context = await launchExtensionContext()
    try {
      const extensionId = await extensionIdOf(context)
      const sidepanel = await waitForSidePanel(context, extensionId)
      await configureOrigin(sidepanel, dshServer.origin)
      await waitForDshReady(sidepanel)

      // Attach one grant and use it so the debugger is attached and the
      // ownership ledger is non-empty.
      const fixturePage = await context.newPage()
      await fixturePage.goto(`${appServer.origin}/`)
      await fixturePage.bringToFront()
      const granted = harness.acceptNextGrant()
      const attached = await attachCurrentTab(sidepanel)
      const grant = await granted
      await harness.call(grant.grantId, 'observe', {})
      const ledger = await sidepanel.evaluate(async () => chrome.storage.session.get('dshBrowserBridge.owned'))
      expect(ledger['dshBrowserBridge.owned']).toBeTruthy()

      // Kill the service worker WITHOUT clearing storage.session. A stopped
      // worker stays dead until an extension event wakes it; reloading the
      // panel reconnects the runtime port, the worker restarts, and startup
      // reconciliation must clear the ledger before accepting new work.
      await stopExtensionServiceWorker(context, sidepanel)
      await sidepanel.reload()
      await expect.poll(async () => {
        const value = await sidepanel.evaluate(async () => chrome.storage.session.get('dshBrowserBridge.owned'))
        return value['dshBrowserBridge.owned'] ?? null
      }, { timeout: 30_000 }).toBeNull()

      // The DSH fixture re-pairs with a fresh nonce and the bridge reconnects.
      await waitForDshReady(sidepanel)

      // The old grant died with the old worker: no leftover ownership.
      await expect(harness.call(grant.grantId, 'observe', {})).rejects.toThrow(/grant_expired/)

      // A fresh grant on the SAME tab works: the startup reconciliation
      // detached the owned session instead of leaving it busy.
      const granted2 = harness.acceptNextGrant()
      const again = await attachCurrentTab(sidepanel)
      const grant2 = await granted2
      const result = await harness.call(grant2.grantId, 'observe', {}) as { page: { url: string } }
      expect(result.page.url).toContain(appServer.origin)
    } finally {
      await context.close()
      await harness.stop()
      await dshServer.stop()
      await appServer.stop()
    }
  })
})

declare global {
  interface Window {
    __dshBridgeTest: {
      request<T>(type: string, payload?: Record<string, unknown>): Promise<T>
      attachCurrentTab(): Promise<{ tab: { tabId: number; windowId: number; title: string; url: string }; handle: string }>
    }
  }
}
