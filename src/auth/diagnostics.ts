import { join } from 'node:path'
import { z } from 'zod'
import { OcboxError } from '../errors/index.js'
import { AtomicJsonStore } from '../lifecycle/atomic-json-store.js'

const Entry = z.strictObject({
  requestId: z.string().max(64),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  at: z.string().datetime(),
  serverReference: z
    .string()
    .regex(/^req_[a-f0-9]{12}$/)
    .nullable(),
})
const Journal = z.strictObject({ entries: z.array(Entry).max(100) })

/** Last 100 auth failures, at most seven days. No exception text, account data or request material. */
export async function recordLocalAuthFailure(
  directory: string,
  error: unknown,
  now = Date.now(),
): Promise<boolean> {
  if (!(error instanceof OcboxError)) return false
  const reason = error.details?.['reasonCode']
  const reasonCode =
    typeof reason === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(reason)
      ? reason
      : 'cli_auth_unclassified'
  const ref = error.details?.['providerRequestId']
  const serverReference = typeof ref === 'string' && /^req_[a-f0-9]{12}$/.test(ref) ? ref : null
  const entry = {
    requestId: error.requestId,
    reasonCode,
    at: new Date(now).toISOString(),
    serverReference,
  }
  const store = new AtomicJsonStore(join(directory, 'auth-failures.json'), Journal)
  try {
    await store.update(
      () => ({ entries: [] }),
      (prior) => ({
        entries: [
          ...prior.entries.filter(
            (row) => Date.parse(row.at) > now - 7 * 86400000 && row.requestId !== entry.requestId,
          ),
          entry,
        ].slice(-100),
      }),
    )
    return true
  } catch {
    return false
  }
}
