/**
 * Shared sensitive-field detection for the extension tool layer. A field is
 * sensitive when its type is password or when its identifying attributes
 * (name/id/placeholder/autocomplete/class) match secret-like patterns. The
 * plaintext value of a sensitive field never crosses into a model-visible
 * tool result: the extension may compare raw values internally, but output
 * carries a `masked: true` flag instead.
 */

export const SENSITIVE_PATTERN = /password|passwd|secret|token|card|cvv|pin|api[-_]?key|authorization|credential|otp|totp/i

export interface FieldIdentity {
  type: string | undefined
  name: string | undefined
  id: string | undefined
  placeholder: string | undefined
  autocomplete: string | undefined
  className: string | undefined
}

export function isSensitiveField(field: FieldIdentity | undefined): boolean {
  if (field === undefined) return false
  if (field.type === 'password') return true
  const haystack = [field.name, field.id, field.placeholder, field.autocomplete, field.className]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ')
  return SENSITIVE_PATTERN.test(haystack)
}
