import { DEFAULT_API_URL } from '../providers/ocbox/defaults.js'

/**
 * Shared human guidance for mistakes every command can make. Keeping one copy
 * makes `init`, `use`, `status`, `stop`, and `exec` answer the same way.
 */
export const INVALID_SESSION_ID_MESSAGE =
  'Session ID must be a UUID or ULID; run `ocbox ls` to copy one.'

export const NOT_LOGGED_IN_MESSAGE =
  'Not logged in. Run `ocbox auth login`, or pass --provider fake to use the local test harness (nothing runs remotely).'

export const FAKE_PROVIDER_NOTICE = 'Using the local fake provider; nothing runs remotely.'

export const HOSTED_PROVIDER_NOTICE = `Using the hosted OpenCloudBox provider (staging at ${DEFAULT_API_URL}).`

/**
 * Names the provider a project was set up with. Hosted also names the API the
 * CLI talks to, marking the default staging base explicitly.
 */
export function providerNotice(provider: string, apiUrl?: string | undefined): string | undefined {
  if (provider === 'fake') return FAKE_PROVIDER_NOTICE
  if (provider !== 'ocbox') return undefined
  const resolved = apiUrl === undefined ? DEFAULT_API_URL : apiUrl
  return resolved === DEFAULT_API_URL
    ? HOSTED_PROVIDER_NOTICE
    : `Using the hosted OpenCloudBox provider (${resolved}).`
}
