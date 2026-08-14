/**
 * @ycp424c/dsh-browser-bridge-page-runtime — framework-neutral browser
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
  type ActivationMeta,
  type ActivationState,
  type KeyEventLike,
} from './activation.ts'
export { PanelChannel, type PanelChannelEnv } from './panel/channel.ts'
export { createPanel, PANEL_HOST_ID, type Panel, type PanelConnectionState } from './panel/panel.ts'
export {
  clearIdentity,
  loadOrCreateIdentity,
  persistGeneration,
  GENERATION_KEY,
  TARGET_ID_KEY,
  type PageIdentity,
} from './identity.ts'
export { probeLocalDsh, type ProbeOptions } from './probe.ts'
export { PageSocket, type PageWebSocket } from './transport/socket.ts'
export { ElementRegistry } from './refs/registry.ts'
export {
  PageDispatcher,
  toBridgeError,
  OBSERVE_ARGS_SCHEMA,
  INSPECT_ARGS_SCHEMA,
  type OperationHandler,
} from './tools/dispatcher.ts'
export { observeDocument, type ObserveNode, type ObserveResult } from './tools/observe.ts'
export { inspectElement, COMPUTED_STYLE_ALLOWLIST, type InspectArgs, type InspectResult } from './tools/inspect.ts'
export { actOnElement, type ActArgs } from './tools/act.ts'
export { navigatePage, type NavigateArgs } from './tools/navigate.ts'
export { waitForCondition, type WaitArgs } from './tools/wait.ts'
export { ConsoleCapture, type ConsoleRow } from './tools/console.ts'
export { createHmrManager, type HmrManager } from './hmr.ts'
export {
  boundField,
  isSensitiveAttribute,
  isSensitiveField,
  maskSensitiveValue,
  maskText,
} from './tools/sanitize.ts'
export { startPageRuntime, type PageRuntime } from './runtime.ts'
