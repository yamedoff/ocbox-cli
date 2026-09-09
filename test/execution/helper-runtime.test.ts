import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecEvent } from '../../src/contracts.js'
import { HelperRequestSchema } from '../../src/execution/helper-protocol.js'
import { runExecutionHelper } from '../../src/execution/helper-runtime.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function request(argv: readonly string[], timeoutMilliseconds: number | null = null) {
  return HelperRequestSchema.parse({
    version: 1,
    executionId: crypto.randomUUID(),
    command: { mode: 'argv', argv },
    workingDirectory: null,
    environment: {},
    timeoutMilliseconds,
  })
}

async function execute(
  argv: readonly string[],
  options: { readonly timeoutMilliseconds?: number; readonly signal?: AbortSignal } = {},
) {
  const events: ExecEvent[] = []
  const result = await runExecutionHelper(
    request(argv, options.timeoutMilliseconds ?? null),
    async (event) => {
      events.push(event)
    },
    {
      supportsBash: process.platform !== 'win32',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
  return { events, result }
}

function output(events: readonly ExecEvent[], stream: 'stdout' | 'stderr'): Buffer {
  return Buffer.concat(
    events
      .filter((event) => event.type === stream)
      .map((event) => Buffer.from(event.type === stream ? event.data : new Uint8Array())),
  )
}

describe('execution helper runtime', () => {
  it('passes spaces, Unicode and shell metacharacters as literal argv with shell disabled', async () => {
    const values = ['', 'two words', '日本語🙂', '$(echo unsafe)', '&|;<>()', '"quoted"']
    const { events, result } = await execute([
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      ...values,
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(output(events, 'stdout').toString('utf8'))).toEqual(values)
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index))
  })

  it('returns a normal remote result for a nonzero exit', async () => {
    const nonzero = await execute([process.execPath, '-e', 'process.exit(17)'])
    expect(nonzero.result).toMatchObject({ exitCode: 17, timedOut: false, cancelled: false })
  })

  it('rejects a missing executable as a typed before-start failure', async () => {
    const events: ExecEvent[] = []
    await expect(
      runExecutionHelper(
        request(['opencloudbox-definitely-missing-executable']),
        async (event) => {
          events.push(event)
        },
        { supportsBash: process.platform !== 'win32' },
      ),
    ).rejects.toMatchObject({
      code: 'EXECUTION_START_FAILED',
      failure: 'not_found',
    })
    expect(events).toEqual([])
  })

  it('cancels an active process and emits a typed terminal result', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 40).unref()
    const { result } = await execute([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
    })
    expect(result).toMatchObject({ exitCode: 130, cancelled: true, timedOut: false })
  })

  it('keeps an earlier user cancellation authoritative over a later timeout', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20).unref()
    const { result } = await execute([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
      timeoutMilliseconds: 200,
    })
    expect(result).toMatchObject({ exitCode: 130, cancelled: true, timedOut: false })
  })

  it('cancellation terminates descendant processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ocbox-exec-cancel-tree-'))
    temporaryDirectories.push(directory)
    const marker = join(directory, 'orphan-marker')
    const childScript =
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), 500)"
    const parentScript =
      "require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], {stdio:'ignore'}); setInterval(() => {}, 1000)"
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50).unref()
    const { result } = await execute([process.execPath, '-e', parentScript, childScript, marker], {
      signal: controller.signal,
    })
    expect(result).toMatchObject({ exitCode: 130, timedOut: false, cancelled: true })
    await delay(650)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('times out and terminates the descendant process tree without destroying session state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ocbox-exec-tree-'))
    temporaryDirectories.push(directory)
    const marker = join(directory, 'orphan-marker')
    const childScript =
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), 500)"
    const parentScript =
      "require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], {stdio:'ignore'}); setInterval(() => {}, 1000)"
    const { result } = await execute([process.execPath, '-e', parentScript, childScript, marker], {
      timeoutMilliseconds: 50,
    })
    expect(result).toMatchObject({ exitCode: 124, timedOut: true, cancelled: false })
    await delay(650)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform !== 'win32')('maps a remote signal to a terminal result', async () => {
    const { result } = await execute([
      process.execPath,
      '-e',
      "process.kill(process.pid, 'SIGTERM')",
    ])
    expect(result.signal).toBe('SIGTERM')
    expect(result.exitCode).toBe(143)
  })
})
