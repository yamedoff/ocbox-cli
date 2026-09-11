import { describe, expect, it } from 'vitest'
import type { EntropyPort } from '../../src/auth/entropy.js'
import {
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
  isCodeVerifier,
  isState,
  timingSafeEqualText,
} from '../../src/auth/pkce.js'

class CountingEntropy implements EntropyPort {
  #value = 0

  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) {
      this.#value = (this.#value + 1) % 256
      bytes[index] = this.#value
    }
    return bytes
  }
}

describe('PKCE', () => {
  it('generates a 43-character base64url verifier from 32 CSPRNG bytes', () => {
    const verifier = generateCodeVerifier(new CountingEntropy())
    expect(verifier).toHaveLength(43)
    expect(isCodeVerifier(verifier)).toBe(true)
  })

  it('generates a bounded state value', () => {
    const state = generateState(new CountingEntropy())
    expect(isState(state)).toBe(true)
    expect(state.length).toBeGreaterThanOrEqual(16)
  })

  it('matches the RFC 7636 S256 reference vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('rejects malformed verifiers', () => {
    expect(isCodeVerifier('short')).toBe(false)
    expect(isCodeVerifier('a'.repeat(42))).toBe(false)
    expect(isCodeVerifier(`${'a'.repeat(42)}!`)).toBe(false)
    expect(() => codeChallengeS256('short')).toThrow()
  })

  it('compares protocol strings in constant time safely', () => {
    expect(timingSafeEqualText('state', 'state')).toBe(true)
    expect(timingSafeEqualText('state', 'other')).toBe(false)
    expect(timingSafeEqualText('state', 'state-longer')).toBe(false)
  })
})
