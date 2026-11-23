import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAdapterError } from '../../../src/agents/codex/errors.js'
import { assertAdapterOwnedPathWithinRoot } from '../../../src/agents/codex/paths.js'

const PLATFORM =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

function canCreateDirectoryLink(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'ocbox-codex-linkprobe-'))
  try {
    mkdirSync(join(root, 'target'))
    symlinkSync(join(root, 'target'), join(root, 'link'), 'junction')
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function canCreateFileLink(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'ocbox-codex-fileprobe-'))
  try {
    writeFileSync(join(root, 'target.json'), '{}')
    symlinkSync(join(root, 'target.json'), join(root, 'link.json'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const CAN_DIRECTORY_LINK = canCreateDirectoryLink()
const CAN_FILE_LINK = canCreateFileLink()

async function expectUnsafePath(promise: Promise<void>): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(CodexAdapterError)
  expect((caught as CodexAdapterError).code).toBe('CODEX_UNSAFE_PATH')
}

describe('codex config path boundary (D9)', () => {
  it.skipIf(!CAN_DIRECTORY_LINK)(
    'refuses a .codex directory link escaping the project with a typed error',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-boundary-'))
      try {
        const project = join(root, 'proj')
        const outside = join(root, 'outside')
        await mkdir(project, { recursive: true })
        await mkdir(outside, { recursive: true })
        await symlink(outside, join(project, '.codex'), 'junction')

        await expectUnsafePath(
          assertAdapterOwnedPathWithinRoot(
            join(project, '.codex', 'config.toml'),
            project,
            PLATFORM,
          ),
        )
        await expectUnsafePath(
          assertAdapterOwnedPathWithinRoot(
            join(project, '.codex', 'hooks.json'),
            project,
            PLATFORM,
          ),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!CAN_DIRECTORY_LINK)(
    'refuses a user CODEX_HOME directory link escaping home with a typed error',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-boundary-user-'))
      try {
        const home = join(root, 'home')
        const outside = join(root, 'outside')
        await mkdir(home, { recursive: true })
        await mkdir(outside, { recursive: true })
        const codexHome = join(home, '.codex')
        await symlink(outside, codexHome, 'junction')

        await expectUnsafePath(
          assertAdapterOwnedPathWithinRoot(join(codexHome, 'config.toml'), codexHome, PLATFORM),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!CAN_DIRECTORY_LINK)(
    'refuses a dangling .codex directory link with the typed error',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-dangling-'))
      try {
        const project = join(root, 'proj')
        const outside = join(root, 'outside')
        await mkdir(project, { recursive: true })
        await mkdir(outside, { recursive: true })
        await symlink(outside, join(project, '.codex'), 'junction')
        await rm(outside, { recursive: true, force: true })

        await expectUnsafePath(
          assertAdapterOwnedPathWithinRoot(
            join(project, '.codex', 'config.toml'),
            project,
            PLATFORM,
          ),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('allows a missing .codex directory so a fresh install remains creatable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-missing-'))
    try {
      const project = join(root, 'proj')
      await mkdir(project, { recursive: true })
      await expect(
        assertAdapterOwnedPathWithinRoot(join(project, '.codex', 'config.toml'), project, PLATFORM),
      ).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!CAN_DIRECTORY_LINK)(
    'allows a normal .codex under a project reached through a linked ancestor',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-linked-ancestor-'))
      try {
        const realProject = join(root, 'real-proj')
        await mkdir(realProject, { recursive: true })
        await symlink(realProject, join(root, 'proj'), 'junction')

        await expect(
          assertAdapterOwnedPathWithinRoot(
            join(root, 'proj', '.codex', 'config.toml'),
            join(root, 'proj'),
            PLATFORM,
          ),
        ).resolves.toBeUndefined()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32' || !CAN_FILE_LINK)(
    'refuses a symlinked config file that escapes .codex (POSIX)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-file-'))
      try {
        const project = join(root, 'proj')
        const secret = join(root, 'secret.toml')
        await mkdir(join(project, '.codex'), { recursive: true })
        await writeFile(secret, 'model = "secret"\n', 'utf8')
        await symlink(secret, join(project, '.codex', 'config.toml'), 'file')

        await expectUnsafePath(
          assertAdapterOwnedPathWithinRoot(
            join(project, '.codex', 'config.toml'),
            project,
            PLATFORM,
          ),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('still refuses a lexical escape with the typed error before touching the filesystem', async () => {
    await expectUnsafePath(
      assertAdapterOwnedPathWithinRoot(
        '/home/ada/.codex/../../etc/passwd',
        '/home/ada/.codex',
        'linux',
      ),
    )
  })
})
