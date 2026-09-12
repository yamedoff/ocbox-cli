import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ClaudeSettingsDocument } from './settings-model.js'
import type { PINNED_CLAUDE_CODE_VERSION } from './version.js'

export const MANIFEST_FILENAME = 'ocbox-claude-code-manifest.json' as const

export interface OwnedManifest {
  readonly adapter: 'claude-code'
  readonly pinnedVersion: typeof PINNED_CLAUDE_CODE_VERSION
  readonly targetPath: string
  readonly baseHash: string
  readonly appliedHash: string
  readonly sessionId: string | null
  readonly updatedAt: string
}

export function hashDocument(document: ClaudeSettingsDocument): string {
  return createHash('sha256')
    .update(`${JSON.stringify(document)}\n`)
    .digest('hex')
}

export function manifestPathForTarget(targetPath: string): string {
  return join(dirname(targetPath), MANIFEST_FILENAME)
}

export function backupPathForTarget(targetPath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `${targetPath}.ocbox-backup-${stamp}.json`
}

export async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'ENOENT') return null
    throw error
  }
}

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${randomUUID()}`
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

export async function readManifest(path: string): Promise<OwnedManifest | null> {
  const raw = await readTextIfPresent(path)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as OwnedManifest
    if (parsed.adapter !== 'claude-code') return null
    return parsed
  } catch {
    return null
  }
}
