/**
 * Prompt marker consumption at `agent/pre-step`: replace non-secret handles
 * with sanitized page summaries, register turn-scoped browser tools, and
 * clean them up when the turn stops.
 */
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { extractMarkers, type TabDescriptor } from '@dsh-external/dsh-browser-bridge-protocol'
import { GrantStore } from './bridge/grant-store.ts'
import { BridgeServer } from './bridge/server.ts'
import type { ActiveTurn } from './tools/register.ts'

export interface PreStepHandlerDeps {
  server: BridgeServer
  grants: GrantStore
  registerTurnTools: (agent: Agent, turn: ActiveTurn) => Array<() => void>
}

export interface PreStepPayload {
  agent: Agent
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

export interface PreStepHandler {
  (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  onTurnStopping(agent: Agent, turn: number): void
  dispose(agent: Agent): void
  disposeAll(): void
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Strip query/fragment and bound the summary length. */
function sanitizeUrl(url: string): string {
  let clean = url
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    clean = parsed.href
  } catch {
    // Keep the raw value; it is attribute-escaped below.
  }
  return clean.length > 500 ? `${clean.slice(0, 500)}…` : clean
}

function sanitizeTitle(title: string): string {
  return title.length > 200 ? `${title.slice(0, 200)}…` : title
}

function renderSummary(alias: string, tab: TabDescriptor): string {
  return `<browser_context id="${alias}" title="${escapeAttribute(sanitizeTitle(tab.title))}" url="${escapeAttribute(sanitizeUrl(tab.url))}">`
}

/** Collect markers from text blocks of user-sourced messages only. */
function collectMarkers(messages: readonly UserMessage[]): Array<{ marker: string; handle: string }> {
  const found: Array<{ marker: string; handle: string }> = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      found.push(...extractMarkers((block as { text: string }).text))
    }
  }
  return found
}

/** Replace every consumed marker with its page summary in place. */
function rewriteMessages(messages: readonly UserMessage[], summaries: ReadonlyMap<string, string>): UserMessage[] {
  return messages.map(message => {
    if (message.source.kind !== 'user') return message
    let changed = false
    const content = message.content.map(block => {
      if (block.type !== 'text') return block
      const text = (block as { text: string }).text
      let rewritten = text
      for (const [marker, summary] of summaries) {
        if (rewritten.includes(marker)) {
          rewritten = rewritten.replaceAll(marker, summary)
          changed = true
        }
      }
      return changed && rewritten !== text ? { ...block, text: rewritten } : block
    })
    return changed ? { ...message, content } : message
  })
}

export function createPreStepHandler(deps: PreStepHandlerDeps): PreStepHandler {
  const active = new Map<Agent, ActiveTurn>()

  const cleanup = (agent: Agent, turn: number): void => {
    const current = active.get(agent)
    if (current === undefined || current.turn !== turn) return
    active.delete(agent)
    // Remove tool registrations first, then revoke extension grants.
    for (const dispose of current.disposers) {
      try {
        dispose()
      } catch (error) {
        // A disposer must not break the remaining cleanup.
        void error
      }
    }
    try {
      deps.server.revokeTurn(current.connectionId, current.sessionId, turn)
    } catch {
      // The connection may already be gone; the store still drops records.
    }
  }

  const handler: PreStepHandler = async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    const markers = collectMarkers(decision.messages)
    if (markers.length === 0) {
      // A continuation with no new markers keeps the current turn's tools.
      return decision
    }

    const connectionId = deps.server.connectionId
    const sessionId = String(payload.agent.session.header.id)
    const turn = payload.turn

    const pages: ActiveTurn['pages'] = []
    const summaries = new Map<string, string>()
    const aliasByGrantId = new Map<string, string>()
    const existing = active.get(payload.agent)
    const base = existing !== undefined && existing.turn === turn ? existing.pages.length : 0

    for (const { marker, handle } of markers) {
      let record
      try {
        record = deps.grants.consume(handle, {
          connectionId: connectionId ?? '',
          sessionId,
          turn,
        })
      } catch {
        // Unknown, expired, foreign, or already-used handle: reject the step.
        return { kind: 'reject' }
      }
      let alias = aliasByGrantId.get(record.grantId)
      if (alias === undefined) {
        alias = `page_${base + aliasByGrantId.size + 1}`
        aliasByGrantId.set(record.grantId, alias)
        pages.push({ alias, grantId: record.grantId, tab: record.tab })
      }
      summaries.set(marker, renderSummary(alias, record.tab))
    }

    let current = active.get(payload.agent)
    if (current === undefined || current.turn !== turn) {
      const turnState: ActiveTurn = {
        agent: payload.agent,
        connectionId: connectionId ?? '',
        sessionId,
        turn,
        pages,
        disposers: [],
      }
      try {
        turnState.disposers = deps.registerTurnTools(payload.agent, turnState)
      } catch (error) {
        // Registration failed: reject the step rather than entering a turn
        // whose tools are missing.
        for (const dispose of turnState.disposers) dispose()
        active.delete(payload.agent)
        throw error
      }
      active.set(payload.agent, turnState)
    } else {
      // Steering added markers to the same turn; the shared pages array is
      // already extended, so existing tool closures see the new page.
    }

    return { kind: 'enter', messages: rewriteMessages(decision.messages, summaries) }
  }

  handler.onTurnStopping = (agent, turn) => cleanup(agent, turn)
  handler.dispose = agent => {
    const current = active.get(agent)
    if (current === undefined) return
    cleanup(agent, current.turn)
  }
  handler.disposeAll = () => {
    // Every active turn belongs to the lost connection.
    for (const agent of [...active.keys()]) {
      const current = active.get(agent)
      if (current === undefined) continue
      cleanup(agent, current.turn)
    }
  }
  return handler
}
