import { Flags } from '@oclif/core'
import { OcboxCommand, runtimeFlags } from '../cli/base-command.js'
import type { AuthCommandFlags } from '../auth/runtime.js'
import {
  createMetadataClient,
  runMetadataAction,
  type MetadataAction,
  type MetadataInput,
} from './client.js'

export const metadataFlags = {
  ...runtimeFlags,
  'api-url': Flags.string({ description: 'Hosted API base URL; defaults to OCBOX_API_URL' }),
}
export const projectFlag = {
  'project-id': Flags.string({
    required: true,
    description: 'Hosted project ID returned by project create/list',
  }),
}
export const environmentFlag = {
  'environment-id': Flags.string({
    required: true,
    description: 'Hosted environment ID returned by environment create/list',
  }),
}
export const paginationFlags = {
  cursor: Flags.string({ description: 'Opaque nextCursor returned by the previous page' }),
  limit: Flags.integer({ min: 1, max: 100, description: 'Maximum resources in this page (1–100)' }),
}
export const mutationFlags = {
  'idempotency-key': Flags.string({
    description: 'Stable retry key (16–200 transport-safe characters); defaults to a UUID',
  }),
}
export const nameFlag = {
  name: Flags.string({ required: true, description: 'Resource name (1–200 characters)' }),
}

export interface MetadataRenderOptions {
  /** Marks the matching list row with `*` so the current workspace is obvious. */
  readonly currentProjectId?: string | undefined
  /** Replaces the raw cursor line with a copy-pasteable follow-up command. */
  readonly cursorCommand?: string | undefined
  /** Overrides the default resource rendering for one command. */
  readonly render?: ((resource: unknown) => string) | undefined
}

/** Common cancellation, authenticated transport, and output boundary for CRUD. */
export abstract class MetadataCommand extends OcboxCommand {
  protected async executeMetadata(
    action: MetadataAction,
    flags: AuthCommandFlags,
    input: MetadataInput,
    options: MetadataRenderOptions = {},
  ): Promise<void> {
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(
        flags,
        action,
        (result) => {
          const resource = result.resource as {
            id?: string
            name?: string
            data?: { id: string; name: string }[]
            nextCursor?: string | null
          }
          if (options.render !== undefined) return options.render(resource)
          const lines =
            resource.data === undefined
              ? [`${resource.id} ${resource.name}`]
              : resource.data.map((item) =>
                  options.currentProjectId === undefined
                    ? `${item.id} ${item.name}`
                    : `${options.currentProjectId === item.id ? '* ' : '  '}${item.id} ${item.name}`,
                )
          if (resource.nextCursor) {
            lines.push(
              options.cursorCommand === undefined
                ? `nextCursor=${resource.nextCursor}`
                : `More: ${options.cursorCommand} --cursor ${resource.nextCursor}`,
            )
          }
          if (lines.length === 0) lines.push('No resources found')
          return lines.join('\n')
        },
        () => runMetadataAction(createMetadataClient(flags), action, input, interrupt.signal),
      )
    } finally {
      interrupt.dispose()
    }
  }
}
