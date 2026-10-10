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

/** Common cancellation, authenticated transport, and output boundary for CRUD. */
export abstract class MetadataCommand extends OcboxCommand {
  protected async executeMetadata(
    action: MetadataAction,
    flags: AuthCommandFlags,
    input: MetadataInput,
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
          const lines =
            resource.data === undefined
              ? [`${resource.id} ${resource.name}`]
              : resource.data.map((item) => `${item.id} ${item.name}`)
          if (resource.nextCursor) lines.push(`nextCursor=${resource.nextCursor}`)
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
