import { describe, expect, it } from 'vitest'
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
  // production).
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
): Promise<PreStepDecision> {
  agent.inbox.append('next-turn', message)
  const claimed = agent.inbox.claim('next-turn', turn)
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: claimed, turn, step: 1, signal: new AbortController().signal },
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
  connectionId: string
  offer(connectionId: string, sessionId: string, tab: TabDescriptor, grantId?: string): string
}

async function makeFixture(): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
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
    registerTurnTools: (agent, turn) => registerTurnTools(agent, turn, { server }),
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
  return { ctx, agent, server, grants, connectionId, offer }
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
})
