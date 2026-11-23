import { parseCodexToml, parseTomlDocument } from './codec.js'
import { isRecord } from './document.js'
import { projectTrustLevel } from './io.js'

export type ProjectTrust = 'trusted' | 'untrusted' | 'unknown'

export function normalizeProjectKey(value: string): string {
  let normalized = value.trim()
  if (normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4)
  normalized = normalized.replaceAll('\\', '/')
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '')
  return normalized.toLowerCase()
}

export function determineProjectTrust(
  userConfigToml: string | null,
  projectRoot: string,
): ProjectTrust {
  const document = parseTomlDocument(userConfigToml, 'user config.toml')
  if (document === null) return 'unknown'
  const projects = document['projects']
  if (!isRecord(projects)) return 'unknown'
  const target = normalizeProjectKey(projectRoot)
  for (const [key, value] of Object.entries(projects)) {
    if (normalizeProjectKey(key) !== target) continue
    if (!isRecord(value)) return 'unknown'
    const trust = value['trust_level']
    if (trust === 'trusted') return 'trusted'
    if (trust === 'untrusted') return 'untrusted'
    return 'unknown'
  }
  return 'unknown'
}

export interface ProjectTrustInputs {
  readonly userConfigToml: string | null
  readonly layerConfigToml: string | null
  readonly projectDirectory: string
}

/**
 * Single project-trust policy shared by the `setup` and `doctor` commands.
 * The user-level `config.toml` wins when it explicitly trusts the repository;
 * otherwise the layer file being planned against is consulted with the same
 * strict TOML reader setup uses, falling back to the user-config verdict
 * (`'untrusted'` or `'unknown'`). The project layer is never auto-trusted: a
 * missing or untrusted verdict keeps setup and doctor fail-closed.
 */
export function resolveProjectTrustLevel(inputs: ProjectTrustInputs): string | null {
  const determined = determineProjectTrust(inputs.userConfigToml, inputs.projectDirectory)
  if (determined === 'trusted') return 'trusted'
  return (
    projectTrustLevel(inputs.layerConfigToml, [inputs.projectDirectory], (text: string) =>
      parseCodexToml(text),
    ) ?? determined
  )
}
