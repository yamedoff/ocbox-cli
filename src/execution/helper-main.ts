#!/usr/bin/env node

import { once } from 'node:events'
import type { ExecEvent } from '../domain/execution.js'
import {
  decodeHelperRequest,
  encodeHelperEventFrame,
  type HelperEventFrame,
} from './helper-protocol.js'
import { runExecutionHelper, type HelperCancellationReason } from './helper-runtime.js'

async function writeFrame(event: ExecEvent): Promise<void> {
  const frame: HelperEventFrame =
    event.type === 'stdout' || event.type === 'stderr'
      ? { ...event, version: 1, data: Buffer.from(event.data).toString('base64') }
      : event.type === 'completed'
        ? {
            version: 1,
            type: 'completed',
            executionId: event.executionId,
            sequence: event.sequence,
            timestamp: event.timestamp,
            result: {
              exitCode: event.result.exitCode,
              timedOut: event.result.timedOut,
              cancelled: event.result.cancelled,
              signal: event.result.signal,
              startedAt: event.result.startedAt,
              completedAt: event.result.completedAt,
            },
          }
        : { ...event, version: 1 }
  if (!process.stdout.write(encodeHelperEventFrame(frame))) await once(process.stdout, 'drain')
}

const cancellation = new AbortController()
let cancellationReason: HelperCancellationReason = 'cancelled'
const requestCancellation = (): void => cancellation.abort()
if (process.argv.length === 3 && process.argv[2] === '--protocol-version') {
  process.stdout.write('1\n')
} else if (process.argv.length !== 2) {
  process.stderr.write('Usage: execution-helper [--protocol-version]\n')
  process.exitCode = 125
} else {
  process.once('SIGINT', requestCancellation)
  process.once('SIGTERM', requestCancellation)

  try {
    const request = await decodeHelperRequest(process.stdin)
    await runExecutionHelper(request, writeFrame, {
      supportsBash: process.platform !== 'win32',
      signal: cancellation.signal,
      cancellationReason: () => cancellationReason,
    })
  } catch {
    cancellationReason = 'cancelled'
    process.stderr.write('Execution helper failed before a terminal result\n')
    process.exitCode = 125
  } finally {
    process.removeListener('SIGINT', requestCancellation)
    process.removeListener('SIGTERM', requestCancellation)
  }
}
