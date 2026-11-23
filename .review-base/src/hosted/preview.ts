import { z } from 'zod'
import type { OcboxApiClient } from '../api/client/index.js'
import { parseHostedResponse } from './response.js'

export const HostedPreviewSchema = z.strictObject({
  id: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  sessionId: z.string().min(1),
  state: z.enum(['active', 'deleted']),
  url: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  expiresAt: z.iso.datetime({ offset: true }),
})
export type HostedPreview = z.infer<typeof HostedPreviewSchema>

export interface CreatePreviewInput {
  readonly sessionId: string
  readonly port: number
  readonly ttlSeconds?: number | undefined
}

/** Create one preview URL for a session port; the server keeps its identity. */
export async function createPreview(
  api: OcboxApiClient,
  input: CreatePreviewInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<{ readonly preview: HostedPreview }> {
  const response = await api.generated.createPreview({
    path: { sessionId: input.sessionId },
    body: {
      port: input.port,
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    },
    idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
  })
  const { resource } = parseHostedResponse(
    api,
    'preview.create',
    response,
    [202],
    HostedPreviewSchema,
    'preview',
  )
  return { preview: resource }
}

/** Human line: the URL, its port and when it expires. */
export function previewLine(preview: HostedPreview): string {
  return `Preview ${preview.id}: ${preview.url} (port ${preview.port}, expires ${preview.expiresAt})`
}
