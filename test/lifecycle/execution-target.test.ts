import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import { parseProjectConfig } from '../../src/config/index.js'
import { ProjectIdSchema, type ProviderCapabilities } from '../../src/contracts.js'
import { parseExecArguments } from '../../src/execution/cli-arguments.js'
import { ExecutionService } from '../../src/execution/service.js'
import { LifecycleService, LifecycleStore } from '../../src/lifecycle/index.js'
import { FAKE_CAPABILITIES, FakeSandboxProvider } from '../../src/providers/fake/index.js'
import { ProviderRegistry } from '../../src/providers/index.js'

const PROJECT_ID = ProjectIdSchema.parse('11111111-1111-4111-8111-111111111111')
const CONFIG = parseProjectConfig(DEFAULT_PROJECT_CONFIG)
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-execution-target-'))
  temporaryDirectories.push(directory)
  return directory
}

function createService(
  stateDirectory: string,
  capabilities?: ProviderCapabilities,
): LifecycleService {
  const registry = new ProviderRegistry().register(
    'fake',
    () =>
      new FakeSandboxProvider(stateDirectory, {
        ...(capabilities === undefined ? {} : { capabilities }),
      }),
  )
  return new LifecycleService({
    config: CONFIG,
    projectId: PROJECT_ID,
    store: new LifecycleStore(stateDirectory, PROJECT_ID),
    registry,
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('LifecycleService execution target', () => {
  it('resolves the active Session, primary running Sandbox, and provider port', async () => {
    const directory = await temporaryDirectory()
    const created = await createService(directory).start()
    const target = await createService(directory).executionTarget()

    expect(target.session.id).toBe(created.session.id)
    expect(target.sandbox?.id).toBe(created.sandbox?.id)
    expect(target.sandbox?.lifecycle.normalizedState).toBe('running')
    expect(target.capabilities.execution).toEqual({ streaming: true, cancellation: true })
    expect(target.provider.name).toBe('fake')

    const events: string[] = []
    const run = await new ExecutionService().start(
      target,
      parseExecArguments([
        '--',
        process.execPath,
        '-e',
        "process.stdout.write('@target@'); process.stderr.write('@err@'); process.exit(9)",
      ]),
      async (event) => {
        events.push(event.type)
      },
    )
    const completion = await run.completion
    expect(completion.outcome).toMatchObject({ kind: 'remote_result', result: { exitCode: 9 } })
    expect(events[0]).toBe('started')
    expect(events.at(-1)).toBe('completed')
  })

  it('selects an explicit Session by ID', async () => {
    const directory = await temporaryDirectory()
    const first = await createService(directory).start()
    await createService(directory).start(true)

    const target = await createService(directory).executionTarget(first.session.id)
    expect(target.session.id).toBe(first.session.id)
    expect(target.sandbox?.id).toBe(first.sandbox?.id)
  })

  it('rejects a missing selection without creating anything', async () => {
    const directory = await temporaryDirectory()
    await expect(createService(directory).executionTarget()).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND',
    })
    const state = await new LifecycleStore(directory, PROJECT_ID).load()
    expect(Object.keys(state.sessions)).toHaveLength(0)
  })

  it('rejects an unknown explicit Session', async () => {
    const directory = await temporaryDirectory()
    await createService(directory).start()
    await expect(
      createService(directory).executionTarget('99999999-9999-4999-8999-999999999999'),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' })
  })

  it('rejects a non-active Session and preserves its state', async () => {
    const directory = await temporaryDirectory()
    const created = await createService(directory).start()
    await createService(directory).pause()

    await expect(createService(directory).executionTarget()).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    const state = await new LifecycleStore(directory, PROJECT_ID).load()
    expect(state.sessions[created.session.id]?.state).toBe('paused')
    expect(state.activeSessionId).toBe(created.session.id)
  })

  it('rejects a destroyed Session without selecting a replacement', async () => {
    const directory = await temporaryDirectory()
    const created = await createService(directory).start()
    await createService(directory).destroy()

    await expect(createService(directory).executionTarget()).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    const state = await new LifecycleStore(directory, PROJECT_ID).load()
    expect(state.sessions[created.session.id]?.state).toBe('destroyed')
    expect(state.activeSessionId).toBe(created.session.id)
  })

  it('rejects providers that cannot stream cancellable execution', async () => {
    const directory = await temporaryDirectory()
    await createService(directory).start()
    const capabilities: ProviderCapabilities = {
      ...FAKE_CAPABILITIES,
      execution: { streaming: false, cancellation: false },
    }
    await expect(createService(directory, capabilities).executionTarget()).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    })
  })
})
