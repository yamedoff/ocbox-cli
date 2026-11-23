import { createHash } from 'node:crypto'

/** SHA-256 of the given bytes as lowercase hexadecimal. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
