import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createServer, type ViteDevServer } from 'vite'
import { ViteBrokerHarness, type RecordedTarget } from './vite-harness.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'vite')
const VANILLA_MAIN = join(FIXTURES, 'vanilla', 'main.ts')
const VANILLA_MAIN_ORIGINAL = readFileSync(VANILLA_MAIN, 'utf8')

interface Fixture {
  harness: ViteBrokerHarness
  server: ViteDevServer
  url: string
}

async function startFixture(fixtureDir: string, env: Record<string, string> = {}): Promise<Fixture> {
  const harness = new ViteBrokerHarness()
  await harness.start()
  const saved = { ...process.env }
  Object.assign(process.env, {
    DSH_BRIDGE_ORIGIN: harness.origin,
    DSH_BRIDGE_PROJECT: 'fixture',
    ...env,
  })
  let server: ViteDevServer
  try {
    server = await createServer({
      configFile: join(FIXTURES, 'vite.config.ts'),
      root: join(FIXTURES, fixtureDir),
      logLevel: 'silent',
      // Fresh per-run dep cache: two servers and repeated runs must never
      // hit each other's stale optimize metadata.
      cacheDir: mkdtempSync(join(tmpdir(), 'dsh-bridge-vite-cache-')),
      server: { host: '127.0.0.1', port: 0, hmr: { overlay: false } },
    })
    await server.listen()
  } finally {
    process.env = saved
  }
  const address = server.httpServer!.address() as AddressInfo
  return { harness, server, url: `http://127.0.0.1:${address.port}/` }
}

async function stopFixture(fixture: Fixture): Promise<void> {
  fixture.harness.close()
  await fixture.server.close()
}

test.describe('vite provider browser flows', () => {
  test.afterEach(() => {
    // Restore the HMR fixture file if a test rewrote it.
    if (readFileSync(VANILLA_MAIN, 'utf8') !== VANILLA_MAIN_ORIGINAL) {
      writeFileSync(VANILLA_MAIN, VANILLA_MAIN_ORIGINAL)
    }
  })

  test('the injected runtime registers one target and observes the page', async ({ page }) => {
    const fixture = await startFixture('vanilla')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      expect(target.targetId).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
      expect(target.origin).toBe(new URL(fixture.url).origin)
      expect(target.projectId).toBe('fixture')
      expect(target.capabilities).toEqual(['observe', 'inspect', 'act', 'navigate', 'wait', 'console'])

      const result = await fixture.harness.call(target.targetId, 'observe', {}) as {
        nodes: Array<{ name: string; role: string }>
        page: { url: string }
        generation: number
      }
      expect(result.nodes.find(node => node.name === 'Save')?.role).toBe('button')
      expect(result.nodes.find(node => node.name === 'Counter')?.role).toBe('button')
      expect(JSON.stringify(result)).not.toContain('super-secret-token')
      expect(result.page.url).toContain('/')
      expect(result.generation).toBe(1)
      expect(fixture.harness.hasOnlyAllowedPageFrames()).toBe(true)
    } finally {
      await stopFixture(fixture)
    }
  })

  test('inspect reads attributes, text, geometry, and computed style', async ({ page }) => {
    const fixture = await startFixture('vanilla')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      const observed = await fixture.harness.call(target.targetId, 'observe', {}) as {
        nodes: Array<{ name: string; ref: string }>
      }
      const saveRef = observed.nodes.find(node => node.name === 'Save')!.ref
      const inspected = await fixture.harness.call(target.targetId, 'inspect', {
        ref: saveRef,
        properties: ['color'],
      }) as { tag: string; rect: { width: number }; text: string }
      expect(inspected.tag).toBe('button')
      expect(inspected.rect.width).toEqual(expect.any(Number))
      expect(inspected.text).toContain('Save')
    } finally {
      await stopFixture(fixture)
    }
  })

  test('act clicks, types, and reports synthetic hover', async ({ page }) => {
    const fixture = await startFixture('vanilla')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()

      await fixture.harness.call(target.targetId, 'act', { action: { kind: 'click', selector: '#save' } })
      expect(await page.locator('#status').textContent()).toBe('saved')

      await fixture.harness.call(target.targetId, 'act', { action: { kind: 'type', selector: '#name', text: 'alice' } })
      expect(await page.locator('#name').inputValue()).toBe('alice')

      await fixture.harness.call(target.targetId, 'act', { action: { kind: 'click', selector: '#counter' } })
      await fixture.harness.call(target.targetId, 'act', { action: { kind: 'click', selector: '#counter' } })
      expect(await page.locator('#clicks').textContent()).toBe('2')

      const hover = await fixture.harness.call(target.targetId, 'act', {
        action: { kind: 'hover', selector: '#save' },
      }) as { synthetic: boolean; cssPseudoState: boolean }
      expect(hover).toMatchObject({ synthetic: true, cssPseudoState: false })
    } finally {
      await stopFixture(fixture)
    }
  })

  test('wait resolves for selectors and stability', async ({ page }) => {
    const fixture = await startFixture('vanilla')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      const attached = await fixture.harness.call(target.targetId, 'wait', {
        condition: { kind: 'selector', selector: '#counter', state: 'attached' },
      })
      expect(attached).toMatchObject({ ok: true })
      const stable = await fixture.harness.call(target.targetId, 'wait', {
        condition: { kind: 'stable', quietMs: 100 },
      })
      expect(stable).toMatchObject({ ok: true })
    } finally {
      await stopFixture(fixture)
    }
  })

  test('console capture returns post-injection rows', async ({ page }) => {
    const fixture = await startFixture('vanilla')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      await page.evaluate(() => {
        console.log('e2e-marker-123')
      })
      await page.waitForTimeout(200)
      const rows = await fixture.harness.call(target.targetId, 'console', {}) as {
        rows: Array<{ level: string; text: string }>
      }
      expect(rows.rows.some(row => row.text.includes('e2e-marker-123'))).toBe(true)
    } finally {
      await stopFixture(fixture)
    }
  })

  test('React controlled input updates the rendered state', async ({ page }) => {
    const fixture = await startFixture('react')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      await fixture.harness.call(target.targetId, 'act', {
        action: { kind: 'type', selector: '#input', text: 'hello' },
      })
      expect(await page.locator('#input').inputValue()).toBe('hello')
      expect(await page.locator('#rendered').textContent()).toBe('hello')
    } finally {
      await stopFixture(fixture)
    }
  })

  test('Vue controlled input updates the rendered state', async ({ page }) => {
    const fixture = await startFixture('vue')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      await fixture.harness.call(target.targetId, 'act', {
        action: { kind: 'type', selector: '#input', text: 'hello' },
      })
      expect(await page.locator('#input').inputValue()).toBe('hello')
      expect(await page.locator('#rendered').textContent()).toBe('hello')
    } finally {
      await stopFixture(fixture)
    }
  })

  test('HMR invalidates old references and completes generation waits', async ({ page }) => {
    const fixture = await startFixture('vanilla')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      const observed = await fixture.harness.call(target.targetId, 'observe', {}) as {
        nodes: Array<{ name: string; ref: string }>
      }
      const oldRef = observed.nodes.find(node => node.name === 'Save')!.ref

      // Trigger a real HMR update: the fixture rewrites its own module.
      writeFileSync(VANILLA_MAIN, `${VANILLA_MAIN_ORIGINAL}\ndocument.querySelector('#status')!.textContent = 'hmr-v2'\n`)
      await fixture.harness.waitForFrame(
        target.targetId,
        frame => (frame.type === 'target.update' || frame.type === 'target.register')
          && (frame.target as { generation: number }).generation >= 2,
      )

      // The old reference died with its generation.
      await expect(fixture.harness.call(target.targetId, 'inspect', { ref: oldRef }))
        .rejects.toMatchObject({ code: 'stale_element' })

      // A generation wait completes after the update.
      const waited = await fixture.harness.call(target.targetId, 'wait', {
        condition: { kind: 'generation', after: 1 },
      }) as { ok: boolean; generation: number }
      expect(waited.ok).toBe(true)
      expect(waited.generation).toBeGreaterThanOrEqual(2)

      // Fresh observe reflects the new generation.
      const refreshed = await fixture.harness.call(target.targetId, 'observe', {}) as { generation: number }
      expect(refreshed.generation).toBeGreaterThanOrEqual(2)
    } finally {
      await stopFixture(fixture)
    }
  })

  test('screenshot and network return unsupported_operation', async ({ page }) => {
    const fixture = await startFixture('vanilla')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      await expect(fixture.harness.call(target.targetId, 'screenshot', {}))
        .rejects.toMatchObject({ code: 'unsupported_operation' })
      await expect(fixture.harness.call(target.targetId, 'network', {}))
        .rejects.toMatchObject({ code: 'unsupported_operation' })
    } finally {
      await stopFixture(fixture)
    }
  })

  test('panel.enabled=false keeps the headless bridge usable', async ({ page }) => {
    const fixture = await startFixture('vanilla', { DSH_BRIDGE_PANEL: 'false' })
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      const result = await fixture.harness.call(target.targetId, 'observe', {}) as { nodes: unknown[] }
      expect(result.nodes.length).toBeGreaterThan(0)
      expect(await page.evaluate(() => document.getElementById('dsh-browser-bridge-panel-host'))).toBeNull()
    } finally {
      await stopFixture(fixture)
    }
  })

  test('development auto-activation registers with the panel UI hidden', async ({ page }) => {
    const fixture = await startFixture('vanilla')
    try {
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      // Dev auto-activates and registers, but the default panel.visible=false
      // keeps the UI hidden: no host element, no launcher, no drawer. The
      // wait gives a hypothetical buggy auto-open time to manifest before
      // the "never appears" assertion.
      await page.waitForTimeout(500)
      expect(await page.evaluate(() => document.getElementById('dsh-browser-bridge-panel-host'))).toBeNull()
      const result = await fixture.harness.call(target.targetId, 'observe', {}) as { nodes: unknown[] }
      expect(result.nodes.length).toBeGreaterThan(0)
    } finally {
      await stopFixture(fixture)
    }
  })

  test('development with panel.visible=true shows the launcher entry after the probe but never the drawer', async ({ page }) => {
    const fixture = await startFixture('vanilla', { DSH_BRIDGE_PANEL_VISIBLE: 'true' })
    try {
      await page.goto(fixture.url)
      await fixture.harness.waitForAnyTarget()
      // The launcher entry appears (probe succeeded), the drawer stays closed.
      await expect(page.locator('#dsh-browser-bridge-panel-host')).toBeVisible({ timeout: 10_000 })
      const launcher = await page.evaluate(() =>
        document.getElementById('dsh-browser-bridge-panel-host')?.shadowRoot?.querySelector('.dsh-bb-launcher') !== null)
      expect(launcher).toBe(true)
      const drawer = await page.evaluate(() =>
        document.getElementById('dsh-browser-bridge-panel-host')?.shadowRoot?.querySelector('.dsh-bb-drawer') !== null)
      expect(drawer).toBe(false)
    } finally {
      await stopFixture(fixture)
    }
  })

  test('development with ?dsh=1 explicitly opens the panel drawer', async ({ page }) => {
    const fixture = await startFixture('vanilla')
    try {
      await page.goto(fixture.url + '?dsh=1')
      const target = await fixture.harness.waitForAnyTarget()
      // Explicit URL activation opens the drawer even though the default
      // panel.visible=false keeps automatic activation hidden.
      await expect(page.locator('#dsh-browser-bridge-panel-host')).toBeVisible({ timeout: 10_000 })
      const drawer = await page.evaluate(() =>
        document.getElementById('dsh-browser-bridge-panel-host')?.shadowRoot?.querySelector('.dsh-bb-drawer') !== null)
      expect(drawer).toBe(true)
      const result = await fixture.harness.call(target.targetId, 'observe', {}) as { nodes: unknown[] }
      expect(result.nodes.length).toBeGreaterThan(0)
    } finally {
      await stopFixture(fixture)
    }
  })

  test('multi-page targets route calls to their exact connections', async ({ browser }) => {
    const vanilla = await startFixture('vanilla')
    const react = await startFixture('react')
    try {
      const pageA = await browser.newPage()
      const pageB = await browser.newPage()
      await pageA.goto(vanilla.url)
      await pageB.goto(react.url)
      const targetA = await vanilla.harness.waitForAnyTarget()
      const targetB = await react.harness.waitForAnyTarget()
      expect(targetA.targetId).not.toBe(targetB.targetId)

      await vanilla.harness.call(targetA.targetId, 'observe', {})
      expect(react.harness.allFrames().some(entry =>
        entry.targetId === targetB.targetId && entry.frame.type === 'tool.call')).toBe(false)

      await react.harness.call(targetB.targetId, 'observe', {})
      // A page never sends host-shaped frames to ITS harness either.
      expect(vanilla.harness.allFrames().some(entry =>
        entry.targetId === targetA.targetId && entry.frame.type === 'tool.call')).toBe(false)
      await pageA.close()
      await pageB.close()
    } finally {
      await stopFixture(vanilla)
      await stopFixture(react)
    }
  })
})
