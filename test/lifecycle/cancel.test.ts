import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '../../src/cli/runtime.js'
import { parseProjectConfig } from '../../src/config/index.js'
import { ProjectIdSchema } from '../../src/contracts.js'
import { LifecycleService, LifecycleStore } from '../../src/lifecycle/index.js'
import { FakeSandboxProvider } from '../../src/providers/fake/provider.js'
import { ProviderRegistry } from '../../src/providers/index.js'
import { LOCAL_IDS, operationContext } from '../providers/doubles.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ocbox-fake-cancel-'))
  directories.push(directory)
  const store = new LifecycleStore(directory, ProjectIdSchema.parse(LOCAL_IDS.project))
  const service = () =>
    new LifecycleService({
      config: parseProjectConfig(DEFAULT_PROJECT_CONFIG),
      projectId: ProjectIdSchema.parse(LOCAL_IDS.project),
      store,
      registry: new ProviderRegistry().register('fake', () => new FakeSandboxProvider(directory)),
    })
  await service().start()
  const target = await service().executionTarget()
  if (target.sandbox === null) throw new Error('Expected a Sandbox')
  const sandboxId = target.sandbox.id
  const execute = async (program: string) => {
    const handle = await target.provider.exec.execute(operationContext() as never, {
      sandboxId,
      command: { mode: 'argv', argv: [process.execPath, '-e', program] },
      environment: {},
      timeoutMilliseconds: null,
      workingDirectory: null,
    })
    const events = (async () => {
      for await (const _event of handle.events) {
        /* drain the harness */
      }
    })()
    return { handle, events }
  }
  return { service, store, sandboxId, execute }
}

describe('fake provider cancellation across service instances', () => {
  it('cancels a durable execution from a fresh service and clears it', async () => {
    const { service, store, sandboxId, execute } = await setup()
    const { handle, events } = await execute('setInterval(() => {}, 1000)')
    expect((await store.load()).lastFakeExecutions[sandboxId]).toBe(handle.execution.id)
    expect(await service().cancelExecution()).toMatchObject({
      state: 'cancelled',
      executionId: handle.execution.id,
    })
    expect(await handle.result).toMatchObject({ cancelled: true })
    await events
    expect((await store.load()).lastFakeExecutions[sandboxId]).toBeUndefined()
    expect(await service().cancelExecution(handle.execution.id)).toMatchObject({
      state: 'cancelled',
    })
    await expect(service().cancelExecution()).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(service().cancelExecution('unknown')).rejects.toMatchObject({
      code: 'SANDBOX_NOT_FOUND',
    })
  })
  it('clears completed executions and permits idempotent explicit cancellation', async () => {
    const { service, store, sandboxId, execute } = await setup()
    const { handle, events } = await execute('process.exit(7)')
    await events
    expect(await handle.result).toMatchObject({ exitCode: 7 })
    expect((await store.load()).lastFakeExecutions[sandboxId]).toBeUndefined()
    expect(await service().cancelExecution(handle.execution.id)).toMatchObject({
      state: 'completed',
    })
  })
  it('rejects another Sandbox execution and permits an explicit local Sandbox selection', async () => {
    const { service, sandboxId, execute } = await setup()
    const { handle, events } = await execute('setInterval(() => {}, 1000)')
    try {
      await service().start(true)
      await expect(service().cancelExecution(handle.execution.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
      })
    } finally {
      expect(await service().cancelExecution(handle.execution.id, sandboxId)).toMatchObject({
        state: 'cancelled',
      })
      await handle.result
      await events
    }
  })
})
