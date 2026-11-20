import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENAPI_CHECKSUM, OPENAPI_SOURCE_COMMIT } from '../../src/api/generated/client.js'
import { HostedSessionSchema } from '../../src/providers/ocbox/wire.js'

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

  it('parses the measured refused session the hosted API sends', () => {
    const parsed = HostedSessionSchema.safeParse({
      createdAt: '2026-10-29T00:00:00.000Z',
      effectiveSpec: { cpu: 1, memory: 1024, region: 'us', runtime: 'python' },
      id: 'ses_9d6b3eb74aae3741801b93a37e4ff2',
      normalizedState: 'failed',
      primarySandboxId: null,
      projectId: 'project-alice',
      rawState: 'admission_denied',
      requestedSpec: {},
      sandboxes: [],
      updatedAt: '2026-10-29T00:00:00.000Z',
      failure: {
        reasonCode: 'user_active_limit',
        nextStep:
          'You have reached the number of running boxes for your plan; stop or destroy one (session_list) and retry.',
      },
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.normalizedState : null).toBe('failed')
    expect(parsed.success ? parsed.data.failure?.reasonCode : null).toBe('user_active_limit')
  })
})
