import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ProjectSchema, SandboxSchema, SessionSchema } from '../../src/contracts.js'

interface EntityFixture {
  project: unknown
  session: unknown
  sandbox: unknown
}

async function readEntityFixture(): Promise<EntityFixture> {
  const fixtureUrl = new URL('../fixtures/contracts/entities.json', import.meta.url)
  return JSON.parse(await readFile(fixtureUrl, 'utf8')) as EntityFixture
}

describe('JSON contract fixtures', () => {
  it('round-trips Project, Session and Sandbox records through their schemas', async () => {
    const fixture = await readEntityFixture()
    const project = ProjectSchema.parse(fixture.project)
    const session = SessionSchema.parse(fixture.session)
    const sandbox = SandboxSchema.parse(fixture.sandbox)

    expect(ProjectSchema.parse(JSON.parse(JSON.stringify(project)))).toEqual(project)
    expect(SessionSchema.parse(JSON.parse(JSON.stringify(session)))).toEqual(session)
    expect(SandboxSchema.parse(JSON.parse(JSON.stringify(sandbox)))).toEqual(sandbox)
  })

  it('keeps the fixture requested/effective values divergent', async () => {
    const sandbox = SandboxSchema.parse((await readEntityFixture()).sandbox)
    expect(sandbox.specification.requested.cpu.millicores).toBe(1_000)
    expect(sandbox.specification.effective?.cpu.millicores).toBe(2_000)
  })
})
