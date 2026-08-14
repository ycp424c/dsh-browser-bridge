/**
 * Strict plugin options: defaults come from the approved spec, every value
 * is validated (the dshOrigin through the page-runtime config logic), and
 * unknown or secret-shaped keys are rejected — every option ends up in the
 * frontend bundle.
 */
import { z } from 'zod'
import { normalizeDshOrigin } from '@ycp424c/dsh-browser-bridge-page-runtime'

export interface DshBrowserBridgeOptions {
  /** Exact loopback DSH origin the injected pages may reach. */
  dshOrigin: string
  bridge?: {
    /** Master switch: false injects nothing anywhere. */
    enabled?: boolean
    /** Production builds inject only when this is explicitly true. */
    injectInBuild?: boolean
    /** Production builds: allow every visitor to probe and connect. */
    autoConnectInBuild?: boolean
  }
  panel?: {
    enabled?: boolean
    visible?: boolean
    shortcut?: string
    queryParameter?: string
  }
  projectId?: string
}

export interface ResolvedPluginOptions {
  dshOrigin: string
  bridge: {
    enabled: boolean
    injectInBuild: boolean
    autoConnectInBuild: boolean
  }
  panel: {
    enabled: boolean
    visible: boolean
    shortcut: string
    queryParameter: string
  }
  projectId?: string
}

const bridgeSchema = z.strictObject({
  enabled: z.boolean().default(true),
  injectInBuild: z.boolean().default(false),
  autoConnectInBuild: z.boolean().default(false),
})

const panelSchema = z.strictObject({
  enabled: z.boolean().default(true),
  visible: z.boolean().default(false),
  shortcut: z.string().min(1).max(64).default('Alt+Shift+D'),
  queryParameter: z.string().min(1).max(32).default('dsh'),
})

const optionsSchema = z.strictObject({
  dshOrigin: z.string().min(1).max(2048),
  bridge: bridgeSchema.optional(),
  panel: panelSchema.optional(),
  projectId: z.string().max(100).optional(),
})

export function resolveOptions(input: DshBrowserBridgeOptions): ResolvedPluginOptions {
  const parsed = optionsSchema.parse(input)
  const dshOrigin = normalizeDshOrigin(parsed.dshOrigin)
  return {
    dshOrigin,
    bridge: parsed.bridge ?? bridgeSchema.parse({}),
    panel: parsed.panel ?? panelSchema.parse({}),
    ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
  }
}
