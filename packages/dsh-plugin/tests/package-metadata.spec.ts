import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PluginManifest {
  dsh?: {
    client?: {
      inject?: string[]
      platform?: string
    }
  }
  dshClient?: unknown
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PluginManifest

describe('DSH plugin package metadata', () => {
  it('declares the web client through the DSH 0810 dsh.client contract', () => {
    expect(manifest.dsh?.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-input-trigger',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-slots',
      ],
      platform: 'web',
    })
    expect(manifest).not.toHaveProperty('dshClient')
  })
})
