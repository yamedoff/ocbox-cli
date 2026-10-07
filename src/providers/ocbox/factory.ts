import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createOcboxApiClient } from '../../api/client/index.js'
import { AuthBindingError, newRequestId } from '../../auth/errors.js'
import { AuthMetadataStore } from '../../auth/metadata.js'
import {
  createCredentialStore,
  createHostedTokenManager,
  resolveAuthEndpoints,
  resolveAuthStateDirectory,
} from '../../auth/runtime.js'
import { createSessionGate } from '../../auth/session-gate.js'
import { OcboxError } from '../../errors/index.js'
import { FileOperationCheckpointStore } from './checkpoints.js'
import { OcboxSandboxProvider } from './provider.js'
import type { HostedRequestedSpec } from './requested-spec.js'

/**
 * Builds the hosted provider from the protected T3/T15 credential path.
 * Bearer material is read and rotated only through the credential store
 * behind the cross-process refresh gate; nothing here accepts a static
 * token, a URL-embedded secret, or a caller-supplied credential.
 */
export function createOcboxProvider(options: {
  stateDirectory: string
  environment?: NodeJS.ProcessEnv
  apiUrl?: string | undefined
  projectId?: string | undefined
  requestedSpec?: HostedRequestedSpec | undefined
}): OcboxSandboxProvider {
  const environment = options.environment ?? process.env
  const hostedProjectId = options.projectId ?? environment['OCBOX_PROJECT_ID']
  if (!hostedProjectId?.trim())
    throw new OcboxError({
      code: 'CONFIG_INVALID',
      message: 'No hosted project selected; run ocbox init or pass --project',
      requestId: newRequestId(),
    })
  const protocol = resolveAuthEndpoints({ 'api-url': options.apiUrl }, environment)
  const stateDirectory = resolveAuthStateDirectory({ stateDirectory: options.stateDirectory })
  const credentialStore = createCredentialStore(environment)
  const tokens = createHostedTokenManager({
    credentialStore,
    endpoints: protocol,
    stateDirectory,
  })
  const metadataStore = new AuthMetadataStore(join(stateDirectory, 'auth.json'))
  const authGate = createSessionGate(stateDirectory)
  let pinnedScope: string | undefined
  const readScope = async () => {
    const metadata = await metadataStore.load()
    if (metadata === null || metadata.issuer !== protocol.issuer) throw new AuthBindingError()
    // Opaque CLI tokens have no subject endpoint in the pinned contract. The
    // login generation is a conservative account boundary: refresh preserves
    // it, while every login (including the same account) establishes a new one.
    const scope = createHash('sha256')
      .update(
        JSON.stringify([
          protocol.issuer,
          metadata.identity,
          metadata.updatedAt,
          metadata.expiresAt,
          hostedProjectId,
        ]),
      )
      .digest('hex')
    if (pinnedScope !== undefined && scope !== pinnedScope) {
      throw new AuthBindingError(
        undefined,
        'The hosted login changed during this operation; rerun the command',
      )
    }
    pinnedScope = scope
    return scope
  }
  const api = createOcboxApiClient({
    protocol,
    tokens,
    // Keep login/logout from changing the account between the mapping check
    // and dispatch. Credential refresh happens before this transport gate.
    fetch: (input, init) =>
      authGate(async () => {
        await readScope()
        return fetch(input, init)
      }, init?.signal ?? undefined),
  })
  // The CLI lifecycle path is restartable: persist a checkpoint per hosted
  // Operation under the resolved state directory and explicitly claim
  // durability so a restarted process resumes instead of re-polling.
  return new OcboxSandboxProvider({
    api,
    mappingScope: async () => {
      await tokens.getValidCredential()
      return authGate(readScope)
    },
    checkpointDurability: 'durable',
    checkpointStore: new FileOperationCheckpointStore(stateDirectory),
    hostedProjectId,
    requestedSpec: options.requestedSpec,
  })
}
