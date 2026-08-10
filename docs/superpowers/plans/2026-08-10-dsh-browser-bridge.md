# DSH Browser Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome side-panel extension and an external DSH plugin that give each prompt structured, turn-scoped access to explicitly attached Chrome tabs.

**Architecture:** A WXT Manifest V3 extension embeds DSH Web and owns tab discovery, prompt grants, and `chrome.debugger` sessions. The DSH client plugin contributes `@` tab references and a current-tab shortcut; the host plugin consumes non-secret reference handles at `agent/pre-step`, registers scoped tools for that turn, and relays calls over an authenticated WebSocket. A shared protocol package validates every cross-process frame.

**Tech Stack:** Node.js 22.19+, pnpm 11.7, TypeScript 6, Vitest 4, WXT 0.21, React 19 + shadcn/Tailwind 4 for the extension shell, host-provided React for the DSH client bundle, Cordis/DSH public plugin APIs, `ws`, Zod 4, Chrome MV3 `sidePanel` and `debugger`, Playwright 1.62.

---

## Scope and execution posture

This is one vertical product, not three independent deliverables: protocol, extension, and DSH plugin are useless without one another. Tasks still keep the units independently testable and integrate them through versioned schemas. The implementation changes only this repository; any discovered DSH limitation requires a reproducer and a separate design decision.

The first release supports local DSH Web origins (`localhost`, `127.0.0.1`, and `[::1]`) and Chrome 118+. Raw CDP passthrough, uploads, downloads, clipboard access, incognito, browser settings, Chrome UI automation, and implicit cross-prompt grants are outside this plan.

## File map

### Workspace

- `package.json`: root scripts and pinned toolchain.
- `pnpm-workspace.yaml`: `extension` plus `packages/*` workspaces.
- `tsconfig.base.json`: strict shared TypeScript options.
- `scripts/link-dsh-source.mjs`: creates the local development link consumed by the DSH plugin package.
- `.github/workflows/ci.yml`: typecheck, unit tests, build, and Linux headed extension tests under Xvfb.

### Shared protocol

- `packages/protocol/src/ids.ts`: branded wire identifiers and random ID factories.
- `packages/protocol/src/errors.ts`: stable bridge error codes and payloads.
- `packages/protocol/src/grants.ts`: tab descriptors, grant offers, active contexts, and tool request types.
- `packages/protocol/src/frames.ts`: Zod frame schemas and parsers.
- `packages/protocol/src/markers.ts`: safe non-secret prompt marker encoding and extraction.
- `packages/protocol/src/index.ts`: public exports only.

### DSH plugin

- `packages/dsh-plugin/src/index.ts`: Cordis assembly, routes, bridge, lifecycle listeners, and config.
- `packages/dsh-plugin/src/bridge/pairing-store.ts`: short-lived single-use pairing nonces.
- `packages/dsh-plugin/src/bridge/grant-store.ts`: connection/session/turn-bound grant state.
- `packages/dsh-plugin/src/bridge/server.ts`: authenticated WebSocket carrier and request correlation.
- `packages/dsh-plugin/src/pre-step.ts`: marker consumption, safe message rewrite, scoped tools, and cleanup.
- `packages/dsh-plugin/src/tools/definitions.ts`: model-facing structured schemas and renderers.
- `packages/dsh-plugin/src/tools/register.ts`: turn-scoped tool registration and alias resolution.
- `packages/dsh-plugin/src/client/extension-channel.ts`: exact-origin parent-frame RPC.
- `packages/dsh-plugin/src/client/reference-store.ts`: bounded per-session tab-reference state.
- `packages/dsh-plugin/src/client/tab-source.ts`: `@` candidates and async reference codec.
- `packages/dsh-plugin/src/client/CurrentTabButton.tsx`: one-click current-tab attachment.
- `packages/dsh-plugin/src/client/index.tsx`: client plugin registration and slot wiring.

### Chrome extension

- `extension/wxt.config.ts`: MV3 manifest, minimum Chrome version, permissions, CSP, and React/Tailwind plugins.
- `extension/entrypoints/sidepanel/*`: shadcn settings/connection shell and DSH Web iframe.
- `extension/entrypoints/background.ts`: service-worker composition root.
- `extension/src/settings.ts`: local-origin validation and storage.
- `extension/src/bridge/client.ts`: authenticated host WebSocket and heartbeat.
- `extension/src/bridge/router.ts`: side-panel requests, host frames, and cancellation.
- `extension/src/tabs/catalog.ts`: eligible/current tab resolution.
- `extension/src/grants/vault.ts`: in-memory prompt grants and `storage.session` ownership ledger.
- `extension/src/cdp/chrome-debugger.ts`: injected wrapper around `chrome.debugger`.
- `extension/src/cdp/session-manager.ts`: lazy attach, domain enablement, navigation generations, buffers, and detach.
- `extension/src/cdp/nodes.ts`: generation-bound element reference registry.
- `extension/src/cdp/observe.ts`: semantic observation and node reference creation.
- `extension/src/cdp/inspect.ts`: attributes, computed styles, geometry, and visibility.
- `extension/src/cdp/act.ts`: click/type/select/hover/focus/key/scroll.
- `extension/src/cdp/navigate.ts`: URL/history/reload operations and expected-navigation windows.
- `extension/src/cdp/wait.ts`: bounded condition polling.
- `extension/src/cdp/capture.ts`: screenshots plus bounded console/network projections.

### Integration and documentation

- `packages/dsh-plugin/tests/composition.e2e.spec.ts`: real Cordis/DSH services, real HTTP/WebSocket bridge, fake extension peer.
- `e2e/fixtures/app.html`: deterministic DOM, style, navigation, console, and failed-request fixture.
- `e2e/bridge-harness.ts`: real protocol peer used by the unpacked extension test.
- `e2e/extension.spec.ts`: headed Chromium with the unpacked extension.
- `INSTALL.md`: development link, plugin install, extension load, update, and uninstall.
- `README.md`: product usage and the development feedback loop.

### Task 1: Bootstrap the workspace and portable DSH source link

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `scripts/link-dsh-source.mjs`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/dsh-plugin/package.json`
- Create: `packages/dsh-plugin/tsconfig.json`
- Create: `extension/package.json`

- [ ] **Step 1: Prove the workspace is not bootstrapped**

Run:

```bash
pnpm install
```

Expected: FAIL because the root has no `package.json`.

- [ ] **Step 2: Add the root workspace and strict compiler baseline**

Create `package.json` with these scripts and versions:

```json
{
  "name": "dsh-browser-bridge-workspace",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.7.0",
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "scripts": {
    "link:dsh": "node scripts/link-dsh-source.mjs",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "test:e2e": "playwright test",
    "check": "pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "@playwright/test": "^1.62.1",
    "typescript": "^6.0.3",
    "vitest": "^4.1.10"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - extension
  - packages/*

onlyBuiltDependencies: []
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  }
}
```

Ignore `.dsh/`, `node_modules/`, `lib/`, `dist/`, `.output/`, `test-results/`, and `playwright-report/`.

- [ ] **Step 3: Add a fail-closed local DSH linker**

Create `scripts/link-dsh-source.mjs` so it accepts exactly one absolute DSH checkout, validates `AGENTS.md`, `packages/client/runtime`, and `vendor/cordis`, creates `.dsh/source/current`, and refuses to overwrite a different existing link:

```js
import { lstat, mkdir, readlink, symlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const source = process.argv[2]
if (source === undefined || !isAbsolute(source)) throw new Error('usage: pnpm link:dsh -- /absolute/path/to/dsh')
const root = resolve(import.meta.dirname, '..')
for (const required of ['AGENTS.md', 'packages/client/runtime', 'vendor/cordis']) {
  await lstat(resolve(source, required))
}
const link = resolve(root, '.dsh/source/current')
await mkdir(resolve(root, '.dsh/source'), { recursive: true })
try {
  const current = await readlink(link)
  if (resolve(resolve(link, '..'), current) !== resolve(source)) {
    throw new Error(`existing DSH link points to ${current}`)
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  await symlink(resolve(source), link, 'dir')
}
console.log(`${link} -> ${resolve(source)}`)
```

- [ ] **Step 4: Add package manifests and install**

Use `@dsh-external/dsh-browser-bridge-protocol`, `@dsh-external/dsh-browser-bridge`, and `@dsh-external/dsh-browser-bridge-extension` as package names. The protocol depends on `zod@^4.4.3`; the host plugin depends on the protocol workspace, `schemastery@^3.18.0`, and `ws@^8.21.0`; its DSH development dependencies use `link:../../.dsh/source/current/...`. The extension depends on the protocol workspace, WXT, React 19, Tailwind 4, and the shadcn runtime packages.

Run:

```bash
pnpm link:dsh -- /Users/justynchen/Documents/code/dsh/test-ycp424c
pnpm install
pnpm exec tsc --version
```

Expected: install succeeds and TypeScript reports `Version 6.0.x`.

- [ ] **Step 5: Commit the workspace baseline**

```bash
git add .gitignore package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json scripts packages/*/package.json packages/*/tsconfig.json extension/package.json
git commit -m "build: bootstrap browser bridge workspace"
```

### Task 2: Define and validate the shared wire protocol

**Files:**
- Create: `packages/protocol/src/ids.ts`
- Create: `packages/protocol/src/errors.ts`
- Create: `packages/protocol/src/grants.ts`
- Create: `packages/protocol/src/frames.ts`
- Create: `packages/protocol/src/markers.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/tests/frames.spec.ts`
- Create: `packages/protocol/tests/markers.spec.ts`
- Create: `packages/protocol/tsdown.config.ts`

- [ ] **Step 1: Write failing parser and marker tests**

Create tests that require versioned discriminants, reject extra fields, round-trip all stable errors, and extract multiple non-secret handles:

```ts
import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeMarker, extractMarkers, PROTOCOL_VERSION } from '../src/index.ts'

describe('wire frames', () => {
  it('accepts a valid hello and rejects unknown protocol versions', () => {
    expect(decodeFrame(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: 'n'.repeat(32) }))).toMatchObject({ type: 'hello' })
    expect(() => decodeFrame(JSON.stringify({ v: 99, type: 'pong' }))).toThrow(/protocol frame/)
  })
})

describe('prompt markers', () => {
  it('extracts only syntactically valid non-secret handles', () => {
    const a = 'a'.repeat(32)
    const b = 'B'.repeat(32)
    const text = `check ${encodeMarker(a)} and ${encodeMarker(b)}`
    expect(extractMarkers(text).map(item => item.handle)).toEqual([a, b])
    expect(extractMarkers('[[dsh-browser-context:<script>]]')).toEqual([])
  })
})
```

- [ ] **Step 2: Run the focused tests and observe the missing exports**

Run:

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-protocol test
```

Expected: FAIL because `src/index.ts` does not exist.

- [ ] **Step 3: Implement branded IDs, errors, grants, markers, and frames**

Use opaque string brands for `ConnectionId`, `PairingNonce`, `GrantId`, `GrantHandle`, `RequestId`, and `ElementRef`. Define this stable error union:

```ts
export const BRIDGE_ERROR_CODES = [
  'bridge_disconnected', 'grant_expired', 'tab_closed', 'unsupported_page',
  'debugger_busy', 'debugger_detached', 'navigation_requires_confirmation',
  'stale_element', 'timeout', 'protocol_mismatch', 'permission_denied', 'internal',
] as const

export type BridgeErrorCode = typeof BRIDGE_ERROR_CODES[number]
export interface BridgeError { code: BridgeErrorCode; message: string; retryable: boolean }
```

Define `TabDescriptor` with `tabId`, `windowId`, `title`, `url`, and optional `favIconUrl`; define `GrantOffer` with `grantId`, `sessionId`, `tab`, and `expiresAt`; define `BrowserToolRequest` with `requestId`, `grantId`, `operation`, and JSON `args`. Keep these operation names:

```ts
export const BROWSER_OPERATIONS = [
  'observe', 'inspect', 'screenshot', 'act', 'navigate', 'wait', 'console', 'network',
] as const
```

Implement markers with one strict pattern and no label or token payload:

```ts
const MARKER = /\[\[dsh-browser-context:([A-Za-z0-9_-]{32,64})\]\]/g
export const encodeMarker = (handle: string): string => {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(handle)) throw new Error('invalid grant handle')
  return `[[dsh-browser-context:${handle}]]`
}
export const extractMarkers = (text: string) => [...text.matchAll(MARKER)].map(match => ({ handle: match[1]!, marker: match[0] }))
```

Use strict Zod discriminated unions for `hello`, `hello.ok`, `ping`, `pong`, `grant.put`, `grant.accepted`, `grant.revoke`, `tool.call`, `tool.result`, and `error`. `decodeFrame` must parse JSON once, validate `.strict()` objects, and throw `protocol frame is invalid` without echoing the received payload.

- [ ] **Step 4: Run protocol tests, typecheck, and build**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-protocol test
pnpm --filter @dsh-external/dsh-browser-bridge-protocol typecheck
pnpm --filter @dsh-external/dsh-browser-bridge-protocol build
```

Expected: all commands pass and `packages/protocol/lib/index.js` exists.

- [ ] **Step 5: Commit the protocol**

```bash
git add packages/protocol
git commit -m "feat: define browser bridge protocol"
```

### Task 3: Build the host pairing, grant, and WebSocket carrier

**Files:**
- Create: `packages/dsh-plugin/src/bridge/pairing-store.ts`
- Create: `packages/dsh-plugin/src/bridge/grant-store.ts`
- Create: `packages/dsh-plugin/src/bridge/server.ts`
- Create: `packages/dsh-plugin/tests/pairing-store.spec.ts`
- Create: `packages/dsh-plugin/tests/grant-store.spec.ts`
- Create: `packages/dsh-plugin/tests/bridge-server.spec.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover single-use pairing, expiry, exact session matching, connection replacement, revocation on close, cancellation, and tool timeouts. The core grant assertion is:

```ts
const record = grants.offer(connectionId, {
  grantId, sessionId: 'session-a', expiresAt: now + 30_000,
  tab: { tabId: 7, windowId: 2, title: 'Fixture', url: 'http://127.0.0.1:4173/' },
})
expect(grants.consume(record.handle, { connectionId, sessionId: 'session-a', turn: 1 }).grantId).toBe(grantId)
expect(() => grants.consume(record.handle, { connectionId, sessionId: 'session-b', turn: 1 })).toThrow(/session/)
```

- [ ] **Step 2: Run tests and confirm the stores are absent**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge test -- pairing-store grant-store bridge-server
```

Expected: FAIL with unresolved bridge modules.

- [ ] **Step 3: Implement fail-closed stores**

`PairingStore.issue(expectedExtensionOrigin)` returns a 32-byte base64url nonce with a 30-second deadline and binds it to one exact `chrome-extension://<id>` origin. `consume(nonce, actualOrigin)` deletes before validating origin or expiry so replay always fails. `GrantStore.offer()` creates a separate random handle; `consume()` binds its record to one turn and returns the same record only for the same `(connectionId, sessionId, turn)`. `revokeConnection()` and `revokeTurn()` return the affected `GrantId[]` for extension cleanup.

Use injected `{ now, randomId }` dependencies in tests and production defaults of `Date.now` and `randomBytes(32).toString('base64url')`.

- [ ] **Step 4: Implement the authenticated WebSocket carrier**

`BridgeServer` owns one authenticated extension connection. Before `hello.ok`, only `hello` is legal; the server requires the exact extension Origin bound into the valid single-use pairing nonce. A replacement connection closes the prior one and rejects its pending calls with `bridge_disconnected`.

The request path must store correlation before sending and clean it in every settlement path:

```ts
request(grantId: GrantId, operation: BrowserOperation, args: JsonValue, signal: AbortSignal): Promise<JsonValue> {
  const connection = this.connection
  if (connection === null) throw bridgeError('bridge_disconnected', 'browser extension is not connected', true)
  if (signal.aborted) throw signal.reason
  const requestId = RequestId(this.randomId())
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      this.pending.delete(requestId)
    }
    const onAbort = () => { finish(); reject(bridgeError('bridge_disconnected', 'browser call cancelled', false)) }
    const timer = setTimeout(() => { finish(); reject(bridgeError('timeout', `${operation} timed out`, true)) }, this.toolTimeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    this.pending.set(requestId, { resolve, reject, finish })
    connection.send({ v: PROTOCOL_VERSION, type: 'tool.call', requestId, grantId, operation, args })
  })
}
```

Do not retry inside the first carrier implementation. Task 12 adds one bounded retry for read-only operations after reconnection and proves that write operations are never replayed.

- [ ] **Step 5: Run focused tests and commit**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge test -- pairing-store grant-store bridge-server
git add packages/dsh-plugin/src/bridge packages/dsh-plugin/tests
git commit -m "feat: add authenticated browser bridge carrier"
```

### Task 4: Build the WXT side-panel shell and extension bridge client

**Files:**
- Create: `extension/wxt.config.ts`
- Create: `extension/tsconfig.json`
- Create: `extension/vitest.config.ts`
- Create: `extension/components.json`
- Create: `extension/entrypoints/sidepanel/index.html`
- Create: `extension/entrypoints/sidepanel/main.tsx`
- Create: `extension/entrypoints/sidepanel/App.tsx`
- Create: `extension/entrypoints/sidepanel/style.css`
- Create: `extension/entrypoints/background.ts`
- Create: `extension/src/components/ui/button.tsx`
- Create: `extension/src/components/ui/input.tsx`
- Create: `extension/src/components/ui/card.tsx`
- Create: `extension/src/lib/utils.ts`
- Create: `extension/src/settings.ts`
- Create: `extension/src/bridge/client.ts`
- Create: `extension/tests/settings.spec.ts`
- Create: `extension/tests/bridge-client.spec.ts`

- [ ] **Step 1: Write failing origin and connection tests**

Test that only loopback HTTP(S) origins are accepted, paths are normalized away, and the bridge client sends `hello` before other frames:

```ts
expect(normalizeDshOrigin('http://127.0.0.1:3080/chat')).toBe('http://127.0.0.1:3080')
expect(normalizeDshOrigin('http://localhost:3080')).toBe('http://localhost:3080')
expect(() => normalizeDshOrigin('https://example.com')).toThrow(/local DSH origin/)

const socket = new FakeSocket()
const client = new BridgeClient({ createSocket: () => socket, heartbeatMs: 20_000 })
client.connect('ws://127.0.0.1:3080/dsh-browser-bridge/ws', 'n'.repeat(32))
socket.open()
expect(socket.sent[0]).toMatchObject({ type: 'hello', pairingNonce: 'n'.repeat(32) })
```

- [ ] **Step 2: Run focused tests and see missing modules**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- settings bridge-client
```

Expected: FAIL because settings and bridge client modules do not exist.

- [ ] **Step 3: Configure WXT, React, Tailwind, and the MV3 manifest**

Use WXT's React module and Tailwind Vite plugin:

```ts
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    minimum_chrome_version: '118',
    name: 'DSH Browser Bridge',
    description: 'Attach explicit Chrome tabs to individual DSH prompts.',
    permissions: ['debugger', 'tabs', 'storage'],
    action: { default_title: 'Open DSH Browser Bridge' },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; frame-src http://127.0.0.1:* http://localhost:* http://[::1]:*; connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:* http://127.0.0.1:* http://localhost:* http://[::1]:*",
    },
  },
})
```

The generated shadcn files are source-owned. Add only `Button`, `Input`, and `Card`; do not install a component runtime beyond Radix Slot, `class-variance-authority`, `clsx`, `tailwind-merge`, and `lucide-react`.

- [ ] **Step 4: Implement settings and the side-panel iframe shell**

Default to `http://127.0.0.1:3080`. Store only the normalized origin under `dshOrigin`. The React shell shows a shadcn settings card until the origin is valid, then renders a full-height iframe plus a compact connection-status banner. Parent messages are accepted only when both checks pass:

```ts
const onMessage = (event: MessageEvent) => {
  if (event.source !== iframeRef.current?.contentWindow) return
  if (event.origin !== dshOrigin) return
  portRef.current?.postMessage({ type: 'panel.forward', payload: event.data })
}
```

Replies use `iframe.contentWindow.postMessage(payload, dshOrigin)`, never `'*'`. When the panel's runtime port disconnects, the background revokes the connection's pending grants.

- [ ] **Step 5: Implement bridge connection and heartbeat**

`BridgeClient` parses every inbound frame through the protocol package, sends a `pong` for `ping`, emits typed state, and sends a frame every 20 seconds while connected. Reconnect uses 500 ms exponential backoff capped at 10 seconds with 0.5–1.0 jitter. A pairing nonce is single-use: reconnect requires the client plugin to obtain and forward a new nonce instead of replaying the old one.

The background action enables `openPanelOnActionClick`:

```ts
export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  const runtime = createBackgroundRuntime({ chrome })
  chrome.runtime.onConnect.addListener(port => runtime.connectPanel(port))
})
```

- [ ] **Step 6: Verify shell tests, typecheck, and build**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- settings bridge-client
pnpm --filter @dsh-external/dsh-browser-bridge-extension typecheck
pnpm --filter @dsh-external/dsh-browser-bridge-extension build
```

Expected: all pass and `extension/.output/chrome-mv3/manifest.json` contains `debugger`, `tabs`, `storage`, and `sidePanel` permissions.

- [ ] **Step 7: Commit the extension shell**

```bash
git add extension
git commit -m "feat: add DSH side panel shell"
```

### Task 5: Add exact-tab discovery and prompt grant issuance in the extension

**Files:**
- Create: `extension/src/tabs/catalog.ts`
- Create: `extension/src/grants/vault.ts`
- Create: `extension/src/bridge/router.ts`
- Create: `extension/tests/tab-catalog.spec.ts`
- Create: `extension/tests/grant-vault.spec.ts`
- Create: `extension/tests/router.spec.ts`
- Modify: `extension/entrypoints/background.ts`

- [ ] **Step 1: Write failing tab and grant tests**

Require immutable send-time descriptors and exact `tabId` targeting:

```ts
const current = await catalog.current()
expect(current).toEqual({ tabId: 9, windowId: 3, title: 'App', url: 'http://127.0.0.1:4173/', favIconUrl: 'icon.png' })
expect(await catalog.list()).not.toContainEqual(expect.objectContaining({ url: 'chrome://settings/' }))

const grant = vault.create({ sessionId: 's1', tab: current, ttlMs: 60_000 })
tabs.active = 10
expect(vault.resolve(grant.grantId).tab.tabId).toBe(9)
vault.revoke(grant.grantId)
expect(() => vault.resolve(grant.grantId)).toThrow(/grant_expired/)
```

- [ ] **Step 2: Run tests and observe missing catalog/vault**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- tab-catalog grant-vault router
```

Expected: FAIL with unresolved modules.

- [ ] **Step 3: Implement eligible-tab resolution**

`TabCatalog.current()` calls `chrome.tabs.query({ active: true, lastFocusedWindow: true })`. `list()` calls `chrome.tabs.query({})`, filters to `http:` and `https:`, excludes the configured DSH origin and extension pages, sorts active-first then by window/index, and returns copied descriptors. Never resolve the active tab again during a browser tool call.

- [ ] **Step 4: Implement the grant vault and router**

The vault stores `GrantId -> { sessionId, tab, expiresAt, state }` in memory and writes only owned `{ grantId, tabId }` pairs to `chrome.storage.session` for startup cleanup. The router supports these iframe requests:

```ts
type PanelRequest =
  | { type: 'bridge.connect'; requestId: string; wsUrl: string; pairingNonce: string }
  | { type: 'tabs.current'; requestId: string }
  | { type: 'tabs.list'; requestId: string }
  | { type: 'grant.create'; requestId: string; sessionId: string; tab: TabDescriptor }
```

For `grant.create`, re-read the tab by exact ID once, reject a closed tab or changed URL, create the local grant, send `grant.put`, wait for `grant.accepted`, and return only the non-secret handle to the iframe. Revoke the local grant if acknowledgement fails or the request aborts. The model-facing path never receives `tabId` or `grantId`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- tab-catalog grant-vault router
pnpm --filter @dsh-external/dsh-browser-bridge-extension typecheck
git add extension/src extension/tests extension/entrypoints/background.ts
git commit -m "feat: issue prompt-scoped tab grants"
```

### Task 6: Add the DSH `@` tab source and current-tab shortcut

**Files:**
- Create: `packages/dsh-plugin/src/client/extension-channel.ts`
- Create: `packages/dsh-plugin/src/client/reference-store.ts`
- Create: `packages/dsh-plugin/src/client/tab-source.ts`
- Create: `packages/dsh-plugin/src/client/CurrentTabButton.tsx`
- Create: `packages/dsh-plugin/src/client/current-tab-button.css`
- Create: `packages/dsh-plugin/src/client/index.tsx`
- Create: `packages/dsh-plugin/src/client/types.d.ts`
- Create: `packages/dsh-plugin/tests/client-channel.spec.ts`
- Create: `packages/dsh-plugin/tests/tab-source.spec.ts`
- Create: `packages/dsh-plugin/tests/current-tab-button.spec.tsx`
- Create: `packages/dsh-plugin/tsdown.config.ts`

- [ ] **Step 1: Write failing channel, source, and shortcut tests**

Test exact parent origin, human-readable duplicate titles, chip insertion, and marker serialization:

```ts
const candidates = await source.candidates({ sessionId: SessionId('s1') }, request(''))
expect(candidates.map(item => item.name)).toEqual(['Dashboard — 127.0.0.1:4173', 'Dashboard — 127.0.0.1:4174'])
const outcome = source.onPick(pick(candidates[0]!))
expect(outcome).toMatchObject({ insert: { source: 'browser-tabs', label: 'Dashboard', clipboardText: '@Dashboard' } })
const marker = await source.codec!.serialize((outcome as { insert: { ref: string } }).insert.ref, signal)
expect(marker).toMatch(/^\[\[dsh-browser-context:[A-Za-z0-9_-]{32,64}\]\]$/)
```

Render `CurrentTabButton` with `input.draft = 'verify this'` and assert its click asks for the current tab and inserts a reference at `{ start: 11, end: 11, draftRev }`.

- [ ] **Step 2: Run focused tests and see missing client modules**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge test -- client-channel tab-source current-tab-button
```

Expected: FAIL with unresolved client modules.

- [ ] **Step 3: Implement exact-origin iframe RPC and bounded references**

Resolve the parent extension origin from `document.referrer`; require `chrome-extension:` and reject any other parent. Correlate requests with random IDs, a 10-second timeout, abort support, and one `message` listener. `ReferenceStore` keeps at most 100 entries for 10 minutes per session; each record contains a random ref ID, copied tab descriptor, session ID, and display label.

- [ ] **Step 4: Implement `browser-tabs` and its async codec**

The source has `trigger: '@'`, `name: 'browser-tabs'`, and `order: -20`. Candidate names use title plus host and add a numeric suffix only when both collide. `onPick` allocates a reference synchronously from the hot candidate map. `codec.serialize` requests a fresh grant from the extension at send time and returns `encodeMarker(handle)`; abort or grant failure rejects the submit.

The client plugin obtains a pairing nonce from `POST /dsh-browser-bridge/pair` with the exact parent extension origin in the JSON body, forwards it with the derived WebSocket URL, and registers the source through `ctx.slash.registerSource`.

- [ ] **Step 5: Register the one-click slot**

Register `CurrentTabButton` in `conversation.input.left`. The component receives the standard `InputZone`, asks the extension for the current tab, creates a reference, and dispatches the official scoped event:

```ts
const applied = actx.bail('slash/input-insert-reference', {
  reference,
  span: {
    start: input.draft.length,
    end: input.draft.length,
    draftRev: input.draftRev,
  },
})
if (applied !== true) throw new Error('composer changed before current tab could be attached')
```

The button label is `@当前标签页`, has an English title fallback, disables while pending/frozen, and uses DSH CSS variables instead of importing shadcn into the host page.

- [ ] **Step 6: Build the host and client bundles**

Configure tsdown to emit `lib/index.js` for Node and a DSH module-loader factory in `lib/client.js`. Keep React and official client platform modules external; bundle the shared protocol into the client artifact.

Run:

```bash
pnpm --filter @dsh-external/dsh-browser-bridge test -- client-channel tab-source current-tab-button
pnpm --filter @dsh-external/dsh-browser-bridge typecheck
pnpm --filter @dsh-external/dsh-browser-bridge build
```

- [ ] **Step 7: Commit composer integration**

```bash
git add packages/dsh-plugin
git commit -m "feat: attach Chrome tabs from DSH prompts"
```

### Task 7: Consume prompt markers and register turn-scoped browser tools

**Files:**
- Create: `packages/dsh-plugin/src/pre-step.ts`
- Create: `packages/dsh-plugin/src/tools/definitions.ts`
- Create: `packages/dsh-plugin/src/tools/register.ts`
- Create: `packages/dsh-plugin/src/index.ts`
- Create: `packages/dsh-plugin/dsh.plugin.json`
- Create: `packages/dsh-plugin/cordis.patch.yml`
- Create: `packages/dsh-plugin/tests/pre-step.spec.ts`
- Create: `packages/dsh-plugin/tests/tools.spec.ts`
- Create: `packages/dsh-plugin/tests/apply.spec.ts`

- [ ] **Step 1: Write failing pre-step scope tests**

Build a real `Session`/`Agent` test fixture and dispatch through `agentEvents(...).waterfall`. Assert:

```ts
expect(agent.ctx.tools.get('browser_observe')).toBeUndefined()
const decision = await proposeStep(agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
expect(textOf(decision)).toContain('<browser_context id="page_1"')
expect(textOf(decision)).not.toContain(handle)
expect(agent.ctx.tools.get('browser_observe')).toBeDefined()
await fireTurnStopping(agent, 1)
expect(agent.ctx.tools.get('browser_observe')).toBeUndefined()
```

Also prove an unknown/expired/mismatched handle rejects the step, duplicate references to one tab deduplicate, multiple tabs receive stable `page_1`, `page_2` aliases, and an empty tool continuation preserves the current turn's tools.

- [ ] **Step 2: Run tests and observe missing pre-step/tools**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge test -- pre-step tools apply
```

Expected: FAIL with missing modules.

- [ ] **Step 3: Define model-facing tools and renderers**

Expose these names: `browser_observe`, `browser_inspect`, `browser_screenshot`, `browser_act`, `browser_navigate`, `browser_wait`, `browser_console`, and `browser_network`. Every parameters schema is an explicit JSON Schema object. Every tool accepts optional `page`; omit it only when one page is attached. `browser_inspect` requires `ref` or `selector`; `browser_act` uses a discriminated `action`; `browser_wait` uses a discriminated condition.

Non-image outputs render one JSON-formatted text block. Screenshot output renders metadata followed by an image block:

```ts
output: {
  schema: SCREENSHOT_RESULT_SCHEMA,
  render: (_args, value) => {
    const shot = value as ScreenshotResult
    return [
      { type: 'text', text: `Screenshot: ${shot.url} (${shot.width}x${shot.height})` },
      { type: 'image', data: shot.data, mimeType: 'image/png' },
    ]
  },
}
```

Mark observe/inspect/screenshot/console/network as concurrency-safe reads. All definitions forward `exec.signal` and use the configured timeout.

- [ ] **Step 4: Implement marker consumption and active-turn ownership**

Call `await next()` first. Scan only text blocks of user-sourced messages in an entering decision. Consume each handle against `agent.session.header.id`, the live connection, and `turn`; replace each marker with a safe summary derived from the server-side grant record. Do not alter non-text blocks.

Register each tool through `agent.ctx.tools.register`, store exact disposers in `WeakMap<Agent, ActiveTurn>`, and merge newly granted pages when steering adds markers to the same turn. Cleanup runs on matching `agent/turn-stopping`, turn signal abort, agent-scope disposal, and bridge disconnect. Cleanup first removes tool registrations, then revokes extension grants.

- [ ] **Step 5: Assemble the external plugin package**

`apply(ctx, config)` creates the stores/server, registers exact POST `/dsh-browser-bridge/pair` and upgrade `/dsh-browser-bridge/ws` routes through `ctx.httpServer`, registers pre-step/turn-stopping listeners, and owns all disposers with `ctx.effect`. The pairing route accepts only JSON with a syntactically valid `chrome-extension://<id>` origin, returns `Cache-Control: no-store`, and never reflects the nonce into a URL. Config fields are `pairingTtlMs`, `grantTtlMs`, `toolTimeoutMs`, `consoleBufferSize`, `networkBufferSize`, and `rawCdpEnabled`; validate at load and default raw CDP to false.

Add a standard `dsh.plugin.json`, a `dshClient` declaration, and a one-row profile bundle patch for `@dsh-external/dsh-browser-bridge`.

- [ ] **Step 6: Verify scoped behavior and commit**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge test -- pre-step tools apply
pnpm --filter @dsh-external/dsh-browser-bridge typecheck
pnpm --filter @dsh-external/dsh-browser-bridge build
git add packages/dsh-plugin
git commit -m "feat: scope browser tools to attached prompts"
```

### Task 8: Add lazy CDP sessions, navigation generations, and cleanup

**Files:**
- Create: `extension/src/cdp/chrome-debugger.ts`
- Create: `extension/src/cdp/nodes.ts`
- Create: `extension/src/cdp/session-manager.ts`
- Create: `extension/tests/node-registry.spec.ts`
- Create: `extension/tests/session-manager.spec.ts`
- Modify: `extension/src/bridge/router.ts`

- [ ] **Step 1: Write failing lazy-attach and teardown tests**

Use an injected fake debugger API. Assert that grant creation does not attach, the first tool does, two grants for one tab share one session, main-frame navigation increments the generation, stale refs fail, and the final revoke detaches:

```ts
manager.bind(grantA)
expect(debuggerApi.attach).not.toHaveBeenCalled()
await manager.session(grantA.grantId)
expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3')
manager.bind(grantB)
await manager.session(grantB.grantId)
expect(debuggerApi.attach).toHaveBeenCalledTimes(1)
manager.revoke(grantA.grantId)
expect(debuggerApi.detach).not.toHaveBeenCalled()
manager.revoke(grantB.grantId)
expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 7 })
```

- [ ] **Step 2: Run tests and confirm no CDP manager exists**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- node-registry session-manager
```

Expected: FAIL with unresolved CDP modules.

- [ ] **Step 3: Implement the debugger wrapper and element registry**

`ChromeDebugger` exposes `attach`, `detach`, `send`, `onEvent`, and `onDetach` so unit tests never patch global Chrome APIs. `NodeRegistry` stores `{ ref, backendNodeId, frameId, generation }`; `resolve(ref, generation)` throws `stale_element` when absent or from another document generation. Clear the whole registry on main-frame document navigation.

- [ ] **Step 4: Implement session ownership and CDP domains**

`CdpSessionManager` keeps one session per tab and a `GrantId` reference set. Lazy attach enables `Page`, `DOM`, `CSS`, `Accessibility`, `Runtime`, `Log`, and `Network`; then it calls `Target.setAutoAttach` with `flatten: true` for immediate OOPIF children. Track `Page.frameNavigated` and `Page.navigatedWithinDocument` for the main frame, `Runtime.consoleAPICalled`, `Log.entryAdded`, `Network.responseReceived`, and `Network.loadingFailed`.

Translate attach failures to `debugger_busy`. Translate `onDetach` to `tab_closed` for `target_closed` and `debugger_detached` otherwise. A detached session rejects pending calls, clears buffers/refs, and notifies the router so the host receives an error.

- [ ] **Step 5: Wire grant lifecycle and verify**

The router binds accepted grants without attaching. `grant.revoke`, connection loss, panel-port loss, and expiry call `manager.revoke`. A tool call resolves the exact grant first and then requests its session; it never queries the active tab.

Run:

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- node-registry session-manager
pnpm --filter @dsh-external/dsh-browser-bridge-extension typecheck
git add extension/src/cdp extension/src/bridge/router.ts extension/tests
git commit -m "feat: manage prompt-bound CDP sessions"
```

### Task 9: Implement semantic observation and computed-style inspection

**Files:**
- Create: `extension/src/cdp/observe.ts`
- Create: `extension/src/cdp/inspect.ts`
- Create: `extension/tests/observe.spec.ts`
- Create: `extension/tests/inspect.spec.ts`
- Modify: `extension/src/bridge/router.ts`

- [ ] **Step 1: Write failing observation and inspection tests**

Fixture fake CDP responses for `Accessibility.getFullAXTree`, `DOM.getDocument`, `DOM.pushNodesByBackendIdsToFrontend`, `CSS.getComputedStyleForNode`, and `Runtime.callFunctionOn`. Require bounded output, masked password values, refs tied to the current generation, exact URL/title, requested CSS properties, and geometry:

```ts
expect(result.page).toMatchObject({ url: 'http://127.0.0.1:4173/', title: 'Fixture' })
expect(result.nodes).toContainEqual(expect.objectContaining({ ref: 'e1', role: 'button', name: 'Save' }))
expect(JSON.stringify(result)).not.toContain('secret-value')

expect(inspected).toMatchObject({
  ref: 'e1', visible: true,
  rect: { x: 10, y: 20, width: 120, height: 32 },
  computedStyle: { color: 'rgb(0, 0, 255)', padding: '16px' },
})
```

- [ ] **Step 2: Run focused tests and see missing operations**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- observe inspect
```

Expected: FAIL with unresolved observe/inspect modules.

- [ ] **Step 3: Implement `browser_observe`**

Read page identity through `Runtime.evaluate` with `returnByValue: true`. Read the accessibility tree, keep meaningful text and interactive roles, map each available `backendDOMNodeId` to a short `ElementRef`, and cap by `maxNodes` and `maxChars`. Include document lifecycle, viewport, main text summary, and truncation counts. Never return password input values; redact fields whose role/name/autocomplete indicate passwords, card numbers, or secrets.

Use this result shape:

```ts
interface ObserveResult {
  page: { url: string; title: string; readyState: string; generation: number }
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  text: string
  nodes: Array<{ ref: ElementRef; role: string; name: string; value?: string; disabled?: boolean; checked?: boolean }>
  truncated: { textChars: number; nodes: number }
}
```

- [ ] **Step 4: Implement `browser_inspect`**

Resolve either a current-generation ref or a selector under the main document. Use `DOM.pushNodesByBackendIdsToFrontend`, `CSS.getComputedStyleForNode`, and `DOM.resolveNode` + `Runtime.callFunctionOn` to return attributes, text, `getBoundingClientRect()`, viewport intersection, `display`, `visibility`, and `opacity`. When `properties` is supplied, return only those CSS names; otherwise return the bounded default set `display`, `position`, `color`, `background-color`, `font-*`, `margin-*`, `padding-*`, `border-*`, `width`, `height`, `opacity`, `visibility`, `overflow`, `z-index`, `align-*`, `justify-*`, and `gap`.

- [ ] **Step 5: Route, verify, and commit**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- observe inspect
pnpm --filter @dsh-external/dsh-browser-bridge-extension typecheck
git add extension/src/cdp extension/src/bridge/router.ts extension/tests
git commit -m "feat: observe and inspect attached pages"
```

### Task 10: Implement interaction, navigation, and waiting

**Files:**
- Create: `extension/src/cdp/act.ts`
- Create: `extension/src/cdp/navigate.ts`
- Create: `extension/src/cdp/wait.ts`
- Create: `extension/tests/act.spec.ts`
- Create: `extension/tests/navigate.spec.ts`
- Create: `extension/tests/wait.spec.ts`
- Modify: `extension/src/bridge/router.ts`

- [ ] **Step 1: Write failing action and navigation tests**

Cover click coordinates, replace typing, select, hover, focus, key, scroll, back/forward/reload, HTTP(S)-only navigation, wait timeout, and stale refs. Assert write suspension on an unexpected cross-origin event:

```ts
await act.click(session, ref)
expect(debuggerApi.commands).toContainEqual(['Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 70, y: 36 })])

session.onMainFrameNavigated('https://unexpected.example/', { expected: false })
await expect(act.click(session, ref)).rejects.toMatchObject({ code: 'navigation_requires_confirmation' })
```

- [ ] **Step 2: Run focused tests and observe missing operations**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- act navigate wait
```

Expected: FAIL with unresolved operation modules.

- [ ] **Step 3: Implement structured actions**

Resolve a ref or selector to a frontend node. Click/hover uses the center of `DOM.getBoxModel` and `Input.dispatchMouseEvent`. Focus uses `DOM.focus`. Replace typing sends platform-select-all, Backspace, then `Input.insertText`; append typing focuses then inserts. `press` sends keyDown/keyUp; `scroll` uses `Input.dispatchMouseEvent` with `mouseWheel`; `select` uses `Runtime.callFunctionOn` to set the option and dispatch bubbling `input`/`change` events.

Each successful write returns `{ ok: true, url, generation }`. Check `session.writeSuspended` immediately before dispatch so a cross-origin race cannot write after validation.

- [ ] **Step 4: Implement expected navigation and bounded waits**

`browser_navigate` accepts only absolute HTTP(S) URLs. Before `Page.navigate`, back/forward/reload, or every dispatched click, call `session.expectNavigation(5_000)`. The window authorizes the resulting main-frame navigation and its redirect chain, then closes at lifecycle completion or deadline. An unmarked cross-origin event sets `writeSuspended = true`. Same-document and same-origin changes update URL without suspending writes.

`browser_wait` supports exactly these conditions:

```ts
type WaitCondition =
  | { kind: 'selector'; selector: string; state: 'attached' | 'visible' | 'hidden' }
  | { kind: 'text'; text: string; state: 'present' | 'absent' }
  | { kind: 'url'; pattern: string }
  | { kind: 'ready'; state: 'interactive' | 'complete' }
  | { kind: 'stable'; quietMs: number }
```

Poll at 100 ms, cap timeout at the plugin-configured tool timeout, observe abort on every iteration, and return the final URL plus elapsed milliseconds. DOM stability means no `DOM.documentUpdated`, lifecycle, or main-frame navigation event during `quietMs`; it is not a claim that network activity ended.

- [ ] **Step 5: Route, verify, and commit**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- act navigate wait
pnpm --filter @dsh-external/dsh-browser-bridge-extension typecheck
git add extension/src/cdp extension/src/bridge/router.ts extension/tests
git commit -m "feat: interact with attached pages over CDP"
```

### Task 11: Add screenshots, console capture, and failed-network evidence

**Files:**
- Create: `extension/src/cdp/capture.ts`
- Create: `extension/tests/capture.spec.ts`
- Create: `extension/tests/console-network.spec.ts`
- Modify: `extension/src/cdp/session-manager.ts`
- Modify: `extension/src/bridge/router.ts`

- [ ] **Step 1: Write failing evidence-capture tests**

Require PNG output, element clipping, bounded buffers, entries only after attach, failed HTTP responses, loading failures, and sensitive-header omission:

```ts
expect(await captureScreenshot(session, {})).toMatchObject({ mimeType: 'image/png', data: 'iVBOR', url: fixtureUrl })
expect(consoleEntries(session)).toEqual([expect.objectContaining({ level: 'error', text: 'fixture failed' })])
expect(networkEntries(session)).toEqual([expect.objectContaining({ url: `${fixtureUrl}missing`, status: 404 })])
expect(JSON.stringify(networkEntries(session))).not.toMatch(/authorization|cookie/i)
```

- [ ] **Step 2: Run focused tests and see missing capture logic**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- capture console-network
```

Expected: FAIL with unresolved capture module.

- [ ] **Step 3: Implement screenshots**

Use `Page.captureScreenshot({ format: 'png', fromSurface: true, captureBeyondViewport: false })`. For an element ref, resolve its box and pass a non-negative `clip` with `scale: 1`; reject zero-area or off-document boxes as `stale_element`. Return base64 data, exact URL, CSS-pixel width/height, and MIME type. Keep screenshot bytes out of console logs and extension storage.

- [ ] **Step 4: Implement bounded console and network projections**

Normalize `Runtime.consoleAPICalled` and `Log.entryAdded` into timestamp/level/text/url rows. Normalize `Network.responseReceived` only for status `>= 400` and every `Network.loadingFailed` into timestamp/method/url/status/error rows. Keep a ring buffer with configured maximum size, start empty on attach, and clear on detach. Do not include headers, bodies, cookies, post data, stack-local variable values, or response content.

- [ ] **Step 5: Route, verify, and commit**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- capture console-network
pnpm --filter @dsh-external/dsh-browser-bridge-extension typecheck
git add extension/src/cdp extension/src/bridge/router.ts extension/tests
git commit -m "feat: capture browser verification evidence"
```

### Task 12: Harden recovery, expiry, ownership, and no-write-replay behavior

**Files:**
- Modify: `packages/protocol/src/frames.ts`
- Modify: `packages/dsh-plugin/src/bridge/server.ts`
- Modify: `packages/dsh-plugin/src/pre-step.ts`
- Modify: `packages/dsh-plugin/tests/bridge-server.spec.ts`
- Create: `packages/dsh-plugin/tests/recovery.spec.ts`
- Modify: `extension/src/bridge/client.ts`
- Modify: `extension/src/bridge/router.ts`
- Modify: `extension/src/grants/vault.ts`
- Modify: `extension/src/cdp/session-manager.ts`
- Modify: `extension/entrypoints/background.ts`
- Modify: `extension/entrypoints/sidepanel/App.tsx`
- Modify: `packages/dsh-plugin/src/client/index.tsx`
- Create: `extension/tests/recovery.spec.ts`
- Create: `extension/tests/security.spec.ts`

- [ ] **Step 1: Write failing reconnect and security-boundary tests**

Prove these invariants with fake clocks, sockets, runtime ports, storage, and debugger APIs:

```ts
it('retries one read after a newly authenticated connection appears', async () => {
  const pending = server.request(grantId, 'observe', {}, signal)
  firstSocket.close()
  server.acceptAuthenticated(secondSocket)
  expect(secondSocket.frames.filter(frame => frame.type === 'tool.call')).toHaveLength(1)
  secondSocket.receive(toolResultForLastCall({ page: { url: fixtureUrl } }))
  await expect(pending).resolves.toMatchObject({ page: { url: fixtureUrl } })
})

it.each(['act', 'navigate'] as const)('never replays the %s operation', async operation => {
  const pending = server.request(grantId, operation, validArgs(operation), signal)
  firstSocket.receive(toolAcceptedForLastCall())
  firstSocket.close()
  server.acceptAuthenticated(secondSocket)
  expect(secondSocket.frames).not.toContainEqual(expect.objectContaining({ type: 'tool.call' }))
  await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
})
```

Also assert that an expired grant detaches its owned session, tab close revokes all matching grants, a panel-port disconnect revokes every connection grant, extension startup detaches only tab IDs in its prior ownership ledger, pairing Origin must be `chrome-extension://<id>`, a second extension ID cannot reuse a connection, unknown protocol frames are rejected without logging their payload, and browser-derived data is absent from `chrome.storage.local` and `chrome.storage.session`.

- [ ] **Step 2: Run focused recovery tests and capture the failures**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge test -- bridge-server recovery
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- recovery security
```

Expected: FAIL because accepted-call acknowledgement, startup ownership cleanup, and reconnect classification are not implemented.

- [ ] **Step 3: Add delivery acknowledgement and bounded read retry**

Add a strict frame:

```ts
type ToolAcceptedFrame = {
  v: typeof PROTOCOL_VERSION
  type: 'tool.accepted'
  requestId: RequestId
}
```

The extension sends `tool.accepted` only after it has validated the frame, resolved a live grant, and placed the request in its local execution journal. The host records `sent | accepted | settled` for each pending call. On disconnect:

- `act` and `navigate` reject immediately and are never replayed, regardless of acknowledgement state.
- `observe`, `inspect`, `screenshot`, `wait`, `console`, and `network` may wait up to 10 seconds for one newly authenticated connection and resend once with a new `RequestId`.
- A second disconnect, the original abort signal, turn cleanup, grant expiry, or the original absolute timeout rejects the call.

The retry budget belongs to the original call and does not reset its timeout. The extension journal drops settled reads and caches only the final result of an in-flight request in memory long enough to answer an exact duplicate `RequestId`; it never persists request arguments or results.

- [ ] **Step 4: Make reconnect obtain a fresh single-use pairing nonce**

When the WebSocket closes while the side panel remains connected, the background emits `bridge.pairing-required` after the current backoff. The DSH client plugin requests a new nonce from the pairing route and sends a new `bridge.connect` request through the exact-origin iframe channel. Do not cache or replay a pairing nonce. Stop reconnect attempts and revoke grants when the panel runtime port closes.

The client plugin emits `bridge.client-ready` after registering its source and slot. The side panel starts a five-second readiness timer after iframe load; if no ready event arrives, show a diagnostic card explaining that DSH Web may be offline or blocking extension framing, with buttons to retry and edit the local origin.

- [ ] **Step 5: Implement deterministic ownership cleanup**

Use one expiry timer for the nearest grant deadline. On expiry or `chrome.tabs.onRemoved`, revoke the local grant, notify the host when connected, remove its session-manager binding, and detach only when the final grant for that tab is gone. On service-worker startup:

1. Read the owned `{ grantId, tabId }` ledger from `chrome.storage.session`.
2. Best-effort detach only those distinct `tabId` values.
3. Clear the ownership ledger before accepting panel or host traffic.
4. Start with no grants, references, buffers, or resumable writes.

Register `chrome.debugger.onDetach`, `chrome.tabs.onRemoved`, runtime-port disconnect, and storage cleanup listeners through one background disposer registry so tests can prove there are no duplicate listeners after recreation.

- [ ] **Step 6: Mask errors and mark browser data as untrusted**

Map raw Chrome and WebSocket errors to the stable `BridgeError` union. Logs may include operation, stable error code, request ID, grant ID, and tab ID, but never prompt text, DOM text, URLs with query/fragment, screenshot data, console arguments, network bodies, pairing nonces, or grant handles. Rewrite attached context summaries as untrusted external browser data and tell the model that page text is evidence, not instructions.

- [ ] **Step 7: Run recovery/security suites and commit**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge-protocol test
pnpm --filter @dsh-external/dsh-browser-bridge test -- bridge-server recovery
pnpm --filter @dsh-external/dsh-browser-bridge-extension test -- recovery security
pnpm typecheck
git add packages/protocol packages/dsh-plugin extension
git commit -m "fix: harden browser bridge lifecycle"
```

### Task 13: Prove the real DSH composition and unpacked-extension loop

**Files:**
- Create: `packages/dsh-plugin/tests/composition.e2e.spec.ts`
- Create: `e2e/fixtures/app.html`
- Create: `e2e/fixtures/style.css`
- Create: `e2e/fixture-server.ts`
- Create: `e2e/bridge-harness.ts`
- Create: `e2e/extension.spec.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Write a failing real DSH composition test**

Boot real linked Cordis `Loader`, DSH `WebServer`, `Session`, `Agent`, and `Tools` services on a free loopback port. Load the built plugin through its manifest and profile patch, then connect a protocol-valid fake extension peer over the real WebSocket. The test must cover the public contracts the unit doubles cannot prove:

```ts
const nonce = await fetchPairingNonce(baseUrl)
await peer.connect(wsUrl(baseUrl), nonce)
const handle = await peer.putGrant({ sessionId: session.header.id, tab: fixtureTab })

const decision = await proposeStep(agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
expect(textOf(decision)).toContain('page_1')
expect(textOf(decision)).not.toContain(handle)

const observe = agent.ctx.tools.get('browser_observe')!
const executing = observe.execute({ page: 'page_1' }, executionContext(signal))
expect(await peer.nextToolCall()).toMatchObject({ operation: 'observe', grantId: peer.lastGrantId })
peer.reply({ page: { url: fixtureUrl, title: 'Fixture' }, nodes: [] })
await expect(executing).resolves.toBeDefined()

await fireTurnStopping(agent, 1)
expect(agent.ctx.tools.get('browser_observe')).toBeUndefined()
expect(await peer.nextFrame()).toMatchObject({ type: 'grant.revoke' })
```

The same suite verifies a continuation within turn 1 keeps the tools, turn 2 cannot reuse the handle, plugin disposal closes the upgrade route/connection, and no global tool registration remains.

- [ ] **Step 2: Run the composition test and confirm the integration gap**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge build
pnpm --filter @dsh-external/dsh-browser-bridge test -- composition.e2e
```

Expected: FAIL until the real manifests, service declarations, route upgrade API, and client/host output paths agree.

- [ ] **Step 3: Align only this repository with real public DSH APIs**

Correct the external plugin package, manifest, service injections, WebSocket upgrade registration, effect ownership, waterfall listener signature, tool registration, client factory output, and profile bundle patch until the composition test passes. Do not patch the linked DSH checkout. If a required behavior has no public DSH API, preserve the failing reproducer and stop that implementation task for a design decision.

- [ ] **Step 4: Build the deterministic browser fixture and bridge harness**

Serve only on `127.0.0.1` and allocate free ports. The fixture contains:

- A `#save` button whose computed `color` and `padding` come from `style.css`.
- A form with text, select, password, disabled, and offscreen controls.
- Buttons that log an error, fetch a 404, perform same-origin navigation, and perform cross-origin navigation to a second fixture origin.
- A DOM mutation counter and visible status region for stable waits.

`FixtureServer.setStyle({ color, padding })` changes the served CSS version without reloading the extension. `bridge-harness.ts` implements the real versioned WebSocket protocol, exposes pairing and grant helpers to Playwright, and records frames while redacting nonces and page data from its diagnostics.

- [ ] **Step 5: Write the failing unpacked-extension E2E**

Build the extension, launch Chrome with `--disable-extensions-except` and `--load-extension` pointing at `extension/.output/chrome-mv3`, derive the extension ID from the service worker URL, and open `chrome-extension://<id>/sidepanel.html` as an ordinary test page. Use a local DSH iframe fixture that speaks the exact parent-frame RPC so this suite exercises the extension boundary without mocking `chrome.tabs` or `chrome.debugger`.

The main scenario is the intended development loop:

```ts
const attached = await dshFrame.attachCurrentTab(fixturePage)
await harness.acceptGrant(attached)

const before = await harness.call(attached.grantId, 'inspect', {
  selector: '#save', properties: ['color', 'padding'],
})
expect(before.computedStyle).toEqual({ color: 'rgb(0, 0, 255)', padding: '8px' })

fixtureServer.setStyle({ color: 'rgb(255, 0, 0)', padding: '16px' })
await fixturePage.reload()
await harness.call(attached.grantId, 'wait', { condition: { kind: 'ready', state: 'complete' } })
const after = await harness.call(attached.grantId, 'inspect', {
  selector: '#save', properties: ['color', 'padding'],
})
expect(after.computedStyle).toEqual({ color: 'rgb(255, 0, 0)', padding: '16px' })
```

Also observe semantic refs, click/type/select, take a PNG screenshot, capture the fixture console error and 404, prove active-tab switching does not retarget the grant, prove an unexpected cross-origin navigation suspends writes, prove ending the grant detaches the debugger, and stop/restart the extension service worker to prove startup reconciliation clears its owned-session ledger before a new grant is accepted.

- [ ] **Step 6: Run both integration layers and commit**

```bash
pnpm --filter @dsh-external/dsh-browser-bridge build
pnpm --filter @dsh-external/dsh-browser-bridge test -- composition.e2e
pnpm --filter @dsh-external/dsh-browser-bridge-extension build
pnpm exec playwright test e2e/extension.spec.ts
git add package.json pnpm-lock.yaml playwright.config.ts packages/dsh-plugin/tests e2e
git commit -m "test: cover the browser bridge feedback loop"
```

### Task 14: Package, document, and verify the complete product

**Files:**
- Create: `INSTALL.md`
- Modify: `README.md`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `extension/package.json`
- Modify: `packages/dsh-plugin/package.json`
- Modify: `packages/dsh-plugin/dsh.plugin.json`

- [ ] **Step 1: Write an executable installation smoke checklist first**

Add an `INSTALL.md` draft containing exact development commands and explicit expected artifacts. It must distinguish the source checkout used for local linking from the installed plugin directory:

```bash
corepack enable
pnpm link:dsh -- /absolute/path/to/dsh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @dsh-external/dsh-browser-bridge-extension zip
dsh plugin --profile web add /absolute/path/to/dsh-browser-bridge/packages/dsh-plugin
dsh web
```

Expected artifacts are `packages/dsh-plugin/lib/index.js`, `packages/dsh-plugin/lib/client.js`, `extension/.output/chrome-mv3/manifest.json`, and a Chrome zip under `extension/.output/`. Loading the unpacked extension must use `extension/.output/chrome-mv3`.

- [ ] **Step 2: Document the product and its permission boundary**

Update `README.md` with:

- The general-purpose bridge model and the code-change/HMR/verify loop as the primary example.
- A short architecture diagram: DSH Web iframe -> extension background -> exact Chrome tab, and host plugin <-> authenticated WebSocket.
- `@当前标签页`, `@` tab picker, multiple-page aliases, per-prompt expiry, and expected navigation behavior.
- Why `debugger`, `tabs`, and `storage` permissions are required; DevTools detaches the CDP session; only HTTP(S) tabs are eligible.
- Chrome 118+, local DSH origins, iframe/CSP diagnostics, raw CDP disabled, incognito unsupported, no telemetry by default, and no implicit access to future prompts.
- Updating, temporarily disabling, uninstalling, and how cleanup detaches owned debugger sessions.
- Stable troubleshooting entries for every public bridge error code.

Do not market this as browser-wide Computer Use or test-only validation. Describe it as an explicit-context browser bridge with structured operations.

- [ ] **Step 3: Finalize package metadata and reproducible artifacts**

Pin public package fields, repository URL, license, files lists, engines, exports, DSH manifest paths, and build scripts. Add `extension` scripts for `dev`, `build`, `zip`, `typecheck`, and `test`; add plugin scripts for host/client build, typecheck, and test. Ensure package tarball dry-runs contain only runtime artifacts, manifests, README/license metadata, and source maps intended for debugging:

```bash
pnpm --filter @dsh-external/dsh-browser-bridge pack --dry-run
pnpm --filter @dsh-external/dsh-browser-bridge-protocol pack --dry-run
pnpm --filter @dsh-external/dsh-browser-bridge-extension zip
```

- [ ] **Step 4: Add CI with the same gates as local verification**

Create `.github/workflows/ci.yml` for pushes and pull requests. Use Node 22.19, Corepack/pnpm 11.7, frozen install, cached pnpm store, `pnpm typecheck`, `pnpm test`, `pnpm build`, package dry-runs, and headed Playwright under Xvfb. Before install, CI checks out the public DSH source at the exact revision recorded in `DSH_SOURCE_REVISION` and runs `pnpm link:dsh -- "$GITHUB_WORKSPACE/.ci/dsh"`; the repository does not vendor DSH.

Upload the extension zip and Playwright report on failure. CI must not publish packages, create releases, or push commits.

- [ ] **Step 5: Run the complete automated gate from a clean dependency state**

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright test
pnpm --filter @dsh-external/dsh-browser-bridge pack --dry-run
pnpm --filter @dsh-external/dsh-browser-bridge-protocol pack --dry-run
pnpm --filter @dsh-external/dsh-browser-bridge-extension zip
git diff --check
```

Expected: every command exits 0 and all four expected artifacts from Step 1 exist.

- [ ] **Step 6: Perform the real Chrome + DSH acceptance loop**

With local DSH Web running and the unpacked extension loaded:

1. Open the fixture or a local development app in Chrome and open the extension side panel.
2. Confirm DSH Web renders in the panel and shows connected status.
3. Click `@当前标签页`; confirm a visible reference chip appears in the current DSH draft.
4. Send a prompt that asks DSH to observe and inspect the attached page; confirm tools exist only for that turn.
5. Change the app's CSS in its source, allow HMR or reload, and ask DSH to inspect the same element's computed styles and screenshot the result.
6. Trigger the fixture console error and 404; confirm only bounded, redacted evidence is returned.
7. Navigate unexpectedly to another origin; confirm reads remain available and writes return `navigation_requires_confirmation` until a new prompt explicitly attaches the page.
8. End the turn, switch active tabs, and start a prompt without an attachment; confirm no browser tools appear and Chrome no longer shows the extension debugging the prior tab.
9. Open DevTools while attached; confirm the bridge reports `debugger_detached` and gives the documented recovery action.

Record the tested Chrome version, DSH revision, extension artifact hash, and pass/fail result in the implementing change's commit or merge-request notes, not in a machine-specific tracked file.

- [ ] **Step 7: Commit the delivery surface**

```bash
git add README.md INSTALL.md .github package.json pnpm-lock.yaml extension/package.json packages/dsh-plugin/package.json packages/dsh-plugin/dsh.plugin.json
git commit -m "docs: add browser bridge installation and operations"
git status --short
```

Expected: clean worktree. Push, release, store submission, and DSH source changes remain separate user-authorized actions.

## Specification coverage matrix

| Approved requirement | Plan tasks |
| --- | --- |
| New independent repository, no `dsh-browser` evolution | 1, 14 |
| No DSH source modification; external dual host/client plugin | 1, 6, 7, 13 |
| Side panel embeds local DSH Web | 4, 12, 14 |
| Explicit per-prompt `@当前标签页` and `@` tab attachments | 5, 6 |
| Multiple exact tabs with stable page aliases | 5, 7 |
| Single-use pairing and short-lived turn grants | 2, 3, 5, 7, 12 |
| CDP-first, lazy attach, no ambient active-tab retargeting | 5, 8 |
| Structured general tools; raw CDP disabled | 7, 9, 10, 11 |
| Development modify/HMR/observe/verify loop | 9, 11, 13, 14 |
| Expected navigation allowed; unexpected cross-origin writes suspended | 8, 10, 13 |
| Console/network evidence is bounded and redacted | 8, 11, 12 |
| Detach/revoke on turn end, expiry, close, disconnect, and restart | 3, 7, 8, 12 |
| DevTools/debugger conflict and stable recovery errors | 2, 8, 12, 14 |
| React + shadcn only for the extension shell; host UI uses DSH platform | 4, 6 |
| Chrome 118+ and local DSH origins first | 4, 14 |
| Real DSH composition plus unpacked Chrome coverage | 13, 14 |

## Definition of done

The work is complete only when all automated commands in Task 14 pass, the manual Chrome + DSH loop is recorded as passed, the specification coverage matrix has no missing row, the linked DSH checkout remains byte-for-byte unmodified, and this repository has a clean worktree. Publishing, Chrome Web Store submission, and changes to DSH itself are not part of completion.
