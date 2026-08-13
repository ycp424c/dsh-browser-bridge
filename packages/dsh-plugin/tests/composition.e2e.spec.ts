import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { agentEvents, Inbox, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type UserMessage } from '@deepseek-ai/dsh-session'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createScope } from '@deepseek-ai/dsh-scope'
import { WebSocket } from 'ws'
import { FakeAttachments } from './fake-attachments.ts'
import { FakeLlm } from './fake-llm.ts'
import {
  GrantId, newGrantId, PROTOCOL_VERSION, VITE_PAGE_PROTOCOL_VERSION, encodeMarker,
  type BridgeFrame, type GrantAcceptedFrame, type GrantPutFrame,
  type HelloOkFrame, type TabDescriptor, type ToolCallFrame, type ToolResultFrame,
} from '@dsh-external/dsh-browser-bridge-protocol'

const EXT_A = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const FIXTURE_URL = 'http://127.0.0.1:4173/'
const TAB: TabDescriptor = { tabId: 7, windowId: 2, title: 'Fixture', url: FIXTURE_URL }

const pluginDir = join(import.meta.dirname, '..')

/** Real versioned protocol peer over a real WebSocket. */
class ExtensionPeer {
  private socket: WebSocket | null = null
  private readonly inbox: BridgeFrame[] = []
  private waiters: Array<{ predicate: (frame: BridgeFrame) => boolean; resolve: (frame: BridgeFrame) => void }> = []
  lastGrantId: GrantId = GrantId('')

  async connect(wsUrl: string, pairingNonce: string): Promise<void> {
    const socket = new WebSocket(wsUrl, { origin: EXT_A })
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.on('message', data => {
      const frame = JSON.parse(data.toString()) as BridgeFrame
      const waiter = this.waiters.findIndex(candidate => candidate.predicate(frame))
      if (waiter !== -1) {
        const [entry] = this.waiters.splice(waiter, 1)
        entry!.resolve(frame)
        return
      }
      this.inbox.push(frame)
    })
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce }))
    await this.nextFrame(frame => frame.type === 'hello.ok')
  }

  async putGrant(sessionId: string, tab: TabDescriptor): Promise<{ grantId: GrantId; handle: string }> {
    const grantId = newGrantId()
    this.send({
      v: PROTOCOL_VERSION,
      type: 'grant.put',
      grantId,
      sessionId,
      tab,
      expiresAt: Date.now() + 60_000,
    } satisfies GrantPutFrame)
    const accepted = await this.nextFrame(frame => frame.type === 'grant.accepted') as GrantAcceptedFrame
    this.lastGrantId = grantId
    return { grantId, handle: accepted.handle }
  }

  async nextToolCall(timeoutMs = 5_000): Promise<ToolCallFrame> {
    const frame = await this.nextFrame(frame => frame.type === 'tool.call', timeoutMs)
    return frame as ToolCallFrame
  }

  async nextFrame(predicate: (frame: BridgeFrame) => boolean, timeoutMs = 5_000): Promise<BridgeFrame> {
    const queued = this.inbox.findIndex(predicate)
    if (queued !== -1) {
      const [frame] = this.inbox.splice(queued, 1)
      return frame!
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('peer: frame timeout')), timeoutMs)
      this.waiters.push({
        predicate,
        resolve: frame => {
          clearTimeout(timer)
          resolve(frame)
        },
      })
    })
  }

  reply(call: ToolCallFrame, value: unknown): void {
    const frame: ToolResultFrame = {
      v: PROTOCOL_VERSION,
      type: 'tool.result',
      requestId: call.requestId,
      result: { ok: true, value },
    }
    this.send(frame)
  }

  send(frame: BridgeFrame): void {
    this.socket?.send(JSON.stringify(frame))
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}

/** Real Vite page protocol peer over a real WebSocket. */
class VitePeer {
  private socket: WebSocket | null = null
  private readonly inbox: Array<Record<string, unknown>> = []
  private waiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = []

  async connect(wsUrl: string, origin: string): Promise<void> {
    const socket = new WebSocket(wsUrl, { origin })
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      const waiter = this.waiters.findIndex(candidate => candidate.predicate(frame))
      if (waiter !== -1) {
        const [entry] = this.waiters.splice(waiter, 1)
        entry!.resolve(frame)
        return
      }
      this.inbox.push(frame)
    })
    socket.send(JSON.stringify({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' }))
  }

  async register(targetId: string, origin: string, url: string): Promise<void> {
    this.send({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.register',
      target: {
        targetId,
        provider: 'vite',
        title: 'Vite Page',
        url,
        origin,
        projectId: 'app',
        generation: 0,
        capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
      },
    })
    await this.nextFrame(frame => frame.type === 'target.registered')
  }

  async nextToolCall(timeoutMs = 5_000): Promise<{ requestId: string; operation: string }> {
    const frame = await this.nextFrame(frame => frame.type === 'tool.call', timeoutMs)
    return frame as unknown as { requestId: string; operation: string }
  }

  async nextFrame(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const queued = this.inbox.findIndex(predicate)
    if (queued !== -1) {
      const [frame] = this.inbox.splice(queued, 1)
      return frame!
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('vite peer: frame timeout')), timeoutMs)
      this.waiters.push({
        predicate,
        resolve: frame => {
          clearTimeout(timer)
          resolve(frame)
        },
      })
    })
  }

  send(frame: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame))
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
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
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    // DSH 0810 agents inherit the AgentLoop dependency surface. Attachments
    // belong to the bridge plugin, not to the agent-scoped tool registry.
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

async function proposeStep(ctx: Context, agent: Agent, message: UserMessage, turn: number): Promise<PreStepDecision> {
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

function executionContext(signal: AbortSignal, agent: Agent): ToolRunContext {
  return {
    callId: CallId('composition-call'),
    name: 'browser_observe',
    arguments: {},
    signal,
    agent,
  } as unknown as ToolRunContext
}

interface Composition {
  ctx: Context
  baseUrl: string
  wsUrl: string
  agent: Agent
  cleanup(): Promise<void>
}

async function makeComposition(): Promise<Composition> {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-bridge-profile-'))
  await mkdir(join(profileDir, 'node_modules/@dsh-external'), { recursive: true })
  await symlink(pluginDir, join(profileDir, 'node_modules/@dsh-external/dsh-browser-bridge'), 'dir')
  // An empty base file plus the plugin's one-row profile bundle patch.
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')

  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  // The bridge plugin owns the attachment dependency. The agent scope minted
  // below intentionally mirrors DSH 0810's narrower AgentLoop dependencies.
  await ctx.plugin(FakeAttachments)
  await ctx.plugin(FakeLlm)
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(profileDir).href })
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: {
      path: pathToFileURL(join(profileDir, 'cordis.yml')).href,
      // The profile bundle patch: one row mounting the external plugin.
      patches: [{
        insert: [{
          id: 'dsh-browser-bridge',
          name: '@dsh-external/dsh-browser-bridge',
          inject: ['webServer', 'attachments', 'llm'],
        }],
      }],
    },
  })
  await ctx.loader.await()
  const agent = await stubAgent(ctx, 'session-composition')
  const port = ctx.webServer.port
  const baseUrl = `http://127.0.0.1:${port}`
  const wsUrl = `ws://127.0.0.1:${port}/dsh-browser-bridge/ws`
  return {
    ctx,
    baseUrl,
    wsUrl,
    agent,
    cleanup: async () => {
      await ctx.fiber.dispose()
      await rm(profileDir, { recursive: true, force: true })
    },
  }
}

async function fetchPairingNonce(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/dsh-browser-bridge/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ extensionOrigin: EXT_A }),
  })
  expect(response.ok).toBe(true)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const { nonce } = (await response.json()) as { nonce: string }
  return nonce
}

describe('DSH composition', () => {
  let composition: Composition | null = null

  afterEach(async () => {
    await composition?.cleanup()
    composition = null
  })

  it('runs the full prompt-scoped grant loop over the real bridge', async () => {
    composition = await makeComposition()
    const { ctx, agent, baseUrl, wsUrl } = composition
    const peer = new ExtensionPeer()
    try {
      const nonce = await fetchPairingNonce(baseUrl)
      await peer.connect(wsUrl, nonce)
      const { handle } = await peer.putGrant(String(agent.session.header.id), TAB)

      const decision = await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
      expect(textOf(decision)).toContain('page_1')
      expect(textOf(decision)).not.toContain(handle)
      const observe = agent.ctx.tools.get('browser_observe', agent)!
      expect(observe).toBeDefined()

      const signal = new AbortController().signal
      const executing = observe.execute({ page: 'page_1' }, executionContext(signal, agent))
      const call = await peer.nextToolCall()
      expect(call).toMatchObject({ operation: 'observe', grantId: peer.lastGrantId })
      peer.reply(call, { page: { url: FIXTURE_URL, title: 'Fixture' }, nodes: [] })
      await expect(executing).resolves.toBeDefined()

      await fireTurnStopping(ctx, agent, 1)
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
      const revoke = await peer.nextFrame(frame => frame.type === 'grant.revoke')
      expect(revoke).toMatchObject({ type: 'grant.revoke', grantId: peer.lastGrantId })
    } finally {
      peer.close()
    }
  })

  it('keeps tools for a continuation and rejects handle reuse across turns', async () => {
    composition = await makeComposition()
    const { ctx, agent, baseUrl, wsUrl } = composition
    const peer = new ExtensionPeer()
    try {
      const nonce = await fetchPairingNonce(baseUrl)
      await peer.connect(wsUrl, nonce)
      const { handle } = await peer.putGrant(String(agent.session.header.id), TAB)

      await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
      const continuation = await proposeStep(ctx, agent, userMessage('continue'), 1)
      expect(continuation.kind).toBe('enter')
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()

      await fireTurnStopping(ctx, agent, 1)
      const second = await proposeStep(ctx, agent, userMessage(`again ${encodeMarker(handle)}`), 2)
      expect(second.kind).toBe('reject')
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
    } finally {
      peer.close()
    }
  })

  it('attaches a Vite page over the real WebSocket and routes tools to it', async () => {
    composition = await makeComposition()
    const { ctx, agent, baseUrl } = composition
    const port = new URL(baseUrl).port
    const vite = new VitePeer()
    const targetId = 'v'.repeat(43)
    try {
      await vite.connect(`ws://127.0.0.1:${port}/dsh-browser-bridge/vite/ws`, 'http://127.0.0.1:5173')
      await vite.register(targetId, 'http://127.0.0.1:5173', 'http://127.0.0.1:5173/')

      const health = await fetch(`${baseUrl}/dsh-browser-bridge/vite/health`, { headers: { origin: 'https://public.example' } })
      expect(health.ok).toBe(true)
      expect(health.headers.get('access-control-allow-origin')).toBe('https://public.example')
      expect(health.headers.get('access-control-allow-credentials')).toBeNull()

      const response = await fetch(`${baseUrl}/dsh-browser-bridge/vite/grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: baseUrl },
        body: JSON.stringify({ sessionId: String(agent.session.header.id), targetId }),
      })
      expect(response.ok).toBe(true)
      const { handle } = (await response.json()) as { handle: string }

      const decision = await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
      expect(textOf(decision)).toContain('provider="vite"')
      expect(textOf(decision)).toContain('capabilities="observe,inspect,act,navigate,wait,console"')
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeDefined()
      expect(agent.ctx.tools.get('browser_screenshot', agent)).toBeUndefined()
      expect(agent.ctx.tools.get('browser_network', agent)).toBeUndefined()

      const signal = new AbortController().signal
      const executing = agent.ctx.tools.get('browser_observe', agent)!.execute({ page: 'page_1' }, executionContext(signal, agent))
      const call = await vite.nextToolCall()
      expect(call.operation).toBe('observe')
      vite.send({ v: VITE_PAGE_PROTOCOL_VERSION, type: 'tool.accepted', requestId: call.requestId })
      vite.send({
        v: VITE_PAGE_PROTOCOL_VERSION,
        type: 'tool.result',
        requestId: call.requestId,
        result: { ok: true, value: { page: { url: 'http://127.0.0.1:5173/', title: 'Vite Page' }, nodes: [] } },
      })
      await expect(executing).resolves.toMatchObject({ page: { url: 'http://127.0.0.1:5173/' } })

      await fireTurnStopping(ctx, agent, 1)
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
      const revoke = await vite.nextFrame(frame => frame.type === 'target.revoke')
      expect(revoke).toMatchObject({ type: 'target.revoke' })
    } finally {
      vite.close()
    }
  })

  it('disposes the plugin, its routes, and the connection', async () => {
    composition = await makeComposition()
    const { ctx, baseUrl, wsUrl } = composition
    const peer = new ExtensionPeer()
    const nonce = await fetchPairingNonce(baseUrl)
    await peer.connect(wsUrl, nonce)
    await ctx.fiber.dispose()
    await expect(fetchPairingNonce(baseUrl)).rejects.toThrow()
    peer.close()
    composition = null
  })

  it('leaves no global tool registrations behind', async () => {
    composition = await makeComposition()
    const { ctx, agent, baseUrl, wsUrl } = composition
    const peer = new ExtensionPeer()
    try {
      const nonce = await fetchPairingNonce(baseUrl)
      await peer.connect(wsUrl, nonce)
      const { handle } = await peer.putGrant(String(agent.session.header.id), TAB)
      await proposeStep(ctx, agent, userMessage(`verify ${encodeMarker(handle)}`), 1)
      expect(ctx.tools.get('browser_observe')).toBeUndefined()
      await fireTurnStopping(ctx, agent, 1)
      expect(agent.ctx.tools.get('browser_observe', agent)).toBeUndefined()
    } finally {
      peer.close()
    }
  })
})
