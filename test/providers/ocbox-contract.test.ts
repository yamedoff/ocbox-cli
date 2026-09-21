import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENAPI_CHECKSUM, OPENAPI_SOURCE_COMMIT } from '../../src/api/generated/client.js'

describe('pinned hosted contract', () => {
  it('pins the reviewed OpenAPI artifact without drift', () => {
    const root = process.cwd()
    const provenance = JSON.parse(
      readFileSync(join(root, 'openapi', 'PROVENANCE.json'), 'utf8'),
    ) as {
      sha256: string
      sourceCommit: string
    }
    expect(OPENAPI_SOURCE_COMMIT).toBe(provenance.sourceCommit)
    expect(OPENAPI_CHECKSUM).toBe(`sha256:${provenance.sha256}`)
  })

  it('exposes the T14 operation surface used by the hosted provider', async () => {
    const client = await import('../../src/api/generated/client.js')
    expect(typeof client.createClient).toBe('function')
    const source = readFileSync(join(process.cwd(), 'src', 'api', 'generated', 'client.ts'), 'utf8')
    for (const operation of [
      'createSession',
      'getSession',
      'startSession',
      'getOperation',
      'cancelOperation',
      'createExecution',
      'listExecutionEvents',
      'getExecutionResult',
      'createSourceManifest',
      'uploadSourceChunk',
      'verifySourceChecksum',
      'createPreview',
    ]) {
      expect(source).toContain(operation)
    }
  })
})
