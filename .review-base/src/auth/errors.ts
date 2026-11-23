import { randomUUID } from 'node:crypto'
import { type RequestId, RequestIdSchema } from '../domain/ids.js'
import { OcboxError } from '../errors/index.js'

export function newRequestId(): RequestId {
  return RequestIdSchema.parse(randomUUID())
}

/** Typed "the user must run `ocbox auth login` again" failure. */
export class LoginRequiredError extends OcboxError {
  constructor(
    requestId: RequestId = newRequestId(),
    message = 'Authentication is required; run `ocbox auth login`',
  ) {
    super({ code: 'AUTH_REQUIRED', message, requestId })
    this.name = 'LoginRequiredError'
  }
}

/** AUDIENCE/scope binding failure: a credential exists but is not usable here. */
export class AuthBindingError extends OcboxError {
  constructor(
    requestId: RequestId = newRequestId(),
    message = 'The stored credential is not valid for this client, audience, or scope',
  ) {
    super({ code: 'AUTH_FORBIDDEN', message, requestId })
    this.name = 'AuthBindingError'
  }
}

export function isLoginRequired(error: unknown): boolean {
  return error instanceof OcboxError && error.code === 'AUTH_REQUIRED'
}
