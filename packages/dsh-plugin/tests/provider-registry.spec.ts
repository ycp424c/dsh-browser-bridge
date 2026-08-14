import { describe, expect, it } from 'vitest'
import {
  newTargetId,
  VITE_BROWSER_CAPABILITIES,
  type BrowserOperation,
  type BrowserTargetDescriptor,
  type JsonValue,
  type RequestId,
} from '@ycp424c/dsh-browser-bridge-protocol'
import { GrantStore } from '../src/bridge/grant-store.ts'
import { TargetCoordinator } from '../src/targets/coordinator.ts'
import { ProviderRegistry } from '../src/targets/provider-registry.ts'
import type { BrowserProvider, TargetBinding } from '../src/targets/types.ts'

interface FakeRequest {
  resolve(value: JsonValue): void
  reject(error: unknown): void
}

interface FakeProviderState {
  provider: BrowserProvider
  /** Build a TargetBinding owned by this fake provider. */
  binding(targetId: string, connectionId: string): TargetBinding
  requests: Array<{
    target: TargetBinding
    requestId: RequestId
    operation: BrowserOperation
    args: JsonValue
    signal: AbortSignal
  }>
  revokes: Array<{ target: TargetBinding; grantId: string }>
  /** Connections explicitly marked dead; everything else is live. */
  disconnected: Set<string>
  /** The settlement handle of the most recent request. */
  lastRequest: FakeRequest | undefined
}

function fakeProvider(kind: 'chrome-extension' | 'vite'): FakeProviderState {
  const state: FakeProviderState = {
    requests: [],
    revokes: [],
    disconnected: new Set(),
    lastRequest: undefined,
    binding: (targetId, connectionId) => (
      kind === 'vite' ? viteBinding(targetId, connectionId) : chromeBinding(connectionId)
    ),
    provider: {
      kind,
      isConnected: target => !state.disconnected.has(target.connectionId),
      request: (target, requestId, operation, args, signal) => {
        state.requests.push({ target, requestId, operation, args, signal })
        return new Promise<JsonValue>((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason)
            return
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          state.lastRequest = { resolve, reject }
        })
      },
      revoke: (target, grantId) => {
        state.revokes.push({ target, grantId })
      },
    },
  }
  return state
}

function viteBinding(targetId: string, connectionId: string): TargetBinding {
  return {
    descriptor: {
      targetId: targetId as never,
      provider: 'vite',
      title: 'Vite Page',
      url: 'http://127.0.0.1:5173/',
      origin: 'http://127.0.0.1:5173',
      projectId: 'app',
      generation: 0,
      capabilities: [...VITE_BROWSER_CAPABILITIES],
    },
    connectionId: connectionId as never,
    // The logical key is target-bound, not connection-bound: it survives
    // legal reconnects of the same page.
    logicalKey: `vite:${targetId}`,
  }
}

function chromeBinding(connectionId: string): TargetBinding {
  return {
    descriptor: {
      targetId: newTargetId(),
      provider: 'chrome-extension',
      title: 'Tab',
      url: 'https://example.test/',
      origin: 'https://example.test',
      generation: 0,
      capabilities: ['observe', 'inspect', 'screenshot', 'act', 'navigate', 'wait', 'console', 'network'],
    },
    connectionId: connectionId as never,
    logicalKey: 'chrome:2:7',
  }
}

function makeCoordinator(providers: FakeProviderState[]): { coordinator: TargetCoordinator; grants: GrantStore } {
  const grants = new GrantStore()
  const registry = new ProviderRegistry(providers.map(state => state.provider))
  const coordinator = new TargetCoordinator({ providers: registry, grants })
  return { coordinator, grants }
}

describe('provider registry', () => {
  it('rejects duplicate provider registration and unknown providers', () => {
    const state = fakeProvider('vite')
    const registry = new ProviderRegistry([state.provider])
    expect(() => registry.register(state.provider)).toThrow(/duplicate/)
    expect(registry.get('vite')).toBe(state.provider)
    expect(registry.get('chrome-extension')).toBeUndefined()
  })
})

describe('target coordinator', () => {
  it('routes a grant only to its bound provider and logical target', async () => {
    const chrome = fakeProvider('chrome-extension')
    const vite = fakeProvider('vite')
    const { coordinator } = makeCoordinator([chrome, vite])
    const record = coordinator.offer({
      sessionId: 'session-a',
      expiresAt: Date.now() + 60_000,
      target: vite.binding('target-a', 'connection-a'),
    })
    coordinator.consumeBatch([record.handle], { sessionId: 'session-a', turn: 1 })
    const pending = coordinator.request(record.grantId, 'observe', {}, AbortSignal.timeout(1_000))
    expect(vite.requests).toHaveLength(1)
    expect(chrome.requests).toHaveLength(0)
    expect(vite.requests[0]!.target.connectionId).toBe('connection-a')
    vite.lastRequest!.resolve({ ok: true })
    await pending
  })

  it('offers with an explicit id and rejects duplicates', () => {
    const vite = fakeProvider('vite')
    const { coordinator } = makeCoordinator([vite])
    const binding = vite.binding('target-a', 'connection-a')
    coordinator.offerWithId('g-1', { sessionId: 's', expiresAt: Date.now() + 60_000, target: binding })
    expect(() => coordinator.offerWithId('g-1', { sessionId: 's', expiresAt: Date.now() + 60_000, target: binding }))
      .toThrow(/duplicate/)
  })

  it('returns unsupported_operation without forwarding to the target', async () => {
    const vite = fakeProvider('vite')
    const { coordinator } = makeCoordinator([vite])
    const record = coordinator.offer({
      sessionId: 'session-a',
      expiresAt: Date.now() + 60_000,
      target: vite.binding('target-a', 'connection-a'),
    })
    await expect(coordinator.request(record.grantId, 'screenshot', {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unsupported_operation' })
    expect(vite.requests).toHaveLength(0)
  })

  it('rejects consumption when the bound target is not live (atomically)', () => {
    const vite = fakeProvider('vite')
    const { coordinator } = makeCoordinator([vite])
    const binding = vite.binding('target-a', 'connection-a')
    const record = coordinator.offer({ sessionId: 's', expiresAt: Date.now() + 60_000, target: binding })
    vite.disconnected.add('connection-a')
    expect(() => coordinator.consumeBatch([record.handle], { sessionId: 's', turn: 1 }))
      .toThrowError(expect.objectContaining({ code: 'target_disconnected' }))
    // Liveness restored: consumption succeeds.
    vite.disconnected.delete('connection-a')
    expect(coordinator.consumeBatch([record.handle], { sessionId: 's', turn: 1 })).toHaveLength(1)
  })

  it('rejects expired grants at consume time', () => {
    let now = 1_000
    const vite = fakeProvider('vite')
    const grants = new GrantStore({ now: () => now })
    const registry = new ProviderRegistry([vite.provider])
    const coordinator = new TargetCoordinator({ providers: registry, grants })
    const record = coordinator.offer({
      sessionId: 's',
      expiresAt: now + 30_000,
      target: vite.binding('target-a', 'connection-a'),
    })
    now = 1_000 + 31_000
    expect(() => coordinator.consumeBatch([record.handle], { sessionId: 's', turn: 1 }))
      .toThrowError(expect.objectContaining({ code: 'grant_expired' }))
  })

  it('revokeTurn notifies the owning provider with complete records and cancels pending calls', async () => {
    const vite = fakeProvider('vite')
    const { coordinator } = makeCoordinator([vite])
    const record = coordinator.offer({
      sessionId: 's',
      expiresAt: Date.now() + 60_000,
      target: vite.binding('target-a', 'connection-a'),
    })
    coordinator.consumeBatch([record.handle], { sessionId: 's', turn: 1 })
    const controller = new AbortController()
    const pending = coordinator.request(record.grantId, 'observe', {}, controller.signal)
    coordinator.revokeConnectionTurn('connection-a', 's', 1)
    expect(vite.revokes).toEqual([
      expect.objectContaining({ grantId: record.grantId, target: expect.objectContaining({ connectionId: 'connection-a' }) }),
    ])
    // The provider contract rejects the pending call (host never replays a
    // revoked grant's work).
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(() => coordinator.consumeBatch([record.handle], { sessionId: 's', turn: 1 })).toThrow()
  })

  it('rebinds grants of a same-target reconnect and refuses live-target takeover', async () => {
    const vite = fakeProvider('vite')
    const { coordinator } = makeCoordinator([vite])
    const targetId = newTargetId()
    const first = vite.binding(targetId, 'connection-a')
    const second = vite.binding(targetId, 'connection-b')
    const record = coordinator.offer({ sessionId: 's', expiresAt: Date.now() + 60_000, target: first })
    // Takeover of a still-live target is rejected.
    expect(() => coordinator.rebindTarget(
      { targetId: targetId as never, origin: first.descriptor.origin },
      second,
    )).toThrowError(expect.objectContaining({ code: 'target_disconnected' }))
    // The live connection drops; a legal rebind re-points the grant.
    vite.disconnected.add('connection-a')
    coordinator.rebindTarget(
      { targetId: targetId as never, origin: first.descriptor.origin },
      second,
    )
    const pending = coordinator.request(record.grantId, 'observe', {}, AbortSignal.timeout(1_000))
    expect(vite.requests).toHaveLength(1)
    expect(vite.requests[0]!.target.connectionId).toBe('connection-b')
    vite.lastRequest!.resolve({ ok: true })
    await pending
    // A grant consumed after the rebind resolves through the new connection.
    expect(coordinator.consumeBatch([record.handle], { sessionId: 's', turn: 1 })).toHaveLength(1)
  })

  it('routes chrome grants through the chrome-extension provider with the same grant.accepted semantics', async () => {
    const chrome = fakeProvider('chrome-extension')
    const { coordinator } = makeCoordinator([chrome])
    const binding = chrome.binding('connection-c')
    const record = coordinator.offerWithId('g-chrome-1', {
      sessionId: 'session-a',
      expiresAt: Date.now() + 30_000,
      target: binding,
    })
    expect(record.handle).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
    const pending = coordinator.request(record.grantId, 'observe', {}, AbortSignal.timeout(1_000))
    expect(chrome.requests).toHaveLength(1)
    expect(chrome.requests[0]!.target.descriptor.provider).toBe('chrome-extension')
    chrome.lastRequest!.resolve({ ok: true })
    await pending
  })
})
