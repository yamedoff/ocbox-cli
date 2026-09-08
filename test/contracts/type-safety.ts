import type {
  OcboxErrorCode,
  ProjectId,
  ProviderSandboxId,
  SandboxId,
  SessionId,
  SessionState,
} from '../../src/contracts.js'
import { assertNever } from '../../src/contracts.js'

declare const projectId: ProjectId
declare const sessionId: SessionId
declare const sandboxId: SandboxId
declare const providerSandboxId: ProviderSandboxId

const acceptsProjectId = (_id: ProjectId): void => undefined
const acceptsSessionId = (_id: SessionId): void => undefined
const acceptsSandboxId = (_id: SandboxId): void => undefined

acceptsProjectId(projectId)
acceptsSessionId(sessionId)
acceptsSandboxId(sandboxId)

// @ts-expect-error Session IDs must never be assigned where Project IDs are required.
acceptsProjectId(sessionId)
// @ts-expect-error Sandbox IDs must never be assigned where Session IDs are required.
acceptsSessionId(sandboxId)
// @ts-expect-error Provider-native IDs must never become OpenCloudBox Sandbox IDs.
acceptsSandboxId(providerSandboxId)

export function exhaustiveSessionState(state: SessionState): string {
  switch (state) {
    case 'creating':
    case 'active':
    case 'pausing':
    case 'paused':
    case 'stopping':
    case 'stopped':
    case 'resuming':
    case 'destroying':
    case 'destroyed':
    case 'error':
      return state
    default:
      return assertNever(state)
  }
}

export function exhaustiveErrorCode(code: OcboxErrorCode): string {
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_EXPIRED':
    case 'AUTH_FORBIDDEN':
    case 'CONFIG_INVALID':
    case 'PROJECT_NOT_FOUND':
    case 'ENVIRONMENT_NOT_FOUND':
    case 'PROVIDER_AUTH':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_RATE_LIMIT':
    case 'PROVIDER_QUOTA':
    case 'PROVIDER_CAPACITY':
    case 'PROVIDER_REGION_UNAVAILABLE':
    case 'PROVIDER_TIMEOUT':
    case 'INVALID_SPEC':
    case 'CAPABILITY_UNSUPPORTED':
    case 'SANDBOX_NOT_FOUND':
    case 'SANDBOX_NOT_READY':
    case 'INVALID_STATE':
    case 'OPERATION_CONFLICT':
    case 'OPERATION_TIMEOUT':
    case 'OPERATION_CANCELLED':
    case 'SYNC_CONFLICT':
    case 'SYNC_TOO_LARGE':
    case 'SYNC_INTEGRITY':
    case 'SYNC_FAILED':
    case 'NETWORK_POLICY_DENIED':
    case 'PREVIEW_UNAVAILABLE':
    case 'PAYMENT_REQUIRED':
    case 'INSUFFICIENT_CREDITS':
    case 'USAGE_LIMIT':
    case 'BILLING_RECONCILIATION':
    case 'INTERNAL':
      return code
    default:
      return assertNever(code)
  }
}
