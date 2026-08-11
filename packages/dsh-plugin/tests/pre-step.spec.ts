import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { agentEvents, Inbox, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type UserMessage } from '@deepseek-ai/dsh-session'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import {
  ConnectionId, GrantId, encodeMarker, type TabDescriptor,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { GrantStore } from '../src/bridge/grant-store.ts'
import { BridgeServer, type BridgeSocket } from '../src/bridge/server.ts'
import { PairingStore } from '../src/bridge/pairing-store.ts'
import { createPreStepHandler, type PreStepHandlerDeps } from '../src/pre-step.ts'
import { registerTurnTools } from '../src/tools/register.ts'
import { FakeAttachments } from './fake-attachments.ts'

const EXT_A = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const TAB: TabDescriptor = { tabId: 7, windowId: 2, title: 'Fixture', url: 'http://127.0.0.1:4173/' }
const TAB2: TabDescriptor = { tabId: 8, windowId: 2, title: 'Other', url: 'http://127.0.0.1:4174/' }

class FakeSocket implements BridgeSocket {
  sent: string[] = []
  closed = false
  private messageHandlers: ((text: string) => void)[] = []
  private closeHandlers: (() => void)[] = []

  onMessage(handler: (text: string) => void): void { this.messageHandlers.push(handler) }
  onClose(handler: () => void): void { this.closeHandlers.push(handler) }
  send(text: string): void { this.sent.push(text) }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const handler of this.closeHandlers) handler()
  }
  receive(text: string): void { for (const handler of this.messageHandlers) handler(text) }
}

async function stubAgent(ctx: Context, id: string): Promise<Agent> {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd: '/tmp' })
  const agent = {
    id: sessionId,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    options: {},
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  // The scoped context resolves services through the MINTING plugin's
  // dependency chain (the agent loop's inject list plays this role in
  // production). DSH 0810 agents inherit the AgentLoop dependency surface:
  // tools and systemPrompt only — attachments belong to the bridge plugin.
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] }))
  ;(agent as unknown as { ctx: Context }).ctx = scope.ctx.extend({ agent })
  return agent
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function textOf(decision: PreStepDecision): string {
  if (decision.kind === 'reject') return ''
  return decision.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('\n')
}

async function proposeStep(
  ctx: Context,
  agent: Agent,
  message: UserMessage,
  turn: number,
  signal: AbortSignal = new AbortController().signal,
): Promise<PreStepDecision> {
  agent.inbox.append('next-turn', message)
  const claimed = agent.inbox.claim('next-turn', turn)
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: claimed, turn, step: 1, signal },
    () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: claimed }),
  )
}

async function fireTurnStopping(ctx: Context, agent: Agent, turn: number): Promise<void> {
  await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn, signal: new AbortController().signal })
}

interface Fixture {
  ctx: Context
  agent: Agent
  server: BridgeServer
  grants: GrantStore
  pairing: PairingStore
  socket: FakeSocket
  connectionId: string
  offer(connectionId: string, sessionId: string, tab: TabDescriptor, grantId?: string): string
}

async function makeFixture(): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  // The bridge plugin owns the attachment dependency: the store is injected
  // into the plugin context (as in production) and handed to the tool
  // registration explicitly. The agent scope minted above intentionally
  // mirrors DSH 0810's narrower AgentLoop dependencies.
  await ctx.plugin(FakeAttachments)
  const agent = await stubAgent(ctx, 'session-a')
  const pairing = new PairingStore()
  const grants = new GrantStore()
  const server = new BridgeServer({ pairing, grants })
  const socket = new FakeSocket()
  server.attach(socket, EXT_A)
  const nonce = pairing.issue(EXT_A)
  socket.receive(JSON.stringify({ v: 1, type: 'hello', pairingNonce: nonce }))
  const ok = socket.sent.map(text => JSON.parse(text)).find(frame => frame.type === 'hello.ok') as { connectionId: string }
  const connectionId = ok.connectionId

  const deps: PreStepHandlerDeps = {
    server,
    grants,
    registerTurnTools: (agent, turn) => registerTurnTools(agent, turn, {
      server,
      attachments: ctx.attachments,
    }),
  }
  const handler = createPreStepHandler(deps)
  ctx.on('agent/pre-step', (payload, next) => handler(payload, next))
  ctx.on('agent/turn-stopping', (payload) => {
    handler.onTurnStopping(payload.agent, payload.turn)
  })

  const offer = (connection: string, sessionId: string, tab: TabDescriptor, grantId?: string): string => {
    const record = grants.offer(connection, {
      grantId: grantId === undefined ? GrantId(`g-${Math.random().toString(36).slice(2)}`) : GrantId(grantId),
      sessionId,
      expiresAt: Date.now() + 60_000,
      tab,
    })
    return record.handle
  }
  return { ctx, agent, server, grants, pairing, socket, connectionId, offer }
}

describe('pre-step marker consumption', () => {
  it('registers browser tools only when a valid marker is attached', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer } = fixture
    expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
    const handle = offer(connectionId, 'session-a', TAB)
    const decision = await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
    expect(textOf(decision)).toContain('<browser_context id="page_1"')
    expect(textOf(decision)).not.toContain(handle)
    expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
    expect(agent.ctx.tools.get('browser_act', agent)).toBeDefined()
    await fireTurnStopping(ctx, agent, 1)
    expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
  })

  it('rejects the step for an unknown or expired handle', async () => {
    const fixture = await makeFixture()
    const { ctx, agent } = fixture
    const decision = await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker('u'.repeat(32))}`), 1)
    expect(decision.kind).toBe('reject')
    expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
  })

  it('rejects a handle from another session', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer } = fixture
    const handle = offer(connectionId, 'other-session', TAB)
    const decision = await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
    expect(decision.kind).toBe('reject')
  })

  it('deduplicates duplicate references to one tab', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer } = fixture
    const handle = offer(connectionId, 'session-a', TAB)
    const decision = await proposeStep(ctx, agent, userMessage(`a ${encodeMarker(handle)} b ${encodeMarker(handle)}`), 1)
    const text = textOf(decision)
    expect(text.match(/<browser_context/g)).toHaveLength(2)
    expect(text.match(/id="page_1"/g)).toHaveLength(2)
    expect(text).not.toContain('page_2')
    expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
  })

  it('assigns stable page_1/page_2 aliases for multiple tabs', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer } = fixture
    const h1 = offer(connectionId, 'session-a', TAB)
    const h2 = offer(connectionId, 'session-a', TAB2)
    const decision = await proposeStep(ctx, agent, userMessage(`a ${encodeMarker(h1)} b ${encodeMarker(h2)}`), 1)
    const text = textOf(decision)
    expect(text).toContain('id="page_1"')
    expect(text).toContain('id="page_2"')
    expect(text).toContain('http://127.0.0.1:4173/')
    expect(text).toContain('http://127.0.0.1:4174/')
  })

  it('keeps the current turn tools for an empty continuation', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer } = fixture
    const handle = offer(connectionId, 'session-a', TAB)
    await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
    expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
    const decision = await proposeStep(ctx, agent, userMessage('continue'), 1)
    expect(decision.kind).toBe('enter')
    expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
  })

  it('merges steering markers into the active turn so tools reach page_2', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer, socket } = fixture
    const h1 = offer(connectionId, 'session-a', TAB)
    const h2 = offer(connectionId, 'session-a', TAB2, 'g-steer-b')
    const first = await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(h1)}`), 1)
    expect(textOf(first)).toContain('id="page_1"')
    // Steering adds a second tab to the SAME turn.
    const second = await proposeStep(ctx, agent, userMessage(`also check ${encodeMarker(h2)}`), 1)
    const text = textOf(second)
    expect(text).toContain('id="page_2"')
    expect(text).toContain('http://127.0.0.1:4174/')
    // The tool closures capture the SAME pages array: page_2 is resolvable
    // even though the tools were registered on the first pre-step.
    const observe = agent.ctx.tools.get('browser_observe', agent)!
    const pending = observe.execute(
      { page: 'page_2' },
      {
        callId: 'c-steer' as never,
        name: 'browser_observe',
        arguments: { page: 'page_2' },
        signal: new AbortController().signal,
        agent,
      } as never,
    )
    await vi.waitFor(() => {
      const calls = socket.sent
        .map(text => JSON.parse(text) as { type?: string; grantId?: string })
        .filter(frame => frame.type === 'tool.call')
      expect(calls).toContainEqual(expect.objectContaining({ grantId: 'g-steer-b', operation: 'observe' }))
    })
    const call = socket.sent
      .map(text => JSON.parse(text) as { type?: string; requestId?: string })
      .find(frame => frame.type === 'tool.call') as { requestId: string }
    socket.receive(JSON.stringify({
      v: 1,
      type: 'tool.result',
      requestId: call.requestId,
      result: { ok: true, value: { page: { url: TAB2.url } } },
    }))
    await expect(pending).resolves.toMatchObject({ page: { url: TAB2.url } })
  })

  it('does not duplicate a tab already attached by the same turn', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer } = fixture
    const handle = offer(connectionId, 'session-a', TAB)
    await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
    const second = await proposeStep(ctx, agent, userMessage(`again ${encodeMarker(handle)}`), 1)
    const text = textOf(second)
    expect(text).toContain('id="page_1"')
    expect(text).not.toContain('page_2')
  })

  it('steering is atomic: one invalid marker rejects the step without consuming the valid handle or changing pages', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer, grants } = fixture
    const h1 = offer(connectionId, 'session-a', TAB)
    const h2 = offer(connectionId, 'session-a', TAB2, 'g-steer-atomic')
    await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(h1)}`), 1)
    // Steering adds page_2 AND a bogus marker in ONE step: the whole step
    // must be rejected atomically — the valid handle is NOT consumed and
    // the current pages array is NOT extended.
    const decision = await proposeStep(
      ctx,
      agent,
      userMessage(`also ${encodeMarker(h2)} and ${encodeMarker('x'.repeat(32))}`),
      1,
    )
    expect(decision.kind).toBe('reject')
    // The valid handle was NOT consumed by the failed step: it remains
    // consumable for a DIFFERENT turn (a consumed handle would reject).
    expect(() => grants.consume(h2, { connectionId, sessionId: 'session-a', turn: 2 })).not.toThrow()
    // page_2 is NOT resolvable through the already-registered tool closures.
    const observe = agent.ctx.tools.get('browser_observe', agent)!
    await expect(observe.execute(
      { page: 'page_2' },
      {
        callId: 'c-atomic' as never,
        name: 'browser_observe',
        arguments: { page: 'page_2' },
        signal: new AbortController().signal,
        agent,
      } as never,
    )).rejects.toThrow(/unknown page page_2/)
  })

  it('a retry with only the valid marker succeeds and reaches page_2', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer, socket } = fixture
    const h1 = offer(connectionId, 'session-a', TAB)
    const h2 = offer(connectionId, 'session-a', TAB2, 'g-steer-retry')
    await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(h1)}`), 1)
    await proposeStep(ctx, agent, userMessage(`bad ${encodeMarker(h2)} ${encodeMarker('y'.repeat(32))}`), 1)
    // The same valid handle alone steers successfully now.
    const retry = await proposeStep(ctx, agent, userMessage(`also ${encodeMarker(h2)}`), 1)
    expect(retry.kind).toBe('enter')
    expect(textOf(retry)).toContain('id="page_2"')
    const observe = agent.ctx.tools.get('browser_observe', agent)!
    const pending = observe.execute(
      { page: 'page_2' },
      {
        callId: 'c-retry' as never,
        name: 'browser_observe',
        arguments: { page: 'page_2' },
        signal: new AbortController().signal,
        agent,
      } as never,
    )
    await vi.waitFor(() => {
      const calls = socket.sent
        .map(text => JSON.parse(text) as { type?: string; grantId?: string })
        .filter(frame => frame.type === 'tool.call')
      expect(calls).toContainEqual(expect.objectContaining({ grantId: 'g-steer-retry', operation: 'observe' }))
    })
    const call = socket.sent
      .map(text => JSON.parse(text) as { type?: string; requestId?: string })
      .find(frame => frame.type === 'tool.call') as { requestId: string }
    socket.receive(JSON.stringify({
      v: 1,
      type: 'tool.result',
      requestId: call.requestId,
      result: { ok: true, value: { page: { url: TAB2.url } } },
    }))
    await expect(pending).resolves.toMatchObject({ page: { url: TAB2.url } })
  })

  it('treats a dropped socket as transient: tools survive and a same-origin reconnect resumes the turn', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, server, pairing, connectionId, offer, grants } = fixture
    const handle = offer(connectionId, 'session-a', TAB, 'g-transient')
    await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
    expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
    // The bridge socket drops while the side panel stays alive: the host
    // must NOT tear the turn down (no disposeAll on connection loss) and
    // the grant stays bound to the logical session.
    fixture.socket.close()
    expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
    expect(grants.resolve(GrantId('g-transient'), connectionId)).toMatchObject({ grantId: 'g-transient' })
    // A same-origin reconnect with a fresh nonce resumes the SAME session.
    const second = new FakeSocket()
    server.attach(second, EXT_A)
    const nonce = pairing.issue(EXT_A)
    second.receive(JSON.stringify({ v: 1, type: 'hello', pairingNonce: nonce }))
    const ok = second.sent.map(text => JSON.parse(text)).find(frame => frame.type === 'hello.ok') as { connectionId: string }
    expect(ok.connectionId).toBe(connectionId)
    // The turn's tools work over the new connection with the same grant.
    const observe = agent.ctx.tools.get('browser_observe', agent)!
    const pending = observe.execute(
      { page: 'page_1' },
      {
        callId: 'c-transient' as never,
        name: 'browser_observe',
        arguments: { page: 'page_1' },
        signal: new AbortController().signal,
        agent,
      } as never,
    )
    await vi.waitFor(() => {
      expect(second.sent.some(text => (JSON.parse(text) as { type?: string }).type === 'tool.call')).toBe(true)
    })
    const call = second.sent
      .map(text => JSON.parse(text) as { type?: string; requestId?: string })
      .find(frame => frame.type === 'tool.call') as { requestId: string }
    second.receive(JSON.stringify({
      v: 1,
      type: 'tool.result',
      requestId: call.requestId,
      result: { ok: true, value: { page: { url: TAB.url } } },
    }))
    await expect(pending).resolves.toMatchObject({ page: { url: TAB.url } })
  })

  it('does not reuse a handle across turns', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, offer } = fixture
    const handle = offer(connectionId, 'session-a', TAB)
    const first = await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
    expect(first.kind).toBe('enter')
    await fireTurnStopping(ctx, agent, 1)
    const second = await proposeStep(ctx, agent, userMessage(`again ${encodeMarker(handle)}`), 2)
    expect(second.kind).toBe('reject')
  })

  it('sanitizes the page summary URL and title', async () => {
    const fixture = await makeFixture()
    const { ctx, agent, connectionId, grants } = fixture
    const record = grants.offer(connectionId, {
      grantId: GrantId('g-sanitize'),
      sessionId: 'session-a',
      expiresAt: Date.now() + 60_000,
      tab: { tabId: 9, windowId: 1, title: 'S', url: 'http://127.0.0.1:4173/path?secret=1#frag' },
    })
    const decision = await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(record.handle)}`), 1)
    const text = textOf(decision)
    expect(text).toContain('http://127.0.0.1:4173/path')
    expect(text).not.toContain('secret=1')
    expect(text).not.toContain('#frag')
  })

  describe('turn signal abort cleanup', () => {
    it('aborting the turn signal removes the tools and revokes the grants', async () => {
      const fixture = await makeFixture()
      const { ctx, agent, connectionId, offer, grants, socket } = fixture
      const handle = offer(connectionId, 'session-a', TAB, 'g-abort')
      const controller = new AbortController()
      const decision = await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1, controller.signal)
      expect(decision.kind).toBe('enter')
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
      // DSH fires `agent/turn-stopping` only on the NORMAL completion path;
      // a cancelled turn aborts the shared signal instead. The pre-step must
      // clean the tools and revoke the grants on that abort.
      controller.abort()
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
      expect(agent.ctx.tools.get('browser_act', agent)).toBeUndefined()
      expect(() => grants.resolve(GrantId('g-abort'), connectionId)).toThrow(/grant/)
      const revokes = socket.sent
        .map(text => JSON.parse(text) as { type?: string; grantId?: string })
        .filter(frame => frame.type === 'grant.revoke')
      expect(revokes).toContainEqual(expect.objectContaining({ grantId: 'g-abort' }))
    })

    it('an aborted turn does not affect a later turn', async () => {
      const fixture = await makeFixture()
      const { ctx, agent, connectionId, offer, grants } = fixture
      const controller = new AbortController()
      const h1 = offer(connectionId, 'session-a', TAB, 'g-abort-before')
      await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(h1)}`), 1, controller.signal)
      controller.abort()
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
      // A later turn with a FRESH signal attaches and registers tools again.
      const h2 = offer(connectionId, 'session-a', TAB2, 'g-after-abort')
      const second = await proposeStep(ctx, agent, userMessage(`check ${encodeMarker(h2)}`), 2)
      expect(second.kind).toBe('enter')
      expect(textOf(second)).toContain('id="page_1"')
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
      expect(grants.resolve(GrantId('g-after-abort'), connectionId)).toBeDefined()
    })

    it('turn-stopping removes the abort listener (single cleanup, single revoke)', async () => {
      const fixture = await makeFixture()
      const { ctx, agent, connectionId, offer, socket } = fixture
      const controller = new AbortController()
      const handle = offer(connectionId, 'session-a', TAB, 'g-stopping')
      await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1, controller.signal)
      // Normal turn end: turn-stopping cleans up and must detach the abort
      // listener so a later abort of the same signal cannot re-run cleanup.
      await fireTurnStopping(ctx, agent, 1)
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
      controller.abort()
      const revokes = socket.sent
        .map(text => JSON.parse(text) as { type?: string; grantId?: string })
        .filter(frame => frame.type === 'grant.revoke' && frame.grantId === 'g-stopping')
      expect(revokes).toHaveLength(1)
    })
  })
})
