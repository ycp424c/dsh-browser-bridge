/**
 * Page-side sensitive-value masking and output bounding. Password, card,
 * token, secret, PIN, and API-key field values never reach observe, inspect,
 * console, or normal logs; every string field is bounded before
 * serialization so a single attribute or row cannot bypass the aggregate
 * frame limit. The host re-sanitizes everything again after the wire.
 */

/** Attribute/id/name patterns marking a field as sensitive. */
const SENSITIVE_FIELD = /password|passwd|token|secret|api[_-]?key|authorization|cookie|pin|cvv|card/i
const SENSITIVE_TEXT = /(password|passwd|token|secret|api[_-]?key|authorization|cookie|pin|cvv)\s*[:=]\s*[^\s,;]+/gi

/** Default cap for one returned string field (attribute, text, error row). */
export const MAX_FIELD_CHARS = 2_000

/** Whether one form control should never expose its value. */
export function isSensitiveField(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
  if (field instanceof HTMLInputElement && field.type === 'password') return true
  const name = [field.name, field.id, field.getAttribute('aria-label'), field.getAttribute('autocomplete')]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  return SENSITIVE_FIELD.test(name)
}

/** The masked rendering of one form control's value. */
export function maskSensitiveValue(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  return isSensitiveField(field) ? '[REDACTED]' : boundField(field.value)
}

/** Mask inline secret patterns inside free text. */
export function maskText(text: string): string {
  return text.replace(SENSITIVE_TEXT, '$1: [REDACTED]')
}

/** Bound one string field before serialization. */
export function boundField(text: string, max = MAX_FIELD_CHARS): string {
  return text.length > max ? text.slice(0, max) : text
}

/** Whether one attribute name should never expose its value. */
export function isSensitiveAttribute(name: string): boolean {
  return SENSITIVE_FIELD.test(name)
}
