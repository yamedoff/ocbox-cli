import { createOcboxApiClient } from '../../api/client/index.js'
import { protocolEndpointsFromIssuer } from '../../auth/config.js'
import {
  createCredentialStore,
  createHostedTokenManager,
  resolveAuthStateDirectory,
} from '../../auth/runtime.js'
import { OcboxError } from '../../errors/index.js'
import { newRequestId } from '../../auth/errors.js'
import { FileOperationCheckpointStore } from './checkpoints.js'
import { OcboxSandboxProvider } from './provider.js'

function requiredEnv(
  name: 'OCBOX_API_URL' | 'OCBOX_PROJECT_ID',
  environment: NodeJS.ProcessEnv,
): string {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OcboxError({
      code: 'CONFIG_INVALID',
      message: `Set ${name} to use the hosted ocbox provider`,
      requestId: newRequestId(),
    })
  }
  return value
}

/**
 * Builds the hosted provider from the protected T3/T15 credential path.
 * Bearer material is read and rotated only through the credential store
 * behind the cross-process refresh gate; nothing here accepts a static
 * token, a URL-embedded secret, or a caller-supplied credential.
 */
export function createOcboxProvider(options: {
  stateDirectory: string
  environment?: NodeJS.ProcessEnv
}): OcboxSandboxProvider {
  const environment = options.environment ?? process.env
  const issuer = requiredEnv('OCBOX_API_URL', environment)
  const hostedProjectId = requiredEnv('OCBOX_PROJECT_ID', environment)
  const protocol = protocolEndpointsFromIssuer(issuer)
  const stateDirectory = resolveAuthStateDirectory({ stateDirectory: options.stateDirectory })
  const credentialStore = createCredentialStore(environment)
  const tokens = createHostedTokenManager({
    credentialStore,
    endpoints: protocol,
    stateDirectory,
  })
  const api = createOcboxApiClient({ protocol, tokens })
  // The CLI lifecycle path is restartable: persist a checkpoint per hosted
  // Operation under the resolved state directory and explicitly claim
  // durability so a restarted process resumes instead of re-polling.
  return new OcboxSandboxProvider({
    api,
    checkpointDurability: 'durable',
    checkpointStore: new FileOperationCheckpointStore(stateDirectory),
    hostedProjectId,
  })
}
