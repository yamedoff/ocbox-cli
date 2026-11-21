import type { z } from 'zod'
import type { ApiCallMetadata, OcboxApiClient } from '../api/client/index.js'
import type { ApiResult } from '../api/generated/client.js'
import { newRequestId } from '../auth/errors.js'
import { RequestIdSchema } from '../domain/ids.js'
import { OcboxError } from '../errors/index.js'

/**
 * One authenticated hosted read or action, parsed against the pinned public
 * contract. Unknown or private fields fail closed before they can enter CLI
 * output, exactly like the metadata and sizes commands.
 */
export function parseHostedResponse<ResponseType>(
  api: OcboxApiClient,
  operation: string,
  response: ApiResult<unknown>,
  expected: readonly number[],
  schema: z.ZodType<ResponseType>,
  contract: string,
): { resource: ResponseType; meta: ApiCallMetadata } {
  const { body, meta } = api.assertSuccess(operation, response, expected)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new OcboxError({
      code: 'INTERNAL',
      message: `Hosted ${contract} response does not match the public contract`,
      requestId: RequestIdSchema.safeParse(meta.requestId).data ?? newRequestId(),
    })
  }
  return { resource: parsed.data, meta }
}
