/**
 * Turn-scoped tool registration: browser tools are registered on the agent's
 * own context so they exist only while that agent's turn holds a grant.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BridgeServer } from '../bridge/server.ts'
import { createBrowserTools, resolvePageAlias, type PageAlias } from './definitions.ts'

export interface ActiveTurn {
  agent: Agent
  connectionId: string
  sessionId: string
  turn: number
  pages: PageAlias[]
  disposers: Array<() => void>
}

export interface RegisterTurnToolsDeps {
  server: BridgeServer
}

/** Register the eight browser tools for one active turn; returns disposers. */
export function registerTurnTools(
  agent: Agent,
  turn: ActiveTurn,
  deps: RegisterTurnToolsDeps,
): Array<() => void> {
  const tools = createBrowserTools({
    resolvePage: page => resolvePageAlias(turn.pages, page),
    request: (grantId, operation, args, signal) => deps.server.request(grantId, operation, args, signal),
  })
  return tools.map(definition => agent.ctx.tools.register(definition))
}
