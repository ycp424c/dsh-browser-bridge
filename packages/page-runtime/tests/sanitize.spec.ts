import { describe, expect, it } from 'vitest'
import { isSensitiveField, maskSensitiveValue, maskText } from '../src/tools/sanitize.ts'

describe('sensitive value sanitization', () => {
  it('masks password and sensitive-named fields by value', () => {
    const password = document.createElement('input')
    password.type = 'password'
    password.value = 'super-secret'
    expect(isSensitiveField(password)).toBe(true)
    expect(maskSensitiveValue(password)).toBe('[REDACTED]')

    const token = document.createElement('input')
    token.id = 'api-token'
    token.value = 'tok-12345'
    expect(isSensitiveField(token)).toBe(true)
    expect(maskSensitiveValue(token)).toBe('[REDACTED]')

    const card = document.createElement('input')
    card.name = 'card_number'
    card.value = '4111 1111 1111 1111'
    expect(isSensitiveField(card)).toBe(true)
    expect(maskSensitiveValue(card)).toBe('[REDACTED]')

    const pin = document.createElement('input')
    pin.setAttribute('aria-label', 'PIN code')
    pin.value = '1234'
    expect(isSensitiveField(pin)).toBe(true)
    expect(maskSensitiveValue(pin)).toBe('[REDACTED]')
  })

  it('keeps ordinary field values', () => {
    const plain = document.createElement('input')
    plain.type = 'text'
    plain.id = 'username'
    plain.value = 'alice'
    expect(isSensitiveField(plain)).toBe(false)
    expect(maskSensitiveValue(plain)).toBe('alice')
  })

  it('masks inline secret patterns in free text', () => {
    const masked = maskText('token=abc123 and Authorization: Bearer xyz and password: hunter2')
    expect(masked).not.toContain('abc123')
    expect(masked).not.toContain('Bearer xyz')
    expect(masked).not.toContain('hunter2')
    expect(masked).toContain('[REDACTED]')
  })

  it('leaves ordinary text untouched', () => {
    expect(maskText('The quick brown fox jumps over the lazy dog')).toContain('quick brown fox')
  })
})
