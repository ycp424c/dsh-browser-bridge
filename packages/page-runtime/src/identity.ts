/**
 * Per-tab page identity kept in namespaced sessionStorage. The targetId is
 * a correlation identity, never an authority; stored values are validated
 * before reuse and the generation increments monotonically across same-tab
 * reloads. Nothing here ever touches localStorage.
 */
import { newTargetId, type TargetId } from '@dsh-external/dsh-browser-bridge-protocol'

export const TARGET_ID_KEY = 'dsh-browser-bridge:targetId'
export const GENERATION_KEY = 'dsh-browser-bridge:generation'

const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{32,64}$/
/** Defense against a corrupted storage value overflowing anything downstream. */
const MAX_GENERATION = 1_000_000

export interface PageIdentity {
  targetId: TargetId
  generation: number
}

export function loadOrCreateIdentity(storage: Storage): PageIdentity {
  const storedId = storage.getItem(TARGET_ID_KEY)
  const targetId = storedId !== null && TARGET_ID_PATTERN.test(storedId) ? storedId : newTargetId()
  const storedGeneration = Number(storage.getItem(GENERATION_KEY) ?? '0')
  const generation = Number.isSafeInteger(storedGeneration) && storedGeneration >= 0 && storedGeneration < MAX_GENERATION
    ? storedGeneration + 1
    : 1
  storage.setItem(TARGET_ID_KEY, targetId)
  storage.setItem(GENERATION_KEY, String(generation))
  return { targetId: targetId as TargetId, generation }
}

/** Persist one generation for an existing identity (HMR bumps). */
export function persistGeneration(storage: Storage, generation: number): void {
  storage.setItem(GENERATION_KEY, String(generation))
}

/** Remove every identity key (page teardown). */
export function clearIdentity(storage: Storage): void {
  storage.removeItem(TARGET_ID_KEY)
  storage.removeItem(GENERATION_KEY)
}
