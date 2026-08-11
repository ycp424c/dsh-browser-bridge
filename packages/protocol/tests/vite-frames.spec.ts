import { describe, expect, it } from 'vitest'
import {
  VITE_BROWSER_CAPABILITIES,
  VITE_PAGE_PROTOCOL_VERSION,
  bridgeErrorSchema,
  browserTargetDescriptorSchema,
  decodeViteHostToPageFrame,
  decodeVitePageToHostFrame,
  viteHostToPageFrameSchema,
  vitePageToHostFrameSchema,
} from '../src/index.ts'

/** 43-char base64url-shaped target id used across fixtures. */
const TARGET_ID = 't'.repeat(43)

const TARGET = {
  targetId: TARGET_ID,
  provider: 'vite',
  title: 'Fixture',
  url: 'https://fixture.test/app',
  origin: 'https://fixture.test',
  projectId: 'fixture',
  generation: 0,
  capabilities: ['observe', 'inspect', 'act', 'navigate', 'wait', 'console'],
} as const

const registerFrame = {
  v: VITE_PAGE_PROTOCOL_VERSION,
  type: 'target.register',
  target: TARGET,
} as const

describe('Vite page protocol', () => {
  it('accepts a strict target registration', () => {
    const frame = decodeVitePageToHostFrame(JSON.stringify(registerFrame))
    expect(frame.type).toBe('target.register')
    if (frame.type !== 'target.register') throw new Error('unreachable')
    expect(frame.target.capabilities).toEqual([...VITE_BROWSER_CAPABILITIES])
  })

  it('rejects Vite screenshot/network claims and extra fields', () => {
    const base = {
      targetId: TARGET_ID,
      provider: 'vite',
      title: 'Fixture',
      url: 'https://fixture.test/',
      origin: 'https://fixture.test',
      generation: 0,
      capabilities: ['screenshot'],
    }
    expect(() => browserTargetDescriptorSchema.parse(base)).toThrow()
    expect(() => browserTargetDescriptorSchema.parse({
      ...base,
      capabilities: ['observe'],
      token: 'must-not-exist',
    })).toThrow()
  })

  it('restricts the Vite descriptor to the reliable capability subset', () => {
    for (const capability of VITE_BROWSER_CAPABILITIES) {
      const parsed = browserTargetDescriptorSchema.parse({
        ...TARGET,
        capabilities: [capability],
      })
      expect(parsed.provider).toBe('vite')
    }
    expect(() => browserTargetDescriptorSchema.parse({
      ...TARGET,
      capabilities: ['network'],
    })).toThrow()
    expect(() => browserTargetDescriptorSchema.parse({
      ...TARGET,
      capabilities: ['observe', 'network'],
    })).toThrow()
  })

  it('keeps Chrome descriptors on the full operation set via the same discriminant', () => {
    const chrome = browserTargetDescriptorSchema.parse({
      targetId: TARGET_ID,
      provider: 'chrome-extension',
      title: 'Tab',
      url: 'https://example.test/',
      origin: 'https://example.test',
      generation: 0,
      capabilities: ['observe', 'inspect', 'screenshot', 'act', 'navigate', 'wait', 'console', 'network'],
    })
    expect(chrome.provider).toBe('chrome-extension')
    expect(chrome.capabilities).toContain('screenshot')
    expect(chrome.capabilities).toContain('network')
  })

  it('rejects malformed target ids and unknown protocol versions', () => {
    expect(() => browserTargetDescriptorSchema.parse({
      ...TARGET,
      targetId: 'short',
    })).toThrow()
    expect(() => decodeVitePageToHostFrame(JSON.stringify({
      ...registerFrame,
      v: 99,
    }))).toThrow(/protocol frame/)
    expect(() => decodeVitePageToHostFrame('not json')).toThrow(/protocol frame/)
    expect(() => decodeVitePageToHostFrame('null')).toThrow(/protocol frame/)
  })

  it('rejects Vite pages sending host-only frames', () => {
    const toolCall = {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 'r'.repeat(32),
      operation: 'observe',
      args: {},
    }
    expect(vitePageToHostFrameSchema.safeParse(toolCall).success).toBe(false)
    expect(() => decodeVitePageToHostFrame(JSON.stringify(toolCall))).toThrow(/protocol frame/)

    const cancel = {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.cancel',
      requestId: 'r'.repeat(32),
      reason: 'cancelled',
    }
    expect(vitePageToHostFrameSchema.safeParse(cancel).success).toBe(false)
    expect(() => decodeVitePageToHostFrame(JSON.stringify(cancel))).toThrow(/protocol frame/)

    const revoke = {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.revoke',
    }
    expect(vitePageToHostFrameSchema.safeParse(revoke).success).toBe(false)
    expect(() => decodeVitePageToHostFrame(JSON.stringify(revoke))).toThrow(/protocol frame/)

    const error = {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'error',
      code: 'internal',
      message: 'boom',
      retryable: false,
    }
    expect(vitePageToHostFrameSchema.safeParse(error).success).toBe(false)
    expect(() => decodeVitePageToHostFrame(JSON.stringify(error))).toThrow(/protocol frame/)
  })

  it('rejects the Host treating target.register as a host-to-page frame', () => {
    expect(viteHostToPageFrameSchema.safeParse(registerFrame).success).toBe(false)
    expect(() => decodeViteHostToPageFrame(JSON.stringify(registerFrame))).toThrow(/protocol frame/)
  })

  it('accepts every host-to-page frame a Vite page may receive', () => {
    const registered = decodeViteHostToPageFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.registered',
      targetId: TARGET_ID,
    }))
    expect(registered.type).toBe('target.registered')

    const call = decodeViteHostToPageFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 'r'.repeat(32),
      operation: 'observe',
      args: {},
    }))
    expect(call.type).toBe('tool.call')

    const cancel = decodeViteHostToPageFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.cancel',
      requestId: 'r'.repeat(32),
      reason: 'cancelled',
    }))
    expect(cancel.type).toBe('tool.cancel')

    const revoke = decodeViteHostToPageFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'target.revoke',
    }))
    expect(revoke.type).toBe('target.revoke')

    expect(decodeViteHostToPageFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'ping',
    })).type).toBe('ping')
    expect(decodeViteHostToPageFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'pong',
    })).type).toBe('pong')
    expect(decodeViteHostToPageFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'error',
      code: 'target_disconnected',
      message: 'gone',
      retryable: true,
    })).type).toBe('error')
  })

  it('restricts tool.call operations to VITE_BROWSER_CAPABILITIES', () => {
    const base = {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: 'r'.repeat(32),
      args: {},
    }
    for (const capability of VITE_BROWSER_CAPABILITIES) {
      expect(viteHostToPageFrameSchema.safeParse({ ...base, operation: capability }).success).toBe(true)
    }
    expect(viteHostToPageFrameSchema.safeParse({ ...base, operation: 'screenshot' }).success).toBe(false)
    expect(viteHostToPageFrameSchema.safeParse({ ...base, operation: 'network' }).success).toBe(false)
    expect(() => decodeViteHostToPageFrame(JSON.stringify({ ...base, operation: 'screenshot' }))).toThrow(/protocol frame/)
  })

  it('bounds tool.cancel to a correlated request id and a stable reason code', () => {
    const cancel = {
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.cancel',
      requestId: 'r'.repeat(32),
      reason: 'cancelled',
    }
    expect(() => decodeViteHostToPageFrame(JSON.stringify(cancel))).not.toThrow()
    // No new operation can hide in a cancel frame.
    expect(() => decodeViteHostToPageFrame(JSON.stringify({ ...cancel, operation: 'observe' }))).toThrow(/protocol frame/)
    expect(() => decodeViteHostToPageFrame(JSON.stringify({ ...cancel, reason: 'takeover' }))).toThrow(/protocol frame/)
  })

  it('never lets a Vite frame carry session ids, grant handles, host methods, secrets, or screenshots', () => {
    const forbiddenExtra = {
      sessionId: 'session-a',
      grantId: 'g'.repeat(32),
      handle: 'h'.repeat(32),
      method: 'fs.read',
      token: 'secret-token',
    }
    const cases: Array<{ frame: Record<string, unknown>; schema: typeof vitePageToHostFrameSchema | typeof viteHostToPageFrameSchema }> = [
      { frame: { ...registerFrame, ...forbiddenExtra }, schema: vitePageToHostFrameSchema },
      { frame: { v: VITE_PAGE_PROTOCOL_VERSION, type: 'target.update', target: { ...TARGET, ...forbiddenExtra } }, schema: vitePageToHostFrameSchema },
      { frame: { v: VITE_PAGE_PROTOCOL_VERSION, type: 'tool.result', requestId: 'r'.repeat(32), result: { ok: true, value: { nodes: [] } }, ...forbiddenExtra }, schema: vitePageToHostFrameSchema },
      { frame: { v: VITE_PAGE_PROTOCOL_VERSION, type: 'tool.call', requestId: 'r'.repeat(32), operation: 'observe', args: {}, ...forbiddenExtra }, schema: viteHostToPageFrameSchema },
    ]
    for (const { frame, schema } of cases) {
      expect(schema.safeParse(frame).success).toBe(false)
    }
  })

  it('accepts page tool results and errors with the stable error shape', () => {
    const result = decodeVitePageToHostFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.result',
      requestId: 'r'.repeat(32),
      result: { ok: true, value: { nodes: [] } },
    }))
    expect(result.type).toBe('tool.result')

    const failure = decodeVitePageToHostFrame(JSON.stringify({
      v: VITE_PAGE_PROTOCOL_VERSION,
      type: 'tool.result',
      requestId: 'r'.repeat(32),
      result: { ok: false, error: { code: 'stale_element', message: 'ref expired', retryable: false } },
    }))
    expect(failure.type).toBe('tool.result')
    if (failure.type !== 'tool.result') throw new Error('unreachable')
    if (failure.result.ok) throw new Error('expected a failure result')
    expect(bridgeErrorSchema.safeParse(failure.result.error).success).toBe(true)
  })

  it('accepts hello, target.update, accepted, ping, and pong from a page', () => {
    const pageFrames = [
      { v: VITE_PAGE_PROTOCOL_VERSION, type: 'hello' },
      {
        v: VITE_PAGE_PROTOCOL_VERSION,
        type: 'target.update',
        target: { ...TARGET, generation: 1 },
      },
      { v: VITE_PAGE_PROTOCOL_VERSION, type: 'tool.accepted', requestId: 'r'.repeat(32) },
      { v: VITE_PAGE_PROTOCOL_VERSION, type: 'ping' },
      { v: VITE_PAGE_PROTOCOL_VERSION, type: 'pong' },
    ]
    for (const frame of pageFrames) {
      expect(vitePageToHostFrameSchema.safeParse(frame).success).toBe(true)
      expect(() => decodeVitePageToHostFrame(JSON.stringify(frame))).not.toThrow()
    }
  })
})
