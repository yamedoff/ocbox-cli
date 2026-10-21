/** Closed public sign-in reasons. Arbitrary server text is never displayed. */
export const SERVER_AUTH_REASONS = {
  auth_browser_origin_not_allowed: {
    message: 'The sign-in form came from an untrusted page.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_cross_site_start_refused: {
    message: 'This sign-in step was started from a different site.',
    nextStep:
      'Return to the authorization page opened by `ocbox auth login` and submit the sign-in form there.',
  },
  auth_browser_cross_site_request: {
    message: 'This sign-in step requires a top-level browser navigation.',
    nextStep: 'Open the sign-in link directly in the browser that started sign-in.',
  },
  auth_browser_form_field_missing: {
    message: 'A required sign-in field is missing.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_form_field_repeated: {
    message: 'A sign-in field was submitted more than once.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_form_field_empty: {
    message: 'A sign-in field is empty.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_form_field_too_large: {
    message: 'A sign-in field exceeds its accepted length.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_query_field_missing: {
    message: 'A required sign-in field is missing.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_query_field_repeated: {
    message: 'A sign-in field was submitted more than once.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_query_field_empty: {
    message: 'A sign-in field is empty.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_query_field_too_large: {
    message: 'A sign-in field exceeds its accepted length.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_optional_query_field_repeated: {
    message: 'A sign-in field was submitted more than once.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_optional_query_field_empty: {
    message: 'A sign-in field is empty.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_optional_query_field_too_large: {
    message: 'A sign-in field exceeds its accepted length.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_binding_missing: {
    message: 'This browser has no binding for the sign-in that was started.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_binding_invalid: {
    message: 'The browser binding for this sign-in is malformed.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_binding_mismatch: {
    message: 'This sign-in link belongs to a different browser.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_response_type_invalid: {
    message: 'The authorization response type is unsupported.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_client_id_invalid: {
    message: 'The authorization client identifier is malformed.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_pkce_invalid: {
    message: 'The authorization proof challenge is malformed.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_pkce_method_invalid: {
    message: 'The authorization proof method must be S256.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_audience_invalid: {
    message: 'The authorization audience is unsupported.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_scope_invalid: {
    message: 'The authorization permissions are malformed.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_scope_repeated: {
    message: 'The authorization permissions contain duplicates.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_state_invalid: {
    message: 'The authorization state is malformed.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_query_too_large: {
    message: 'The authorization query exceeds its accepted length.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_query_too_many_fields: {
    message: 'The authorization query has too many fields.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_field_unknown: {
    message: 'The authorization request contains an unsupported field.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_authorize_field_invalid: {
    message: 'An authorization field is missing, repeated, empty or too long.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_decision_too_many_fields: {
    message: 'The consent form has too many fields.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_csrf_shape_invalid: {
    message: 'The consent proof is malformed.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_decision_invalid: {
    message: 'The consent decision is unsupported.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_client_surface_invalid: {
    message: 'This application requires a different authorization page.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_scope_not_allowed: {
    message: 'The application cannot request these permissions.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_resume_invalid: {
    message: 'The pending sign-in request is expired or unavailable.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_resume_mismatch: {
    message: 'The sign-in link does not match the pending authorization.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_consent_unavailable: {
    message: 'The pending consent is unavailable or already used.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_consent_expired: {
    message: 'The pending consent has expired.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_consent_issuer_mismatch: {
    message: 'The pending consent belongs to a different authorization server.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_consent_session_mismatch: {
    message: 'The pending consent belongs to a different browser session.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_consent_csrf_invalid: {
    message: 'The consent proof does not match the pending authorization.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_email_invalid: {
    message: 'The sign-in email address is malformed.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_link_shape_invalid: {
    message: 'The sign-in link is incomplete or malformed.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_link_unavailable: {
    message: 'The sign-in link is expired, already used or unavailable.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_identity_mismatch: {
    message: 'The sign-in proof does not match the pending sign-in.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_email_delivery_failed: {
    message: 'The sign-in email could not be requested.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_email_transport_failed: {
    message: 'The sign-in email service could not be reached.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_email_proof_rejected: {
    message: 'The sign-in email proof was refused.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_email_response_invalid: {
    message: 'The sign-in email service returned an unreadable response.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_email_cleanup_failed: {
    message: 'The sign-in verification could not finish its cleanup.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_email_account_invalid: {
    message: 'The sign-in proof could not establish a verified account.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_deadline_exceeded: {
    message: 'The sign-in step did not finish within its time limit.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_cancelled: {
    message: 'The sign-in request was cancelled before completion.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_body_too_large: {
    message: 'The sign-in request body exceeds its accepted size.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_session_required: {
    message: 'The authorization step requires a signed-in browser session.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_rate_limited: {
    message: 'Too many sign-in requests were made.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_unexpected: {
    message: 'The sign-in step could not be completed.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_browser_diagnostic_unavailable: {
    message: 'The sign-in failure record is unavailable.',
    nextStep: 'Start again with `ocbox auth login` and complete sign-in in the same browser.',
  },
  auth_oauth_audience_unsupported: {
    message: 'The requested audience is not permitted for this application',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_refresh_missing: {
    message: 'The refresh request is missing its credential',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_refresh_unknown: {
    message: 'The refresh credential is unavailable',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_refresh_family_unavailable: {
    message: 'The refresh session is unavailable or revoked',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_refresh_expired: {
    message: 'The refresh credential has expired',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_refresh_client_mismatch: {
    message: 'The refresh credential belongs to a different application',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_refresh_superseded: {
    message: 'The refresh credential was already replaced',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_code_unavailable: {
    message: 'The authorization code is unavailable or already used',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_code_client_mismatch: {
    message: 'The authorization code belongs to a different application',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_code_expired: {
    message: 'The authorization code has expired',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_code_replayed_during_issue: {
    message: 'The authorization code was reused during token issuance',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_body_json_invalid: {
    message: 'The authentication body is not valid JSON',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_body_object_required: {
    message: 'The authentication body must be an object',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_body_field_invalid: {
    message: 'A required authentication field is missing or malformed',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_contract_request_invalid: {
    message: 'The authentication request does not match the supported format',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_contract_response_invalid: {
    message: 'The authentication response could not be validated',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_metadata_invalid: {
    message: 'Registration metadata must be a valid JSON object with a printable client_name',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_metadata_too_large: {
    message: 'The OAuth request metadata exceeds the accepted size',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_auth_method_unsupported: {
    message: 'The requested client authentication method is not supported',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_auth_method_mixed: {
    message: 'Use exactly the registered client authentication method',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_client_authentication_failed: {
    message: 'Client credentials are missing or invalid',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_client_unknown: {
    message: 'The client registration is unavailable',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_redirect_uri_invalid: {
    message: 'The redirect_uri must match a registered redirect URI',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_grant_type_unsupported: {
    message: 'The grant_type is not supported for this client',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_response_type_unsupported: {
    message: 'The response_type must be code',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_scope_invalid: {
    message: 'The scope parameter must be a bounded string',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_scope_unsupported: {
    message: 'The requested scope is not permitted for this client',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_rate_limited: {
    message: 'Too many OAuth requests; retry after the advertised interval',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_pkce_missing: {
    message: 'S256 PKCE challenge and code_verifier are required',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_pkce_invalid: {
    message: 'The PKCE proof is invalid',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_resource_mismatch: {
    message: 'The resource must identify this MCP endpoint',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_parameter_invalid: {
    message: 'The OAuth parameter structure is invalid',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_parameter_missing: {
    message: 'A required OAuth parameter is missing',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_parameter_repeated: {
    message: 'An OAuth parameter was sent more than once',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_parameter_empty: {
    message: 'An OAuth parameter must not be empty',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_parameter_too_large: {
    message: 'An OAuth parameter exceeds its accepted length',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_state_missing: {
    message: 'The authorization state is required',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_content_type_invalid: {
    message: 'The OAuth request Content-Type is invalid',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_grant_invalid: {
    message: 'The authorization grant is invalid, expired, or already used',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_issuer_mismatch: {
    message: 'The authorization grant issuer does not match this server',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_consent_invalid: {
    message: 'The authorization consent transaction is invalid or expired',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_csrf_invalid: {
    message: 'The consent CSRF proof is invalid',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_session_required: {
    message: 'A valid browser session is required for consent',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_access_denied: {
    message: 'The user denied this authorization request',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_method_unsupported: {
    message: 'The HTTP method is not supported for this OAuth endpoint',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
  auth_oauth_server_error: {
    message: 'The service could not process the OAuth request',
    nextStep:
      'Run `ocbox auth login` again. If it still fails, share the server reference with support.',
  },
} as const

export function serverAuthReason(value: unknown) {
  if (typeof value !== 'string' || !Object.hasOwn(SERVER_AUTH_REASONS, value)) return null
  return { reasonCode: value, ...SERVER_AUTH_REASONS[value as keyof typeof SERVER_AUTH_REASONS] }
}
