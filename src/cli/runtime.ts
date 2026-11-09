import { createHash } from 'node:crypto'
import { open, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Flags } from '@oclif/core'
import { parse, stringify } from 'smol-toml'
import { newRequestId } from '../auth/errors.js'
import { readHostedIdentity } from '../auth/identity.js'
import { AuthMetadataStore } from '../auth/metadata.js'
import { createCredentialStore } from '../auth/runtime.js'
import {
  type ProjectConfig,
  parseProjectConfig,
  resolveConfigurationValue,
} from '../config/index.js'
import { OcboxError } from '../errors/index.js'
import { NOT_LOGGED_IN_MESSAGE } from '../errors/messages.js'
import { LifecycleService, LifecycleStore, projectIdForPath } from '../lifecycle/index.js'
import {
  createMetadataClient,
  ProjectPageSchema,
  ProjectSchema,
  runMetadataAction,
} from '../metadata/client.js'
import { type OutputMode, OutputWriter } from '../output/index.js'
import { resolveCurrentPlatformPaths } from '../platform/index.js'
import { FakeSandboxProvider } from '../providers/fake/index.js'
import { ProviderRegistry } from '../providers/index.js'
import { DEFAULT_API_URL } from '../providers/ocbox/defaults.js'
import { createOcboxProvider } from '../providers/ocbox/factory.js'
import { requestedSpecFromConfig } from '../providers/ocbox/requested-spec.js'
import { createWarmSessionCache, warmSessionsEnabled } from '../warm/client.js'

export const DEFAULT_PROJECT_CONFIG = `schemaVersion = 1

[provider]
name = "fake"
runtimeClass = "container"
region = "local"

[sandbox]
operatingSystem = "linux"
architecture = "x86_64"
environmentName = "development"
image = { kind = "template", reference = "fake-node-24" }

[sandbox.resources]
cpuMillicores = 1000
memoryBytes = 2147483648
diskBytes = 10737418240

[network]
egress = "open"
allowedHosts = []
directInbound = "blocked"
previews = "authenticated_only"

[lifecycle]
idleTimeoutMilliseconds = 900000
maximumRuntimeMilliseconds = 7200000
autoStopAfterMilliseconds = 1800000
autoDestroyAfterMilliseconds = 10800000

[source]
kind = "none"

[env]
`

export interface RuntimeFlags {
  readonly 'api-url'?: string | undefined
  readonly project?: string | undefined
  readonly provider?: string | undefined
  readonly cpu?: number | undefined
  readonly memory?: number | undefined
  readonly image?: string | undefined
  readonly region?: string | undefined
  readonly runtime?: string | undefined
  readonly config?: string | undefined
  readonly json?: boolean | undefined
  readonly jsonl?: boolean | undefined
  readonly 'no-color'?: boolean | undefined
  readonly 'state-dir'?: string | undefined
}

export const hostedRuntimeFlags = {
  'api-url': Flags.string({ description: 'Hosted API base URL (overrides OCBOX_API_URL)' }),
  project: Flags.string({
    description: 'Hosted project ID (overrides OCBOX_PROJECT_ID and workspace)',
  }),
  cpu: Flags.integer({ min: 1, description: 'Requested CPU cores' }),
  memory: Flags.integer({ min: 1, description: 'Requested memory in bytes' }),
  image: Flags.string({ description: 'Requested hosted image reference' }),
  region: Flags.string({ description: 'Requested hosted region' }),
  runtime: Flags.string({ description: 'Requested hosted runtime' }),
}

export interface CliIo {
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
}

export function outputMode(flags: RuntimeFlags): OutputMode {
  if (flags.json === true && flags.jsonl === true) {
    throw new TypeError('--json and --jsonl cannot be used together')
  }
  return flags.json === true ? 'json' : flags.jsonl === true ? 'jsonl' : 'human'
}

export function createOutputWriter(flags: RuntimeFlags, io: CliIo): OutputWriter {
  return new OutputWriter({
    mode: outputMode(flags),
    stdout: io.stdout,
    stderr: io.stderr,
    ...(flags['no-color'] === undefined ? {} : { noColor: flags['no-color'] }),
  })
}

export function resolveConfigPath(flags: RuntimeFlags, cwd = process.cwd()): string {
  return resolve(cwd, flags.config ?? 'opencloudbox.toml')
}

export function resolveStateDirectory(
  flags: RuntimeFlags,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  // CLI flag > environment > platform default, resolved through the single
  // documented precedence helper so runtime and config resolution cannot drift.
  // The project file has no state-directory field, so that layer is absent.
  const resolved = resolveConfigurationValue({
    flag: flags['state-dir'],
    // Environment is an index signature; bracket access is required by TypeScript.
    // biome-ignore lint/complexity/useLiteralKeys: see explanation above
    environment: environment['OCBOX_STATE_DIR'],
    defaultValue: resolveCurrentPlatformPaths(environment).stateDirectory,
    parseEnvironment: (value) => value,
    environmentName: 'OCBOX_STATE_DIR',
  })
  return resolve(resolved.value)
}

export async function loadProjectConfig(flags: RuntimeFlags): Promise<ProjectConfig> {
  try {
    return parseProjectConfig(await readFile(resolveConfigPath(flags), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new OcboxError({
        code: 'CONFIG_INVALID',
        message: 'Workspace configuration was not found; run ocbox init',
        requestId: newRequestId(),
      })
    throw error
  }
}

export function createRegistry(
  stateDirectory: string,
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
  hostedOptions: Omit<
    Parameters<typeof createOcboxProvider>[0],
    'stateDirectory' | 'environment'
  > = {},
): ProviderRegistry {
  return new ProviderRegistry()
    .register(
      'fake',
      () => new FakeSandboxProvider(stateDirectory, signal === undefined ? {} : { signal }),
    )
    .register('ocbox', () => createOcboxProvider({ environment, stateDirectory, ...hostedOptions }))
}

function accountDirectory(stateDirectory: string, subject: string): string {
  const key = createHash('sha256').update(subject).digest('hex').slice(0, 32)
  return join(stateDirectory, 'accounts', key)
}

/**
 * Local session state is per account, keyed by the token's subject. The auth
 * metadata and credential stay at the shared state root so login is unchanged.
 * A server without `/auth/me`, or an offline token, keeps the legacy shared
 * directory instead of failing local commands.
 */
export async function resolveAccountStateDirectory(
  flags: RuntimeFlags,
  stateDirectory: string,
  hosted: boolean,
  signal?: AbortSignal,
): Promise<string> {
  if (!hosted) return stateDirectory
  const metadataStore = new AuthMetadataStore(join(stateDirectory, 'auth.json'))
  try {
    const metadata = await metadataStore.load(signal)
    if (metadata?.subject !== undefined) return accountDirectory(stateDirectory, metadata.subject)
    const identity = await readHostedIdentity(flags, process.env, signal)
    if (metadata !== null)
      await metadataStore.save({ ...metadata, subject: identity.subject }, signal).catch(() => {})
    return accountDirectory(stateDirectory, identity.subject)
  } catch {
    return stateDirectory
  }
}

export interface CreateLifecycleServiceOptions {
  /**
   * Opt this command into the optional warm-session daemon. The daemon only
   * serves the execution path; lifecycle mutations always read the API.
   */
  readonly warmSessions?: boolean | undefined
}

export async function createLifecycleService(
  flags: RuntimeFlags,
  signal?: AbortSignal,
  lifecycleStateDirectory?: string,
  options: CreateLifecycleServiceOptions = {},
): Promise<LifecycleService> {
  const config = await loadProjectConfig(flags)
  const stateDirectory = resolveStateDirectory(flags)
  const projectId = projectIdForPath(resolve(process.cwd()))
  const hostedProjectId = flags.project ?? process.env['OCBOX_PROJECT_ID'] ?? config.projectId
  const lifecycleStateRoot =
    lifecycleStateDirectory ??
    (await resolveAccountStateDirectory(
      flags,
      stateDirectory,
      config.provider.name === 'ocbox',
      signal,
    ))
  const sessionCache =
    options.warmSessions === true &&
    config.provider.name === 'ocbox' &&
    hostedProjectId !== undefined &&
    warmSessionsEnabled(process.env)
      ? createWarmSessionCache({
          // Environment is an index signature; bracket access is required by TypeScript.
          // biome-ignore lint/complexity/useLiteralKeys: see explanation above
          apiUrl: flags['api-url'] ?? process.env['OCBOX_API_URL'] ?? DEFAULT_API_URL,
          environment: process.env,
          projectId: hostedProjectId,
          stateDirectory,
        })
      : undefined
  return new LifecycleService({
    config,
    projectId,
    store: new LifecycleStore(lifecycleStateRoot, projectId),
    registry: createRegistry(stateDirectory, signal, process.env, {
      apiUrl: flags['api-url'],
      projectId: hostedProjectId,
      requestedSpec: {
        ...requestedSpecFromConfig(await readFile(resolveConfigPath(flags), 'utf8')),
        ...Object.fromEntries(
          ['cpu', 'memory', 'image', 'region', 'runtime'].flatMap((key) => {
            const value = flags[key as keyof RuntimeFlags]
            return value === undefined ? [] : [[key, value]]
          }),
        ),
      },
      ...(sessionCache === undefined ? {} : { sessionCache }),
    }),
    ...(signal === undefined ? {} : { signal }),
  })
}

/** Project onboarding outcome used to explain exactly what `init` did. */
export interface ProjectInitialization {
  readonly status: 'created' | 'validated'
  readonly provider: string
  readonly projectId?: string | undefined
  readonly projectName?: string | undefined
  readonly projectCreated?: boolean | undefined
  /** True when an existing hosted project was found by its workspace name. */
  readonly projectMatchedByName?: boolean | undefined
}

/** Creates the starter config exclusively, or validates and completes onboarding. */
export async function initializeProject(flags: RuntimeFlags): Promise<ProjectInitialization> {
  const path = resolveConfigPath(flags)
  let source: string
  let exists = true
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    exists = false
    source = DEFAULT_PROJECT_CONFIG
  }
  const existing = parseProjectConfig(source)
  if (flags.provider === undefined) {
    const metadata = await new AuthMetadataStore(
      join(resolveStateDirectory(flags), 'auth.json'),
    ).load()
    const loggedIn =
      metadata !== null && (await createCredentialStore().get(metadata.identity)) !== null
    if (!loggedIn) {
      throw new OcboxError({
        code: 'AUTH_REQUIRED',
        message: NOT_LOGGED_IN_MESSAGE,
        requestId: newRequestId(),
      })
    }
  }
  const provider = flags.provider ?? (exists ? existing.provider.name : 'ocbox')
  let projectId = flags.project ?? process.env['OCBOX_PROJECT_ID'] ?? existing.projectId
  let projectName: string | undefined
  let projectCreated = false
  let projectMatchedByName = false
  if (provider === 'ocbox' && !projectId) {
    const api = createMetadataClient(flags)
    const name = basename(process.cwd())
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const result = await runMetadataAction(api, 'project.list', { cursor })
      const page = ProjectPageSchema.parse(result.resource)
      const match = page.data.find((project) => project.name === name)
      projectId = match?.id
      projectName = match?.name
      projectMatchedByName = match !== undefined
      cursor = page.nextCursor ?? undefined
      if (cursor && seen.has(cursor)) throw new Error('Hosted project pagination repeated a cursor')
      if (cursor) seen.add(cursor)
    } while (!projectId && cursor)
    if (!projectId) {
      const result = await runMetadataAction(api, 'project.create', { name })
      const created = ProjectSchema.parse(result.resource)
      projectId = created.id
      projectName = created.name
      projectCreated = true
    }
  }
  if (provider === 'ocbox' && projectId !== undefined && !projectCreated && !projectMatchedByName) {
    // A saved project can belong to a different signed-in account; validating
    // only the local file would report success and let `start` fail later.
    try {
      await runMetadataAction(createMetadataClient(flags), 'project.get', { projectId })
    } catch (error) {
      if (error instanceof OcboxError && error.code === 'PROJECT_NOT_FOUND') {
        throw new OcboxError({
          code: 'PROJECT_NOT_FOUND',
          message:
            'The configured hosted project is not visible to the signed-in account. ' +
            'Remove or replace projectId in opencloudbox.toml (or pass --project with a ' +
            'project this account can see), then rerun ocbox init.',
          requestId: error.requestId,
        })
      }
      throw error
    }
  }
  if (!exists && provider === 'ocbox') {
    // Omit resource/image/location overrides so the server chooses its free default.
    source = DEFAULT_PROJECT_CONFIG.replace(
      'name = "fake"\nruntimeClass = "container"\nregion = "local"',
      'name = "ocbox"',
    )
      .replace('image = { kind = "template", reference = "fake-node-24" }\n', '')
      .replace(/\[sandbox.resources\]\n[\s\S]*?\n\n/, '')
  }
  if (provider !== parseProjectConfig(source).provider.name || projectId !== existing.projectId) {
    const document = parse(source)
    ;(document['provider'] as Record<string, unknown>)['name'] = provider
    if (projectId !== undefined) document['projectId'] = projectId
    source = stringify(document)
  }
  if (
    ['cpu', 'memory', 'image', 'region', 'runtime'].some(
      (key) => flags[key as keyof RuntimeFlags] !== undefined,
    )
  ) {
    const document = parse(source)
    const providerConfig = document['provider'] as Record<string, unknown>
    const sandbox = document['sandbox'] as Record<string, unknown>
    const resources = (sandbox['resources'] ?? {}) as Record<string, unknown>
    if (flags.cpu !== undefined) resources['cpuMillicores'] = flags.cpu * 1000
    if (flags.memory !== undefined) resources['memoryBytes'] = flags.memory
    if (flags.cpu !== undefined || flags.memory !== undefined) sandbox['resources'] = resources
    if (flags.image !== undefined) sandbox['image'] = { kind: 'image', reference: flags.image }
    if (flags.region !== undefined) providerConfig['region'] = flags.region
    if (flags.runtime !== undefined) providerConfig['runtimeClass'] = flags.runtime
    source = stringify(document)
  }
  parseProjectConfig(source)
  if (exists) {
    if (source !== (await readFile(path, 'utf8'))) await writeFile(path, source, { mode: 0o600 })
    return { status: 'validated', provider }
  }
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(source, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (provider !== 'ocbox') return { status: 'created', provider }
  if (projectId === undefined)
    throw new Error('Hosted project initialization did not resolve an ID')
  return {
    status: 'created',
    provider,
    projectId,
    ...(projectName === undefined ? {} : { projectName }),
    projectCreated,
    ...(projectMatchedByName ? { projectMatchedByName } : {}),
  }
}

/** Reads the workspace project ID when a config exists; absence is not an error. */
export async function loadProjectIdIfPresent(flags: RuntimeFlags): Promise<string | undefined> {
  try {
    return parseProjectConfig(await readFile(resolveConfigPath(flags), 'utf8')).projectId
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
