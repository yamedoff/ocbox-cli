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
  if (!view.revocationAttempted) return 'Logged out; local credential material cleared'
  return view.revoked
    ? 'Logged out; hosted credential revoked and local material cleared'
    : 'Logged out; local credential material cleared (server revocation failed)'
}
