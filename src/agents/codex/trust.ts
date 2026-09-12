import { parseTomlDocument } from './codec.js'
import { isRecord } from './document.js'

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
