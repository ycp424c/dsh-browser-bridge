/**
 * Provider registry: one provider per kind. Duplicate registration is a
 * wiring bug and fails loudly; unknown providers are rejected at dispatch.
 */
import type { BrowserProviderKind } from '@ycp424c/dsh-browser-bridge-protocol'
import type { BrowserProvider } from './types.ts'

export class ProviderRegistry {
  private readonly byKind = new Map<BrowserProviderKind, BrowserProvider>()

  constructor(providers: readonly BrowserProvider[] = []) {
    for (const provider of providers) this.register(provider)
  }

  /** Register one provider; duplicates of the same kind are rejected. */
  register(provider: BrowserProvider): void {
    if (this.byKind.has(provider.kind)) {
      throw new Error(`provider: duplicate ${provider.kind} registration`)
    }
    this.byKind.set(provider.kind, provider)
  }

  get(kind: BrowserProviderKind): BrowserProvider | undefined {
    return this.byKind.get(kind)
  }

  list(): BrowserProvider[] {
    return [...this.byKind.values()]
  }
}
