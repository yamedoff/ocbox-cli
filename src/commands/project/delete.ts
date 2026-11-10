import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../../cli/base-command.js'
import { loadProjectIdIfPresent } from '../../cli/runtime.js'
import { RequestIdSchema } from '../../contracts.js'
import { OcboxError } from '../../errors/index.js'
import { createMetadataClient, runMetadataAction } from '../../metadata/client.js'
import { mutationFlags } from '../../metadata/command.js'

async function confirmProjectDelete(projectId: string): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (
      (await prompt.question(`Delete hosted project ${projectId} and its resources? [y/N] `))
        .trim()
        .toLowerCase() === 'y'
    )
  } finally {
    prompt.close()
  }
}

export default class ProjectDelete extends OcboxCommand {
  static override description = 'Delete a hosted project after explicit confirmation'
  static override flags = {
    ...runtimeFlags,
    ...mutationFlags,
    'project-id': Flags.string({
      description: 'Hosted project ID; defaults to opencloudbox.toml',
    }),
    yes: Flags.boolean({ char: 'y', description: 'Confirm destructive deletion' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ProjectDelete)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        'project.deleted',
        (result) => {
          const operation = result.resource as { id?: string }
          return operation.id === undefined
            ? 'Project deletion accepted'
            : `Project deletion accepted (operation ${operation.id})`
        },
        async () => {
          const projectId = flags['project-id'] ?? (await loadProjectIdIfPresent(flags))
          if (projectId === undefined) {
            throw new OcboxError({
              code: 'CONFIG_INVALID',
              message: 'No project selected; pass --project-id or run ocbox init',
              requestId: RequestIdSchema.parse(randomUUID()),
            })
          }
          if (flags.yes !== true && !(await confirmProjectDelete(projectId))) {
            throw new OcboxError({
              code: 'INVALID_STATE',
              message: 'Project deletion requires confirmation; rerun with --yes',
              requestId: RequestIdSchema.parse(randomUUID()),
            })
          }
          return runMetadataAction(
            createMetadataClient(flags),
            'project.delete',
            {
              projectId,
              idempotencyKey: flags['idempotency-key'],
            },
            interrupt.signal,
          )
        },
      )
    } finally {
      interrupt.dispose()
    }
  }
}
