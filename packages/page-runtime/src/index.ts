/**
 * @dsh-external/dsh-browser-bridge-page-runtime — framework-neutral browser
 * runtime injected into Vite pages. It probes and connects to the exact
 * loopback DSH origin, registers one target, executes strict page tool
 * calls, and (in later tasks) observes the DOM and hosts the optional
 * Shadow DOM panel.
 */
export {
  normalizeDshOrigin,
  pageRuntimeConfigSchema,
  type PageRuntimeConfig,
} from './config.ts'
export {
  ACTIVATION_STORAGE_KEY,
  Activator,
  type ActivationState,
  type KeyEventLike,
} from './activation.ts'
export {
  clearIdentity,
  loadOrCreateIdentity,
  persistGeneration,
  GENERATION_KEY,
  TARGET_ID_KEY,
  type PageIdentity,
} from './identity.ts'
export { probeLocalDsh, type ProbeOptions } from './probe.ts'
export { PageSocket, type PageDispatcher, type PageWebSocket } from './transport/socket.ts'
export { startPageRuntime, type PageRuntime } from './runtime.ts'
