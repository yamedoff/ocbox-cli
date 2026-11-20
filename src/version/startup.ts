import { apiUrlFromArgv, checkCliVersionGate } from './gate.js'

const INFORMATIONAL_FLAGS = new Set(['--help', '-h', '--version', '-v'])

/** Help and version never contact the API; a bare invocation prints help. */
export function isInformationalInvocation(argv: readonly string[]): boolean {
  const commandTokens: string[] = []
  for (const token of argv) {
    if (token === '--') break
    commandTokens.push(token)
  }
  return (
    commandTokens.length === 0 ||
    commandTokens[0] === 'help' ||
    commandTokens.some((token) => INFORMATIONAL_FLAGS.has(token))
  )
}

/**
 * Runs the version gate once per real invocation. The notice goes to stderr so
 * a structured stdout envelope stays parseable; failures never block startup.
 */
export async function runStartupVersionGate(argv: readonly string[]): Promise<void> {
  if (isInformationalInvocation(argv)) return
  // Offline test harnesses opt out explicitly; a loopback API is a real
  // deployment and still gets the gate.
  if (process.env['OCBOX_DISABLE_VERSION_GATE'] === '1') return
  try {
    const gate = await checkCliVersionGate({ apiUrl: apiUrlFromArgv(argv) })
    if (gate.status === 'outdated' && gate.message !== undefined) {
      process.stderr.write(`${gate.message}\n`)
    }
  } catch {
    /* A version check must never prevent a command from running. */
  }
}
