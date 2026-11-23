import { randomBytes } from 'node:crypto'

/** Injectable entropy boundary; production uses the operating-system CSPRNG. */
export interface EntropyPort {
  randomBytes(length: number): Uint8Array
}

export class SystemEntropy implements EntropyPort {
  randomBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length <= 0 || length > 65_536) {
      throw new TypeError('Entropy length must be a positive bounded integer')
    }
    return new Uint8Array(randomBytes(length))
  }
}
