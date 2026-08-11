/**
 * Turn-scoped tool registration: browser tools are registered on the agent's
 * own context so they exist only while that agent's turn holds a grant. The
 * registered tool set is the UNION of the attached targets' capabilities:
 * a Vite-only turn never registers screenshot or network tools.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { TargetCoordinator } from '../targets/coordinator.ts'
import {
  createBrowserTool,
  resolvePageAlias,
  BROWSER_TOOL_OPERATIONS,
  type PageAlias,
} from './definitions.ts'

export interface ActiveTurn {
  agent: Agent
  sessionId: string
  turn: number
  pages: PageAlias[]
  disposers: Array<() => void>
  /** Detach the once-abort cleanup listener (every cleanup path removes it). */
  removeAbortListener: () => void
}

export interface RegisterTurnToolsDeps {
  /** Provider-neutral grant routing and dispatch authority. */
  coordinator: TargetCoordinator
  /**
   * Durable attachment store, owned by the host plugin's own inject surface
   * (`attachments`) and passed down explicitly. The agent scope inherits the
   * AgentLoop dependency surface (tools/systemPrompt) and never exposes it.
   */
  attachments: AttachmentStore
}

/**
 * Register the browser tools supported by the attached targets' capability
 * union for one active turn; returns disposers.
 */
export function registerTurnTools(
  agent: Agent,
  turn: ActiveTurn,
  deps: RegisterTurnToolsDeps,
): Array<() => void> {
  const union = new Set<string>(turn.pages.flatMap(page => page.target.capabilities))
  const tools = BROWSER_TOOL_OPERATIONS
    .filter(operation => union.has(operation))
    .map(operation => createBrowserTool(operation, {
      resolvePage: page => resolvePageAlias(turn.pages, page),
      request: (grantId, operation, args, signal) => deps.coordinator.request(grantId, operation, args, signal),
      attachments: deps.attachments,
    }))
  return tools.map(definition => agent.ctx.tools.register(definition))
}
