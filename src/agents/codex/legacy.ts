import { isRecord } from './document.js'
import {
  CodexHookFragmentSchema,
  type CodexHookFragment,
  type CodexHookRepresentation,
} from './hooks.js'
import { ownedFragmentsInDocument } from './ownership.js'
import type { CodexLayer } from './paths.js'

/**
 * Lenient reader for pre-kernel single-layer manifests.
 *
 * Two historical shapes exist under `${state}/agents/codex/manifest.json`:
 *  - the 41474a4 per-fragment shape (lacks `sessionId`), and
 *  - the 4bdeaba fixture shape (`ownedTomlText`/`ownedHooksText`).
 *
 * Neither parses under the current strict schema, so they were silently ignored
 * and their owned fragments became permanent, unremovable orphans. This reader
 * recovers enough evidence to discover and repair those orphans by strict
 * ownership, never by trusting the legacy file to name user entries.
 */
export interface LegacyCodexManifest {
  readonly layer: CodexLayer | null
  readonly representation: CodexHookRepresentation | null
  readonly configPath: string | null
  readonly hooksPath: string | null
  readonly sessionId: string | null
  readonly fragments: readonly CodexHookFragment[]
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asLayer(value: unknown): CodexLayer | null {
  return value === 'user' || value === 'project' ? value : null
}

function asRepresentation(value: unknown): CodexHookRepresentation | null {
  return value === 'config-toml' || value === 'hooks-json' ? value : null
}

function parseFragments(value: unknown): CodexHookFragment[] {
  if (!Array.isArray(value)) return []
  const fragments: CodexHookFragment[] = []
  for (const candidate of value) {
    const parsed = CodexHookFragmentSchema.safeParse(candidate)
    if (parsed.success) fragments.push(parsed.data)
  }
  return fragments
}

function fragmentsFromOwnedText(source: string | null): CodexHookFragment[] {
  if (source === null) return []
  try {
    const parsed: unknown = JSON.parse(source)
    if (isRecord(parsed)) return [...ownedFragmentsInDocument(parsed)]
  } catch {
    void 0
  }
  return []
}

export function parseLegacyCodexManifest(source: string): LegacyCodexManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed['adapter'] !== 'codex') return null
  const configPath = asString(parsed['configPath']) ?? asString(parsed['configFile'])
  const hooksPath = asString(parsed['hooksPath']) ?? asString(parsed['hooksFile'])
  const ownedHooksText = asString(parsed['ownedHooksText'])
  const ownedTomlText = asString(parsed['ownedTomlText'])
  const fragments = parseFragments(parsed['fragments'])
  const recovered = [
    ...fragments,
    ...fragmentsFromOwnedText(ownedHooksText),
    ...fragmentsFromOwnedText(ownedTomlText),
  ]
  const unique = new Map<string, CodexHookFragment>()
  for (const fragment of recovered) unique.set(fragment.id, fragment)
  const looksLegacy =
    fragments.length > 0 ||
    ownedHooksText !== null ||
    ownedTomlText !== null ||
    parsed['sessionId'] === undefined
  if (!looksLegacy) return null
  return {
    layer: asLayer(parsed['layer']),
    representation: asRepresentation(parsed['representation'] ?? parsed['hookRepresentation']),
    configPath,
    hooksPath,
    sessionId: asString(parsed['sessionId']),
    fragments: [...unique.values()],
  }
}

export function legacyFragmentsForLayer(
  legacy: LegacyCodexManifest | null | undefined,
  layer: CodexLayer,
): readonly CodexHookFragment[] {
  if (legacy === null || legacy === undefined) return []
  if (legacy.layer !== null && legacy.layer !== layer) return []
  return legacy.fragments
}
