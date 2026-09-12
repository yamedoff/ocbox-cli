import { mkdir, rename, writeFile } from 'node:fs/promises'
import { copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { replaceFileAtomically } from '../../state/exclusive-file-lock.js'

export function backupTimestamp(date: Date = new Date()): string {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '-')
}

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Math.floor(Math.random() * 1_000_000_000)}`
  await writeFile(temporary, content, 'utf8')
  try {
    await replaceFileAtomically(temporary, path)
  } catch (error) {
    await rename(temporary, path).catch(() => {
      throw error
    })
  }
}

export async function backupFileTo(
  source: string,
  backupDirectory: string,
  timestamp: string,
): Promise<string | null> {
  try {
    await mkdir(backupDirectory, { recursive: true })
    const base = source.split(/[\\/]/).at(-1) ?? 'config'
    const destination = join(backupDirectory, `${base}.${timestamp}.bak`)
    await copyFile(source, destination)
    return destination
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}
