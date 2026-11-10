import { z } from 'zod'
import type { OcboxApiClient } from '../api/client/client.js'
import { OcboxError } from '../errors/index.js'
import { createMetadataClient } from '../metadata/client.js'
import { newRequestId } from './errors.js'
import type { AuthCommandFlags } from './runtime.js'

/** The public `GET /v1/auth/me` shape; it carries no token or secret. */
export const AuthIdentitySchema = z.strictObject({
  subject: z.string().min(1).max(128),
  audience: z.enum(['cli', 'mcp']),
  scopes: z.array(z.string().min(1).max(128)).max(256),
  expiresAt: z.iso.datetime({ offset: true }),
})
export type AuthIdentity = z.infer<typeof AuthIdentitySchema>

/** Reads the identity of the presented bearer token through the bound client. */
export async function readAuthIdentity(
  api: OcboxApiClient,
  signal?: AbortSignal,
): Promise<AuthIdentity> {
  const result = await api.generated.getAuthMe(signal === undefined ? {} : { signal })
  const body = api.assertSuccess('getAuthMe', result, [200]).body
  const parsed = AuthIdentitySchema.safeParse(body)
  if (!parsed.success)
    throw new OcboxError({
      code: 'PROVIDER_AUTH',
      message: 'The hosted service returned an invalid identity response',
      requestId: newRequestId(),
    })
  return parsed.data
}

/** Builds the bound client for the configured hosted API and reads `/auth/me`. */
export function readHostedIdentity(
  flags: AuthCommandFlags,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<AuthIdentity> {
  return readAuthIdentity(createMetadataClient(flags, environment), signal)
}
