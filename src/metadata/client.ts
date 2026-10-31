import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createOcboxApiClient, type OcboxApiClient } from '../api/client/index.js'
import type { ApiResult } from '../api/generated/client.js'
import { newRequestId } from '../auth/errors.js'
import {
  createCredentialStore,
  createHostedTokenManager,
  resolveAuthEndpoints,
  resolveAuthStateDirectory,
  type AuthCommandFlags,
} from '../auth/runtime.js'
import { IdempotencyKeySchema, RequestIdSchema } from '../domain/ids.js'
import { OcboxError } from '../errors/index.js'

// These schemas mirror the pinned public OpenAPI DTOs. Unknown/private fields
// fail closed before they can enter CLI JSON or human output.
const id = z.string().min(1)
const name = z.string().min(1).max(200)
const timestamp = z.iso.datetime({ offset: true })
export const ProjectSchema = z.strictObject({
  id,
  name,
  createdAt: timestamp,
  updatedAt: timestamp,
})
export const EnvironmentSchema = z.strictObject({
  id,
  name,
  createdAt: timestamp,
  updatedAt: timestamp,
  projectId: id,
  selected: z.boolean(),
})
export const ProjectPageSchema = z.strictObject({
  data: z.array(ProjectSchema),
  nextCursor: z.string().nullable(),
})
export const EnvironmentPageSchema = z.strictObject({
  data: z.array(EnvironmentSchema),
  nextCursor: z.string().nullable(),
})
const querySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})
const namedSchema = z.strictObject({ name })
const updateEnvironmentSchema = z
  .strictObject({ name: name.optional(), selected: z.boolean().optional() })
  .refine((body) => body.name !== undefined || body.selected !== undefined)

export type MetadataAction =
  | 'project.list'
  | 'project.create'
  | 'project.get'
  | 'project.update'
  | 'environment.list'
  | 'environment.create'
  | 'environment.get'
  | 'environment.update'
export interface MetadataInput {
  readonly projectId?: string | undefined
  readonly environmentId?: string | undefined
  readonly name?: string | undefined
  readonly selected?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
  readonly idempotencyKey?: string | undefined
}

function invalid(message: string): OcboxError {
  return new OcboxError({ code: 'CONFIG_INVALID', message, requestId: newRequestId() })
}

/** Validate without including rejected values or response bodies in diagnostics. */
function inputOf<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw invalid(`Invalid ${label}; consult command help for accepted values`)
  return parsed.data
}

/** Issuer-bound metadata access does not depend on a selected hosted project. */
export function createMetadataClient(
  flags: AuthCommandFlags,
  environment: NodeJS.ProcessEnv = process.env,
): OcboxApiClient {
  const protocol = resolveAuthEndpoints(flags, environment)
  const tokens = createHostedTokenManager({
    credentialStore: createCredentialStore(environment),
    endpoints: protocol,
    stateDirectory: resolveAuthStateDirectory({ flags, environment }),
  })
  return createOcboxApiClient({ protocol, tokens })
}

/**
 * Run one bounded metadata request. Pagination is deliberately caller-driven;
 * a supplied mutation key makes retry/replay safe across CLI invocations.
 */
export async function runMetadataAction(
  api: OcboxApiClient,
  action: MetadataAction,
  input: MetadataInput,
  signal?: AbortSignal,
) {
  try {
    return await dispatchMetadataAction(api, action, input, signal)
  } catch (error) {
    if (error instanceof OcboxError) throw error
    // JSON.parse errors can embed raw response bytes. Unexpected transport or
    // parsing errors must never carry their message/cause across the boundary.
    throw new OcboxError({
      code: signal?.aborted === true ? 'OPERATION_CANCELLED' : 'INTERNAL',
      message:
        signal?.aborted === true
          ? 'Hosted metadata request cancelled'
          : 'Hosted metadata request failed',
      requestId: newRequestId(),
    })
  }
}

async function dispatchMetadataAction(
  api: OcboxApiClient,
  action: MetadataAction,
  input: MetadataInput,
  signal?: AbortSignal,
) {
  const key = () =>
    inputOf(IdempotencyKeySchema, input.idempotencyKey ?? randomUUID(), 'idempotency key')
  const projectId = () => inputOf(id, input.projectId, 'project ID')
  const environmentId = () => inputOf(id, input.environmentId, 'environment ID')
  const named = () => inputOf(namedSchema, { name: input.name }, 'name (1–200 characters)')
  const query = () => {
    const parsed = inputOf(
      querySchema,
      {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      'pagination (limit 1–100)',
    )
    return {
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    }
  }
  const options = signal === undefined ? {} : { signal }
  let response: ApiResult<unknown>
  let schema: z.ZodType = action.startsWith('project.') ? ProjectSchema : EnvironmentSchema
  switch (action) {
    case 'project.list':
      schema = ProjectPageSchema
      response = await api.generated.listProjects({ query: query(), ...options })
      break
    case 'project.create':
      response = await api.generated.createProject({
        body: named(),
        idempotencyKey: key(),
        ...options,
      })
      break
    case 'project.get':
      response = await api.generated.getProject({ path: { projectId: projectId() }, ...options })
      break
    case 'project.update':
      response = await api.generated.updateProject({
        path: { projectId: projectId() },
        body: named(),
        idempotencyKey: key(),
        ...options,
      })
      break
    case 'environment.list':
      schema = EnvironmentPageSchema
      response = await api.generated.listEnvironments({
        path: { projectId: projectId() },
        query: query(),
        ...options,
      })
      break
    case 'environment.create':
      response = await api.generated.createEnvironment({
        path: { projectId: projectId() },
        body: named(),
        idempotencyKey: key(),
        ...options,
      })
      break
    case 'environment.get':
      response = await api.generated.getEnvironment({
        path: { environmentId: environmentId() },
        ...options,
      })
      break
    case 'environment.update': {
      const body = inputOf(
        updateEnvironmentSchema,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.selected === undefined ? {} : { selected: input.selected }),
        },
        'environment update (provide --name or --selected)',
      )
      response = await api.generated.updateEnvironment({
        path: { environmentId: environmentId() },
        body: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.selected === undefined ? {} : { selected: body.selected }),
        },
        idempotencyKey: key(),
        ...options,
      })
      break
    }
  }
  const { body, meta } = api.assertSuccess(
    action,
    response,
    action.endsWith('.create') ? [201] : [200],
  )
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new OcboxError({
      code: 'INTERNAL',
      message: 'Hosted metadata response does not match the public contract',
      requestId: RequestIdSchema.safeParse(meta.requestId).data ?? newRequestId(),
    })
  }
  return { resource: parsed.data, meta }
}
