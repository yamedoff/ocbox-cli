import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileOperationCheckpointStore } from '../../src/providers/ocbox/checkpoints.js'
import { hostedOperationFixture } from './doubles.js'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'

describe('durable operation checkpoint store', () => {
  it('reloads a saved checkpoint from a fresh store instance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ocbox-checkpoints-'))
    try {
      const first = new FileOperationCheckpointStore(directory)
      await first.save({
        attempt: 2,
        operation: hostedOperationFixture({ progress: 10, state: 'running' }) as never,
        operationId: 'op_hosted_1',
        progress: 10,
        requestId: REQUEST_ID,
        state: 'running',
      })

      const restarted = new FileOperationCheckpointStore(directory)
      const loaded = await restarted.load('op_hosted_1')
      expect(loaded?.state).toBe('running')
      expect(loaded?.progress).toBe(10)
      expect(loaded?.operation?.state).toBe('running')
      expect(await restarted.load('op_missing')).toBeNull()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
