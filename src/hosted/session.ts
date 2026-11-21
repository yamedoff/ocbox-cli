import { z } from 'zod'
import type { OcboxApiClient } from '../api/client/index.js'
import { parseHostedResponse } from './response.js'

const sandboxBinding = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  role: z.literal('primary'),
  active: z.boolean(),
  // A newer server may publish a state this pin does not know; show it as-is instead of failing.
  state: z.string().min(1),
  sandboxId: z.string().min(1),
  boundAt: z.iso.datetime({ offset: true }),
  releasedAt: z.iso.datetime({ offset: true }).nullable(),
})
const sessionFailure = z.strictObject({
  reasonCode: z.string().min(1),
  nextStep: z.string().min(1),
})
export const HostedSessionSchema = z.strictObject({
  id: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  projectId: z.string().min(1),
  requestedSpec: z.record(z.string(), z.unknown()),
  effectiveSpec: z.record(z.string(), z.unknown()),
  // The server's normalized states grow (`failed` postdates the pin); keep every published and
  // future value as a string so a newer server never breaks `session list`/`session get`.
  normalizedState: z.string().min(1),
  rawState: z.string().min(1),
  sandboxes: z.array(sandboxBinding),
  primarySandboxId: z.string().min(1).nullable(),
  failure: sessionFailure.optional(),
})
export const HostedSessionPageSchema = z.strictObject({
  data: z.array(HostedSessionSchema),
  nextCursor: z.string().nullable(),
})
export type HostedSession = z.infer<typeof HostedSessionSchema>

export interface ListSessionsInput {
  readonly projectId: string
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
  readonly includeDestroyed?: boolean | undefined
}

/** One project page of hosted Sessions; destroyed rows are opt-in. */
export async function listSessions(
  api: OcboxApiClient,
  input: ListSessionsInput,
  signal?: AbortSignal,
): Promise<{ readonly sessions: readonly HostedSession[]; readonly nextCursor: string | null }> {
  const response = await api.listProjectSessions(
    {
      projectId: input.projectId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.includeDestroyed === undefined ? {} : { includeDestroyed: input.includeDestroyed }),
    },
    signal,
  )
  const { resource } = parseHostedResponse(
    api,
    'session.list',
    response,
    [200],
    HostedSessionPageSchema,
    'session list',
  )
  return { sessions: resource.data, nextCursor: resource.nextCursor }
}

/** One hosted Session, including a Session that was created over MCP. */
export async function getSession(
  api: OcboxApiClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ readonly session: HostedSession }> {
  const response = await api.generated.getSession({
    path: { sessionId },
    ...(signal === undefined ? {} : { signal }),
  })
  const { resource } = parseHostedResponse(
    api,
    'session.get',
    response,
    [200],
    HostedSessionSchema,
    'session',
  )
  return { session: resource }
}

/** Human line: identity, state, project and the stored failure reason. */
export function sessionLine(session: HostedSession): string {
  const primary = session.primarySandboxId === null ? '' : ` sandbox=${session.primarySandboxId}`
  const line = `${session.id}  ${session.normalizedState}  project=${session.projectId}${primary}`
  return session.failure === undefined ? line : `${line}\nReason ${session.failure.reasonCode}.`
}
