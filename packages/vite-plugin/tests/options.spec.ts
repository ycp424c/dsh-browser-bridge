import { describe, expect, it } from 'vitest'
import { resolveOptions } from '../src/options.ts'

describe('plugin options', () => {
  it('applies the spec defaults', () => {
    const resolved = resolveOptions({ dshOrigin: 'http://127.0.0.1:3080' })
    expect(resolved).toMatchObject({
      dshOrigin: 'http://127.0.0.1:3080',
      bridge: { enabled: true, injectInBuild: false, autoConnectInBuild: false },
      panel: { enabled: true, visible: false, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' },
    })
    expect(resolved.projectId).toBeUndefined()
  })

  it('accepts explicit overrides', () => {
    const resolved = resolveOptions({
      dshOrigin: 'https://127.0.0.1:3443',
      bridge: { enabled: true, injectInBuild: true, autoConnectInBuild: true },
      panel: { enabled: false, visible: true, shortcut: 'Alt+Shift+P', queryParameter: 'open' },
      projectId: 'fixture',
    })
    expect(resolved.bridge.injectInBuild).toBe(true)
    expect(resolved.bridge.autoConnectInBuild).toBe(true)
    expect(resolved.panel.enabled).toBe(false)
    expect(resolved.projectId).toBe('fixture')
  })

  it('validates dshOrigin through the runtime config logic', () => {
    expect(() => resolveOptions({ dshOrigin: 'https://example.com' })).toThrow()
    expect(() => resolveOptions({ dshOrigin: 'http://user:pass@localhost:3080' })).toThrow()
    expect(() => resolveOptions({ dshOrigin: 'file:///tmp' })).toThrow()
  })

  it('rejects unknown and secret-shaped option keys', () => {
    expect(() => resolveOptions({ dshOrigin: 'http://127.0.0.1:3080', token: 'x' } as never)).toThrow()
    expect(() => resolveOptions({ dshOrigin: 'http://127.0.0.1:3080', secret: 'x' } as never)).toThrow()
    expect(() => resolveOptions({
      dshOrigin: 'http://127.0.0.1:3080',
      bridge: { enabled: true, apiKey: 'x' },
    } as never)).toThrow()
  })
})
