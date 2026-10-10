import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { Flags, ux } from '@oclif/core'
import { RequestIdSchema } from '../contracts.js'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import { createLifecycleService, loadProjectConfig } from '../cli/runtime.js'
import { sessionViewLine } from '../cli/views.js'
import { OcboxError } from '../errors/index.js'

async function confirmDestroy(): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (
      (await prompt.question('Destroy the selected Session and discard its filesystem? [y/N] '))
        .trim()
        .toLowerCase() === 'y'
    )
  } finally {
    prompt.close()
  }
}

export default class Destroy extends OcboxCommand {
  static override description = 'Destroy a Session after explicit confirmation'
  static override flags = {
    ...runtimeFlags,
    session: Flags.string({ description: 'Session ID; defaults to the selected Session' }),
    yes: Flags.boolean({ char: 'y', description: 'Confirm destructive deletion' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Destroy)
    const interrupt = this.abortOnInterrupt()
    let spinning = false
    try {
      await this.emitResult(flags, 'session.destroyed', sessionViewLine, async () => {
        if (flags.yes !== true && !(await confirmDestroy())) {
          throw new OcboxError({
            code: 'INVALID_STATE',
            message: 'Destroy requires confirmation; rerun with --yes',
            requestId: RequestIdSchema.parse(randomUUID()),
          })
        }
        if (
          !flags.json &&
          !flags.jsonl &&
          (await loadProjectConfig(flags)).provider.name === 'ocbox'
        ) {
          if (process.stderr.isTTY) {
            ux.action.start('Waiting for hosted sandbox deletion')
            spinning = true
          } else {
            process.stderr.write('Waiting for hosted sandbox deletion...\n')
          }
        }
        return (await createLifecycleService(flags, interrupt.signal)).destroy(flags.session)
      })
    } finally {
      if (spinning) ux.action.stop()
      interrupt.dispose()
    }
  }
}
