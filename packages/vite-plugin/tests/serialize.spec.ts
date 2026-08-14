import { describe, expect, it } from 'vitest'
import type { PageRuntimeConfig } from '@ycp424c/dsh-browser-bridge-page-runtime'
import { serializeConfig } from '../src/serialize.ts'

const CONFIG: PageRuntimeConfig = {
  dshOrigin: 'http://127.0.0.1:3080',
  mode: 'production',
  bridge: { enabled: true, autoConnectInBuild: false },
  panel: { enabled: true, visible: false, shortcut: 'Alt+Shift+D', queryParameter: 'dsh' },
}

describe('config serialization', () => {
  it('escapes less-than, U+2028, and U+2029', () => {
    const withDanger = {
      ...CONFIG,
      projectId: '</script><script>alert(1)</script>',
      panel: { ...CONFIG.panel, shortcut: 'Alt+\u2028Shift+\u2029D' },
    }
    const serialized = serializeConfig(withDanger)
    expect(serialized).not.toContain('</script>')
    expect(serialized).toContain('\\u003c/script>')
    expect(serialized).not.toContain('\u2028')
    expect(serialized).not.toContain('\u2029')
  })

  it('round-trips through JSON.parse to the same shape', () => {
    const serialized = serializeConfig(CONFIG)
    expect(JSON.parse(serialized)).toEqual(CONFIG)
  })

  it('is deterministic for the same input', () => {
    expect(serializeConfig(CONFIG)).toBe(serializeConfig(CONFIG))
  })
})
