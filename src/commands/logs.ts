import { Args } from '@oclif/core'
import { OcboxCommand } from '../cli/base-command.js'
import type { CapturedStream } from '../execution/stream-output.js'
import { getExecutionLogs, type ExecutionLogs } from '../hosted/execution.js'
import { createMetadataClient } from '../metadata/client.js'
import { hostedFlags } from '../metadata/command.js'

/** Same base64 stream shape `ocbox exec --json` emits for bounded output. */
function capturedStream(text: string, truncated: boolean, totalBytes: number): CapturedStream {
  const retainedBytes = Buffer.byteLength(text, 'utf8')
  return {
    encoding: 'base64',
    data: Buffer.from(text, 'utf8').toString('base64'),
    retainedBytes,
    // The stored result reports one combined total; keep it at least the
    // retained bytes so `truncated` never contradicts the stream counters.
    totalBytes: truncated ? Math.max(totalBytes, retainedBytes) : retainedBytes,
    truncated,
  }
}

/** Structured output carries command bytes as streams; other results pass through. */
function structuredLogs(view: ExecutionLogs): unknown {
  if (view.result.kind !== 'command') return view
  const { stdout, stderr, truncated, outputBytes } = view.result
  return {
    execution: view.execution,
    result: {
      ...view.result,
      stdout: capturedStream(stdout, truncated, outputBytes),
      stderr: capturedStream(stderr, truncated, outputBytes),
    },
  }
}

/**
 * Prints the stored stdout and stderr of a finished execution, so an agent that
 * lost the live stream still sees the run's output.
 */
export default class Logs extends OcboxCommand {
  static override description =
    "Print the stored stdout and stderr of a finished execution, so an agent that lost the live stream still sees the run's output"
  static override args = {
    'execution-id': Args.string({
      required: true,
      description: 'Hosted execution ID returned by `ocbox exec`',
    }),
  }
  static override flags = hostedFlags

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Logs)
    const interrupt = this.abortOnInterrupt()
    const writer = this.writerFor(flags)
    try {
      const view = await getExecutionLogs(
        createMetadataClient(flags),
        args['execution-id'],
        interrupt.signal,
      )
      if (flags.json === true || flags.jsonl === true) {
        writer.result('execution.logs', structuredLogs(view))
      } else if (view.result.kind === 'command') {
        // Raw bytes, like `ocbox exec` streams; the human path skips redaction.
        if (view.result.stdout !== '') process.stdout.write(view.result.stdout)
        if (view.result.stderr !== '') process.stderr.write(view.result.stderr)
      }
    } catch (error) {
      writer.error(error)
      process.exitCode = 1
    } finally {
      interrupt.dispose()
    }
  }
}
