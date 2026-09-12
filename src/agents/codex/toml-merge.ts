import { parse, stringify } from 'smol-toml'

export const OWNED_TOML_TABLE = 'ocbox' as const

export const FIXTURE_TOML_SCHEMA = 'ocbox-codex-fixture-v1' as const

export class CodexTomlError extends Error {
  readonly code = 'TOML_PARSE_ERROR' as const
  constructor(message: string) {
    super(message)
    this.name = 'CodexTomlError'
  }
}

export function parseCodexToml(text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch {
    throw new CodexTomlError('Codex config is not parseable TOML; refusing to merge.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CodexTomlError('Codex config TOML root is not a table; refusing to merge.')
  }
  return parsed as Record<string, unknown>
}

export interface OwnedTomlFragmentInput {
  readonly adapterVersion: string
  readonly codexVersion: string
  readonly layer: string
  readonly sessionId: string
  readonly hookId: string
  readonly hookRepresentation: string
}

export function ownedTomlFragment(input: OwnedTomlFragmentInput): Record<string, unknown> {
  return {
    [OWNED_TOML_TABLE]: {
      codex: {
        fixture: FIXTURE_TOML_SCHEMA,
        adapter: input.adapterVersion,
        codexVersion: input.codexVersion,
        layer: input.layer,
        sessionId: input.sessionId,
        hookId: input.hookId,
        hookRepresentation: input.hookRepresentation,
        managed: true,
      },
    },
  }
}

export function mergeOwnedToml(
  base: Record<string, unknown>,
  fragment: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...fragment }
}

export function stripOwnedToml(document: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...document }
  delete next[OWNED_TOML_TABLE]
  return next
}

export function readOwnedToml(document: Record<string, unknown>): Record<string, unknown> | null {
  const owned = document[OWNED_TOML_TABLE]
  if (owned === null || typeof owned !== 'object' || Array.isArray(owned)) return null
  return owned as Record<string, unknown>
}

export function inlineHooksPresent(document: Record<string, unknown>): boolean {
  return Object.hasOwn(document, 'hooks')
}

export function serializeCodexToml(document: Record<string, unknown>): string {
  return `${stringify(document).trimEnd()}\n`
}
