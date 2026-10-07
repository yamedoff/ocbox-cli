import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthMetadataStore } from '../../src/auth/metadata.js'
import {
  createCredentialStore,
  defaultCredentialKey,
  resolveAuthEndpoints,
} from '../../src/auth/runtime.js'
import { createLifecycleService, initializeProject } from '../../src/cli/runtime.js'
import { parseProjectConfig } from '../../src/config/index.js'
import { UtcTimestampSchema } from '../../src/domain/timestamps.js'
import { DEFAULT_API_URL } from '../../src/providers/ocbox/defaults.js'
import { createOcboxProvider } from '../../src/providers/ocbox/factory.js'
import { hostedOperationFixture, hostedSessionFixture, jsonResponse } from '../providers/doubles.js'

let directory: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('uses the default API for init and start, saves the project, and honors project precedence', async () => {
  directory = await mkdtemp(join(tmpdir(), 'ocbox-hosted-runtime-'))
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  for (const name of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
  ])
    vi.stubEnv(name, directory)
  vi.stubEnv('OCBOX_API_URL', undefined)
  vi.stubEnv('OCBOX_PROJECT_ID', undefined)
  const flags = { 'state-dir': join(directory, 'state') }
  const endpoints = resolveAuthEndpoints({}, {})
  const key = defaultCredentialKey()
  const credential = {
    accessToken: 'fixture-access-'.padEnd(48, 'a'),
    refreshToken: 'fixture-refresh-'.padEnd(48, 'r'),
    expiresAt: UtcTimestampSchema.parse(new Date(Date.now() + 3600000).toISOString()),
    scopes: [...endpoints.scopes],
    tokenType: 'Bearer' as const,
  }
  await createCredentialStore().set(key, credential)
  await new AuthMetadataStore(join(flags['state-dir'], 'auth.json')).save({
    schemaVersion: 1,
    issuer: endpoints.issuer,
    clientId: endpoints.clientId,
    audience: 'cli',
    scopes: credential.scopes,
    expiresAt: credential.expiresAt,
    identity: key,
    updatedAt: UtcTimestampSchema.parse(new Date().toISOString()),
  })
  const calls: { path: string; body: unknown }[] = []
  let selected = 'project_saved'
  const timestamp = new Date().toISOString()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe(DEFAULT_API_URL)
      calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.pathname === '/v1/projects') {
        if (init?.method === 'POST')
          return jsonResponse(
            { id: selected, name: 'mock', createdAt: timestamp, updatedAt: timestamp },
            201,
          )
        return jsonResponse({ data: [], nextCursor: null })
      }
      if (url.pathname.endsWith('/sessions')) {
        selected = url.pathname.split('/')[3] as string
        return jsonResponse(hostedOperationFixture({ projectId: selected }), 202)
      }
      if (url.pathname.includes('/operations/'))
        return jsonResponse(hostedOperationFixture({ projectId: selected }))
      if (url.pathname.includes('/sessions/'))
        return jsonResponse(hostedSessionFixture({ projectId: selected }))
      if (url.pathname.startsWith('/v1/projects/'))
        return jsonResponse({ id: url.pathname.split('/')[3] })
      throw new Error('Unexpected mock API route')
    }),
  )
  await initializeProject(flags)
  const config = parseProjectConfig(await readFile(join(directory, 'opencloudbox.toml'), 'utf8'))
  expect(config.provider.name).toBe('ocbox')
  expect(config.projectId).toBe('project_saved')
  await (await createLifecycleService(flags)).start(true)
  expect(calls.find((call) => call.path.endsWith('/sessions'))).toEqual({
    path: '/v1/projects/project_saved/sessions',
    body: {},
  })
  vi.stubEnv('OCBOX_PROJECT_ID', 'project_env')
  await (await createLifecycleService(flags)).start(true)
  expect(calls.find((call) => call.path === '/v1/projects/project_env/sessions')).toBeDefined()
  await (await createLifecycleService({ ...flags, project: 'project_flag', cpu: 2 })).start(true)
  expect(calls.find((call) => call.path === '/v1/projects/project_flag/sessions')).toEqual({
    path: '/v1/projects/project_flag/sessions',
    body: { requestedSpec: { cpu: '2' } },
  })
  await initializeProject({
    ...flags,
    project: 'project_init_flag',
    memory: 8192,
    region: 'eu-west',
  })
  const updated = parseProjectConfig(await readFile(join(directory, 'opencloudbox.toml'), 'utf8'))
  expect(updated.projectId).toBe('project_init_flag')
  expect(updated.sandbox.resources.memoryBytes).toBe(8192)
  expect(updated.provider.region).toBe('eu-west')
})

it('suggests init when a hosted project cannot be resolved', () => {
  expect(() =>
    createOcboxProvider({ stateDirectory: '/tmp/ocbox-missing', environment: {} }),
  ).toThrow('run ocbox init')
})
