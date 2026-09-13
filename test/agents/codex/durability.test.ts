import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCodexChangePlan,
  applyCodexRemovePlan,
  codexDoctor,
  planCodexRemove,
  planCodexSetup,
  type SetupPlanInput,
} from '../../../src/agents/codex/planner.js'
import {
  parseTomlDocument,
  serializeHooksJsonDocument,
  serializeTomlDocument,
} from '../../../src/agents/codex/codec.js'
import { nodeCodexFileSystem } from '../../../src/agents/codex/fs.js'
import { buildHookShellCommand } from '../../../src/agents/codex/hook-helper.js'
import { type CodexHookFragment, toOwnedFragment } from '../../../src/agents/codex/hooks.js'
import { parseLegacyCodexManifest } from '../../../src/agents/codex/legacy.js'
import { ownedFragmentsInDocument } from '../../../src/agents/codex/ownership.js'
import { resolveCodexPaths } from '../../../src/agents/codex/paths.js'
import { editTomlHooks } from '../../../src/agents/codex/toml-edit.js'

const VERSION_TEXT = 'codex-cli 0.153.4'
const TIMESTAMP = '2026-09-12T00:00:00.000Z'
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

function userPaths(stateDirectory = '/state') {
  return resolveCodexPaths({
    platform: 'linux',
    homeDirectory: '/home/ada',
    environment: {},
    stateDirectory,
  })
}

function setupInput(overrides: Partial<SetupPlanInput> = {}): SetupPlanInput {
  return {
    versionText: VERSION_TEXT,
    layer: 'user',
    trustLevel: null,
    sessionId: 'sess-new',
    paths: userPaths(),
    baseTomlText: null,
    baseHooksText: null,
    timestamp: TIMESTAMP,
    ...overrides,
  }
}

function owned(sessionId: string): CodexHookFragment {
  return toOwnedFragment({
    event: 'PreToolUse',
    matcher: 'shell',
    group: {
      matcher: 'shell',
      hooks: [{ type: 'command', command: buildHookShellCommand({ sessionId }) }],
    },
  })
}

const userGroup = {
  matcher: 'startup',
  hooks: [{ type: 'command', command: 'existing-user-hook' }],
}

function hooksJson(groups: Record<string, unknown[]>): string {
  return serializeHooksJsonDocument({ hooks: groups })
}

function tomlWithOwned(sessionId: string): string {
  return serializeTomlDocument({ hooks: { PreToolUse: [owned(sessionId).group] } })
}

function nextHookChange(plan: ReturnType<typeof planCodexSetup>): string | null {
  return plan.changes.find((change) => change.kind === 'hooks-write')?.after ?? null
}

function nextTomlChange(plan: ReturnType<typeof planCodexSetup>): string | null {
  return plan.changes.find((change) => change.kind === 'toml-merge')?.after ?? null
}

const commentedToml = [
  '# keep this comment',
  'model = "gpt-5.6-luna"',
  '',
  '# user hooks below',
  '[[hooks.SessionStart]]',
  'matcher = "startup"',
  '',
  '[[hooks.SessionStart.hooks]]',
  'type = "command"',
  'command = "existing-user-hook"',
  '',
].join('\n')

describe('comment-preserving TOML durability (F3)', () => {
  it('splices the owned group into config.toml without disturbing user bytes', () => {
    const plan = planCodexSetup(
      setupInput({ preferredRepresentation: 'config-toml', baseTomlText: commentedToml }),
    )
    expect(plan.ok).toBe(true)
    const next = nextTomlChange(plan)
    expect(next).not.toBeNull()
    expect(next).toContain(commentedToml)
    expect(next).toContain('# keep this comment')
    expect(next).toContain('existing-user-hook')
    expect(next).toContain('sess-new')
  })

  it('round-trips back to the original bytes when only the owned group is stripped', () => {
    const plan = planCodexSetup(
      setupInput({ preferredRepresentation: 'config-toml', baseTomlText: commentedToml }),
    )
    const next = nextTomlChange(plan)
    if (next === null) throw new Error('no config change')
    const present = ownedFragmentsInDocument(parseTomlDocument(next))
    expect(present).toHaveLength(1)
    const stripped = editTomlHooks(next, { add: [], remove: present }).text
    expect(stripped).toBe(commentedToml)
  })

  it('restores the exact pre-setup bytes on remove when the file is intact', () => {
    const plan = planCodexSetup(
      setupInput({ preferredRepresentation: 'config-toml', baseTomlText: commentedToml }),
    )
    if (!plan.ok || plan.manifest === null) throw new Error('plan failed')
    const next = nextTomlChange(plan)
    if (next === null) throw new Error('no config change')
    const remove = planCodexRemove({
      manifest: plan.manifest,
      layer: 'user',
      currentTomlText: next,
      currentHooksText: null,
      originalTomlText: commentedToml,
      originalHooksText: null,
    })
    const action = remove.actions.find((entry) => entry.file.endsWith('config.toml'))
    expect(action?.action).toBe('restore')
    expect(action?.after).toBe(commentedToml)
  })
})

describe('crash-safe orphan recovery (F4)', () => {
  it('discovers and strips an orphaned owned hook left by a crashed apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-'))
    temps.push(root)
    const paths = resolveCodexPaths({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      homeDirectory: root,
      environment: {},
      stateDirectory: join(root, 'state'),
    })
    const plan = planCodexSetup({ ...setupInput(), paths })
    if (!plan.ok) throw new Error('plan failed')
    const hooksChange = plan.changes.find((change) => change.kind === 'hooks-write')
    if (hooksChange === undefined) throw new Error('no hooks change')
    await mkdir(paths.codexHome, { recursive: true })
    // Crash: the hooks file lands but the manifest write never happens.
    await applyCodexChangePlan({ files: [hooksChange] }, nodeCodexFileSystem)
    const orphaned = await readFile(paths.userHooksPath, 'utf8')
    expect(orphaned).toContain('sess-new')

    const remove = planCodexRemove({
      manifest: null,
      layer: 'user',
      configFile: paths.userConfigFile,
      hooksFile: paths.userHooksPath,
      currentTomlText: null,
      currentHooksText: orphaned,
      originalTomlText: null,
      originalHooksText: null,
    })
    expect(remove.status).toBe('removed')
    expect(remove.repairs.map((repair) => repair.reason)).toContain('orphaned-owned-fragment')
    await applyCodexRemovePlan({ actions: remove.actions, manifestPath: null }, nodeCodexFileSystem)
    await expect(readFile(paths.userHooksPath, 'utf8')).rejects.toThrow()
  })

  it('self-heals a stale session hook on the next setup even without a manifest', () => {
    const stale = hooksJson({
      PreToolUse: [owned('sess-old').group],
      SessionStart: [userGroup],
    })
    const plan = planCodexSetup(setupInput({ sessionId: 'sess-new', baseHooksText: stale }))
    expect(plan.ok).toBe(true)
    const after = nextHookChange(plan) ?? ''
    expect(after).toContain('sess-new')
    expect(after).not.toContain('sess-old')
    expect(after).toContain('existing-user-hook')
    expect(plan.repairs.map((repair) => repair.reason)).toContain('orphaned-owned-fragment')
  })

  it('rolls a multi-file remove back exactly when a later operation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-'))
    temps.push(root)
    const configFile = join(root, 'config.toml')
    const hooksFile = join(root, 'hooks.json')
    const manifestPath = join(root, 'manifest.json')
    const currentHooks = hooksJson({
      PreToolUse: [owned('sess-old').group],
      SessionStart: [userGroup],
    })
    await writeFile(hooksFile, currentHooks)
    await writeFile(manifestPath, '{"adapter":"codex"}\n')
    const remove = planCodexRemove({
      manifest: null,
      layer: 'user',
      configFile,
      hooksFile,
      currentTomlText: null,
      currentHooksText: currentHooks,
      originalTomlText: null,
      originalHooksText: null,
    })
    const failing = {
      ...nodeCodexFileSystem,
      deleteFile: async () => {
        throw new Error('injected delete failure')
      },
    }
    await expect(
      applyCodexRemovePlan({ actions: remove.actions, manifestPath }, failing),
    ).rejects.toMatchObject({ code: 'CODEX_APPLY_FAILED' })
    expect(await readFile(hooksFile, 'utf8')).toBe(currentHooks)
    expect(await readFile(manifestPath, 'utf8')).toBe('{"adapter":"codex"}\n')
  })

  it('reports not-installed when no manifest and no owned fragments exist', () => {
    const remove = planCodexRemove({
      manifest: null,
      layer: 'user',
      configFile: '/home/ada/.codex/config.toml',
      hooksFile: '/home/ada/.codex/hooks.json',
      currentTomlText: 'model = "gpt-5.6-luna"\n',
      currentHooksText: hooksJson({ SessionStart: [userGroup] }),
      originalTomlText: null,
      originalHooksText: null,
    })
    expect(remove.status).toBe('not-installed')
  })
})

describe('strict-ownership duplicate pruning (F5)', () => {
  it('prunes a stale owned fragment from the non-target TOML representation', () => {
    const seed = planCodexSetup(setupInput({ sessionId: 'sess-new' }))
    if (!seed.ok || seed.manifest === null) throw new Error('seed failed')
    expect(seed.manifest.representation).toBe('hooks-json')
    const base = `${commentedToml}${tomlWithOwned('sess-old')}`
    const plan = planCodexSetup(
      setupInput({ sessionId: 'sess-new', baseTomlText: base }),
      seed.manifest,
    )
    expect(plan.ok).toBe(true)
    const next = nextTomlChange(plan)
    expect(next).not.toBeNull()
    expect(next).not.toContain('sess-old')
    expect(next).toContain('existing-user-hook')
    expect(next).toContain('# keep this comment')
    expect(plan.repairs.map((repair) => repair.reason)).toContain('orphaned-owned-fragment')
  })

  it('prunes a stale owned fragment from the target JSON representation', () => {
    const stale = hooksJson({
      PreToolUse: [owned('sess-old').group],
      SessionStart: [userGroup],
    })
    const plan = planCodexSetup(setupInput({ sessionId: 'sess-new', baseHooksText: stale }))
    const after = nextHookChange(plan) ?? ''
    expect(after).not.toContain('sess-old')
    expect(after).toContain('sess-new')
    expect(after).toContain('existing-user-hook')
  })
})

describe('mixed user content and legacy manifests (F7)', () => {
  it('repairs legacy orphans recorded in a pre-kernel manifest without touching user entries', () => {
    const legacyFragment = owned('sess-legacy')
    const currentHooks = hooksJson({
      PreToolUse: [legacyFragment.group],
      SessionStart: [userGroup],
    })
    const legacy = parseLegacyCodexManifest(
      JSON.stringify({ adapter: 'codex', ownedHooksText: currentHooks }),
    )
    expect(legacy?.fragments).toHaveLength(1)
    const plan = planCodexSetup(
      setupInput({ sessionId: 'sess-new', baseHooksText: currentHooks, legacyManifest: legacy }),
    )
    expect(plan.ok).toBe(true)
    const after = nextHookChange(plan) ?? ''
    expect(after).not.toContain('sess-legacy')
    expect(after).toContain('sess-new')
    expect(after).toContain('existing-user-hook')
    expect(plan.repairs.map((repair) => repair.reason)).toContain('legacy-orphaned-fragment')
  })

  it('strips legacy recorded fragments during remove while preserving unrelated user hooks', () => {
    const legacyFragment = owned('sess-legacy')
    const legacy = parseLegacyCodexManifest(
      JSON.stringify({ adapter: 'codex', layer: 'user', fragments: [legacyFragment] }),
    )
    const currentHooks = hooksJson({
      PreToolUse: [legacyFragment.group],
      SessionStart: [userGroup],
    })
    const remove = planCodexRemove({
      manifest: null,
      legacyManifest: legacy,
      layer: 'user',
      configFile: '/home/ada/.codex/config.toml',
      hooksFile: '/home/ada/.codex/hooks.json',
      currentTomlText: 'model = "gpt-5.6-luna"\n# untouched\n',
      currentHooksText: currentHooks,
      originalTomlText: null,
      originalHooksText: null,
    })
    expect(remove.status).toBe('removed')
    expect(remove.repairs.map((repair) => repair.reason)).toContain('legacy-orphaned-fragment')
    const hooksAction = remove.actions.find((entry) => entry.file.endsWith('hooks.json'))
    expect(hooksAction?.after).toBeTruthy()
    expect(hooksAction?.after).not.toContain('sess-legacy')
    expect(hooksAction?.after).toContain('existing-user-hook')
  })

  it('never removes unrelated user entries a legacy manifest does not match', () => {
    const legacyFragment = owned('sess-legacy')
    const legacy = parseLegacyCodexManifest(
      JSON.stringify({ adapter: 'codex', ownedHooksText: JSON.stringify({ hooks: {} }) }),
    )
    const currentHooks = hooksJson({ SessionStart: [userGroup] })
    const plan = planCodexSetup(
      setupInput({
        sessionId: 'sess-new',
        baseHooksText: currentHooks,
        legacyManifest: legacy,
      }),
    )
    expect(plan.ok).toBe(true)
    const after = nextHookChange(plan) ?? ''
    expect(after).toContain('existing-user-hook')
    if (legacy === null) throw new Error('legacy fixture should parse')
    expect(legacy.fragments).toHaveLength(0)
    expect(legacyFragment.id).toMatch(/^ocbox-codex-[0-9a-f]{32}$/)
  })

  it('keeps the desired hook when a legacy manifest names the same fragment', () => {
    const desired = owned('sess-new')
    const currentHooks = hooksJson({ PreToolUse: [desired.group] })
    const legacy = parseLegacyCodexManifest(
      JSON.stringify({ adapter: 'codex', ownedHooksText: currentHooks }),
    )
    const plan = planCodexSetup(
      setupInput({ sessionId: 'sess-new', baseHooksText: currentHooks, legacyManifest: legacy }),
    )
    expect(plan.ok).toBe(true)
    const effective = nextHookChange(plan) ?? currentHooks
    const groups = JSON.parse(effective).hooks?.PreToolUse ?? []
    expect(groups).toHaveLength(1)
  })

  it('flags unrecorded owned fragments in doctor output', () => {
    const report = codexDoctor({
      versionText: VERSION_TEXT,
      tomlText: null,
      hooksText: hooksJson({ PreToolUse: [owned('sess-orphan').group] }),
      manifest: null,
      trustLevel: null,
      sessionId: 'sess-orphan',
      sessionRecorded: true,
      environment: {},
    })
    expect(report.checks.map((check) => check.id)).toContain('orphaned-hooks')
  })
})
