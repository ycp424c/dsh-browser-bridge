/** Shared fixture: exact model metadata for screenshot capability gates. */
import { Context, Service } from 'cordis'

export class FakeLlm extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  resolveModelInfo(provider: string, model: string): Promise<{
    provider: string
    id: string
    name: string
    inputModalities: readonly ('text' | 'image')[]
  }> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
}
