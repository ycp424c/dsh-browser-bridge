import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { dshBrowserBridge } from '@dsh-external/dsh-browser-bridge-vite'
import { ViteBrokerHarness } from './vite-harness.ts'
import { StaticServer } from './fixture-server.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'vite', 'vanilla')

interface BuildFixture {
  harness: ViteBrokerHarness
  server: StaticServer
  url: string
  cleanup(): void
}

async function startHttpsFixture(
  options: {
    dshOrigin?: string
    autoConnect?: boolean
    visible?: boolean
    panelEnabled?: boolean
    redirectHealth?: boolean
    csp?: Record<string, string>
    query?: string
  } = {},
): Promise<BuildFixture> {
  const harness = new ViteBrokerHarness({ redirectHealth: options.redirectHealth ?? false })
  await harness.start()
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-secure-'))
  const certDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-cert-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'),
    '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' })
  await build({
    configFile: false,
    root: FIXTURES,
    logLevel: 'silent',
    plugins: [buildPlugin({ dshOrigin: harness.origin, ...options })],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { input: join(FIXTURES, 'index.html') },
    },
  })
  const server = new StaticServer({
    root: outDir,
    tls: {
      key: readFileSync(join(certDir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(certDir, 'cert.pem'), 'utf8'),
    },
    headers: options.csp,
  })
  await server.start()
  return {
    harness,
    server,
    url: `${server.origin}/${options.query ?? ''}`,
    cleanup: () => {
      harness.close()
      server.close()
      rmSync(outDir, { recursive: true, force: true })
      rmSync(certDir, { recursive: true, force: true })
    },
  }
}

function buildPlugin(options: {
  dshOrigin?: string
  autoConnect?: boolean
  visible?: boolean
  panelEnabled?: boolean
}): ReturnType<typeof dshBrowserBridge> {
  const dshOrigin = options.dshOrigin ?? 'http://127.0.0.1:3080'
  return dshBrowserBridge({
    dshOrigin,
    bridge: {
      enabled: true,
      injectInBuild: true,
      autoConnectInBuild: options.autoConnect ?? false,
    },
    panel: {
      enabled: options.panelEnabled ?? true,
      visible: options.visible ?? false,
      shortcut: 'Alt+Shift+D',
      queryParameter: 'dsh',
    },
    projectId: 'secure-fixture',
  })
}

test.describe('vite provider production and security', () => {
  test('an HTTPS production page reaches the loopback HTTP/WS DSH', async ({ browser }) => {
    const fixture = await startHttpsFixture({ autoConnect: true, panelEnabled: false })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      const result = await fixture.harness.call(target.targetId, 'observe', {}) as { nodes: unknown[] }
      expect(result.nodes.length).toBeGreaterThan(0)
      await context.close()
    } finally {
      fixture.cleanup()
    }
  })

  test('production default dormancy sends no loopback request', async ({ browser }) => {
    const fixture = await startHttpsFixture()
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      await page.goto(fixture.url)
      await page.waitForTimeout(3_000)
      expect(fixture.harness.healthRequestCount()).toBe(0)
      expect(fixture.harness.targets()).toHaveLength(0)
      await context.close()
    } finally {
      fixture.cleanup()
    }
  })

  test('visible=true probes health, shows the launcher, and never registers before activation', async ({ browser }) => {
    const fixture = await startHttpsFixture({ visible: true })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      await page.goto(fixture.url)
      await page.waitForTimeout(2_000)
      expect(fixture.harness.healthRequestCount()).toBeGreaterThanOrEqual(1)
      expect(fixture.harness.targets()).toHaveLength(0)
      // The launcher appears only after the probe succeeded.
      const launcher = await page.evaluate(() => {
        const host = document.getElementById('dsh-browser-bridge-panel-host')
        return host?.shadowRoot?.querySelector('.dsh-bb-launcher') !== null
      })
      expect(launcher).toBe(true)
      await context.close()
    } finally {
      fixture.cleanup()
    }
  })

  test('frame-src blocking surfaces embedding_blocked and keeps the target alive', async ({ browser }) => {
    const fixture = await startHttpsFixture({
      visible: false,
      csp: {
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; frame-src 'none'; style-src 'self' 'unsafe-inline'",
      },
      query: '?dsh=1',
    })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      await page.goto(fixture.url)
      // The target connected BEFORE the panel failure.
      const target = await fixture.harness.waitForAnyTarget()
      // The panel shows the embedding failure and the exact-origin fallback.
      await expect(page.locator('#dsh-browser-bridge-panel-host')).toBeVisible({ timeout: 15_000 })
      await page.waitForFunction(() => {
        const host = document.getElementById('dsh-browser-bridge-panel-host')
        const fallback = host?.shadowRoot?.querySelector('a.dsh-bb-fallback') as HTMLAnchorElement | null
        return fallback !== null && !fallback.hasAttribute('hidden')
      }, undefined, { timeout: 15_000 })
      const fallbackHref = await page.evaluate(() => {
        const host = document.getElementById('dsh-browser-bridge-panel-host')
        const fallback = host?.shadowRoot?.querySelector('a.dsh-bb-fallback') as HTMLAnchorElement | null
        return fallback?.href ?? ''
      })
      expect(fallbackHref).toBe(fixture.harness.origin + '/')
      // The target connection survived the embedding failure.
      const result = await fixture.harness.call(target.targetId, 'observe', {}) as { nodes: unknown[] }
      expect(result.nodes.length).toBeGreaterThan(0)
      await context.close()
    } finally {
      fixture.cleanup()
    }
  })

  test('connect-src blocking surfaces the local-access diagnostic', async ({ browser }) => {
    const fixture = await startHttpsFixture({
      visible: false,
      csp: {
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'none'; style-src 'self' 'unsafe-inline'",
      },
      query: '?dsh=1',
    })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      await page.goto(fixture.url)
      // The panel opens with the failure diagnostic and the fallback.
      await expect(page.locator('#dsh-browser-bridge-panel-host')).toBeVisible({ timeout: 15_000 })
      await page.waitForFunction(() => {
        const host = document.getElementById('dsh-browser-bridge-panel-host')
        const banner = host?.shadowRoot?.querySelector('.dsh-bb-connection') as HTMLElement | null
        return banner !== null && banner.dataset.state === 'failed'
      }, undefined, { timeout: 15_000 })
      // The browser blocked the loopback request before it reached the host.
      expect(fixture.harness.healthRequestCount()).toBe(0)
      expect(fixture.harness.targets()).toHaveLength(0)
      await context.close()
    } finally {
      fixture.cleanup()
    }
  })

  test('a non-loopback dshOrigin is rejected before any connection', async () => {
    const harness = new ViteBrokerHarness()
    await harness.start()
    try {
      // The plugin config rejects the origin at build time, so no page can
      // ever be injected with a remote DSH target.
      expect(() => buildPlugin({ dshOrigin: 'https://evil.example' })).toThrow(/loopback-only/)
      expect(harness.healthRequestCount()).toBe(0)
      expect(harness.targets()).toHaveLength(0)
    } finally {
      harness.close()
    }
  })

  test('a redirecting health endpoint fails the probe without connecting', async ({ browser }) => {
    const fixture = await startHttpsFixture({ redirectHealth: true, query: '?dsh=1' })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      await page.goto(fixture.url)
      await page.waitForTimeout(2_000)
      expect(fixture.harness.healthRequestCount()).toBeGreaterThanOrEqual(1)
      expect(fixture.harness.targets()).toHaveLength(0)
      await context.close()
    } finally {
      fixture.cleanup()
    }
  })

  test('target frames never send grant or host commands', async ({ browser }) => {
    const fixture = await startHttpsFixture({ autoConnect: true, panelEnabled: false })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      await page.goto(fixture.url)
      const target = await fixture.harness.waitForAnyTarget()
      await fixture.harness.call(target.targetId, 'observe', {})
      const kinds = fixture.harness.pageFrameKinds()
      for (const forbidden of ['grant.put', 'grant.revoke', 'tool.call', 'tool.cancel', 'target.revoke', 'error']) {
        expect(kinds).not.toContain(forbidden)
      }
      expect(fixture.harness.hasOnlyAllowedPageFrames()).toBe(true)
      await context.close()
    } finally {
      fixture.cleanup()
    }
  })
})
