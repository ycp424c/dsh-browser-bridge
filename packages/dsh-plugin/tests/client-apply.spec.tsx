// @vitest-environment jsdom
/**
 * Client plugin apply wiring on a real cordis Context + SlotsService: the
 * current-tab button must register into the official
 * `conversation.input.dock` list slot with order 30 — after the host's
 * Todo(0)/Goal(10)/Queue(20) rows, closest to the input card — while the
 * per-session inject face keeps resolving the channel/store the component
 * needs to attach the current tab.
 */
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScope, scopeOf, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SlashServiceContract } from '@deepseek-ai/dsh-client-ui-slash/src/client/contract.ts'
import { apply, inject } from '../src/client/index.tsx'
import { CurrentTabButton, type CurrentTabButtonInjected } from '../src/client/CurrentTabButton.tsx'
import { ExtensionChannel } from '../src/client/extension-channel.ts'
import { ReferenceStore } from '../src/client/reference-store.ts'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const sid = (k: string): SessionId => k as SessionId

/**
 * One browser-like bench: a real cordis Context with the SlotsService, a
 * sessions face over one minted Agent scope, and a slash face recording
 * source registrations. The `conversation.input.dock` slot is declared
 * through a stand-in root entry (the ui-conversation composer entry's
 * children table) before the plugin loads.
 */
async function bench() {
  Object.defineProperty(window.document, 'referrer', {
    value: `${EXT}/sidepanel.html`,
    configurable: true,
  })
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const slots = ctx.get('slots') as SlotsService
  slots.register(
    { name: 'root', children: { 'conversation.input.dock': { kind: 'list', scope: 'session' } } } as never,
    () => null,
  )
  // Host rows sharing the same strip: Todo(0), Goal(10), Queue(20).
  slots.register({ name: 'conversation.input.dock', id: 'todo', order: 0 } as never, () => null)
  slots.register({ name: 'conversation.input.dock', id: 'goal', order: 10 } as never, () => null)
  slots.register({ name: 'conversation.input.dock', id: 'queue', order: 20 } as never, () => null)

  const scope = createScope(ctx, sid('a'))
  ctx.provide('sessions', {
    scope: (id: SessionId) => (id === sid('a') ? scope.ctx : undefined),
    scopeOf: (c: Context) => scopeOf(c),
  })
  const slash: SlashServiceContract = {
    registerSource: vi.fn(() => () => {}),
    sessionOf: vi.fn(),
  }
  ctx.provide('slash', slash)
  return { ctx, slots, scope, slash }
}

describe('client apply', () => {
  beforeEach(() => {
    // The effect pairs with the host on boot; keep it deterministic and quiet.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('declares the slash/sessions/slots dependencies', () => {
    expect(inject).toEqual(['slash', 'sessions', 'slots'])
  })

  it('keeps Vite discovery active outside an extension iframe', async () => {
    const { ctx, slash } = await bench()
    // bench() wires the extension referrer; a standalone DSH Web has none.
    Object.defineProperty(window.document, 'referrer', { value: '', configurable: true })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const names = slash.registerSource.mock.calls.map(call => (call[0] as { name: string }).name)
    expect(names).toContain('vite-pages')
    expect(names).not.toContain('browser-tabs')
    await fiber.dispose()
  })

  it('registers the button into conversation.input.dock with order 30, after the host dock rows', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entries = slots.entries('conversation.input.dock')
    expect(entries.map(entry => entry.options.id)).toEqual([
      'todo',
      'goal',
      'queue',
      'dsh-browser-bridge-current-tab',
    ])
    const ours = entries[3]!
    expect(ours.options.id).toBe('dsh-browser-bridge-current-tab')
    expect(ours.options.order).toBe(30)
    expect(ours.component).toBe(CurrentTabButton)

    await fiber.dispose()
    expect(slots.entries('conversation.input.dock').map(entry => entry.options.id)).toEqual([
      'todo',
      'goal',
      'queue',
    ])
  })

  it('resolves the per-session inject face to the session scope, channel and store', async () => {
    const { ctx, slots, scope } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = slots.entries('conversation.input.dock').find(candidate => candidate.options.id === 'dsh-browser-bridge-current-tab')
    expect(entry).toBeDefined()
    const injectEntry = entry!.inject as unknown as (sessionId: SessionId) => CurrentTabButtonInjected
    const injected = injectEntry(sid('a'))
    expect(injected.actx).toBe(scope.ctx)
    expect(injected.channel).toBeInstanceOf(ExtensionChannel)
    expect(injected.store).toBeInstanceOf(ReferenceStore)
    // Unknown session ids fail loud (no silent scope miss).
    expect(() => injectEntry(sid('ghost'))).toThrow(/session scope missing/)

    await fiber.dispose()
  })

  it('registers the browser-tabs source and tears the slot entry down with the fiber', async () => {
    const { ctx, slots, slash } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const calls = slash.registerSource.mock.calls.map(call => call[0] as { name?: string; order?: number })
    expect(calls.map(call => call.name)).toContain('vite-pages')
    const source = calls.find(call => call.name === 'browser-tabs')!
    expect(source).toMatchObject({ name: 'browser-tabs', order: -20 })

    await fiber.dispose()
    expect(slots.entries('conversation.input.dock').some(entry => entry.options.id === 'dsh-browser-bridge-current-tab')).toBe(false)
  })
})
