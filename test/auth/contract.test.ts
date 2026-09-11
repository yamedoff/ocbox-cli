import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const artifact = readFileSync(join(repositoryRoot, 'openapi', 'openapi.yaml'))
const provenance = JSON.parse(
  readFileSync(join(repositoryRoot, 'openapi', 'PROVENANCE.json'), 'utf8'),
) as { bytes: number; generated: string[]; sha256: string; sourceCommit: string }
const generated = readFileSync(join(repositoryRoot, 'src', 'api', 'generated', 'client.ts'), 'utf8')

describe('pinned OpenAPI contract', () => {
  it('matches the pinned commit and SHA-256 exactly', () => {
    const sha256 = createHash('sha256').update(artifact).digest('hex')
    expect(provenance.sourceCommit).toBe('96ea22927492a16d115daa791a3836ac9e06d159')
    expect(provenance.sha256).toBe(sha256)
    expect(provenance.bytes).toBe(artifact.length)
    expect(provenance.generated).toContain('src/api/generated/client.ts')
  })

  it('embeds the pinned provenance in the generated client', () => {
    expect(generated).toContain(`OPENAPI_SOURCE_COMMIT = "${provenance.sourceCommit}"`)
    expect(generated).toContain(`OPENAPI_CHECKSUM = "sha256:${provenance.sha256}"`)
    for (const name of ['CliTokenPair', 'CliTokenRequest', 'StartCliAuthorizationRequest']) {
      expect(generated).toContain(`interface ${name}`)
    }
  })

  it('passes the regeneration drift and checksum gate', () => {
    const output = execFileSync(
      process.execPath,
      [join(repositoryRoot, 'scripts', 'check-api-contract.mjs')],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
      },
    )
    expect(output).toContain('API contract verified')
  })
})
