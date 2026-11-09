import type { HostedSession } from './wire.js'

/**
 * Optional cache for the owned hosted Session that an execution reads. The
 * warm-session daemon implements this so later CLI commands can reuse the
 * session observation and the daemon's API connection. A provider without a
 * cache keeps reading the API directly.
 *
 * Implementations must return `null` (never throw) when the cache is absent or
 * unavailable; the provider then falls back to its direct read.
 */
export interface HostedSessionCache {
  get(hostedSessionId: string): Promise<HostedSession | null>
  remember(hostedSessionId: string, session: HostedSession): Promise<void> | void
}
