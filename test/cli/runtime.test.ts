import { resolve as resolvePath } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveStateDirectory } from '../../src/cli/runtime.js'
import { resolveCurrentPlatformPaths } from '../../src/platform/index.js'

const CLEAN_ENV = {
  HOME: '/home/ocbox-tester',
  USERPROFILE: 'C:\\Users\\ocbox-tester',
  LOCALAPPDATA: 'C:\\Users\\ocbox-tester\\AppData\\Local',
  APPDATA: 'C:\\Users\\ocbox-tester\\AppData\\Roaming',
} as NodeJS.ProcessEnv

// `resolveStateDirectory` is the runtime consumer of the advertised
// CLI > environment > project > default precedence resolver. It has no project
// layer (no state-directory config field), so the contract exercised here is
// CLI flag > environment > platform default (L3).
describe('state-directory precedence contract (L3)', () => {
  it('resolves CLI flag over environment over platform default', () => {
    const environment: NodeJS.ProcessEnv = { ...CLEAN_ENV, OCBOX_STATE_DIR: 'env-state' }
    const platformDefault = resolveCurrentPlatformPaths(CLEAN_ENV).stateDirectory

    expect(resolveStateDirectory({ 'state-dir': 'flag-state' }, environment)).toBe(
      resolvePath('flag-state'),
    )
    expect(resolveStateDirectory({}, environment)).toBe(resolvePath('env-state'))
    expect(resolveStateDirectory({}, CLEAN_ENV)).toBe(resolvePath(platformDefault))
  })

  it('keeps every resolved value absolute', () => {
    const resolved = resolveStateDirectory({}, { ...CLEAN_ENV, OCBOX_STATE_DIR: 'relative-state' })
    expect(resolved).toBe(resolvePath('relative-state'))
  })
})
