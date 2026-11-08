/**
 * Shared human guidance for mistakes every command can make. Keeping one copy
 * makes `init`, `use`, `status`, `stop`, and `exec` answer the same way.
 */
export const INVALID_SESSION_ID_MESSAGE =
  'Session ID must be a UUID or ULID; run `ocbox ls` to copy one.'

export const NOT_LOGGED_IN_MESSAGE =
  'Not logged in. Run `ocbox auth login`, or pass --provider fake to use the local test harness (nothing runs remotely).'

export const FAKE_PROVIDER_NOTICE = 'Using the local fake provider; nothing runs remotely.'
