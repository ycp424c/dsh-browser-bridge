import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PluginManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: {
    client?: {
      inject?: string[]
      platform?: string
    }
  }
  dshClient?: unknown
  peerDependencies?: Record<string, string>
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

  it('ships the scoped schemastery runtime imported by the host bundle', () => {
    expect(manifest.dependencies?.['@deepseek-ai/schemastery']).toBe('^3.18.1-rc.1')
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/schemastery')
    expect(manifest.devDependencies).not.toHaveProperty('@deepseek-ai/schemastery')
  })
})
