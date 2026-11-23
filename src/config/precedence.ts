export type ConfigurationSource = 'cli' | 'environment' | 'project' | 'default'

export interface ResolvedConfigurationValue<T> {
  readonly source: ConfigurationSource
  readonly value: T
}

export interface ConfigurationCandidates<T> {
  readonly flag?: T | undefined
  readonly environment?: string | undefined
  readonly project?: T | undefined
  readonly defaultValue: T
  readonly parseEnvironment: (value: string) => T
  readonly environmentName: string
}

/** Raised without echoing an environment value that may be sensitive. */
export class ConfigurationPrecedenceError extends Error {
  readonly environmentName: string

  constructor(environmentName: string) {
    super(`Invalid value in environment variable ${environmentName}`)
    this.name = 'ConfigurationPrecedenceError'
    this.environmentName = environmentName
  }
}

/** Resolves deterministic CLI > environment > project file > default precedence. */
export function resolveConfigurationValue<T>(
  candidates: ConfigurationCandidates<T>,
): ResolvedConfigurationValue<T> {
  if (candidates.flag !== undefined) return { source: 'cli', value: candidates.flag }
  if (candidates.environment !== undefined) {
    try {
      return {
        source: 'environment',
        value: candidates.parseEnvironment(candidates.environment),
      }
    } catch {
      throw new ConfigurationPrecedenceError(candidates.environmentName)
    }
  }
  if (candidates.project !== undefined) return { source: 'project', value: candidates.project }
  return { source: 'default', value: candidates.defaultValue }
}
