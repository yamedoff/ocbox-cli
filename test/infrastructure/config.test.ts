import { describe, expect, it } from 'vitest'
import {
  ConfigValidationError,
  ConfigurationPrecedenceError,
  migrateProjectConfig,
  parseProjectConfig,
  resolveConfigurationValue,
  toSandboxSpec,
} from '../../src/config/index.js'

const VALID_CONFIG = `
schemaVersion = 1

[provider]
name = "acme-cloud"
runtimeClass = "microvm"
region = "us-east-1"

[sandbox]
operatingSystem = "linux"
architecture = "x86_64"
environmentName = "development"
image = { kind = "template", reference = "node-24" }

[sandbox.resources]
cpuMillicores = 2000
memoryBytes = 4294967296
diskBytes = 21474836480

[network]
egress = "restricted"
allowedHosts = ["registry.npmjs.org:443"]
directInbound = "blocked"
previews = "authenticated_only"

[lifecycle]
idleTimeoutMilliseconds = 900000
maximumRuntimeMilliseconds = 7200000
autoStopAfterMilliseconds = 1800000
autoDestroyAfterMilliseconds = 10800000

[source]
kind = "none"

[env]
NODE_ENV = "development"
CI = "true"
`

describe('project configuration', () => {
  it('parses schema v1 and maps canonical sections to the T2 SandboxSpec', () => {
    const config = parseProjectConfig(VALID_CONFIG)
    const specification = toSandboxSpec(config)

    expect(config.schemaVersion).toBe(1)
    expect(specification.cpu.millicores).toBe(2000)
    expect(specification.environment).toEqual({
      name: 'development',
      variableNames: ['CI', 'NODE_ENV'],
      secretReferenceIds: [],
    })
    expect(specification.network.allowedHosts).toEqual(['registry.npmjs.org:443'])
  })

  it('reports unknown fields with their full TOML path and a suggestion', () => {
    const source = VALID_CONFIG.replace('region = "us-east-1"', 'regoin = "us-east-1"')

    expect(() => parseProjectConfig(source)).toThrowError(ConfigValidationError)
    try {
      parseProjectConfig(source)
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect((error as ConfigValidationError).diagnostics).toContainEqual({
        code: 'unknown_field',
        path: 'provider.regoin',
        replacement: 'provider.region',
        message: 'Unknown configuration field provider.regoin; did you mean provider.region?',
      })
    }
  })

  it('gives actionable deprecated-field diagnostics', () => {
    const source = VALID_CONFIG.replace(
      'name = "acme-cloud"',
      'name = "acme-cloud"\ntype = "acme-cloud"',
    )
    try {
      parseProjectConfig(source)
      throw new Error('expected parse failure')
    } catch (error) {
      expect((error as ConfigValidationError).diagnostics[0]).toMatchObject({
        code: 'deprecated_field',
        path: 'provider.type',
        replacement: 'provider.name',
      })
    }
  })

  it('rejects provider BYOK variables and never echoes their value', () => {
    const source = VALID_CONFIG.replace('CI = "true"', 'OPENAI_API_KEY = "sk-examplevalue"')
    try {
      parseProjectConfig(source)
      throw new Error('expected parse failure')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect(String(error)).not.toContain('sk-examplevalue')
      expect((error as ConfigValidationError).diagnostics[0]?.path).toBe('env.OPENAI_API_KEY')
    }
  })

  it('migrates only an unversioned canonical document and refuses secret-looking input', () => {
    const legacy = VALID_CONFIG.replace('schemaVersion = 1\n', '')
    const migrated = migrateProjectConfig(legacy)
    expect(parseProjectConfig(migrated).schemaVersion).toBe(1)

    const unsafe = legacy.replace('CI = "true"', 'SERVICE_TOKEN = "opaque"')
    expect(() => migrateProjectConfig(unsafe)).toThrowError(/Migration refused.*env.SERVICE_TOKEN/)
  })

  it('uses CLI, environment, project, and default precedence in that order', () => {
    const base = {
      parseEnvironment: Number,
      environmentName: 'OCBOX_TIMEOUT_MS',
      defaultValue: 100,
    }
    expect(resolveConfigurationValue({ ...base, flag: 1, environment: '2', project: 3 })).toEqual({
      source: 'cli',
      value: 1,
    })
    expect(resolveConfigurationValue({ ...base, environment: '2', project: 3 })).toEqual({
      source: 'environment',
      value: 2,
    })
    expect(resolveConfigurationValue({ ...base, project: 3 })).toEqual({
      source: 'project',
      value: 3,
    })
    expect(resolveConfigurationValue(base)).toEqual({ source: 'default', value: 100 })
  })

  it('does not include invalid environment values in precedence errors', () => {
    expect(() =>
      resolveConfigurationValue({
        environment: 'credential-canary',
        environmentName: 'OCBOX_MODE',
        defaultValue: 'safe',
        parseEnvironment: () => {
          throw new TypeError('invalid')
        },
      }),
    ).toThrowError(ConfigurationPrecedenceError)
    try {
      resolveConfigurationValue({
        environment: 'credential-canary',
        environmentName: 'OCBOX_MODE',
        defaultValue: 'safe',
        parseEnvironment: () => {
          throw new TypeError('invalid')
        },
      })
    } catch (error) {
      expect(String(error)).not.toContain('credential-canary')
    }
  })

  it('sanitizes parser diagnostics instead of returning source text', () => {
    expect(() => parseProjectConfig('schemaVersion = "unterminated')).toThrowError(
      /^Invalid TOML syntax/,
    )
  })
})
