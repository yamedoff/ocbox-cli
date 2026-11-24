import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OcboxSandboxProvider } from '../src/providers/ocbox/provider.js'
import { applyCodexChangePlan } from '../src/agents/codex/planner.js'
import { nodeCodexFileSystem } from '../src/agents/codex/fs.js'
import { sha256 } from '../src/agents/codex/document.js'
import {
  HOSTED_PROJECT,
  HOSTED_SESSION,
  hostedOperationFixture,
  hostedSessionFixture,
  jsonResponse,
  LOCAL_IDS,
  operationContext,
  seededApi,
  testSpec,
} from './providers/doubles.js'
import { planCodexSetup } from '../src/agents/codex/planner.js'
import { resolveCodexPaths } from '../src/agents/codex/paths.js'

function projectFixture(): Record<string, unknown> {
  return {
    createdAt: '2026-09-12T10:00:00.000Z',
    id: HOSTED_PROJECT,
    name: 'hosted project',
    updatedAt: '2026-09-12T10:00:00.000Z',
  }
}

async function hostedProvider(
  sessionOverrides: Record<string, unknown>,
  providerRequestedSpec?: Record<string, unknown>,
): Promise<OcboxSandboxProvider> {
  const { api } = await seededApi((input, init) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.endsWith(`/projects/${HOSTED_PROJECT}`) && method === 'GET') {
      return Promise.resolve(jsonResponse(projectFixture()))
    }
    if (url.endsWith(`/projects/${HOSTED_PROJECT}/sessions`) && method === 'POST') {
      return Promise.resolve(jsonResponse(hostedOperationFixture({}), 202))
    }
    if (url.includes('/operations/') && method === 'GET') {
      return Promise.resolve(jsonResponse(hostedOperationFixture({})))
    }
    if (url.endsWith(`/sessions/${HOSTED_SESSION}`) && method === 'GET') {
      return Promise.resolve(jsonResponse(hostedSessionFixture(sessionOverrides)))
    }
    return Promise.resolve(jsonResponse({}))
  })
  return new OcboxSandboxProvider({
    api,
    hostedProjectId: HOSTED_PROJECT,
    now: () => '2026-09-12T10:02:00.000Z',
    ...(providerRequestedSpec === undefined ? {} : { requestedSpec: providerRequestedSpec }),
  })
}

async function created(specification: Record<string, unknown>) {
  const provider = await hostedProvider({}, {})
  const context = operationContext()
  return provider.create(
    context as never,
    {
      adoption: {
        metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
        strategy: 'serialize_then_reconcile',
      },
      projectId: LOCAL_IDS.project,
      sessionId: LOCAL_IDS.session,
      specification: specification as never,
    } as never,
  )
}

describe('review scratch: hosted spec sources', () => {
  it('A1: session requestedSpec supplies image and region when effectiveSpec is empty', async () => {
    const provider = await hostedProvider({
      requestedSpec: { image: 'node-24', region: 'eu' },
      effectiveSpec: {},
    })
    const context = operationContext()
    const result = await provider.create(
      context as never,
      {
        adoption: {
          metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
          strategy: 'serialize_then_reconcile',
        },
        projectId: LOCAL_IDS.project,
        sessionId: LOCAL_IDS.session,
        specification: testSpec() as never,
      } as never,
    )
    const spec = result.sandbox.specification
    console.log('A1 requested', JSON.stringify(spec.requested.image), spec.requested.region)
    console.log('A1 effective', JSON.stringify(spec.effective?.image), spec.effective?.region)
    expect(spec.requested.image).toEqual({ kind: 'image', reference: 'node-24' })
    expect(spec.requested.region).toBe('eu')
    expect(spec.effective?.image).toEqual({ kind: 'image', reference: 'node-24' })
  })

  it('A2: effectiveSpec alone still wins and does not regress', async () => {
    const provider = await hostedProvider({
      requestedSpec: {},
      effectiveSpec: { image: 'node-24', region: 'eu' },
    })
    const context = operationContext()
    const result = await provider.create(
      context as never,
      {
        adoption: {
          metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
          strategy: 'serialize_then_reconcile',
        },
        projectId: LOCAL_IDS.project,
        sessionId: LOCAL_IDS.session,
        specification: testSpec() as never,
      } as never,
    )
    const spec = result.sandbox.specification
    console.log('A2 requested', JSON.stringify(spec.requested.image), spec.requested.region)
    console.log('A2 effective', JSON.stringify(spec.effective?.image), spec.effective?.region)
    expect(spec.requested.image).toEqual({ kind: 'image', reference: 'node-24' })
    expect(spec.effective?.region).toBe('eu')
  })

  it('A3: cpu from effectiveSpec and image from requestedSpec combine', async () => {
    const provider = await hostedProvider({
      requestedSpec: { image: 'node-24', region: 'eu' },
      effectiveSpec: { cpu: 2 },
    })
    const context = operationContext()
    const result = await provider.create(
      context as never,
      {
        adoption: {
          metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
          strategy: 'serialize_then_reconcile',
        },
        projectId: LOCAL_IDS.project,
        sessionId: LOCAL_IDS.session,
        specification: testSpec() as never,
      } as never,
    )
    const spec = result.sandbox.specification
    console.log('A3 effective', JSON.stringify(spec.effective))
    expect(spec.effective?.cpu).toEqual({ millicores: 2000 })
    expect(spec.effective?.image).toEqual({ kind: 'image', reference: 'node-24' })
  })

  it('A4: an unparsable server image is ignored, not fatal', async () => {
    const provider = await hostedProvider({
      requestedSpec: { image: 'not a valid image!', region: 'NOT A REGION' },
      effectiveSpec: {},
    })
    const context = operationContext()
    const result = await provider.create(
      context as never,
      {
        adoption: {
          metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
          strategy: 'serialize_then_reconcile',
        },
        projectId: LOCAL_IDS.project,
        sessionId: LOCAL_IDS.session,
        specification: testSpec() as never,
      } as never,
    )
    const spec = result.sandbox.specification
    console.log('A4 effective', JSON.stringify(spec.effective))
    console.log('A4 requested', JSON.stringify(spec.requested.image), spec.requested.region)
    expect(spec.effective).toBeNull()
  })

  it('A5: a server image of another kind is accepted', async () => {
    const provider = await hostedProvider({
      requestedSpec: { image: { kind: 'template', reference: 'node-24' } },
      effectiveSpec: {},
    })
    const context = operationContext()
    const result = await provider.create(
      context as never,
      {
        adoption: {
          metadata: { operationId: context.operationId, sessionId: LOCAL_IDS.session },
          strategy: 'serialize_then_reconcile',
        },
        projectId: LOCAL_IDS.project,
        sessionId: LOCAL_IDS.session,
        specification: testSpec() as never,
      } as never,
    )
    console.log('A5 requested', JSON.stringify(result.sandbox.specification.requested.image))
  })
})

describe('review scratch: codex writer guard', () => {
  async function tempPaths() {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-review-'))
    const host = process.platform === 'win32' ? 'win32' : 'linux'
    return resolveCodexPaths({
      platform: host,
      homeDirectory: root,
      environment: {},
      stateDirectory: join(root, 'state'),
    })
  }

  it('B1: a writer call with a null expected hash refuses an existing file', async () => {
    const paths = await tempPaths()
    await mkdir(paths.codexHome, { recursive: true })
    await writeFile(paths.userHooksPath, 'existing\n')
    await expect(
      nodeCodexFileSystem.writeFileAtomic(paths.userHooksPath, 'new\n', null),
    ).rejects.toMatchObject({ code: 'CODEX_APPLY_CONFLICT' })
    expect(await readFile(paths.userHooksPath, 'utf8')).toBe('existing\n')
  })

  it('B2: a writer call with a null expected hash writes a missing file', async () => {
    const paths = await tempPaths()
    await nodeCodexFileSystem.writeFileAtomic(paths.userHooksPath, 'new\n', null)
    expect(await readFile(paths.userHooksPath, 'utf8')).toBe('new\n')
  })

  it('B3: a conflict on the second file rolls back the first and keeps the user edit', async () => {
    const paths = await tempPaths()
    const original = 'model = "gpt-5.6-luna"\n'
    await mkdir(paths.codexHome, { recursive: true })
    await writeFile(paths.userConfigFile, original)
    const plan = planCodexSetup({
      versionText: 'codex-cli 0.153.4',
      layer: 'user',
      trustLevel: null,
      sessionId: 'sess-test-1',
      paths,
      baseTomlText: original,
      baseHooksText: null,
      timestamp: '2026-09-12T00:00:00.000Z',
    })
    if (!plan.ok) throw new Error('plan failed')
    const edited = 'model = "gpt-5.6-luna"\n# edited\n'
    await writeFile(paths.userHooksPath, edited)
    await expect(
      applyCodexChangePlan({ files: plan.changes }, nodeCodexFileSystem),
    ).rejects.toMatchObject({ code: 'CODEX_APPLY_CONFLICT' })
    console.log(
      'B3 config after rollback',
      JSON.stringify(await readFile(paths.userConfigFile, 'utf8')),
    )
    console.log(
      'B3 hooks after rollback',
      JSON.stringify(await readFile(paths.userHooksPath, 'utf8')),
    )
    expect(await readFile(paths.userConfigFile, 'utf8')).toBe(original)
    expect(await readFile(paths.userHooksPath, 'utf8')).toBe(edited)
  })

  it('B4: the writer guard leaves no temp file behind', async () => {
    const paths = await tempPaths()
    await mkdir(paths.codexHome, { recursive: true })
    await writeFile(paths.userHooksPath, 'existing\n')
    await expect(
      nodeCodexFileSystem.writeFileAtomic(paths.userHooksPath, 'new\n', sha256('other')),
    ).rejects.toMatchObject({ code: 'CODEX_APPLY_CONFLICT' })
    const { readdir } = await import('node:fs/promises')
    console.log('B4 dir', JSON.stringify(await readdir(paths.codexHome)))
  })
})
