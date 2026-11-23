import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { replaceFileAtomically } from '../../state/exclusive-file-lock.js'

export interface CodexFileSystem {
  readFile(path: string): Promise<string | null>
  writeFileAtomic(path: string, contents: string): Promise<void>
  deleteFile(path: string): Promise<void>
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await replaceFileAtomically(temporary, path)
  } catch (error) {
    await handle?.close()
    await rm(temporary, { force: true })
    throw error
  }
}

export const nodeCodexFileSystem: CodexFileSystem = {
  readFile: readFileOrNull,
  writeFileAtomic,
  deleteFile: async (path) => {
    await rm(path, { force: true })
  },
}

export function backupTimestamp(date: Date = new Date()): string {
  return date.toISOString()
}

export async function backupFileTo(
  fileSystem: CodexFileSystem,
  source: string,
  backupPath: string,
): Promise<string> {
  const current = await fileSystem.readFile(source)
  if (current === null) throw new Error(`Cannot back up missing file ${source}`)
  await fileSystem.writeFileAtomic(backupPath, current)
  return backupPath
}
