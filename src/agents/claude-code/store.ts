import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { replaceFileAtomically } from '../../state/exclusive-file-lock.js'
import { hashBytes } from './json.js'
import type { ClaudeSettingsDocument } from './settings-model.js'
import type { PINNED_CLAUDE_CODE_VERSION } from './version.js'

export const MANIFEST_FILENAME = 'ocbox-claude-code-manifest.json' as const

export interface OwnedManifest {
  readonly adapter: 'claude-code'
  readonly pinnedVersion: typeof PINNED_CLAUDE_CODE_VERSION
  readonly targetPath: string
  readonly baseHash: string
  readonly appliedHash: string
  readonly desiredHash: string
  readonly sessionId: string | null
  readonly updatedAt: string
  readonly backupPath: string | null
  readonly createdPointers: readonly string[]
  readonly protectedRules: readonly string[]
  /**
   * True when setup created the target settings file from nothing. `remove`
   * deletes that adapter-created file instead of leaving an empty `{}`, while a
   * pre-existing file is always rewritten (byte-for-byte for the untouched
   * shape) rather than deleted.
   */
  readonly createdFile: boolean
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

const DEFAULT_FILE_MODE = 0o600

async function resolveTargetMode(path: string): Promise<number> {
  try {
    const info = await stat(path)
    return info.mode & 0o777
  } catch {
    return DEFAULT_FILE_MODE
  }
}

async function fsyncParentDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, 'r')
  } catch {
    return
  }
  try {
    await handle.sync()
  } catch {
    // Some platforms (notably Windows) cannot fsync a directory handle; the
    // rename itself still provides atomic replacement there.
  } finally {
    await handle.close()
  }
}

export async function removePathIfPresent(path: string): Promise<void> {
  await rm(path, { force: true })
}

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const mode = await resolveTargetMode(path)
  const temporary = `${path}.tmp-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await replaceFileAtomically(temporary, path)
    } catch {
      await rename(temporary, path)
    }
    await fsyncParentDirectory(directory)
  } catch (error) {
    await handle?.close()
    await rm(temporary, { force: true })
    throw error
  }
}

export async function rollbackWrite(path: string, backupContent: string | null): Promise<void> {
  if (backupContent === null) {
    await rm(path, { force: true })
    return
  }
  await writeFileAtomic(path, backupContent)
}

export async function readManifest(path: string): Promise<OwnedManifest | null> {
  const raw = await readTextIfPresent(path)
  return parseManifestContent(raw)
}

export function parseManifestContent(raw: string | null): OwnedManifest | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<OwnedManifest>
    if (parsed.adapter !== 'claude-code') return null
    if (typeof parsed.targetPath !== 'string') return null
    if (typeof parsed.baseHash !== 'string') return null
    if (typeof parsed.appliedHash !== 'string') return null
    if (typeof parsed.pinnedVersion !== 'string' || parsed.pinnedVersion.length === 0) return null
    return {
      adapter: 'claude-code',
      pinnedVersion: parsed.pinnedVersion as OwnedManifest['pinnedVersion'],
      targetPath: parsed.targetPath,
      baseHash: parsed.baseHash,
      appliedHash: parsed.appliedHash,
      desiredHash: typeof parsed.desiredHash === 'string' ? parsed.desiredHash : parsed.appliedHash,
      sessionId: parsed.sessionId ?? null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      backupPath: typeof parsed.backupPath === 'string' ? parsed.backupPath : null,
      createdPointers: Array.isArray(parsed.createdPointers)
        ? parsed.createdPointers.filter((entry): entry is string => typeof entry === 'string')
        : [],
      protectedRules: Array.isArray(parsed.protectedRules)
        ? parsed.protectedRules.filter((entry): entry is string => typeof entry === 'string')
        : [],
      createdFile: parsed.createdFile === true,
    }
  } catch {
    return null
  }
}

export function hashBackupContent(content: string): string {
  return hashBytes(content)
}
