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

/**
 * Protocol endpoints derived from the pinned hosted OpenAPI contract root.
 * This is the surface the hosted data plane (T14) consumes: token issuance,
 * rotation, and revocation only. It deliberately carries no browser
 * authorization page, because the pinned contract publishes none.
 */
export interface HostedProtocolEndpoints {
  readonly issuer: string
  readonly tokenEndpoint: string
  readonly revocationEndpoint: string
  readonly clientId: string
  readonly audience: typeof DEFAULT_AUDIENCE
  readonly scopes: readonly string[]
}

/**
 * Full login endpoints: the protocol surface plus the operator-supplied
 * browser authorization page. There is no default page to derive: the pinned
 * contract defines `/auth/cli/authorize` only as an authenticated POST
 * web-consent route, so deriving a GET page from it would fabricate a URL
 * that cannot complete a browser flow.
 */
export interface AuthEndpoints extends HostedProtocolEndpoints {
  readonly authorizationEndpoint: string
}

export interface AuthEndpointOverrides {
  readonly tokenEndpoint?: string | undefined
  readonly revocationEndpoint?: string | undefined
  readonly clientId?: string | undefined
  readonly scopes?: readonly string[] | undefined
}

export interface BrowserAuthorizationEndpointOverride {
  readonly authorizationEndpoint: string
}

/** Hosts for which cleartext http is tolerated (loopback-only development setups). */
const HTTP_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

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
  if (
    parsed.protocol === 'http:' &&
    !HTTP_LOOPBACK_HOSTS.has(parsed.hostname.trim().toLowerCase())
  ) {
    // Authorization codes, PKCE verifiers, and token pairs must never cross a
    // non-loopback network hop in cleartext; loopback http stays available for
    // development and integration mocks.
    throw new TypeError('The hosted API URL must use https except on loopback hosts')
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

/**
 * Validates an operator-supplied endpoint override. Protocol endpoint overrides
 * carry codes, verifiers, and refresh material, so they must be absolute
 * uncredentialed, query/fragment-free http(s) URLs, and cleartext http stays
 * restricted to loopback hosts exactly like the issuer itself. When an
 * `expectedOrigin` is supplied the override must resolve to exactly that
 * origin; everything else fails closed instead of silently handing token
 * material to a malformed or foreign target.
 */
export function validateEndpointOverride(
  name: string,
  value: string,
  options: { readonly expectedOrigin?: string | undefined } = {},
): void {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new TypeError(`The ${name} override must be an absolute http(s) URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`The ${name} override must use http or https`)
  }
  if (
    parsed.protocol === 'http:' &&
    !HTTP_LOOPBACK_HOSTS.has(parsed.hostname.trim().toLowerCase())
  ) {
    throw new TypeError(`The ${name} override must use https except on loopback hosts`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError(`The ${name} override must not embed credentials`)
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError(`The ${name} override must not include a query or fragment`)
  }
  if (options.expectedOrigin !== undefined && parsed.origin !== options.expectedOrigin) {
    throw new TypeError(`The ${name} override must use the configured hosted API origin`)
  }
}

/**
 * The pinned hosted OpenAPI contract serves every operation under `/v1`
 * (`servers: [{url: "/v1"}]`, matching the generated client). Users naturally
 * provide the bare deployment origin, so the version segment is appended here
 * and a caller-supplied trailing `/v1` is normalized away exactly like the
 * generated client does.
 */
export const HOSTED_API_VERSION_SEGMENT = 'v1'

function versionedApiBase(normalizedIssuer: string): string {
  return `${normalizedIssuer.replace(/\/v1\/?$/, '')}/${HOSTED_API_VERSION_SEGMENT}`
}

/** Derives the documented protocol endpoints from a single hosted API base URL. */
export function protocolEndpointsFromIssuer(
  issuer: string,
  overrides: AuthEndpointOverrides = {},
): HostedProtocolEndpoints {
  const normalized = normalizeIssuer(issuer)
  const apiBase = versionedApiBase(normalized)
  const issuerOrigin = new URL(normalized).origin
  for (const [name, value] of [
    ['revocationEndpoint', overrides.revocationEndpoint],
    ['tokenEndpoint', overrides.tokenEndpoint],
  ] as const) {
    if (value === undefined) continue
    validateEndpointOverride(name, value, {
      // A browser authorization page may legitimately live on a separate web
      // origin: only public parameters (client id, redirect URI, state, PKCE
      // challenge) travel there, never a code, verifier, or token. The token
      // and revocation endpoints receive authorization codes, PKCE verifiers,
      // refresh tokens, and revoke tokens, and the pinned contract publishes
      // them only under the issuer's own `/v1` root, so a cross-origin override
      // for them has no contract evidence and must fail closed.
      ...(name === 'authorizationEndpoint' ? {} : { expectedOrigin: issuerOrigin }),
    })
  }
  return {
    audience: DEFAULT_AUDIENCE,
    clientId: overrides.clientId ?? DEFAULT_CLIENT_ID,
    issuer: normalized,
    revocationEndpoint: overrides.revocationEndpoint ?? joinEndpoint(apiBase, 'auth/revoke'),
    scopes: overrides.scopes ?? [...DEFAULT_SCOPES],
    tokenEndpoint: overrides.tokenEndpoint ?? joinEndpoint(apiBase, 'auth/cli/token'),
  }
}

/**
 * Resolves the full login endpoints. The browser authorization page is always
 * explicit: no default is derived from the contract POST route, so a missing
 * page fails closed instead of producing an unopenable URL.
 */
export function authEndpointsFromIssuer(
  issuer: string,
  overrides: AuthEndpointOverrides & BrowserAuthorizationEndpointOverride,
): AuthEndpoints {
  if (
    typeof overrides.authorizationEndpoint !== 'string' ||
    overrides.authorizationEndpoint.trim().length === 0
  ) {
    throw new TypeError(
      'A hosted browser authorization URL is required; the pinned contract publishes no default page',
    )
  }
  validateEndpointOverride('authorizationEndpoint', overrides.authorizationEndpoint)
  return {
    ...protocolEndpointsFromIssuer(issuer, overrides),
    authorizationEndpoint: overrides.authorizationEndpoint,
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
