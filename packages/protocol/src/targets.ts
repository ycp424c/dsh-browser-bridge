/**
 * Provider-neutral browser target descriptors and capabilities shared by the
 * Chrome extension provider and the Vite page provider. The `provider`
 * discriminant is strict: a Vite descriptor may only advertise the reliable
 * capability subset, while a Chrome descriptor keeps the full operation set.
 */
import { z } from 'zod'
import { BROWSER_OPERATIONS, type BrowserOperation } from './grants.ts'
import type { TargetId } from './ids.ts'

/**
 * The reliable Vite capability subset. Screenshot and network are NEVER
 * advertised by a Vite target; related calls return `unsupported_operation`.
 */
export const VITE_BROWSER_CAPABILITIES = [
  'observe', 'inspect', 'act', 'navigate', 'wait', 'console',
] as const

export type ViteBrowserCapability = typeof VITE_BROWSER_CAPABILITIES[number]

export type BrowserProviderKind = 'chrome-extension' | 'vite'

export const viteBrowserCapabilitySchema = z.enum(VITE_BROWSER_CAPABILITIES)

/** Shared, bounded base fields of any browser target descriptor. */
const browserTargetDescriptorBase = z.strictObject({
  targetId: z.string().min(32).max(64),
  title: z.string().max(500),
  url: z.string().max(2048),
  origin: z.string().max(500),
  projectId: z.string().max(200).optional(),
  generation: z.number().int().nonnegative(),
})

export const viteBrowserTargetDescriptorSchema = browserTargetDescriptorBase.extend({
  provider: z.literal('vite'),
  capabilities: z.array(viteBrowserCapabilitySchema).min(1),
})

export const chromeBrowserTargetDescriptorSchema = browserTargetDescriptorBase.extend({
  provider: z.literal('chrome-extension'),
  capabilities: z.array(z.enum(BROWSER_OPERATIONS)).min(1),
})

/** One normalized, provider-tagged browser target snapshot (immutable). */
export const browserTargetDescriptorSchema = z.discriminatedUnion('provider', [
  chromeBrowserTargetDescriptorSchema,
  viteBrowserTargetDescriptorSchema,
])

export interface BrowserTargetDescriptorBase {
  targetId: TargetId
  title: string
  url: string
  origin: string
  projectId?: string
  generation: number
}

export interface ChromeBrowserTargetDescriptor extends BrowserTargetDescriptorBase {
  provider: 'chrome-extension'
  capabilities: BrowserOperation[]
}

export interface ViteBrowserTargetDescriptor extends BrowserTargetDescriptorBase {
  provider: 'vite'
  capabilities: ViteBrowserCapability[]
}

export type BrowserTargetDescriptor =
  | ChromeBrowserTargetDescriptor
  | ViteBrowserTargetDescriptor
