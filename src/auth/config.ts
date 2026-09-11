/** Registered public CLI OAuth client and the fixed loopback callback shape. */
export const DEFAULT_CLIENT_ID = 'ocb_cli'
export const DEFAULT_AUDIENCE = 'cli' as const
export const DEFAULT_SCOPES = ['source:read'] as const
export const LOOPBACK_HOST = '127.0.0.1'
export const LOOPBACK_PATH = '/callback'

/** Non-secret credential-reference account slot for the single active CLI identity. */
export const CLI_CREDENTIAL_PROVIDER = 'ocbox'
export const CLI_CREDENTIAL_ACCOUNT_ID = 'default'

export const DEFAULT_EXPIRY_SKEW_MILLISECONDS = 30_000
export const DEFAULT_LOGIN_TIMEOUT_MILLISECONDS = 5 * 60_000
export const DEFAULT_HTTP_TIMEOUT_MILLISECONDS = 30_000

export interface AuthEndpoints {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly revocationEndpoint: string
  readonly clientId: string
  readonly audience: typeof DEFAULT_AUDIENCE
  readonly scopes: readonly string[]
}

export interface AuthEndpointOverrides {
  readonly authorizationEndpoint?: string | undefined
  readonly tokenEndpoint?: string | undefined
  readonly revocationEndpoint?: string | undefined
  readonly clientId?: string | undefined
  readonly scopes?: readonly string[] | undefined
}

/** Normalizes an issuer base URL and rejects non-http(s) or credentialed forms. */
export function normalizeIssuer(issuer: string): string {
  let parsed: URL
  try {
    parsed = new URL(issuer.trim())
  } catch {
    throw new TypeError('The hosted API URL must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('The hosted API URL must use http or https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('The hosted API URL must not embed credentials')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('The hosted API URL must not include a query or fragment')
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${path}`
}

function joinEndpoint(issuer: string, path: string): string {
  return `${issuer}/${path.replace(/^\/+/, '')}`
}

/** Derives the documented protocol endpoints from a single hosted API base URL. */
export function authEndpointsFromIssuer(
  issuer: string,
  overrides: AuthEndpointOverrides = {},
): AuthEndpoints {
  const normalized = normalizeIssuer(issuer)
  return {
    audience: DEFAULT_AUDIENCE,
    authorizationEndpoint:
      overrides.authorizationEndpoint ?? joinEndpoint(normalized, 'auth/cli/authorize'),
    clientId: overrides.clientId ?? DEFAULT_CLIENT_ID,
    issuer: normalized,
    revocationEndpoint: overrides.revocationEndpoint ?? joinEndpoint(normalized, 'auth/revoke'),
    scopes: overrides.scopes ?? [...DEFAULT_SCOPES],
    tokenEndpoint: overrides.tokenEndpoint ?? joinEndpoint(normalized, 'auth/cli/token'),
  }
}

export interface AuthorizationUrlInput {
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
}

/**
 * Builds the browser authorization URL with a fixed parameter order so the
 * value is deterministic and testable. It carries no code, verifier, or token.
 */
export function buildAuthorizationUrl(
  endpoints: AuthEndpoints,
  input: AuthorizationUrlInput,
): string {
  const query = new URLSearchParams()
  query.set('response_type', 'code')
  query.set('client_id', endpoints.clientId)
  query.set('redirect_uri', input.redirectUri)
  query.set('scope', endpoints.scopes.join(' '))
  query.set('audience', endpoints.audience)
  query.set('state', input.state)
  query.set('code_challenge', input.codeChallenge)
  query.set('code_challenge_method', 'S256')
  const separator = endpoints.authorizationEndpoint.includes('?') ? '&' : '?'
  return `${endpoints.authorizationEndpoint}${separator}${query.toString()}`
}
