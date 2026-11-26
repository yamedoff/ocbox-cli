import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTracer,
  installHttpTrace,
  pathWithoutIds,
  traceRequested,
  type TraceSink,
} from '../../src/cli/trace.js'

function memorySink(): TraceSink & { text(): string } {
  const chunks: string[] = []
  return {
    text: () => chunks.join(''),
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('OCBOX_TRACE gate', () => {
  it('is off for every value except the documented opt-in', () => {
    expect(traceRequested({})).toBe(false)
    expect(traceRequested({ OCBOX_TRACE: '0' })).toBe(false)
    expect(traceRequested({ OCBOX_TRACE: 'true' })).toBe(false)
    expect(traceRequested({ OCBOX_TRACE: '1' })).toBe(true)
  })

  it('writes nothing when disabled', () => {
    const sink = memorySink()
    const tracer = createTracer({ enabled: false, stderr: sink, now: () => 10 })

    tracer.phase('entry')
    tracer.phase('command', { durationMs: 5 })
    tracer.http('GET', 'https://api.example/v1/sessions/ses_abc123', 200, 3)
    tracer.countHttpRequest()

    expect(sink.text()).toBe('')
    expect(tracer.httpRequestCount).toBe(0)
  })

  it('leaves global fetch untouched when disabled', () => {
    const original = globalThis.fetch
    const dispose = installHttpTrace(createTracer({ enabled: false, stderr: memorySink() }))

    expect(globalThis.fetch).toBe(original)
    dispose()
    expect(globalThis.fetch).toBe(original)
  })
})

describe('phase lines', () => {
  it('prints one line per phase with elapsed milliseconds since process start', () => {
    const sink = memorySink()
    let now = 12.6
    const tracer = createTracer({ enabled: true, stderr: sink, now: () => now })

    tracer.phase('entry')
    now = 180.2
    tracer.phase('module-load', { durationMs: 167.6 })
    now = 190
    tracer.phase('config')
    now = 250
    tracer.phase('credentials')
    now = 260
    tracer.phase('token-refresh', { network: 'no' })
    now = 300
    tracer.phase('command', { durationMs: 40 })

    expect(sink.text().trimEnd().split('\n')).toEqual([
      'ocbox-trace phase=entry elapsed_ms=13',
      'ocbox-trace phase=module-load elapsed_ms=180 duration_ms=168',
      'ocbox-trace phase=config elapsed_ms=190',
      'ocbox-trace phase=credentials elapsed_ms=250',
      'ocbox-trace phase=token-refresh elapsed_ms=260 network=no',
      'ocbox-trace phase=command elapsed_ms=300 duration_ms=40',
    ])
  })

  it('names the HTTP method, id-free path, status and duration', () => {
    const sink = memorySink()
    const tracer = createTracer({ enabled: true, stderr: sink, now: () => 500 })

    tracer.http(
      'get',
      'https://api.staging.opencloudbox.dev/v1/projects/6f1c9f7e-2b4a-4c1d-9e8f-0123456789ab/sessions?cursor=next',
      200,
      42.4,
    )

    expect(sink.text()).toBe(
      'ocbox-trace phase=http elapsed_ms=500 duration_ms=42 method=GET ' +
        'path=/v1/projects/:id/sessions status=200\n',
    )
    expect(sink.text()).not.toContain('6f1c9f7e')
    expect(sink.text()).not.toContain('cursor')
    expect(sink.text()).not.toContain('staging.opencloudbox.dev')
  })

  it('keeps static API path words readable', () => {
    expect(pathWithoutIds('/v1/sizes')).toBe('/v1/sizes')
    expect(pathWithoutIds('/v1/gpu-check')).toBe('/v1/gpu-check')
    expect(pathWithoutIds('/v1/sessions/ses_abc123/snapshots/42/restore')).toBe(
      '/v1/sessions/:id/snapshots/:id/restore',
    )
  })

  it('never prints a token or an identifier from a request', () => {
    const sink = memorySink()
    const tracer = createTracer({ enabled: true, stderr: sink, now: () => 1 })
    const token = 'sk-live-abcdefghijklmnop'

    tracer.http(
      'POST',
      `https://api.example/v1/sessions/ses_${token}/snapshots?access_token=${token}`,
      201,
      1,
    )
    tracer.phase('token-refresh', { network: 'no' })

    expect(sink.text()).not.toContain(token)
    expect(sink.text()).not.toContain('access_token')
    expect(sink.text()).not.toContain('ses_')
    expect(sink.text()).toContain('path=/v1/sessions/:id/snapshots')
  })

  it('traces and counts each global fetch attempt', async () => {
    const sink = memorySink()
    const tracer = createTracer({ enabled: true, stderr: sink, now: () => 25 })
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
    const dispose = installHttpTrace(tracer)

    try {
      await globalThis.fetch('https://api.example/v1/meta')
      expect(tracer.httpRequestCount).toBe(1)
      expect(sink.text()).toMatch(
        /^ocbox-trace phase=http elapsed_ms=25 duration_ms=\d+ method=GET path=\/v1\/meta status=200\n$/,
      )
    } finally {
      dispose()
      globalThis.fetch = original
    }
  })
})

describe('runtime integration', () => {
  async function withConfigFile<Result>(
    action: (path: string) => Promise<Result>,
  ): Promise<Result> {
    const directory = await mkdtemp(join(tmpdir(), 'ocbox-trace-test-'))
    try {
      const path = join(directory, 'opencloudbox.toml')
      const runtime = await import('../../src/cli/runtime.js')
      await writeFile(path, runtime.DEFAULT_PROJECT_CONFIG, 'utf8')
      return await action(path)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  it('stays silent through the real config load when OCBOX_TRACE is unset', async () => {
    vi.resetModules()
    vi.stubEnv('OCBOX_TRACE', '')
    const chunks: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk))
      return true
    })

    await withConfigFile(async (path) => {
      const runtime = await import('../../src/cli/runtime.js')
      await runtime.loadProjectConfig({ config: path })
    })

    expect(chunks.join('')).toBe('')
  })

  it('prints a config phase through the real config load when enabled', async () => {
    vi.resetModules()
    vi.stubEnv('OCBOX_TRACE', '1')
    const chunks: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk))
      return true
    })

    await withConfigFile(async (path) => {
      const runtime = await import('../../src/cli/runtime.js')
      await runtime.loadProjectConfig({ config: path })
    })

    expect(chunks.join('')).toMatch(/^ocbox-trace phase=config elapsed_ms=\d+ duration_ms=\d+\n$/)
  })
})
