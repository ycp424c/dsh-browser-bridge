/**
 * Branded wire identifiers and random ID factories for the browser bridge.
 * IDs are opaque strings; brands exist only at the type level.
 */

declare const brand: unique symbol

type Branded<Name extends string> = string & { readonly [brand]: Name }

/** Identity of one authenticated extension connection. */
export type ConnectionId = Branded<'ConnectionId'>
/** One short-lived single-use pairing nonce issued by the host. */
export type PairingNonce = Branded<'PairingNonce'>
/** Server-side identity of one prompt grant. */
export type GrantId = Branded<'GrantId'>
/** Non-secret correlation handle serialized into prompt text. */
export type GrantHandle = Branded<'GrantHandle'>
/** Correlation identity of one bridge request. */
export type RequestId = Branded<'RequestId'>
/** Short-lived element reference returned by `browser_observe`. */
export type ElementRef = Branded<'ElementRef'>
/** Identity of one Vite page target (per-tab sessionStorage, not authority). */
export type TargetId = Branded<'TargetId'>

export const ConnectionId = (value: string): ConnectionId => value as ConnectionId
export const PairingNonce = (value: string): PairingNonce => value as PairingNonce
export const GrantId = (value: string): GrantId => value as GrantId
export const GrantHandle = (value: string): GrantHandle => value as GrantHandle
export const RequestId = (value: string): RequestId => value as RequestId
export const ElementRef = (value: string): ElementRef => value as ElementRef
export const TargetId = (value: string): TargetId => value as TargetId

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Cryptographically random base64url string. Uses `globalThis.crypto`
 * (`getRandomValues`) so the same factory works in the extension service
 * worker and in Node. Note that this is NOT a WebCrypto `crypto.randomUUID`
 * shape: it is raw uniform bytes over the base64url alphabet.
 */
export function randomBase64url(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buffer)
  let out = ''
  for (let i = 0; i < buffer.length; i += 3) {
    const b0 = buffer[i]!
    const b1 = buffer[i + 1]
    const b2 = buffer[i + 2]
    out += ALPHABET[b0 >> 2]!
    out += ALPHABET[((b0 & 0x3) << 4) | ((b1 ?? 0) >> 4)]!
    if (b1 !== undefined) {
      out += ALPHABET[((b1 & 0xf) << 2) | ((b2 ?? 0) >> 6)]!
      if (b2 !== undefined) out += ALPHABET[b2 & 0x3f]!
    }
  }
  return out
}

/** New random 32-byte base64url identifier (43 chars). */
export const newConnectionId = (): ConnectionId => ConnectionId(randomBase64url(32))
export const newPairingNonce = (): PairingNonce => PairingNonce(randomBase64url(32))
export const newGrantId = (): GrantId => GrantId(randomBase64url(32))
export const newGrantHandle = (): GrantHandle => GrantHandle(randomBase64url(32))
export const newRequestId = (): RequestId => RequestId(randomBase64url(32))
/** Element references are shorter (16 bytes) but still unguessable. */
export const newElementRef = (): ElementRef => ElementRef(randomBase64url(16))
/** Target ids are random 32-byte base64url identifiers (43 chars). */
export const newTargetId = (): TargetId => TargetId(randomBase64url(32))
