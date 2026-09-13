import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCodexChangePlan,
  codexDoctor,
  computeThreeWayRepair,
  detectCodexDrift,
  planCodexRemove,
  planCodexSetup,
  type SetupPlanInput,
} from '../../../src/agents/codex/planner.js'
import { parseTomlDocument } from '../../../src/agents/codex/codec.js'
import { nodeCodexFileSystem } from '../../../src/agents/codex/fs.js'
import { parseCodexAdapterManifest } from '../../../src/agents/codex/manifest.js'
import { resolveCodexPaths } from '../../../src/agents/codex/paths.js'
import type { CodexManifest } from '../../../src/agents/codex/manifest.js'

const VERSION_TEXT = 'codex-cli 0.153.4'
const TIMESTAMP = '2026-09-12T00:00:00.000Z'
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocbox-codex-'))
  temps.push(root)
  return root
}

function userPaths(projectDirectory?: string, stateDirectory = '/state') {
  return resolveCodexPaths({
    platform: 'linux',
    homeDirectory: '/home/ada',
    environment: {},
    stateDirectory,
    ...(projectDirectory === undefined ? {} : { projectRoot: projectDirectory }),
  })
}

function setupInput(overrides: Partial<SetupPlanInput> = {}): SetupPlanInput {
  return {
    versionText: VERSION_TEXT,
    layer: 'user',
    trustLevel: null,
    sessionId: 'sess-test-1',
    paths: userPaths(),
    baseTomlText: null,
    baseHooksText: null,
    timestamp: TIMESTAMP,
    ...overrides,
  }
}

function manifestForPlan(
  plan: { configFile: string; hooksFile: string },
  sessionId = 'sess-test-1',
): CodexManifest {
  const input = setupInput({ sessionId })
  const full = planCodexSetup(input)
  if (!full.ok || full.manifest === null) throw new Error('fixture plan failed')
  return {
    ...full.manifest,
    configPath: plan.configFile,
    hooksPath: plan.hooksFile,
  }
}

describe('codex setup planner', () => {
  it('plans an explicit user-layer setup with owned fragments', () => {
    const plan = planCodexSetup(setupInput())
    expect(plan.ok).toBe(true)
    expect(plan.alreadyApplied).toBe(false)
    expect(plan.status).toBe('installed')
    const hooks = plan.changes.find((change) => change.kind === 'hooks-write')
    expect(hooks?.after).toContain('sess-test-1')
    expect(hooks?.after).toContain('PreToolUse')
    expect(hooks?.after).toContain('agent hook codex')
    expect(hooks?.after).toContain('"matcher": "Bash"')
    expect(hooks?.backupPath).toBeNull()
    const manifest = plan.changes.find((change) => change.kind === 'manifest')
    expect(manifest?.file).toBe('/state/agents/codex/user/manifest.json')
  })

  it('is idempotent on repeat setup with a matching manifest', () => {
    const paths = userPaths()
    const first = planCodexSetup({ ...setupInput(), paths })
    if (!first.ok || first.manifest === null) throw new Error('first plan failed')
    const hooks = first.changes.find((change) => change.kind === 'hooks-write')?.after ?? null
    const repeat = planCodexSetup(
      { ...setupInput(), paths, baseTomlText: null, baseHooksText: hooks },
      first.manifest,
    )
    expect(repeat.ok).toBe(true)
    expect(repeat.alreadyApplied).toBe(true)
    expect(repeat.status).toBe('unchanged')
    expect(repeat.changes).toHaveLength(0)
    expect(repeat.idempotent).toBe(true)
  })

  it('replaces the owned hook on session rotation instead of accumulating', () => {
    const paths = userPaths()
    const first = planCodexSetup({ ...setupInput(), paths })
    if (!first.ok || first.manifest === null) throw new Error('first plan failed')
    const hooks = first.changes.find((change) => change.kind === 'hooks-write')?.after ?? null
    const rotated = planCodexSetup(
      { ...setupInput(), paths, sessionId: 'sess-test-2', baseHooksText: hooks },
      first.manifest,
    )
    expect(rotated.ok).toBe(true)
    expect(rotated.alreadyApplied).toBe(false)
    expect(rotated.manifest?.fragments).toHaveLength(1)
    expect(rotated.manifest?.sessionId).toBe('sess-test-2')
    const after = rotated.changes.find((change) => change.kind === 'hooks-write')?.after ?? ''
    expect(after).toContain('sess-test-2')
    expect(after).not.toContain('sess-test-1')
  })

  it('no longer needs the deprecated unverified-schema flag', () => {
    const plan = planCodexSetup(setupInput({ allowUnverifiedSchema: false }))
    expect(plan.ok).toBe(true)
    expect(plan.warnings.join(' ')).toMatch(/deprecated/)
  })

  it('refuses unsupported versions', () => {
    const plan = planCodexSetup(setupInput({ versionText: 'codex-cli 0.200.0' }))
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/0\.153\.4/)
  })

  it('refuses a Desktop pre-release with an explicit remediation', () => {
    const plan = planCodexSetup(setupInput({ versionText: 'codex-desktop 0.154.0-alpha.6.2' }))
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/Desktop pre-release/)
  })

  it('fails closed with no usable Session', () => {
    const plan = planCodexSetup(setupInput({ sessionId: null }))
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/failing closed/)
  })

  it('fails closed on an explicit Session that is not recorded', () => {
    const plan = planCodexSetup(setupInput({ sessionId: 'sess-missing', sessionRecorded: false }))
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/not recorded/)
    expect(plan.changes).toHaveLength(0)
  })

  it('still plans when session recording was not checked', () => {
    const plan = planCodexSetup(setupInput())
    expect(plan.ok).toBe(true)
  })

  it('never auto-trusts the project layer', () => {
    const paths = userPaths('/srv/repo')
    const untrusted = planCodexSetup({
      ...setupInput(),
      paths,
      layer: 'project',
      trustLevel: 'untrusted',
    })
    expect(untrusted.ok).toBe(false)
    expect(untrusted.errors.join(' ')).toMatch(/not auto-trusted/)
    const unknown = planCodexSetup({ ...setupInput(), paths, layer: 'project', trustLevel: null })
    expect(unknown.ok).toBe(false)
    const trusted = planCodexSetup({
      ...setupInput(),
      paths,
      layer: 'project',
      trustLevel: 'trusted',
    })
    expect(trusted.ok).toBe(true)
  })

  it('refuses corrupted config instead of guessing', () => {
    const corrupted = planCodexSetup(setupInput({ baseTomlText: 'model = [oops' }))
    expect(corrupted.ok).toBe(false)
    expect(corrupted.errors.join(' ')).toMatch(/not valid TOML/)
    const corruptedHooks = planCodexSetup(setupInput({ baseHooksText: '{oops' }))
    expect(corruptedHooks.ok).toBe(false)
    expect(corruptedHooks.errors.join(' ')).toMatch(/not valid JSON/)
  })

  it('prunes a duplicated owned copy while keeping one representation per layer', () => {
    const seed = planCodexSetup(setupInput({ preferredRepresentation: 'config-toml' }))
    if (!seed.ok) throw new Error('seed plan failed')
    const seedToml = seed.changes.find((change) => change.kind === 'toml-merge')?.after
    if (seedToml === undefined || seedToml === null) throw new Error('seed has no config change')
    const seedDocument = parseTomlDocument(seedToml)
    const seedGroups = (seedDocument?.['hooks'] as Record<string, unknown> | undefined)?.[
      'PreToolUse'
    ] as unknown[] | undefined
    if (seedGroups === undefined || seedGroups.length !== 1) throw new Error('seed group missing')
    const duplicate = planCodexSetup(
      setupInput({
        baseTomlText: seedToml,
        baseHooksText: JSON.stringify({ hooks: { PreToolUse: seedGroups } }),
      }),
    )
    expect(duplicate.ok).toBe(true)
    expect(duplicate.repairs.map((repair) => repair.reason)).toContain('duplicated-representation')
    const hooksAfter = duplicate.changes.find((change) => change.kind === 'hooks-write')?.after
    expect(hooksAfter).toBeDefined()
    expect(JSON.parse(hooksAfter ?? '').hooks?.PreToolUse).toBeUndefined()
  })

  it('preserves unrelated settings in planned output', () => {
    const base = 'model = "gpt-5.6-luna"\n[projects."x"]\ntrust_level = "trusted"\n'
    const plan = planCodexSetup(setupInput({ baseTomlText: base }))
    expect(plan.ok).toBe(true)
    expect(plan.changes.find((change) => change.kind === 'toml-merge')).toBeUndefined()
    const hooks = plan.changes.find((change) => change.kind === 'hooks-write')
    expect(hooks).toBeDefined()
  })

  it('fails closed on an unknown hooks schema', () => {
    const plan = planCodexSetup(setupInput({ baseHooksText: '{"hooks":{"FutureEvent":[]}}' }))
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/Unknown hook event/)
  })
})

describe('codex drift and remove', () => {
  it('reports clean drift for matching fragments', () => {
    const first = planCodexSetup(setupInput())
    if (!first.ok || first.manifest === null) throw new Error('plan failed')
    const hooks = first.changes.find((change) => change.kind === 'hooks-write')?.after ?? null
    const drift = detectCodexDrift(first.manifest, null, hooks)
    expect(drift.status).toBe('clean')
  })

  it('detects drift and corruption', () => {
    const manifest = manifestForPlan({
      configFile: '/home/ada/.codex/config.toml',
      hooksFile: '/home/ada/.codex/hooks.json',
    })
    const first = planCodexSetup(setupInput())
    if (!first.ok || first.manifest === null) throw new Error('plan failed')
    const hooks = first.changes.find((change) => change.kind === 'hooks-write')?.after ?? null
    expect(detectCodexDrift(manifest, 'model = "other"\n', hooks).status).toBe('drifted')
    expect(detectCodexDrift(manifest, 'model = [oops', hooks).status).toBe('corrupted')
    expect(detectCodexDrift(manifest, null, null).status).toBe('drifted')
    expect(detectCodexDrift(null, null, null).status).toBe('no-manifest')
  })

  it('restores backups when nothing drifted', () => {
    const first = planCodexSetup(setupInput())
    if (!first.ok || first.manifest === null) throw new Error('plan failed')
    const hooks = first.changes.find((change) => change.kind === 'hooks-write')?.after ?? null
    const plan = planCodexRemove({
      manifest: first.manifest,
      currentTomlText: null,
      currentHooksText: hooks,
      originalTomlText: null,
      originalHooksText: '{"hooks":{}}\n',
    })
    expect(plan.ok).toBe(true)
    expect(plan.status).toBe('removed')
    const hooksAction = plan.actions.find((action) => action.file.endsWith('hooks.json'))
    expect(hooksAction?.action).toBe('restore')
    expect(hooksAction?.after).toBe('{"hooks":{}}\n')
    const tomlAction = plan.actions.find((action) => action.file.endsWith('config.toml'))
    expect(tomlAction?.action).toBe('noop')
  })

  it('emits repair-required and writes nothing when a user edits an owned fragment', () => {
    const first = planCodexSetup(setupInput())
    if (!first.ok || first.manifest === null) throw new Error('plan failed')
    const edited = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-edited' }] }],
      },
    })
    const plan = planCodexRemove({
      manifest: first.manifest,
      currentTomlText: null,
      currentHooksText: edited,
      originalTomlText: null,
      originalHooksText: null,
    })
    expect(plan.status).toBe('repair-required')
    expect(plan.actions).toHaveLength(0)
    expect(plan.repairs[0]).toMatchObject({
      reason: 'user-modified-owned-fragment',
      preserved: true,
    })
  })

  it('preserves both copies on unrelated drift with the original backup missing', () => {
    const first = planCodexSetup(setupInput())
    if (!first.ok || first.manifest === null) throw new Error('plan failed')
    const hooks = first.changes.find((change) => change.kind === 'hooks-write')?.after ?? ''
    const plan = planCodexRemove({
      manifest: first.manifest,
      currentTomlText: 'extra = 1\n',
      currentHooksText: hooks,
      originalTomlText: null,
      originalHooksText: null,
    })
    const tomlAction = plan.actions.find((action) => action.file.endsWith('config.toml'))
    expect(tomlAction?.action).toBe('preserve-and-plan')
    expect(tomlAction?.preservedCopy).toContain('.ocbox-preserved')
    expect(plan.repairSteps.length).toBeGreaterThan(0)
    expect(plan.warnings.join(' ')).toMatch(/preserved/)
  })
})

describe('codex doctor', () => {
  it('lists exact covered and uncovered capabilities with routing-aid language', () => {
    const first = planCodexSetup(setupInput())
    if (!first.ok || first.manifest === null) throw new Error('plan failed')
    const hooks = first.changes.find((change) => change.kind === 'hooks-write')?.after ?? null
    const report = codexDoctor({
      versionText: VERSION_TEXT,
      tomlText: null,
      hooksText: hooks,
      manifest: first.manifest,
      trustLevel: null,
      sessionId: 'sess-test-1',
      sessionRecorded: true,
      environment: {},
    })
    expect(report.matrix.notice).toMatch(/routing aid/)
    expect(report.matrix.uncovered.join(' ')).toMatch(/MCP/)
    expect(report.checks.map((check) => check.id)).toContain('selected-session')
    expect(report.checks.find((check) => check.id === 'schema-proof')?.status).toBe('ok')
    expect(report.checks.find((check) => check.id === 'hook-contract')).toMatchObject({
      status: 'ok',
    })
  })

  it('fails closed checks with no usable Session and never exposes tokens', () => {
    const report = codexDoctor({
      versionText: VERSION_TEXT,
      tomlText: null,
      hooksText: null,
      manifest: null,
      trustLevel: null,
      sessionId: null,
      sessionRecorded: false,
      environment: {},
    })
    const session = report.checks.find((check) => check.id === 'selected-session')
    expect(session?.status).toBe('fail')
    expect(JSON.stringify(report)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
  })
})

describe('three-way repair classification', () => {
  const recorded = { matcher: 'shell', hooks: [{ command: 'owned' }] }
  it('classifies intact, desired, missing, and divergent copies', () => {
    expect(computeThreeWayRepair(recorded, recorded, recorded).action).toBe('already-desired')
    expect(computeThreeWayRepair(recorded, recorded, null).action).toBe('take-desired')
    expect(computeThreeWayRepair(recorded, null, recorded).action).toBe('recreate')
    expect(
      computeThreeWayRepair(recorded, { matcher: 'shell', hooks: [{ command: 'user' }] }, recorded)
        .action,
    ).toBe('preserve-both')
  })

  it('round-trips a persisted manifest so ownership survives a restart', async () => {
    const root = await tempRoot()
    const host = process.platform === 'win32' ? 'win32' : 'linux'
    const paths = resolveCodexPaths({
      platform: host,
      homeDirectory: root,
      environment: {},
      stateDirectory: join(root, 'state'),
    })
    const plan = planCodexSetup({ ...setupInput(), paths })
    if (!plan.ok || plan.manifest === null) throw new Error('plan failed')
    await applyCodexChangePlan({ files: plan.changes }, nodeCodexFileSystem)
    const manifest = parseCodexAdapterManifest(await readFile(paths.manifestPath('user'), 'utf8'))
    expect(manifest.adapter).toBe('codex')
    expect(manifest.fragments).toHaveLength(1)
    expect(manifest.layer).toBe('user')
    expect(manifest.sessionId).toBe('sess-test-1')
  })

  it('rolls back exactly when a later write fails', async () => {
    const root = await tempRoot()
    const host = process.platform === 'win32' ? 'win32' : 'linux'
    const paths = resolveCodexPaths({
      platform: host,
      homeDirectory: root,
      environment: {},
      stateDirectory: join(root, 'state'),
    })
    const hooksPath = paths.userHooksPath
    const original = `${JSON.stringify({ unrelated: true }, null, 2)}\n`
    await mkdir(paths.codexHome, { recursive: true })
    await writeFile(hooksPath, original)
    const plan = planCodexSetup({
      ...setupInput(),
      paths,
      baseHooksText: original,
    })
    expect(plan.ok).toBe(true)
    expect(plan.status).toBe('installed')
    let writes = 0
    const failing = {
      ...nodeCodexFileSystem,
      writeFileAtomic: async (path: string, contents: string) => {
        writes += 1
        if (writes === 3) throw new Error('injected write failure')
        await nodeCodexFileSystem.writeFileAtomic(path, contents)
      },
    }
    await expect(applyCodexChangePlan({ files: plan.changes }, failing)).rejects.toMatchObject({
      code: 'CODEX_APPLY_FAILED',
    })
    expect(await readFile(hooksPath, 'utf8')).toBe(original)
  })
})
