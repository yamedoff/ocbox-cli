import { createHash, timingSafeEqual } from 'node:crypto'
import type { EntropyPort } from './entropy.js'

export const CODE_VERIFIER_MIN_LENGTH = 43
export const CODE_VERIFIER_MAX_LENGTH = 128
export const STATE_MIN_LENGTH = 16
export const STATE_MAX_LENGTH = 128

const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** RFC 7636 verifier: 32 random bytes rendered as a 43-character base64url string. */
export function generateCodeVerifier(entropy: EntropyPort): string {
  return base64Url(entropy.randomBytes(32))
}

/** Opaque OAuth state; long enough that guessing is infeasible. */
export function generateState(entropy: EntropyPort): string {
  return base64Url(entropy.randomBytes(32))
}

/** S256 challenge derived from the verifier; the verifier itself is never transmitted. */
export function codeChallengeS256(codeVerifier: string): string {
  if (!isCodeVerifier(codeVerifier)) throw new TypeError('Invalid PKCE code verifier')
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
}

export function isCodeVerifier(value: string): boolean {
  return CODE_VERIFIER_PATTERN.test(value)
}

export function isState(value: string): boolean {
  return STATE_PATTERN.test(value)
}

/** Timing-safe comparison for equal-length protocol strings such as `state`. */
export function timingSafeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  if (leftBytes.length !== rightBytes.length) return false
  return timingSafeEqual(leftBytes, rightBytes)
}
