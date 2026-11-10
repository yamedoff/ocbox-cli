import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * True when a completed sync left durable evidence for this Session: the fake
 * provider's verified baseline or a hosted CAS state snapshot. Pending files do
 * not count because no source reached the box yet.
 */
export async function hasSyncedSource(
  stateDirectory: string,
  projectId: string,
  sessionId: string,
): Promise<boolean> {
  const root = join(stateDirectory, 'sync', projectId, sessionId)
  try {
    const entries = await readdir(root, { recursive: true })
    return entries.some((entry) => {
      const name = entry.split(/[\\/]/).at(-1)
      return name === 'baseline.json' || name === 'state.json'
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
