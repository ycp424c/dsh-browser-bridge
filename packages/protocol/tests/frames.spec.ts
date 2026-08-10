import { describe, expect, it } from 'vitest'
import {
  BRIDGE_ERROR_CODES,
  bridgeError,
  decodeFrame,
  encodeFrame,
  newGrantId,
  newRequestId,
  PROTOCOL_VERSION,
  type BridgeFrame,
  type ToolCallFrame,
} from '../src/index.ts'

describe('wire frames', () => {
  it('accepts a valid hello and rejects unknown protocol versions', () => {
    expect(decodeFrame(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', pairingNonce: 'n'.repeat(32) }))).toMatchObject({ type: 'hello' })
    expect(() => decodeFrame(JSON.stringify({ v: 99, type: 'pong' }))).toThrow(/protocol frame/)
  })

  it('rejects extra fields on every frame kind', () => {
    const hello = { v: PROTOCOL_VERSION, type: 'hello', pairingNonce: 'n'.repeat(32) }
    expect(decodeFrame(JSON.stringify(hello))).toMatchObject({ type: 'hello' })
    expect(() => decodeFrame(JSON.stringify({ ...hello, extra: true }))).toThrow(/protocol frame/)
    expect(() => decodeFrame(JSON.stringify({ v: PROTOCOL_VERSION, type: 'grant.put' }))).toThrow(/protocol frame/)
  })

  it('rejects malformed JSON and non-object payloads without echoing them', () => {
    expect(() => decodeFrame('not json')).toThrow(/protocol frame/)
    expect(() => decodeFrame('null')).toThrow(/protocol frame/)
    expect(() => decodeFrame('"string"')).toThrow(/protocol frame/)
    expect(() => decodeFrame('[1,2]')).toThrow(/protocol frame/)
  })

  it('round-trips every stable bridge error through the error frame', () => {
    for (const code of BRIDGE_ERROR_CODES) {
      const error = bridgeError(code, `message for ${code}`, code === 'timeout')
      const frame: BridgeFrame = { v: PROTOCOL_VERSION, type: 'error', ...error }
      const decoded = decodeFrame(encodeFrame(frame))
      expect(decoded).toMatchObject({ type: 'error', code, retryable: code === 'timeout' })
    }
  })

  it('round-trips grant offers and tool requests with nested JSON args', () => {
    const grant: BridgeFrame = {
      v: PROTOCOL_VERSION,
      type: 'grant.put',
      grantId: newGrantId(),
      sessionId: 'session-a',
      tab: { tabId: 7, windowId: 2, title: 'Fixture', url: 'http://127.0.0.1:4173/' },
      expiresAt: 123_456,
    }
    const decoded = decodeFrame(encodeFrame(grant))
    expect(decoded).toMatchObject({ type: 'grant.put', tab: { tabId: 7 } })

    const call: BridgeFrame = {
      v: PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: newRequestId(),
      grantId: newGrantId(),
      operation: 'inspect',
      args: { selector: '#save', properties: ['color'] },
    }
    const callDecoded = decodeFrame(encodeFrame(call))
    expect(callDecoded).toMatchObject({ type: 'tool.call', operation: 'inspect' })
    expect((callDecoded as ToolCallFrame).args).toMatchObject({ selector: '#save' })
  })

  it('rejects tool results with unknown error codes', () => {
    const result = {
      v: PROTOCOL_VERSION,
      type: 'tool.result',
      requestId: newRequestId(),
      result: { ok: false, error: { code: 'not-a-code', message: 'x', retryable: false } },
    }
    expect(() => decodeFrame(JSON.stringify(result))).toThrow(/protocol frame/)
  })
})
