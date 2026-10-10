import { open, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Flags } from '@oclif/core'
import { parse, stringify } from 'smol-toml'
import { newRequestId } from '../auth/errors.js'
import { AuthMetadataStore } from '../auth/metadata.js'
import { createCredentialStore } from '../auth/runtime.js'
import {
  type ProjectConfig,
  parseProjectConfig,
  resolveConfigurationValue,
} from '../config/index.js'
import { OcboxError } from '../errors/index.js'
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
import { createOcboxProvider } from '../providers/ocbox/factory.js'
import { requestedSpecFromConfig } from '../providers/ocbox/requested-spec.js'

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

export async function createLifecycleService(
  flags: RuntimeFlags,
  signal?: AbortSignal,
): Promise<LifecycleService> {
  const config = await loadProjectConfig(flags)
  const stateDirectory = resolveStateDirectory(flags)
  const projectId = projectIdForPath(resolve(process.cwd()))
  return new LifecycleService({
    config,
    projectId,
    store: new LifecycleStore(stateDirectory, projectId),
    registry: createRegistry(stateDirectory, signal, process.env, {
      apiUrl: flags['api-url'],
      projectId: flags.project ?? process.env['OCBOX_PROJECT_ID'] ?? config.projectId,
      requestedSpec: {
        ...requestedSpecFromConfig(await readFile(resolveConfigPath(flags), 'utf8')),
        ...Object.fromEntries(
          ['cpu', 'memory', 'image', 'region', 'runtime'].flatMap((key) => {
            const value = flags[key as keyof RuntimeFlags]
            return value === undefined ? [] : [[key, value]]
          }),
        ),
      },
    }),
    ...(signal === undefined ? {} : { signal }),
  })
}

/** Creates the starter config exclusively, or validates and completes onboarding. */
export async function initializeProject(flags: RuntimeFlags): Promise<'created' | 'validated'> {
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
  let loggedIn = false
  if (!exists && flags.provider === undefined) {
    const metadata = await new AuthMetadataStore(
      join(resolveStateDirectory(flags), 'auth.json'),
    ).load()
    loggedIn = metadata !== null && (await createCredentialStore().get(metadata.identity)) !== null
  }
  const provider = flags.provider ?? (exists ? existing.provider.name : loggedIn ? 'ocbox' : 'fake')
  let projectId = flags.project ?? process.env['OCBOX_PROJECT_ID'] ?? existing.projectId
  if (provider === 'ocbox' && !projectId) {
    const api = createMetadataClient(flags)
    const name = basename(process.cwd())
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const result = await runMetadataAction(api, 'project.list', { cursor })
      const page = ProjectPageSchema.parse(result.resource)
      projectId = page.data.find((project) => project.name === name)?.id
      cursor = page.nextCursor ?? undefined
      if (cursor && seen.has(cursor)) throw new Error('Hosted project pagination repeated a cursor')
      if (cursor) seen.add(cursor)
    } while (!projectId && cursor)
    if (!projectId) {
      const result = await runMetadataAction(api, 'project.create', { name })
      projectId = ProjectSchema.parse(result.resource).id
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
    return 'validated'
  }
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(source, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return 'created'
}
