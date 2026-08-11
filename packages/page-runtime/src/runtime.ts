/**
 * Runtime orchestrator shell: owns activation, page identity, the health
 * probe, the resilient socket, the generation counter, a placeholder
 * dispatcher (unsupported_operation until DOM tools land), and dispose.
 */
import {
  bridgeError,
  VITE_BROWSER_CAPABILITIES,
  type TargetId,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { Activator } from './activation.ts'
import { normalizeDshOrigin, type PageRuntimeConfig } from './config.ts'
import { GENERATION_KEY, loadOrCreateIdentity } from './identity.ts'
import { probeLocalDsh } from './probe.ts'
import { PageSocket, type PageDispatcher } from './transport/socket.ts'

export interface PageRuntime {
  readonly targetId: TargetId
  activate(options?: { openPanel?: boolean }): Promise<void>
  notifyHmrUpdate(): void
  dispose(): void
}

export function startPageRuntime(config: PageRuntimeConfig): PageRuntime {
  const dshOrigin = normalizeDshOrigin(config.dshOrigin)
  const storage = window.sessionStorage
  const identity = loadOrCreateIdentity(storage)
  let generation = identity.generation

  // Placeholder dispatcher: DOM tool handlers register in later tasks.
  const dispatcher: PageDispatcher = {
    execute: async operation => {
      throw bridgeError('unsupported_operation', `operation ${operation} is not implemented by this runtime`, false)
    },
  }

  let socket: PageSocket | null = null
  let activator: Activator | null = null

  const wsUrl = (): string => {
    const parsed = new URL(dshOrigin)
    const protocol = parsed.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${parsed.host}/dsh-browser-bridge/vite/ws`
  }

  const connect = async (): Promise<void> => {
    if (socket !== null) return
    socket = new PageSocket({
      url: wsUrl(),
      descriptor: () => ({
        targetId: identity.targetId,
        provider: 'vite',
        title: document.title,
        url: window.location.href,
        origin: window.location.origin,
        ...(config.projectId !== undefined ? { projectId: config.projectId } : {}),
        generation,
        capabilities: [...VITE_BROWSER_CAPABILITIES],
      }),
      dispatcher,
    })
    socket.connect()
    // Console evidence clearing on revoke is wired with the console tool.
    socket.onRevoke(() => {})
  }

  activator = new Activator({
    config,
    probe: () => probeLocalDsh({ dshOrigin }),
    connect,
    openPanel: () => {
      // The Shadow DOM panel is wired in a later task.
    },
    storage,
    location: window.location,
    addKeyListener: handler => {
      const onKey = (event: KeyboardEvent): void => handler(event)
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    },
  })
  activator.start()

  return {
    targetId: identity.targetId,
    activate: options => activator!.activate(options),
    notifyHmrUpdate: () => {
      generation += 1
      // The generation persists across reloads; refs, DOM quiet, target
      // update, and generation waiters are wired with HMR in a later task.
      storage.setItem(GENERATION_KEY, String(generation))
    },
    dispose: () => {
      activator?.dispose()
      socket?.close()
      socket = null
    },
  }
}
