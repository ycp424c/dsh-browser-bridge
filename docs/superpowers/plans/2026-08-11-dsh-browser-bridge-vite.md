# DSH Browser Bridge Vite Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Vite provider that injects a low-authority page Runtime, optionally embeds local DSH Web, and lets an existing DSH conversation explicitly attach and operate Vite pages without a Chrome extension.

**Architecture:** Keep the existing Chrome extension wire protocol intact. Add a provider-neutral host target/grant layer, a separately versioned Vite page protocol, a framework-neutral browser Runtime that connects directly to loopback DSH, and a Vite plugin that injects the Runtime in dev or explicitly enabled builds.

**Tech Stack:** TypeScript 6, Vite 8, Zod 4, Cordis/DSH external plugin APIs, WebSocket, React 18 for the DSH client slot, framework-neutral DOM/Shadow DOM for the injected Runtime, Vitest 4, Playwright.

**Execution constraint:** Work in the current checkout as requested; do not create a worktree. Do not modify DSH source. Commit each task locally and do not push unless the user explicitly invokes CP.

**Approved spec:** docs/superpowers/specs/2026-08-11-dsh-browser-bridge-vite-design.md

---

## File map

New packages:

- packages/page-runtime: browser-side target connection, DOM tools, HMR lifecycle, activation, and optional Shadow DOM panel.
- packages/vite-plugin: Vite configuration, virtual Runtime entry, dev/build HTML injection, and HMR adapter.

New host/client areas:

- packages/protocol/src/targets.ts: provider-neutral descriptors and capabilities.
- packages/protocol/src/vite-frames.ts: strict Vite page wire frames and protocol version.
- packages/dsh-plugin/src/targets/: provider registry and grant coordinator.
- packages/dsh-plugin/src/vite/: multi-target broker and HTTP/WebSocket routes.
- packages/dsh-plugin/src/client/vite-*: DSH Web target discovery, grants, embedded-parent channel, and current-page composer action.

Existing areas that remain authoritative:

- packages/protocol/src/frames.ts: Chrome extension wire protocol version 1; do not change its frame shapes.
- packages/dsh-plugin/src/bridge/server.ts: Chrome extension connection and request correlation.
- extension/src/cdp/: CDP implementation; no Vite behavior belongs here.
- packages/dsh-plugin/src/pre-step.ts and src/tools/: common turn-scoped model surface after provider routing is introduced.

---

### Task 1: Add provider-neutral target and Vite wire schemas

**Files:**
- Create: packages/protocol/src/targets.ts
- Create: packages/protocol/src/vite-frames.ts
- Create: packages/protocol/tests/vite-frames.spec.ts
- Modify: packages/protocol/src/ids.ts
- Modify: packages/protocol/src/errors.ts
- Modify: packages/protocol/src/index.ts
- Modify: packages/protocol/README.md

- [ ] **Step 1: Write failing strict-schema tests**

Add tests that accept only the reliable Vite capability subset and reject unknown fields, screenshot/network capability claims, malformed target IDs, and unknown protocol versions:

~~~ts
import { describe, expect, it } from 'vitest'
import {
  VITE_PAGE_PROTOCOL_VERSION,
  browserTargetDescriptorSchema,
  decodeVitePageToHostFrame,
} from '../src/index.ts'

describe('Vite page protocol', () => {
  it('accepts a strict target registration', () => {
    const frame = decodeVitePageToHostFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: {
        targetId: 't'.repeat(43),
        provider: 'vite',
        title: 'Fixture',
        url: 'https://fixture.test/app',
        origin: 'https://fixture.test',
        projectId: 'fixture',
        generation: 0,
        capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      },
    }))
    expect(frame.type).toBe('target.register')
  })

  it('rejects Vite screenshot/network claims and extra fields', () => {
    const base = {
      targetId: 't'.repeat(43),
      provider: 'vite',
      title: 'Fixture',
      url: 'https://fixture.test/',
      origin: 'https://fixture.test',
      generation: 0,
      capabilities: ['screenshot'],
    }
    expect(() => browserTargetDescriptorSchema.parse(base)).toThrow()
    expect(() => browserTargetDescriptorSchema.parse({
      ...base,
      capabilities: ['observe'],
      token: 'must-not-exist',
    })).toThrow()
  })
})
~~~

- [ ] **Step 2: Run the protocol test and verify the expected failure**

Run:

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-protocol exec vitest run tests/vite-frames.spec.ts
~~~

Expected: FAIL because targets.ts, vite-frames.ts, and their exports do not exist.

- [ ] **Step 3: Implement target descriptors, capabilities, IDs, and errors**

Define the shared vocabulary:

~~~ts
export const VITE_BROWSER_CAPABILITIES = [
  'observe', 'inspect', 'act', 'navigate', 'wait', 'console',
] as const

export type ViteBrowserCapability = typeof VITE_BROWSER_CAPABILITIES[number]
export type BrowserProviderKind = 'chrome-extension' | 'vite'

interface BrowserTargetDescriptorBase {
  targetId: TargetId
  title: string
  url: string
  origin: string
  projectId?: string
  generation: number
}

export interface ChromeBrowserTargetDescriptor extends BrowserTargetDescriptorBase {
  provider: 'chrome-extension'
  capabilities: BrowserOperation[]
}

export interface ViteBrowserTargetDescriptor extends BrowserTargetDescriptorBase {
  provider: 'vite'
  capabilities: ViteBrowserCapability[]
}

export type BrowserTargetDescriptor =
  | ChromeBrowserTargetDescriptor
  | ViteBrowserTargetDescriptor
~~~

Use the same discriminant in a strict Zod union so both TypeScript and runtime parsing restrict a Vite descriptor to VITE_BROWSER_CAPABILITIES, while a Chrome descriptor may advertise the existing full BROWSER_OPERATIONS set. Add TargetId to ids.ts. Add these stable errors and recovery text to errors.ts:

~~~ts
'dsh_unavailable'
'local_access_blocked'
'embedding_blocked'
'target_disconnected'
'unsupported_operation'
~~~

- [ ] **Step 4: Implement a separately versioned strict Vite page protocol**

Add strict frames for hello, target.register, target.registered, target.update, tool.call, tool.cancel, tool.accepted, tool.result, target.revoke, ping, pong, and error. Keep PAGE protocol version independent from PROTOCOL_VERSION:

~~~ts
export const VITE_PAGE_PROTOCOL_VERSION = 1

export const vitePageFrameSchema = z.discriminatedUnion('type', [
  viteHelloFrameSchema,
  targetRegisterFrameSchema,
  targetRegisteredFrameSchema,
  targetUpdateFrameSchema,
  viteToolCallFrameSchema,
  viteToolCancelFrameSchema,
  viteToolAcceptedFrameSchema,
  viteToolResultFrameSchema,
  targetRevokeFrameSchema,
  vitePingFrameSchema,
  vitePongFrameSchema,
  viteErrorFrameSchema,
])

export function decodeVitePageToHostFrame(text: string): VitePageToHostFrame {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('vite page protocol frame is invalid')
  }
  const parsed = vitePageToHostFrameSchema.safeParse(value)
  if (!parsed.success) throw new Error('vite page protocol frame is invalid')
  return parsed.data
}
~~~

In addition to the complete union, export separate strict vitePageToHostFrameSchema and viteHostToPageFrameSchema plus direction-specific decoders. Tests must prove that a page cannot send tool.call, tool.cancel, target.revoke, or error, and that Host cannot treat target.register as a Host-to-page frame. tool.call must accept only VITE_BROWSER_CAPABILITIES. tool.cancel carries only the correlated request ID and a bounded reason code; it cannot introduce a new operation. No Vite frame may carry a DSH session ID, grant handle, filesystem request, host method, secret, screenshot, or network payload.

- [ ] **Step 5: Run protocol tests, typecheck, and the existing extension-frame regression**

Run:

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-protocol test
pnpm --filter @dsh-external/dsh-browser-bridge-protocol typecheck
~~~

Expected: all protocol tests pass, including existing frames.spec.ts unchanged.

- [ ] **Step 6: Commit the protocol slice**

~~~bash
git add packages/protocol
git commit -m "feat: add Vite target protocol"
~~~

---

### Task 2: Refactor host grants behind provider-neutral target routing

**Files:**
- Create: packages/dsh-plugin/src/targets/types.ts
- Create: packages/dsh-plugin/src/targets/provider-registry.ts
- Create: packages/dsh-plugin/src/targets/coordinator.ts
- Create: packages/dsh-plugin/tests/provider-registry.spec.ts
- Modify: packages/dsh-plugin/src/bridge/grant-store.ts
- Modify: packages/dsh-plugin/src/bridge/server.ts
- Modify: packages/dsh-plugin/tests/grant-store.spec.ts
- Modify: packages/dsh-plugin/tests/bridge-server.spec.ts
- Modify: packages/dsh-plugin/tests/recovery.spec.ts

- [ ] **Step 1: Write failing provider-routing and grant tests**

Cover mixed providers, logical-target binding, active-connection takeover rejection, same-target bounded reconnect, grant expiry, turn removal/cancellation, and write non-replay:

~~~ts
it('routes a grant only to its bound provider and logical target', async () => {
  const chrome = fakeProvider('chrome-extension')
  const vite = fakeProvider('vite')
  const registry = new ProviderRegistry([chrome.provider, vite.provider])
  const coordinator = new TargetCoordinator({
    providers: registry,
    grants: new GrantStore(),
  })
  const record = coordinator.offer({
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
    target: vite.binding('target-a', 'connection-a'),
  })
  coordinator.consumeBatch([record.handle], { sessionId: 'session-a', turn: 1 })
  await coordinator.request(record.grantId, 'observe', {}, AbortSignal.timeout(1_000))
  expect(vite.requests).toHaveLength(1)
  expect(chrome.requests).toHaveLength(0)
})
~~~

Also retain an explicit test that an existing Chrome grant.put produces the same grant.accepted frame as before.

- [ ] **Step 2: Run targeted host tests and verify they fail**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge exec vitest run tests/provider-registry.spec.ts tests/grant-store.spec.ts tests/bridge-server.spec.ts
~~~

Expected: FAIL because provider-neutral host types do not exist.

- [ ] **Step 3: Introduce canonical target/provider interfaces**

Use these interfaces consistently in later tasks:

~~~ts
export interface TargetBinding {
  descriptor: BrowserTargetDescriptor
  connectionId: ConnectionId
  logicalKey: string
}

export interface BrowserProvider {
  readonly kind: BrowserProviderKind
  isConnected(target: TargetBinding): boolean
  request(
    target: TargetBinding,
    requestId: RequestId,
    operation: BrowserOperation,
    args: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue>
  revoke(target: TargetBinding, grantId: GrantId): void
}
~~~

ProviderRegistry must reject duplicate provider registration and unknown providers, check target capability before dispatch, and return unsupported_operation without forwarding.

- [ ] **Step 4: Make GrantStore store TargetBinding instead of TabDescriptor**

GrantRecord becomes:

~~~ts
export interface GrantRecord {
  grantId: GrantId
  handle: GrantHandle
  sessionId: string
  turn?: number
  expiresAt: number
  target: TargetBinding
}
~~~

consumeBatch validates session, turn, expiry, and target liveness atomically. revokeTurn returns complete GrantRecord objects so the coordinator can notify the owning provider. Keep duplicate-handle same-turn consumption idempotent.

- [ ] **Step 5: Add TargetCoordinator and adapt BridgeServer without changing wire frames**

TargetCoordinator owns offer, consumeBatch, request, revokeTurn, revokeSession, revokeConnection, and target reconnect/rebind. BridgeServer registers as the chrome-extension provider and normalizes incoming TabDescriptor into a TargetBinding internally:

~~~ts
const target: TargetBinding = {
  descriptor: chromeDescriptor(frame.tab),
  connectionId: connection.id,
  logicalKey: 'chrome:' + String(frame.tab.windowId) + ':' + String(frame.tab.tabId),
}
coordinator.offerWithId(frame.grantId, {
  sessionId: frame.sessionId,
  expiresAt: frame.expiresAt,
  target,
})
~~~

Do not change packages/protocol/src/frames.ts or any Chrome frame schema.

- [ ] **Step 6: Run targeted and complete host tests**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge exec vitest run tests/provider-registry.spec.ts tests/grant-store.spec.ts tests/bridge-server.spec.ts tests/recovery.spec.ts
pnpm --filter @dsh-external/dsh-browser-bridge test
pnpm --filter @dsh-external/dsh-browser-bridge typecheck
~~~

Expected: all host tests pass; existing Chrome recovery and grant semantics remain unchanged.

- [ ] **Step 7: Commit the provider-neutral host refactor**

~~~bash
git add packages/dsh-plugin/src/targets packages/dsh-plugin/src/bridge packages/dsh-plugin/tests
git commit -m "refactor: route browser grants by provider"
~~~

---

### Task 3: Add the low-authority Vite multi-target broker and host routes

**Files:**
- Create: packages/dsh-plugin/src/vite/broker.ts
- Create: packages/dsh-plugin/src/vite/routes.ts
- Create: packages/dsh-plugin/src/vite/sanitize.ts
- Create: packages/dsh-plugin/tests/vite-broker.spec.ts
- Create: packages/dsh-plugin/tests/vite-routes.spec.ts
- Modify: packages/dsh-plugin/src/index.ts
- Modify: packages/dsh-plugin/package.json
- Modify: packages/dsh-plugin/dsh.plugin.json
- Modify: packages/dsh-plugin/tests/apply.spec.ts
- Modify: packages/dsh-plugin/tests/composition.e2e.spec.ts

- [ ] **Step 1: Write failing broker resource-limit and route-security tests**

Tests must prove:

- health is the only cross-origin HTTP endpoint and returns no credentials;
- targets and grant issuance require a same-origin local DSH request;
- a page WebSocket may register only itself and cannot submit grant or host frames;
- 32 total targets, 8 per page origin, 1 MiB frames, 4 concurrent calls, 16 non-heartbeat frames per second, 15-second heartbeat, and 45-second disconnect defaults are enforced;
- a live target cannot be taken over by a second connection;
- targetId plus exact origin may rebind within the configured recovery window;
- metadata is bounded and query/fragment are stripped before model exposure.
- page tool results and error text are schema-checked, size-bounded, and sanitized again by Host before model exposure;
- aborting a DSH turn emits one correlated tool.cancel and settles the Host pending call idempotently;
- after a legal rebind, an unaccepted read retries at most once, while accepted or mutating calls never replay;
- changing page origin revokes the logical target instead of entering the reconnect window.

Example:

~~~ts
it('rejects grant issuance from a non-DSH origin', async () => {
  const response = await callRoute(routes, {
    method: 'POST',
    path: '/dsh-browser-bridge/vite/grants',
    origin: 'https://public.example',
    body: { sessionId: 's1', targetId: TARGET_ID },
  })
  expect(response.status).toBe(403)
})
~~~

- [ ] **Step 2: Run the new tests and verify they fail**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge exec vitest run tests/vite-broker.spec.ts tests/vite-routes.spec.ts
~~~

Expected: FAIL because the broker and routes do not exist.

- [ ] **Step 3: Implement ViteTargetBroker as a BrowserProvider**

The broker stores connection, target descriptor, heartbeat, rate state, pending calls, and reconnect tombstone separately:

~~~ts
interface LiveViteTarget {
  binding: TargetBinding
  socket: BridgeSocket
  lastSeenAt: number
  pending: Map<string, PendingViteCall>
  frameWindow: { startedAt: number; count: number }
}
~~~

Only hello/register/update/accepted/result/ping/pong are accepted from a page. Unknown, oversized, over-rate, or host-shaped frames close that page connection without affecting Chrome or other Vite targets. Host-to-page tool.cancel is sent when the BrowserProvider request signal aborts. The broker retries an unaccepted read once only after TargetCoordinator confirms an exact targetId+origin rebind; it never retries a mutating operation or any call acknowledged by tool.accepted.

- [ ] **Step 4: Implement health, target-list, grant, and WebSocket routes**

Register:

~~~text
GET  /dsh-browser-bridge/vite/health
GET  /dsh-browser-bridge/vite/targets
POST /dsh-browser-bridge/vite/grants
WS   /dsh-browser-bridge/vite/ws
~~~

health validates an HTTP(S) Origin, echoes that exact validated origin in Access-Control-Allow-Origin, returns only protocol/version status, sets Vary: Origin, and never sets Access-Control-Allow-Credentials. targets and grants accept only the exact local DSH Web origin inferred from the request host/protocol. Grant issuance resolves a live target and calls TargetCoordinator.offer; the returned body contains only the non-secret handle.

- [ ] **Step 5: Wire broker lifecycle into the host plugin**

Extend ConfigShape with concrete defaults:

~~~ts
viteMaxTargets?: number
viteMaxTargetsPerOrigin?: number
viteMaxFrameBytes?: number
viteMaxConcurrentCalls?: number
viteMaxFramesPerSecond?: number
viteHeartbeatMs?: number
viteDisconnectMs?: number
viteReconnectWindowMs?: number
~~~

Construct one broker, register it with ProviderRegistry, mount its routes, and dispose routes/broker before disposing the coordinator. On page close or heartbeat timeout, keep only the bounded reconnect tombstone; on origin change or reconnect-window expiry, revoke the target and its grants. Existing pair and extension WS paths remain unchanged.

- [ ] **Step 6: Run host integration and compatibility tests**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge exec vitest run tests/vite-broker.spec.ts tests/vite-routes.spec.ts tests/apply.spec.ts tests/composition.e2e.spec.ts
pnpm --filter @dsh-external/dsh-browser-bridge test
~~~

Expected: new Vite tests and every pre-existing host test pass.

- [ ] **Step 7: Commit the Vite host broker**

~~~bash
git add packages/dsh-plugin
git commit -m "feat: add Vite page target broker"
~~~

---

### Task 4: Make pre-step and browser tools capability-aware

**Files:**
- Modify: packages/dsh-plugin/src/pre-step.ts
- Modify: packages/dsh-plugin/src/tools/definitions.ts
- Modify: packages/dsh-plugin/src/tools/register.ts
- Modify: packages/dsh-plugin/tests/pre-step.spec.ts
- Modify: packages/dsh-plugin/tests/tools.spec.ts
- Modify: packages/dsh-plugin/tests/composition.e2e.spec.ts

- [ ] **Step 1: Write failing mixed-provider turn tests**

Create a turn containing one Chrome page with all operations and one Vite page with the reliable subset. Assert that:

- the prompt summary names provider and capabilities per page;
- tool union includes screenshot because the Chrome page supports it;
- requesting screenshot against the Vite alias throws unsupported_operation before dispatch;
- a Vite-only turn does not register screenshot or network;
- completion, cancellation, queue removal, timeout, and session disposal revoke both providers;
- cancel propagates through TargetCoordinator to the exact pending provider request only.

~~~ts
expect(summary).toContain('provider="vite"')
expect(summary).toContain('capabilities="observe,inspect,act,navigate,wait,console"')
expect(toolNames(viteOnlyAgent)).not.toContain('browser_screenshot')
expect(toolNames(viteOnlyAgent)).not.toContain('browser_network')
~~~

- [ ] **Step 2: Run targeted tests and verify they fail**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge exec vitest run tests/pre-step.spec.ts tests/tools.spec.ts
~~~

Expected: FAIL because PageAlias and ActiveTurn still assume TabDescriptor and BridgeServer.

- [ ] **Step 3: Replace tab-specific aliases with target-aware aliases**

~~~ts
export interface PageAlias {
  alias: string
  grantId: GrantId
  target: BrowserTargetDescriptor
}

export interface ActiveTurn {
  agent: Agent
  sessionId: string
  turn: number
  pages: PageAlias[]
  disposers: Array<() => void>
  removeAbortListener(): void
}
~~~

pre-step consumes markers through TargetCoordinator, renders sanitized provider/capability metadata, and keeps the existing external-evidence notice.

- [ ] **Step 4: Filter tools by the turn capability union and guard by target capability**

Split tool construction into a definition table keyed by BrowserOperation. registerTurnTools computes the union, creates only supported tools, and each execute path checks the selected PageAlias before forwarding:

~~~ts
if (!target.capabilities.includes(operation)) {
  throw new HarnessError(
    'unsupported_operation: ' + target.provider + ' target does not support ' + operation,
    'unsupported_operation',
  )
}
~~~

The screenshot implementation still uses attachments only when a Chrome-capable turn registers it.

- [ ] **Step 5: Route requests and cleanup through TargetCoordinator**

registerTurnTools calls coordinator.request. pre-step cleanup removes tools first, then coordinator.revokeTurn(sessionId, turn), preserving cancellation idempotence and write non-replay.

- [ ] **Step 6: Run targeted, complete host, and protocol tests**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge exec vitest run tests/pre-step.spec.ts tests/tools.spec.ts tests/composition.e2e.spec.ts
pnpm --filter @dsh-external/dsh-browser-bridge test
pnpm --filter @dsh-external/dsh-browser-bridge typecheck
~~~

Expected: mixed-provider assertions pass and existing Chrome tool rendering remains unchanged.

- [ ] **Step 7: Commit capability-aware turns**

~~~bash
git add packages/dsh-plugin/src/pre-step.ts packages/dsh-plugin/src/tools packages/dsh-plugin/tests
git commit -m "feat: scope browser tools by target capability"
~~~

---

### Task 5: Add Vite page references to DSH Web without weakening the extension channel

**Files:**
- Create: packages/dsh-plugin/src/client/vite-api.ts
- Create: packages/dsh-plugin/src/client/vite-source.ts
- Create: packages/dsh-plugin/src/client/vite-parent-channel.ts
- Create: packages/dsh-plugin/src/client/CurrentVitePageButton.tsx
- Create: packages/dsh-plugin/tests/vite-api.spec.ts
- Create: packages/dsh-plugin/tests/vite-source.spec.ts
- Create: packages/dsh-plugin/tests/vite-parent-channel.spec.ts
- Create: packages/dsh-plugin/tests/current-vite-page-button.spec.tsx
- Modify: packages/dsh-plugin/src/client/reference-store.ts
- Modify: packages/dsh-plugin/src/client/index.tsx
- Modify: packages/dsh-plugin/src/client/current-tab-button.css
- Modify: packages/dsh-plugin/tests/tab-source.spec.ts
- Modify: packages/dsh-plugin/tests/current-tab-button.spec.tsx

- [ ] **Step 1: Write failing standalone and embedded DSH Web client tests**

Assert that standalone DSH Web registers vite-pages even without a Chrome parent, an extension iframe still registers browser-tabs, and an embedded Vite panel exposes @当前开发页 only after Host verifies the parent-provided targetId.

~~~ts
it('keeps Vite discovery active outside an extension iframe', () => {
  applyClient(ctx, standaloneWindow())
  expect(ctx.slash.registeredSources()).toContain('vite-pages')
  expect(ctx.slash.registeredSources()).not.toContain('browser-tabs')
})
~~~

- [ ] **Step 2: Run the new and existing client tests and verify failure**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge exec vitest run tests/vite-api.spec.ts tests/vite-source.spec.ts tests/vite-parent-channel.spec.ts tests/current-vite-page-button.spec.tsx tests/client-channel.spec.ts
~~~

Expected: FAIL because the current client returns early unless its parent is chrome-extension.

- [ ] **Step 3: Generalize ReferenceStore without changing marker format**

Make ReferenceStore generic over a copied descriptor:

~~~ts
export interface TargetReference<T> {
  ref: GrantHandle
  target: T
  sessionId: string
  label: string
  createdAt: number
}

export class ReferenceStore<T> {
  allocate(sessionId: string, target: T, label: string): TargetReference<T>
  get(ref: string, sessionId?: string): TargetReference<T> | undefined
}
~~~

Update tab-source and CurrentTabButton to use ReferenceStore<TabDescriptor>; marker encoding remains exactly [[dsh-browser-context:handle]].

- [ ] **Step 4: Implement same-origin Vite target API and slash source**

ViteTargetApi fetches:

~~~ts
listTargets(signal): Promise<BrowserTargetDescriptor[]>
issueGrant(sessionId: string, targetId: TargetId, signal): Promise<{ handle: string }>
~~~

createViteSource mirrors browser-tabs but uses source vite-pages, shows title plus host and projectId, and requests the grant only during serialize.

- [ ] **Step 5: Implement the exact-parent MessageChannel handshake**

The Vite parent first posts one init message with a transferred port. The DSH client accepts it only when event.source === window.parent, records the exact HTTP(S) event.origin, rejects duplicate init messages, and then verifies targetId plus origin through ViteTargetApi before exposing a current-page button. Do not reuse or relax ExtensionChannel; chrome-extension origin validation remains unchanged.

- [ ] **Step 6: Refactor client apply to initialize providers independently**

Always register vite-pages. Attempt ExtensionChannel in a guarded branch and register browser-tabs/current-tab only when available. Attempt ViteParentChannel separately and register @当前开发页 only after verification. Dispose every source, slot, listener, abort, and MessagePort on plugin unload.

- [ ] **Step 7: Run the complete client test set and typecheck**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge exec vitest run tests/vite-api.spec.ts tests/vite-source.spec.ts tests/vite-parent-channel.spec.ts tests/current-vite-page-button.spec.tsx tests/tab-source.spec.ts tests/current-tab-button.spec.tsx tests/client-channel.spec.ts
pnpm --filter @dsh-external/dsh-browser-bridge test
pnpm --filter @dsh-external/dsh-browser-bridge typecheck
~~~

Expected: standalone, Vite-embedded, and extension-embedded modes all pass.

- [ ] **Step 8: Commit the DSH Web client integration**

~~~bash
git add packages/dsh-plugin/src/client packages/dsh-plugin/tests
git commit -m "feat: attach Vite pages from DSH Web"
~~~

---

### Task 6: Create page-runtime configuration, activation, identity, and transport

**Files:**
- Create: packages/page-runtime/package.json
- Create: packages/page-runtime/tsconfig.json
- Create: packages/page-runtime/tsdown.config.ts
- Create: packages/page-runtime/vitest.config.ts
- Create: packages/page-runtime/src/index.ts
- Create: packages/page-runtime/src/config.ts
- Create: packages/page-runtime/src/activation.ts
- Create: packages/page-runtime/src/identity.ts
- Create: packages/page-runtime/src/probe.ts
- Create: packages/page-runtime/src/transport/socket.ts
- Create: packages/page-runtime/src/runtime.ts
- Create: packages/page-runtime/tests/config.spec.ts
- Create: packages/page-runtime/tests/activation.spec.ts
- Create: packages/page-runtime/tests/identity.spec.ts
- Create: packages/page-runtime/tests/transport.spec.ts
- Modify: pnpm-lock.yaml

- [ ] **Step 1: Add package metadata and failing runtime-foundation tests**

Use package name @dsh-external/dsh-browser-bridge-page-runtime, ESM library output, DOM libs, protocol workspace dependency, jsdom Vitest environment, and tsdown build. Tests cover:

- loopback allowlist including localhost, *.localhost, 127/8, and ::1;
- rejection of credentials, non-HTTP(S), and remote redirects;
- dev auto-activation;
- production default zero-network dormancy;
- shortcut/query/persisted activation;
- panel.visible probe-only semantics;
- per-tab sessionStorage target identity;
- bounded exponential probe/socket reconnect without port scanning;
- reconnect queue never replaying accepted writes;
- AbortSignal cancellation aborting the exact in-flight dispatcher call;
- target/grant/console evidence never entering localStorage or extension storage.

- [ ] **Step 2: Run the package test and verify failure**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime test
~~~

Expected: FAIL because the package implementation does not exist.

- [ ] **Step 3: Implement strict serializable configuration**

~~~ts
export interface PageRuntimeConfig {
  dshOrigin: string
  mode: 'development' | 'production'
  bridge: {
    enabled: boolean
    autoConnectInBuild: boolean
  }
  panel: {
    enabled: boolean
    visible: boolean
    shortcut: string
    queryParameter: string
  }
  projectId?: string
}
~~~

normalizeDshOrigin returns an exact origin without path/query/fragment and rejects credentials or non-loopback hosts. No secret-bearing config key exists.

- [ ] **Step 4: Implement activation and health probe as separate states**

Use explicit states dormant, probing, available, connecting, connected, and failed. In production:

- visible=false and autoConnect=false does nothing until shortcut/query/persisted activation;
- visible=true probes health but does not connect/register;
- autoConnect=true probes then connects/registers;
- explicit activation probes, connects, and opens panel when enabled.

Probe only the exact configured /dsh-browser-bridge/vite/health endpoint with redirect manual, credentials omit, bounded timeout, and no port scan.

- [ ] **Step 5: Implement page identity and resilient Vite socket**

Store targetId and the last generation in namespaced sessionStorage keys. Validate stored values before reuse and monotonically increment generation across same-tab reloads. The socket sends hello/register, maps strict incoming tool calls to a supplied dispatcher, sends accepted before execution, correlates results, handles tool.cancel with a per-request AbortController, heartbeats every 15 seconds, and reconnects with bounded exponential backoff. Retry decisions remain Host-owned: the page never self-replays a tool call. Accepted writes settle as target_disconnected on loss and are never replayed.

- [ ] **Step 6: Implement the Runtime orchestrator shell**

startPageRuntime(config) owns activation, identity, probe, socket, generation, dispatcher placeholder, and dispose:

~~~ts
export interface PageRuntime {
  readonly targetId: TargetId
  activate(options?: { openPanel?: boolean }): Promise<void>
  notifyHmrUpdate(): void
  dispose(): void
}

export function startPageRuntime(config: PageRuntimeConfig): PageRuntime
~~~

No DOM tool or panel behavior is implemented in this task; the dispatcher returns unsupported_operation until later tasks register handlers.

- [ ] **Step 7: Run tests, typecheck, and build**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime test
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime typecheck
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime build
~~~

Expected: package foundation passes and produces ESM plus declarations.

- [ ] **Step 8: Commit the Runtime foundation**

~~~bash
git add packages/page-runtime pnpm-lock.yaml
git commit -m "feat: add Vite page runtime foundation"
~~~

---

### Task 7: Implement Vite observe, inspect, sensitive-value masking, and references

**Files:**
- Create: packages/page-runtime/src/refs/registry.ts
- Create: packages/page-runtime/src/tools/sanitize.ts
- Create: packages/page-runtime/src/tools/observe.ts
- Create: packages/page-runtime/src/tools/inspect.ts
- Create: packages/page-runtime/src/tools/dispatcher.ts
- Create: packages/page-runtime/tests/refs.spec.ts
- Create: packages/page-runtime/tests/sanitize.spec.ts
- Create: packages/page-runtime/tests/observe.spec.ts
- Create: packages/page-runtime/tests/inspect.spec.ts
- Modify: packages/page-runtime/src/runtime.ts
- Modify: packages/page-runtime/src/index.ts

- [ ] **Step 1: Write failing DOM evidence tests**

Create jsdom fixtures with headings, buttons, labels, controlled inputs, hidden nodes, detached nodes, password/card/token fields, long text, and requested computed-style properties. Assert:

~~~ts
expect(result.nodes.find(node => node.name === 'Save')?.role).toBe('button')
expect(JSON.stringify(result)).not.toContain('super-secret')
expect(() => refs.resolve(oldRef, generation + 1)).toThrowError(/stale_element/)
expect(inspected.rect).toEqual(expect.objectContaining({ width: expect.any(Number) }))
~~~

- [ ] **Step 2: Run targeted tests and verify failure**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime exec vitest run tests/refs.spec.ts tests/sanitize.spec.ts tests/observe.spec.ts tests/inspect.spec.ts
~~~

Expected: FAIL because the DOM tool modules do not exist.

- [ ] **Step 3: Implement generation-bound ElementRegistry**

Use random ElementRef keys mapped to Element plus generation. resolve checks reference format, current generation, element.isConnected, and the same Document. clear removes all records on HMR, navigation, disconnect, and dispose.

- [ ] **Step 4: Implement bounded semantic DOM projection**

observe walks document order, derives role/name from native semantics and ARIA, emits references only for actionable/meaningful elements, masks sensitive values, and returns page identity, viewport, text, nodes, generation, and truncation counts. Defaults remain 100 nodes and 20,000 characters; accepted maximums match the existing tool schema. Cap every individual string/result field before serialization so a single attribute, error, or console row cannot bypass the aggregate frame limit.

- [ ] **Step 5: Implement inspect with explicit property allowlisting**

Resolve either ref or selector, reject ambiguous missing inputs, return bounded attributes/text/selected computed properties/DOMRect/visibility, and mask sensitive values. Reject selectors that target outside the main document and return stale_element for disconnected references.

- [ ] **Step 6: Register observe and inspect in the dispatcher**

Dispatcher validates operation arguments with strict schemas before calling handlers, returns JSON-only values, and maps local failures to stable BridgeError objects.

- [ ] **Step 7: Run Runtime tests, typecheck, and build**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime test
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime typecheck
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime build
~~~

Expected: all Runtime tests pass and no secret fixture value appears in snapshots/output.

- [ ] **Step 8: Commit DOM evidence tools**

~~~bash
git add packages/page-runtime
git commit -m "feat: observe and inspect injected pages"
~~~

---

### Task 8: Implement actions, navigation, waits, console, and HMR generation

**Files:**
- Create: packages/page-runtime/src/tools/act.ts
- Create: packages/page-runtime/src/tools/navigate.ts
- Create: packages/page-runtime/src/tools/wait.ts
- Create: packages/page-runtime/src/tools/console.ts
- Create: packages/page-runtime/src/hmr.ts
- Create: packages/page-runtime/tests/act.spec.ts
- Create: packages/page-runtime/tests/navigate.spec.ts
- Create: packages/page-runtime/tests/wait.spec.ts
- Create: packages/page-runtime/tests/console.spec.ts
- Create: packages/page-runtime/tests/hmr.spec.ts
- Modify: packages/page-runtime/src/tools/dispatcher.ts
- Modify: packages/page-runtime/src/runtime.ts

- [ ] **Step 1: Write failing interaction and lifecycle tests**

Cover native setter plus input/change for React/Vue-style controlled fields, select, focus, key, scroll, synthetic hover disclosure, same-origin navigation, cross-origin rejection before navigation, DOM quiet waits, next-generation waits, bounded console, error/unhandledrejection, and listener restoration on dispose.

~~~ts
expect(typeEvents).toEqual(['input', 'change'])
expect(hoverResult).toMatchObject({ synthetic: true, cssPseudoState: false })
await expect(navigate({ url: 'https://other.example/' }))
  .rejects.toMatchObject({ code: 'navigation_requires_confirmation' })
~~~

- [ ] **Step 2: Run targeted tests and verify failure**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime exec vitest run tests/act.spec.ts tests/navigate.spec.ts tests/wait.spec.ts tests/console.spec.ts tests/hmr.spec.ts
~~~

Expected: FAIL because the new handlers do not exist.

- [ ] **Step 3: Implement reliable action semantics**

click uses HTMLElement.click; type uses the prototype-native value setter and input/change events; select sets selected values and emits input/change; focus calls focus; press emits synthetic KeyboardEvent; scroll uses element/window scrollBy; hover emits pointer/mouse enter/over/move only and returns synthetic=true, cssPseudoState=false. Any operation requiring isTrusted returns unsupported_operation.

- [ ] **Step 4: Implement same-origin navigation and bounded waits**

Navigate accepts exactly one of url/history/reload. URL navigation must be same-origin for the Vite MVP. Wait supports selector/text/url/ready/stable plus a Vite generation condition:

~~~ts
{ kind: 'generation', after: number }
~~~

Use AbortSignal and a hard timeout on every wait; MutationObserver and event listeners must always disconnect in finally.

- [ ] **Step 5: Implement console capture and cleanup**

Wrap console methods while preserving original this binding and return values. Capture bounded primitive-safe text plus window error and unhandledrejection after injection, tag each row with generation, cap at 200, mask sensitive patterns, and restore all originals/listeners on dispose. Clear the buffer on target revoke/termination as well as Runtime disposal; do not persist it.

- [ ] **Step 6: Implement HMR generation updates**

notifyHmrUpdate increments and persists generation, clears refs, waits for a bounded DOM quiet window, sends target.update, and wakes generation waiters. Full same-origin reload reuses targetId but starts with a new Runtime and generation greater than the stored previous generation. Production Runtime does not install an HMR listener, and generation waits return unsupported_operation when HMR is unavailable.

- [ ] **Step 7: Run the full Runtime verification**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime test
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime typecheck
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime build
~~~

Expected: all Runtime tests pass; screenshot and network are still absent from dispatcher registrations.

- [ ] **Step 8: Commit the reliable Vite tool subset**

~~~bash
git add packages/page-runtime
git commit -m "feat: operate and track Vite pages"
~~~

---

### Task 9: Add the optional Shadow DOM DSH Web panel

**Files:**
- Create: packages/page-runtime/src/panel/styles.ts
- Create: packages/page-runtime/src/panel/channel.ts
- Create: packages/page-runtime/src/panel/panel.ts
- Create: packages/page-runtime/tests/panel-channel.spec.ts
- Create: packages/page-runtime/tests/panel.spec.ts
- Modify: packages/page-runtime/src/activation.ts
- Modify: packages/page-runtime/src/runtime.ts
- Modify: packages/page-runtime/src/index.ts

- [ ] **Step 1: Write failing panel isolation and visibility tests**

Assert that:

- panel.enabled=false creates no host element but bridge activation still connects;
- visible=false creates no visible launcher before explicit activation;
- visible=true performs health probe only and shows launcher only after success;
- opening creates one Shadow Root and sandboxed iframe at exact dshOrigin;
- init uses a transferred MessagePort, exact target origin, and no wildcard postMessage;
- embedding failure leaves target connection alive and offers exact-origin new-tab fallback;
- dispose removes DOM, listeners, ports, and timers.

- [ ] **Step 2: Run panel tests and verify failure**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime exec vitest run tests/panel-channel.spec.ts tests/panel.spec.ts
~~~

Expected: FAIL because the panel modules do not exist.

- [ ] **Step 3: Implement an isolated minimal panel**

Use one fixed host element with a Shadow Root and styles from styles.ts. Implement launcher, resizable drawer, connection banner, close control, retry diagnostic, and open-local-DSH fallback using plain DOM so the injected package remains framework-neutral.

- [ ] **Step 4: Implement exact-origin iframe and MessageChannel**

The iframe src is exactly dshOrigin. Apply the existing minimal sandbox:

~~~text
allow-scripts allow-same-origin allow-forms allow-popups allow-modals
~~~

After iframe load, transfer one MessagePort in a single init event sent to exact dshOrigin. Include targetId only. Require ready on the port within five seconds; timeout maps to embedding_blocked without disconnecting the target Runtime.

- [ ] **Step 5: Wire visibility and activation semantics**

visible=true calls probe and only renders launcher on success. Shortcut/query/persisted activation calls probe, connects/registers, and opens panel when enabled. panel.enabled=false skips UI but still runs the bridge activation pipeline.

- [ ] **Step 6: Run Runtime tests, typecheck, and build**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime test
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime typecheck
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime build
~~~

Expected: all panel and previous Runtime tests pass.

- [ ] **Step 7: Commit the optional panel**

~~~bash
git add packages/page-runtime
git commit -m "feat: embed local DSH Web in Vite pages"
~~~

---

### Task 10: Create the Vite plugin and inject Runtime in dev/build

**Files:**
- Create: packages/vite-plugin/package.json
- Create: packages/vite-plugin/tsconfig.json
- Create: packages/vite-plugin/tsdown.config.ts
- Create: packages/vite-plugin/vitest.config.ts
- Create: packages/vite-plugin/src/index.ts
- Create: packages/vite-plugin/src/options.ts
- Create: packages/vite-plugin/src/serialize.ts
- Create: packages/vite-plugin/src/virtual-entry.ts
- Create: packages/vite-plugin/tests/options.spec.ts
- Create: packages/vite-plugin/tests/serialize.spec.ts
- Create: packages/vite-plugin/tests/injection.spec.ts
- Create: packages/vite-plugin/tests/build.spec.ts
- Create: packages/vite-plugin/tests/fixtures/multi-page/index.html
- Create: packages/vite-plugin/tests/fixtures/multi-page/admin.html
- Modify: pnpm-lock.yaml

- [ ] **Step 1: Add package metadata and failing plugin tests**

Use package name @dsh-external/dsh-browser-bridge-vite, ESM output, Vite ^8 peer dependency, page-runtime workspace dependency, and Vitest. The public plugin options retain bridge.injectInBuild, while the serialized PageRuntimeConfig omits that build-only switch. Tests cover:

- bridge.enabled=false injects nothing;
- serve injects by default;
- build injects only with injectInBuild=true;
- both HTML entries receive exactly one module script;
- serialized config escapes less-than, U+2028, and U+2029;
- mode and projectId are deterministic;
- no secret-shaped option is accepted.

- [ ] **Step 2: Run plugin tests and verify failure**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-vite test
~~~

Expected: FAIL because the plugin package does not exist.

- [ ] **Step 3: Implement strict options and safe serialization**

Export dshBrowserBridge(options). Resolve defaults exactly from the spec. Validate dshOrigin through page-runtime config logic. Serialize only normalized public configuration:

~~~ts
function serializeConfig(value: PageRuntimeConfig): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
~~~

- [ ] **Step 4: Implement a virtual Runtime module and HTML injection**

Use virtual:dsh-browser-bridge/runtime with a null-byte internal ID. The virtual module starts Runtime and wires official HMR events:

~~~ts
import { startPageRuntime } from '@dsh-external/dsh-browser-bridge-page-runtime'

const runtime = startPageRuntime(PUBLIC_CONFIG)
if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', () => runtime.notifyHmrUpdate())
  import.meta.hot.dispose(() => runtime.dispose())
}
~~~

transformIndexHtml injects one type=module script referencing the virtual entry. apply/configResolved enforce serve always and build only when injectInBuild=true. Do not inject into library mode or non-HTML SSR output.

- [ ] **Step 5: Verify real dev transform and production multi-page build**

Use Vite createServer/build APIs in tests with temporary outDir. Assert development output includes the virtual entry, default build does not, explicit build does, and generated assets contain no absolute repository path or secret-like fields.

- [ ] **Step 6: Run plugin tests, typecheck, and build**

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-vite test
pnpm --filter @dsh-external/dsh-browser-bridge-vite typecheck
pnpm --filter @dsh-external/dsh-browser-bridge-vite build
~~~

Expected: all injection/build tests pass on Vite 8.2.1.

- [ ] **Step 7: Commit the Vite plugin**

~~~bash
git add packages/vite-plugin pnpm-lock.yaml
git commit -m "feat: inject browser bridge with Vite"
~~~

---

### Task 11: Add real browser, framework, HTTPS, CSP, and end-to-end coverage

**Files:**
- Create: e2e/vite-harness.ts
- Create: e2e/vite-provider.spec.ts
- Create: e2e/vite-security.spec.ts
- Create: e2e/fixtures/vite/vanilla/index.html
- Create: e2e/fixtures/vite/vanilla/main.ts
- Create: e2e/fixtures/vite/react/index.html
- Create: e2e/fixtures/vite/react/main.tsx
- Create: e2e/fixtures/vite/vue/index.html
- Create: e2e/fixtures/vite/vue/main.ts
- Create: e2e/fixtures/vite/vite.config.ts
- Create: docs/testing/vite-provider-manual.md
- Modify: e2e/fixture-server.ts
- Modify: playwright.config.ts
- Modify: package.json
- Modify: pnpm-lock.yaml

- [ ] **Step 1: Write failing Playwright Vite-provider scenarios**

The deterministic harness must emulate/host the local DSH Vite broker and record redacted frames. Browser tests cover:

- standalone DSH Web lists a connected page;
- embedded panel handshake identifies current page;
- Vanilla observe/inspect/act/wait/console;
- React and Vue controlled input emits input/change and updates rendered state;
- HMR invalidates old refs and generation wait completes;
- multi-page aliases route to exact targets;
- Vite screenshot/network return unsupported_operation;
- panel.enabled=false keeps headless bridge usable.
- a page without an explicit @ reference creates no model tools;
- completion, cancellation, queue removal, expiry, page close, and cross-origin departure revoke access;
- console and page evidence disappear on revoke and are not persisted.

- [ ] **Step 2: Add HTTPS and CSP security scenarios**

Use a runtime-generated test certificate and Playwright ignoreHTTPSErrors only for the fixture. Verify:

- HTTPS target reaches exact loopback HTTP/WS DSH in Chrome/Chromium;
- default production dormancy sends no loopback request;
- visible=true probes but does not register before activation;
- autoConnectInBuild=true probes and registers;
- frame-src/connect-src blocking produces embedding_blocked/local_access_blocked diagnostics;
- non-loopback dshOrigin and redirect are rejected before connection;
- target frames cannot issue grants or host commands.

- [ ] **Step 3: Run the focused browser tests and confirm the first failure**

~~~bash
pnpm exec playwright test e2e/vite-provider.spec.ts e2e/vite-security.spec.ts
~~~

Expected: FAIL until the harness, fixtures, and remaining integration wiring are complete.

- [ ] **Step 4: Complete only the integration gaps exposed by the browser tests**

Keep fixes in the owning package: protocol bugs in protocol, routing in dsh-plugin, DOM behavior in page-runtime, injection in vite-plugin. Do not add browser-only exceptions to the shared host path. Add a regression test beside every fix before changing implementation.

- [ ] **Step 5: Create the exact Chrome and Arc manual gate**

docs/testing/vite-provider-manual.md must record:

~~~text
Chrome:
- dev page: embedded DSH Web opens
- production HTTPS page: local DSH probe/connect succeeds
- @当前开发页: observe, controlled input, HMR, revoke

Arc:
- same four checks without extension installation
- launcher hidden/visible policy
- panel close/reopen and standalone @开发页面
- CSP failure diagnostic

Evidence:
- browser version
- DSH version
- tested URL and config
- pass/fail plus screenshot or short recording path
~~~

- [ ] **Step 6: Run automated browser and package regressions**

~~~bash
pnpm exec playwright test e2e/vite-provider.spec.ts e2e/vite-security.spec.ts
pnpm test
pnpm typecheck
pnpm build
~~~

Expected: all automated suites pass. Manual Chrome/Arc status must be reported separately and may not be inferred from Chromium.

- [ ] **Step 7: Perform and record Chrome/Arc manual acceptance**

Start local DSH and the dev/HTTPS production fixtures, execute every checklist row, and write browser versions plus evidence into a dated section of docs/testing/vite-provider-manual.md. If Arc fails, stop release completion and retain the exact failing step; do not mark the feature accepted.

- [ ] **Step 8: Commit browser and security evidence**

~~~bash
git add e2e docs/testing package.json pnpm-lock.yaml packages
git commit -m "test: cover Vite provider browser flows"
~~~

---

### Task 12: Document, verify, and prepare the implementation handoff

**Files:**
- Modify: README.md
- Modify: INSTALL.md
- Modify: packages/protocol/README.md
- Modify: packages/dsh-plugin/README.md
- Create: packages/page-runtime/README.md
- Create: packages/vite-plugin/README.md
- Modify: docs/testing/vite-provider-manual.md

- [ ] **Step 1: Write user-facing installation and configuration documentation**

README must present Extension and Vite as complementary providers. Add the approved configuration example, @开发页面/@当前开发页 workflow, dev/build defaults, panel.enabled/visible behavior, reliable capability table, local-only DSH boundary, CSP requirements, and Chrome/Arc status.

- [ ] **Step 2: Add executable setup and troubleshooting commands**

INSTALL.md must include:

~~~bash
pnpm add -D @dsh-external/dsh-browser-bridge-vite
~~~

and a complete vite.config.ts example. Troubleshooting must map dsh_unavailable, local_access_blocked, embedding_blocked, target_disconnected, unsupported_operation, stale_element, protocol_mismatch, and timeout to concrete checks.

- [ ] **Step 3: Verify package metadata and public exports**

Run:

~~~bash
pnpm --filter @dsh-external/dsh-browser-bridge-protocol test
pnpm --filter @dsh-external/dsh-browser-bridge-page-runtime test
pnpm --filter @dsh-external/dsh-browser-bridge-vite test
pnpm --filter @dsh-external/dsh-browser-bridge test
pnpm check
pnpm test:e2e
git diff --check
~~~

Expected: every command exits 0. Report exact test counts from the fresh output. Warnings are recorded separately from failures.

- [ ] **Step 4: Check spec coverage and forbidden regressions**

Run:

~~~bash
rg -n "browser_screenshot|browser_network|isTrusted|:hover" packages/page-runtime packages/vite-plugin README.md
rg -n "chrome-extension|tabId|windowId" packages/protocol/src/vite-frames.ts packages/page-runtime packages/vite-plugin
rg --pcre2 -n "https?://(?!127\\.|localhost|\\[::1\\])" packages/page-runtime/src/config.ts
git status --short
~~~

Expected:

- screenshot/network appear only in unsupported-capability documentation/tests, never Vite dispatcher registration;
- Vite packages contain no Chrome tab identity dependency;
- Runtime config has no remote DSH allowance;
- only intentional documentation or evidence changes remain.

- [ ] **Step 5: Commit documentation and final verification state**

~~~bash
git add README.md INSTALL.md packages/*/README.md docs/testing/vite-provider-manual.md
git commit -m "docs: add Vite browser bridge provider"
~~~

- [ ] **Step 6: Produce the final implementation report without pushing**

Report:

- commits created per task;
- exact tests/builds run and pass/fail counts;
- Chrome and Arc manual evidence separately;
- any warnings or remaining release blockers;
- final git status and local branch divergence;
- no DSH source changes;
- no push unless the user explicitly requests CP.

---

## Plan self-review checklist

- [ ] Every approved spec section maps to at least one task.
- [ ] Existing Extension protocol schemas stay unchanged and their tests run throughout.
- [ ] Vite screenshot/network/native CSS hover/trusted input are never represented as reliable capabilities.
- [ ] panel.enabled=false preserves the bridge.
- [ ] Production defaults to no injection; explicit injection defaults to zero-network dormancy.
- [ ] Only loopback DSH origins are accepted.
- [ ] Grants remain prompt/turn/target scoped and writes are never replayed.
- [ ] Chrome and Arc acceptance is recorded separately from automated Chromium.
- [ ] Every task begins with a failing test and ends with focused verification plus a local commit.
- [ ] No step modifies DSH source or pushes without CP.
