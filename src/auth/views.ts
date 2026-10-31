import type { AuthLoginView, AuthLogoutView, AuthStatusView } from './service.js'

function scopesOf(view: AuthStatusView): string {
  return view.scopes.length === 0 ? 'none' : view.scopes.join(' ')
}

/** Compact human summary; structured output retains the full view. */
export function authStatusLine(view: AuthStatusView): string {
  if (!view.loggedIn) {
    return view.expired ? 'Not logged in (stored credential has expired)' : 'Not logged in'
  }
  return `Logged in issuer=${view.issuer} audience=${view.audience} scopes=${scopesOf(view)} expires=${view.expiresAt ?? 'unknown'}`
}

export function authLoginLine(view: AuthLoginView): string {
  const opened = view.browserOpened ? 'browser opened' : 'manual authorization URL printed'
  return `${authStatusLine(view)} (${opened})`
}

export function authLogoutLine(view: AuthLogoutView): string {
  if (!view.revocationAttempted) {
    const reasons = {
      no_local_credential: 'there was no local credential',
      metadata_missing: 'login metadata was missing',
      metadata_unreadable: 'login metadata could not be read',
      credential_unreadable: 'the local credential could not be read',
      identity_mismatch: 'login metadata did not match the active identity',
      endpoint_invalid: 'the stored sign-in address could not be validated',
      revoked: 'revocation was completed',
      remote_failed: 'remote revocation failed',
    }
    return `Logged out; local credential material cleared. Revocation skipped because ${reasons[view.revocationReason]}. Reason ${view.revocationReason}. Run ocbox auth login to sign in again.`
  }
  return view.revoked
    ? 'Logged out; hosted credential revoked and local material cleared'
    : 'Logged out; local credential material cleared. Reason remote_failed: server revocation failed; the remote session may remain active until expiry. Retry sign-in only when needed.'
}
