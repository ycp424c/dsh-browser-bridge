/**
 * Runtime orchestrator shell: owns activation, page identity, the health
 * probe, the resilient socket, the generation counter, the full reliable
 * tool dispatcher (observe/inspect/act/navigate/wait/console), the HMR
 * pipeline, console capture, and dispose.
 */
import {
  VITE_BROWSER_CAPABILITIES,
  VITE_PAGE_PROTOCOL_VERSION,
  type JsonValue,
  type TargetId,
} from '@dsh-external/dsh-browser-bridge-protocol'
import { Activator } from './activation.ts'
import { normalizeDshOrigin, type PageRuntimeConfig } from './config.ts'
import { createHmrManager } from './hmr.ts'
import { createPanel } from './panel/panel.ts'
import { GENERATION_KEY, loadOrCreateIdentity } from './identity.ts'
import { probeLocalDsh } from './probe.ts'
import { ElementRegistry } from './refs/registry.ts'
import { PageSocket } from './transport/socket.ts'
import { actOnElement } from './tools/act.ts'
import { ConsoleCapture } from './tools/console.ts'
import {
  ACT_ARGS_SCHEMA,
  CONSOLE_ARGS_SCHEMA,
  INSPECT_ARGS_SCHEMA,
  NAVIGATE_ARGS_SCHEMA,
  OBSERVE_ARGS_SCHEMA,
  PageDispatcher,
  WAIT_ARGS_SCHEMA,
} from './tools/dispatcher.ts'
import { inspectElement } from './tools/inspect.ts'
import { navigatePage } from './tools/navigate.ts'
import { observeDocument } from './tools/observe.ts'
import { waitForCondition } from './tools/wait.ts'

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

  // Generation-bound element references and the real tool dispatcher.
  const refs = new ElementRegistry()
  const generationState = { value: generation }

  // Console capture starts at injection; the buffer clears on revoke.
  const consoleCapture = new ConsoleCapture({ generation: () => generationState.value })
  consoleCapture.start()

  let socket: PageSocket | null = null
  let activator: Activator | null = null

  const wsUrl = (): string => {
    const parsed = new URL(dshOrigin)
    const protocol = parsed.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${parsed.host}/dsh-browser-bridge/vite/ws`
  }

  const buildDescriptor = (currentGeneration: number) => ({
    targetId: identity.targetId,
    provider: 'vite' as const,
    title: document.title,
    url: window.location.href,
    origin: window.location.origin,
    ...(config.projectId !== undefined ? { projectId: config.projectId } : {}),
    generation: currentGeneration,
    capabilities: [...VITE_BROWSER_CAPABILITIES],
  })

  const hmr = createHmrManager({
    refs,
    available: config.mode === 'development',
    generation: () => generationState.value,
    setGeneration: value => {
      generation = value
      generationState.value = value
    },
    sendTargetUpdate: current => {
      socket?.send({
        v: VITE_PAGE_PROTOCOL_VERSION,
        type: 'target.update',
        target: buildDescriptor(current),
      })
    },
    doc: document,
    win: window,
    notifyHmrUpdate: () => {},
  })

  const dispatcher = new PageDispatcher()
  dispatcher.register('observe', OBSERVE_ARGS_SCHEMA, async args =>
    observeDocument({
      refs,
      generation: generationState.value,
      ...(args as { maxNodes?: number; maxChars?: number }),
      doc: document,
      win: window,
    }) as unknown as JsonValue)
  dispatcher.register('inspect', INSPECT_ARGS_SCHEMA, async args =>
    inspectElement({
      refs,
      generation: generationState.value,
      args: args as { ref?: string; selector?: string; properties?: string[] },
      doc: document,
      win: window,
    }) as unknown as JsonValue)
  dispatcher.register('act', ACT_ARGS_SCHEMA, async args =>
    actOnElement({
      refs,
      generation: generationState.value,
      args: args as never,
      doc: document,
      win: window,
    }) as unknown as JsonValue)
  dispatcher.register('navigate', NAVIGATE_ARGS_SCHEMA, async args =>
    navigatePage({
      args: args as never,
      win: window,
    }) as unknown as JsonValue)
  dispatcher.register('wait', WAIT_ARGS_SCHEMA, async (args, signal) =>
    waitForCondition({
      args: args as never,
      signal,
      doc: document,
      win: window,
      generation: () => generationState.value,
      waitForGeneration: (after, innerSignal) => hmr.waitForGeneration(after, innerSignal),
    }) as unknown as JsonValue)
  dispatcher.register('console', CONSOLE_ARGS_SCHEMA, async () =>
    ({ rows: consoleCapture.rows() }) as unknown as JsonValue)

  const connect = async (): Promise<void> => {
    if (socket !== null) return
    socket = new PageSocket({
      url: wsUrl(),
      descriptor: () => buildDescriptor(generationState.value),
      dispatcher,
    })
    socket.connect()
    // Console evidence dies with the target's grant.
    socket.onRevoke(() => consoleCapture.clear())
  }

  // Optional Shadow DOM panel: enabled=false creates no UI while the
  // bridge activation pipeline keeps running.
  const panel = createPanel({
    config,
    targetId: identity.targetId,
    dshOrigin,
    onActivate: () => activator?.userActivate({ openPanel: true }),
  })

  activator = new Activator({
    config,
    probe: () => probeLocalDsh({ dshOrigin }),
    connect,
    openPanel: () => panel?.open(),
    onState: state => {
      // visible=true shows the launcher only after a successful probe; a
      // connected bridge updates the drawer banner; a failed activation
      // opens the drawer with the diagnostic and the new-tab fallback so
      // blocked local access is never silent.
      if (state === 'available') panel?.showLauncher()
      if (state === 'failed') {
        panel?.open()
        panel?.setConnection('failed')
        panel?.showDiagnostic()
      }
      if (state === 'connecting') panel?.setConnection('connecting')
      if (state === 'connected') panel?.setConnection('connected')
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
      // The generation bump, ref clear, quiet wait, target.update, and
      // generation waiters all live in the HMR manager; the persisted
      // generation survives reloads.
      generation += 1
      generationState.value = generation
      storage.setItem(GENERATION_KEY, String(generation))
      hmr.notifyHmrUpdate()
    },
    dispose: () => {
      activator?.dispose()
      hmr.dispose()
      panel?.dispose()
      consoleCapture.dispose()
      socket?.close()
      socket = null
    },
  }
}
