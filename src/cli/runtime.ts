import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseProjectConfig, type ProjectConfig } from '../config/index.js'
import { LifecycleService, LifecycleStore, projectIdForPath } from '../lifecycle/index.js'
import { OutputWriter, type OutputMode } from '../output/index.js'
import { resolveCurrentPlatformPaths } from '../platform/index.js'
import { FakeSandboxProvider } from '../providers/fake/index.js'
import { ProviderRegistry } from '../providers/index.js'
import { createOcboxProvider } from '../providers/ocbox/factory.js'

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
  readonly config?: string | undefined
  readonly json?: boolean | undefined
  readonly jsonl?: boolean | undefined
  readonly 'no-color'?: boolean | undefined
  readonly 'state-dir'?: string | undefined
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
  return resolve(
    flags['state-dir'] ??
      // Environment is an index signature; bracket access is required by TypeScript.
      // biome-ignore lint/complexity/useLiteralKeys: see explanation above
      environment['OCBOX_STATE_DIR'] ??
      resolveCurrentPlatformPaths(environment).stateDirectory,
  )
}

export async function loadProjectConfig(flags: RuntimeFlags): Promise<ProjectConfig> {
  return parseProjectConfig(await readFile(resolveConfigPath(flags), 'utf8'))
}

export function createRegistry(
  stateDirectory: string,
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
): ProviderRegistry {
  return new ProviderRegistry()
    .register(
      'fake',
      () => new FakeSandboxProvider(stateDirectory, signal === undefined ? {} : { signal }),
    )
    .register('ocbox', () => createOcboxProvider({ environment, stateDirectory }))
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
    registry: createRegistry(stateDirectory, signal),
    ...(signal === undefined ? {} : { signal }),
  })
}

/** Creates the starter config exclusively, or validates the existing file. */
export async function initializeProject(flags: RuntimeFlags): Promise<'created' | 'validated'> {
  const path = resolveConfigPath(flags)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'wx', 0o600)
    await handle.writeFile(DEFAULT_PROJECT_CONFIG, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    parseProjectConfig(DEFAULT_PROJECT_CONFIG)
    return 'created'
  } catch (error) {
    await handle?.close()
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null
    if (code !== 'EEXIST') throw error
    await loadProjectConfig(flags)
    return 'validated'
  }
}
