export const PINNED_CODEX_VERSION = '0.153.4' as const

export const SUPPORTED_CODEX_VERSIONS: readonly string[] = [PINNED_CODEX_VERSION]

export const CODEX_VERSION_EVIDENCE = {
  versionCommand: 'codex --version',
  versionOutput: 'codex-cli 0.153.4',
  doctorCodexVersion: '0.153.4',
  schemaProof: 'unverified',
} as const

export type CodexVersionStatus = 'supported' | 'unsupported' | 'unparsable'

export interface CodexVersionCheck {
  readonly detected: string | null
  readonly status: CodexVersionStatus
  readonly remediation: string | null
}

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/

export function parseCodexVersionText(text: string): string | null {
  const match = VERSION_PATTERN.exec(text)
  if (match === null) return null
  return `${match[1]}.${match[2]}.${match[3]}`
}

export function checkCodexVersion(versionText: string): CodexVersionCheck {
  const detected = parseCodexVersionText(versionText)
  if (detected === null) {
    return {
      detected,
      status: 'unparsable',
      remediation: `Could not parse a Codex version from the output of ${CODEX_VERSION_EVIDENCE.versionCommand}; reinstall Codex and retry. Setup is refused rather than guessing the hook schema.`,
    }
  }
  if (!SUPPORTED_CODEX_VERSIONS.includes(detected)) {
    return {
      detected,
      status: 'unsupported',
      remediation: `Detected Codex ${detected} but this adapter pins ${PINNED_CODEX_VERSION}; install the pinned version or wait for an adapter update. Setup is refused rather than guessing the hook schema.`,
    }
  }
  return { detected, status: 'supported', remediation: null }
}

export const LIVE_E2E_BLOCKER =
  'Live Codex E2E (setup, remote shell task, sync, drift detection, remove/restore) has not been run against the pinned version; the hook/config schema is unverified locally, so live setup stays fail-closed until the schema is proven on a host with the pinned Codex.'
