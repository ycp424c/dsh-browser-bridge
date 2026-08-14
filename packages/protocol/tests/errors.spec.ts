import { describe, expect, it } from 'vitest'
import {
  BRIDGE_ERROR_CODES,
  BRIDGE_ERROR_RECOVERY,
  bridgeError,
  bridgeErrorSchema,
} from '../src/errors.ts'

describe('bridge error codes', () => {
  it('every stable code has a recovery entry', () => {
    for (const code of BRIDGE_ERROR_CODES) {
      expect(BRIDGE_ERROR_RECOVERY[code], `recovery missing for ${code}`).toBeTruthy()
      expect(BRIDGE_ERROR_RECOVERY[code]!.length).toBeGreaterThan(10)
    }
  })

  it('exposes the failure-visibility codes added for confirmable operations', () => {
    expect(BRIDGE_ERROR_CODES).toContain('postcondition_failed')
    expect(BRIDGE_ERROR_CODES).toContain('input_not_applied')
    expect(BRIDGE_ERROR_CODES).toContain('invalid_value')
  })

  it('validates payloads built by bridgeError', () => {
    const error = bridgeError('postcondition_failed', 'condition not satisfied', true)
    expect(bridgeErrorSchema.safeParse(error).success).toBe(true)
  })

  it('rejects unknown codes', () => {
    expect(bridgeErrorSchema.safeParse({ code: 'nope', message: 'x', retryable: false }).success).toBe(false)
  })
})
