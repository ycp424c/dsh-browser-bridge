/**
 * Short-lived, single-use pairing nonces bound to one exact extension origin.
 */
import { bridgeError, newPairingNonce, type PairingNonce } from '@dsh-external/dsh-browser-bridge-protocol'

export interface PairingStoreOptions {
  now?: () => number
  pairingTtlMs?: number
}

/** Chrome extension origins: `chrome-extension://` plus a 32-char [a-p] id. */
export const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/

export class PairingStore {
  private readonly now: () => number
  private readonly pairingTtlMs: number
  private readonly nonces = new Map<string, { origin: string; expiresAt: number }>()

  constructor(options: PairingStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.pairingTtlMs = options.pairingTtlMs ?? 30_000
  }

  /** Issue a single-use nonce bound to one exact `chrome-extension://<id>` origin. */
  issue(expectedExtensionOrigin: string): PairingNonce {
    if (!EXTENSION_ORIGIN_PATTERN.test(expectedExtensionOrigin)) {
      throw new Error(`pairing: invalid chrome-extension origin ${expectedExtensionOrigin}`)
    }
    const nonce = newPairingNonce()
    this.nonces.set(nonce, { origin: expectedExtensionOrigin, expiresAt: this.now() + this.pairingTtlMs })
    return nonce
  }

  /**
   * Consume one nonce. The record is deleted BEFORE origin or expiry is
   * validated so a replayed nonce always fails, even when the first attempt
   * was a mismatched origin.
   */
  consume(nonce: string, actualOrigin: string): boolean {
    const record = this.nonces.get(nonce)
    this.nonces.delete(nonce)
    if (record === undefined) {
      throw bridgeError('permission_denied', 'pairing: unknown or already used pairing nonce', false)
    }
    if (record.origin !== actualOrigin) {
      throw bridgeError('permission_denied', 'pairing: nonce origin mismatch', false)
    }
    if (this.now() > record.expiresAt) {
      throw bridgeError('grant_expired', 'pairing: nonce expired', false)
    }
    return true
  }
}
