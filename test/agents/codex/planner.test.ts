import { describe, expect, it } from 'vitest'
import {
  codexDoctor,
  detectCodexDrift,
  planCodexRemove,
  planCodexSetup,
  type SetupPlanInput,
} from '../../../src/agents/codex/planner.js'
import { resolveCodexPaths } from '../../../src/agents/codex/paths.js'
import type { CodexManifest } from '../../../src/agents/codex/manifest.js'

const VERSION_TEXT = 'codex-cli 0.153.4'

function userPaths(projectDirectory?: string) {
  return resolveCodexPaths({
    platform: 'linux',
    homeDirectory: '/home/ada',
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
  })
}

function setupInput(overrides: Partial<SetupPlanInput> = {}): SetupPlanInput {
  return {
    versionText: VERSION_TEXT,
    layer: 'user',
    trustLevel: null,
    sessionId: 'sess-test-1',
    allowUnverifiedSchema: true,
    paths: userPaths(),
    baseTomlText: null,
    baseHooksText: null,
    ...overrides,
  }
}

function manifestFor(plan: { configFile: string; hooksFile: string }): CodexManifest {
  const input = setupInput()
  const full = planCodexSetup(input)
  if (!full.ok || full.changes.length !== 2) throw new Error('fixture plan failed')
  const toml = full.changes.find((change) => change.kind === 'toml-merge')?.after ?? ''
  const hooks = full.changes.find((change) => change.kind === 'hooks-write')?.after ?? ''
  return {
    schemaVersion: 1,
    adapter: 'codex',
    adapterVersion: 'ocbox-codex-adapter-v1',
    codexVersion: '0.153.4',
    layer: 'user',
    codexHome: '/home/ada/.codex',
    projectDirectory: null,
    configFile: plan.configFile,
    hooksFile: plan.hooksFile,
    hookRepresentation: 'hooks-json',
    sessionId: 'sess-test-1',
    ownedTomlText: toml,
    ownedHooksText: hooks,
    backupConfigPath: null,
    backupHooksPath: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  }
}

describe('codex setup planner', () => {
  it('plans an explicit user-layer setup with owned fragments', () => {
    const plan = planCodexSetup(setupInput())
    expect(plan.ok).toBe(true)
    expect(plan.alreadyApplied).toBe(false)
    expect(plan.changes).toHaveLength(2)
    expect(plan.configFile).toBe('/home/ada/.codex/config.toml')
    expect(plan.hooksFile).toBe('/home/ada/.codex/hooks.json')
  })

  it('is idempotent on repeat setup with a matching manifest', () => {
    const paths = userPaths()
    const first = planCodexSetup({ ...setupInput(), paths })
    if (!first.ok) throw new Error('first plan failed')
    const toml = first.changes.find((change) => change.kind === 'toml-merge')?.after ?? null
    const hooks = first.changes.find((change) => change.kind === 'hooks-write')?.after ?? null
    const repeat = planCodexSetup(
      { ...setupInput(), paths, baseTomlText: toml, baseHooksText: hooks },
      manifestFor({ configFile: first.configFile, hooksFile: first.hooksFile }),
    )
    expect(repeat.ok).toBe(true)
    expect(repeat.alreadyApplied).toBe(true)
    expect(repeat.changes).toHaveLength(0)
  })

  it('stays fail-closed without the unverified-schema flag', () => {
    const plan = planCodexSetup(setupInput({ allowUnverifiedSchema: false }))
    expect(plan.ok).toBe(false)
    expect(plan.changes).toHaveLength(0)
    expect(plan.errors.join(' ')).toMatch(/fail-closed/)
  })

  it('refuses unsupported versions', () => {
    const plan = planCodexSetup(setupInput({ versionText: 'codex-cli 0.200.0' }))
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/0\.153\.4/)
  })

  it('fails closed with no usable Session', () => {
    const plan = planCodexSetup(setupInput({ sessionId: null }))
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/failing closed/)
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

  it('refuses corrupted config and duplicate hook representations', () => {
    const corrupted = planCodexSetup(setupInput({ baseTomlText: 'model = [oops' }))
    expect(corrupted.ok).toBe(false)
    expect(corrupted.errors.join(' ')).toMatch(/corrupted/)
    const duplicate = planCodexSetup(
      setupInput({
        baseTomlText: 'model = "x"\n[hooks]\ntest = 1\n',
        baseHooksText: '{"schemaVersion":1,"fixture":"x","hooks":[]}',
      }),
    )
    expect(duplicate.ok).toBe(false)
    expect(duplicate.errors.join(' ')).toMatch(/one representation per layer/)
  })

  it('preserves unrelated settings in planned output', () => {
    const base = 'model = "gpt-5.6-luna"\n[projects."x"]\ntrust_level = "trusted"\n'
    const plan = planCodexSetup(setupInput({ baseTomlText: base }))
    expect(plan.ok).toBe(true)
    const after = plan.changes.find((change) => change.kind === 'toml-merge')?.after ?? ''
    expect(after).toContain('gpt-5.6-luna')
    expect(after).toContain('trust_level')
  })
})

describe('codex drift and remove', () => {
  it('reports clean drift for matching fragments', () => {
    const paths = userPaths()
    const first = planCodexSetup({ ...setupInput(), paths })
    if (!first.ok) throw new Error('plan failed')
    const manifest = manifestFor({ configFile: first.configFile, hooksFile: first.hooksFile })
    const drift = detectCodexDrift(manifest, manifest.ownedTomlText, manifest.ownedHooksText)
    expect(drift.status).toBe('clean')
  })

  it('detects drift and corruption', () => {
    const manifest = manifestFor({
      configFile: '/home/ada/.codex/config.toml',
      hooksFile: '/home/ada/.codex/hooks.json',
    })
    expect(detectCodexDrift(manifest, 'model = "other"\n', manifest.ownedHooksText).status).toBe(
      'drifted',
    )
    expect(detectCodexDrift(manifest, 'model = [oops', manifest.ownedHooksText).status).toBe(
      'corrupted',
    )
    expect(detectCodexDrift(manifest, null, null).status).toBe('drifted')
    expect(detectCodexDrift(null, null, null).status).toBe('no-manifest')
  })

  it('restores backups when nothing drifted', () => {
    const manifest: CodexManifest = {
      ...manifestFor({
        configFile: '/home/ada/.codex/config.toml',
        hooksFile: '/home/ada/.codex/hooks.json',
      }),
      backupConfigPath: '/backups/config.toml.ts.bak',
      backupHooksPath: null,
    }
    const plan = planCodexRemove({
      manifest,
      currentTomlText: manifest.ownedTomlText,
      currentHooksText: manifest.ownedHooksText,
      originalTomlText: 'model = "original"\n',
      originalHooksText: null,
    })
    expect(plan.ok).toBe(true)
    expect(plan.actions.map((action) => action.action)).toEqual(['restore', 'delete'])
  })

  it('emits a three-way repair plan preserving both copies on user edits', () => {
    const manifest = manifestFor({
      configFile: '/home/ada/.codex/config.toml',
      hooksFile: '/home/ada/.codex/hooks.json',
    })
    const plan = planCodexRemove({
      manifest,
      currentTomlText: `${manifest.ownedTomlText}extra = 1\n`,
      currentHooksText: manifest.ownedHooksText,
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
    const manifest = manifestFor({
      configFile: '/home/ada/.codex/config.toml',
      hooksFile: '/home/ada/.codex/hooks.json',
    })
    const report = codexDoctor({
      versionText: VERSION_TEXT,
      tomlText: manifest.ownedTomlText,
      hooksText: manifest.ownedHooksText,
      manifest,
      trustLevel: null,
      sessionId: 'sess-test-1',
      sessionRecorded: true,
      environment: {},
    })
    expect(report.matrix.notice).toMatch(/routing aid/)
    expect(report.matrix.uncovered.join(' ')).toMatch(/MCP/)
    expect(report.checks.map((check) => check.id)).toContain('selected-session')
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
