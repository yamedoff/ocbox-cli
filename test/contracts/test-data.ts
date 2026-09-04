import type {
  BindingId,
  ExecutionId,
  IdempotencyKey,
  OperationId,
  ProjectId,
  ProviderSandboxId,
  RequestId,
  Sandbox,
  SandboxId,
  SandboxSpec,
  Session,
  SessionId,
  UtcTimestamp,
} from '../../src/contracts.js'

export const ids = {
  project: '11111111-1111-4111-8111-111111111111' as ProjectId,
  session: '22222222-2222-4222-8222-222222222222' as SessionId,
  sandbox: '33333333-3333-4333-8333-333333333333' as SandboxId,
  binding: '44444444-4444-4444-8444-444444444444' as BindingId,
  operation: '55555555-5555-4555-8555-555555555555' as OperationId,
  execution: '66666666-6666-4666-8666-666666666666' as ExecutionId,
  request: '77777777-7777-4777-8777-777777777777' as RequestId,
  providerSandbox: 'provider-sandbox-01' as ProviderSandboxId,
  idempotency: 'session-create-00000001' as IdempotencyKey,
} as const

export const timestamps = {
  created: '2026-08-31T00:00:00.000Z' as UtcTimestamp,
  observed: '2026-08-31T00:00:01.000Z' as UtcTimestamp,
  completed: '2026-08-31T00:00:02.000Z' as UtcTimestamp,
} as const

export const requestedSpec: SandboxSpec = {
  cpu: { millicores: 1_000 },
  memory: { bytes: 1_073_741_824 },
  disk: { bytes: 10_737_418_240 },
  operatingSystem: 'linux',
  architecture: 'x86_64',
  image: { kind: 'template', reference: 'node:24-bookworm' },
  region: 'us-east-1',
  network: {
    egress: 'open',
    allowedHosts: [],
    directInbound: 'blocked',
    previews: 'authenticated_only',
  },
  lifecycle: {
    idleTimeoutMilliseconds: 300_000,
    maximumRuntimeMilliseconds: 3_600_000,
    autoStopAfterMilliseconds: 600_000,
    autoDestroyAfterMilliseconds: 7_200_000,
  },
  environment: {
    name: 'development',
    variableNames: ['NODE_ENV'],
    secretReferenceIds: ['provider-secret-ref-01'],
  },
  source: {
    kind: 'git',
    repositoryUrl: 'https://github.com/example/project.git',
    revision: 'main',
    subdirectory: null,
  },
  providerClass: 'container',
}

export const effectiveSpec: SandboxSpec = {
  ...requestedSpec,
  cpu: { millicores: 2_000 },
  memory: { bytes: 2_147_483_648 },
}

export const sandbox: Sandbox = {
  id: ids.sandbox,
  projectId: ids.project,
  providerSandboxId: ids.providerSandbox,
  provider: 'fake',
  lifecycle: {
    normalizedState: 'running',
    rawState: 'RUNNING',
    desiredState: 'running',
    reason: null,
    observedAt: timestamps.observed,
    lifecycleTimestamps: {
      creationStartedAt: timestamps.created,
      runningAt: timestamps.observed,
      pauseStartedAt: null,
      pausedAt: null,
      stopStartedAt: null,
      stoppedAt: null,
      deletionStartedAt: null,
      deletedAt: null,
      errorAt: null,
      lastTransitionAt: timestamps.observed,
    },
  },
  specification: {
    requested: requestedSpec,
    effective: effectiveSpec,
    effectiveObservedAt: timestamps.observed,
  },
  createdAt: timestamps.created,
  updatedAt: timestamps.observed,
}

export const session: Session = {
  id: ids.session,
  projectId: ids.project,
  state: 'active',
  bindings: [
    {
      id: ids.binding,
      sessionId: ids.session,
      sandboxId: ids.sandbox,
      role: 'primary',
      ordinal: 0,
      boundAt: timestamps.created,
      releasedAt: null,
    },
  ],
  currentOperationId: null,
  providerVerifiedAt: timestamps.observed,
  sandboxDeletionVerifiedAt: null,
  createdAt: timestamps.created,
  updatedAt: timestamps.observed,
}
