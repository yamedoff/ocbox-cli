import { z } from 'zod'
import { CodexAdapterError } from './errors.js'
import { CODEX_HOOK_EVENTS, CODEX_HOOK_REPRESENTATIONS } from './hooks.js'

export const PINNED_CODEX_VERSION = '0.153.4' as const

export const SUPPORTED_CODEX_VERSIONS: readonly string[] = [PINNED_CODEX_VERSION]

export const CODEX_VERSION_EVIDENCE = {
  versionCommand: 'codex --version',
  versionOutput: 'codex-cli 0.153.4',
  doctorCodexVersion: '0.153.4',
  schemaProof: 'hooks-table HookEventsToml (12 events), one representation per layer',
} as const

export const LIVE_E2E_BLOCKER =
  'Live Codex E2E (setup, remote shell task, sync, drift detection, remove/restore) has not been run against the pinned version; the hook/config schema is unverified locally, so live setup stays fail-closed until the schema is proven on a host with the pinned Codex.'

export type CodexVersionStatus = 'supported' | 'unsupported' | 'unparsable'

export type CodexReleaseChannel = 'shell' | 'desktop' | 'unknown'

export interface CodexVersionCheck {
  readonly detected: string | null
  readonly status: CodexVersionStatus
  readonly remediation: string | null
  readonly channel: CodexReleaseChannel
  readonly prerelease: string | null
}

export const CodexVersionSchema = z.strictObject({
  raw: z.string().min(1).max(200),
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  prerelease: z.string().min(1).max(64).nullable(),
})

export type CodexVersion = z.infer<typeof CodexVersionSchema>

export interface CodexSchemaDescriptor {
  readonly revision: string
  readonly codexVersion: string
  readonly events: readonly string[]
  readonly representations: readonly string[]
}

interface PinnedCodexRelease {
  readonly codexVersion: string
  readonly revision: string
}

export const PINNED_CODEX_RELEASES: readonly PinnedCodexRelease[] = [
  { codexVersion: PINNED_CODEX_VERSION, revision: 'codex-cli-0.153' },
]

const VERSION_PATTERN =
  /^(?:codex(?:-cli|-desktop)?\s+)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/
const LOOSE_VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/

function channelFor(raw: string): CodexReleaseChannel {
  if (/desktop/i.test(raw)) return 'desktop'
  if (/^\s*(codex-cli\b|codex\b|\d+\.\d+\.\d+)/i.test(raw)) return 'shell'
  return 'unknown'
}

function prereleaseFor(raw: string): string | null {
  const match = VERSION_PATTERN.exec(raw.trim())
  if (match === null) return null
  return match[4] ?? null
}

export function parseCodexVersionText(text: string): string | null {
  const anchored = VERSION_PATTERN.exec(text.trim())
  if (anchored !== null) return `${anchored[1]}.${anchored[2]}.${anchored[3]}`
  const loose = LOOSE_VERSION_PATTERN.exec(text)
  if (loose === null) return null
  return `${loose[1]}.${loose[2]}.${loose[3]}`
}

export function parseCodexVersion(raw: string): CodexVersion {
  const match = VERSION_PATTERN.exec(raw.trim())
  if (match === null) {
    throw new CodexAdapterError({
      code: 'CODEX_VERSION_UNSUPPORTED',
      message: 'Could not parse the installed Codex CLI version',
      remediation:
        'Confirm `codex --version` prints `codex-cli <semver>` and reinstall the pinned release if not.',
    })
  }
  return CodexVersionSchema.parse({
    raw: raw.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  })
}

export function formatCodexVersion(version: CodexVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`
  return version.prerelease === null ? core : `${core}-${version.prerelease}`
}

function desktopRemediation(raw: string): string {
  return (
    `Detected Codex Desktop pre-release (${raw.trim()}); this adapter pins the shell ` +
    `Codex CLI ${PINNED_CODEX_VERSION} (` +
    `\`codex --version\` must print \`codex-cli ${PINNED_CODEX_VERSION}\`). The Desktop pre-release ` +
    `schema is not certified, so setup is refused rather than guessing the hook schema. ` +
    `Install the pinned shell release or wait for an adapter update that certifies the Desktop schema.`
  )
}

export function checkCodexVersion(versionText: string): CodexVersionCheck {
  const raw = versionText.trim()
  const channel = channelFor(versionText)
  const anchored = VERSION_PATTERN.exec(raw)
  if (anchored === null) {
    const loose = parseCodexVersionText(versionText)
    if (loose === null) {
      return {
        detected: null,
        status: 'unparsable',
        remediation:
          `Could not parse a Codex version from the output of ${CODEX_VERSION_EVIDENCE.versionCommand}; ` +
          `reinstall the pinned shell Codex CLI ${PINNED_CODEX_VERSION} and retry. Setup is refused rather than guessing the hook schema.`,
        channel,
        prerelease: null,
      }
    }
    return {
      detected: loose,
      status: 'unsupported',
      remediation:
        `Detected Codex ${loose} but this adapter pins shell codex-cli ${PINNED_CODEX_VERSION}; ` +
        `install the pinned version or wait for an adapter update. Setup is refused rather than guessing the hook schema.`,
      channel,
      prerelease: prereleaseFor(versionText),
    }
  }
  const base = `${anchored[1]}.${anchored[2]}.${anchored[3]}`
  const prerelease = (anchored[4] ?? null) as string | null
  if (channel === 'desktop' || /desktop/i.test(prerelease ?? '')) {
    return {
      detected: base,
      status: 'unsupported',
      remediation: desktopRemediation(versionText),
      channel: 'desktop',
      prerelease,
    }
  }
  if (prerelease !== null) {
    return {
      detected: base,
      status: 'unsupported',
      remediation:
        `Detected Codex pre-release ${base}-${prerelease} but this adapter pins shell codex-cli ${PINNED_CODEX_VERSION}; ` +
        `pre-release hook schemas are not certified (including Desktop pre-releases). Install the pinned shell release or wait for an adapter update. ` +
        `Setup is refused rather than guessing the hook schema.`,
      channel,
      prerelease,
    }
  }
  if (!SUPPORTED_CODEX_VERSIONS.includes(base)) {
    return {
      detected: base,
      status: 'unsupported',
      remediation:
        `Detected Codex ${base} but this adapter pins ${PINNED_CODEX_VERSION}; ` +
        `install the pinned version or wait for an adapter update. Setup is refused rather than guessing the hook schema.`,
      channel,
      prerelease,
    }
  }
  return {
    detected: base,
    status: 'supported',
    remediation: null,
    channel: 'shell',
    prerelease: null,
  }
}

export function assertSupportedCodexVersion(version: CodexVersion): PinnedCodexRelease {
  const supported = PINNED_CODEX_RELEASES.find(
    (release) => release.codexVersion === formatCodexVersion(version),
  )
  if (supported === undefined) {
    const raw = version.raw
    const channel = channelFor(raw)
    if (channel === 'desktop') {
      throw new CodexAdapterError({
        code: 'CODEX_VERSION_UNSUPPORTED',
        message: `Unsupported Codex Desktop pre-release ${formatCodexVersion(version)}`,
        remediation: desktopRemediation(raw),
        details: { detected: formatCodexVersion(version) },
      })
    }
    throw new CodexAdapterError({
      code: 'CODEX_VERSION_UNSUPPORTED',
      message: `Unsupported Codex CLI version ${formatCodexVersion(version)}`,
      remediation: `Install the pinned Codex CLI ${PINNED_CODEX_VERSION} (npm install -g @openai/codex@${PINNED_CODEX_VERSION}) or wait for an adapter release that certifies this version.`,
      details: { detected: formatCodexVersion(version) },
    })
  }
  return supported
}

export function codexSchemaDescriptor(release: PinnedCodexRelease): CodexSchemaDescriptor {
  return {
    revision: release.revision,
    codexVersion: release.codexVersion,
    events: [...CODEX_HOOK_EVENTS],
    representations: [...CODEX_HOOK_REPRESENTATIONS],
  }
}
