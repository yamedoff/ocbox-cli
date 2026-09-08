import { describe, expect, it } from 'vitest'
import { OutputWriter } from '../../src/output/index.js'
import { sanitizeTelemetryPayload } from '../../src/security/index.js'

class MemoryStream {
  readonly isTTY: boolean
  value = ''

  constructor(isTTY: boolean) {
    this.isTTY = isTTY
  }

  write(chunk: string): void {
    this.value += chunk
  }
}

const FIXED_NOW = () => new Date('2026-09-04T12:00:00.000Z')

describe('OutputWriter', () => {
  it('emits a stable pretty JSON envelope', () => {
    const stdout = new MemoryStream(false)
    const writer = new OutputWriter({
      mode: 'json',
      stdout,
      stderr: new MemoryStream(false),
      now: FIXED_NOW,
    })

    writer.result('session.selected', { sessionId: 'session-safe', active: true })

    expect(stdout.value).toMatchInlineSnapshot(`
      "{
        \"data\": {
          \"active\": true,
          \"sessionId\": \"session-safe\"
        },
        \"kind\": \"result\",
        \"name\": \"session.selected\",
        \"schemaVersion\": 1,
        \"timestamp\": \"2026-09-04T12:00:00.000Z\"
      }
      "
    `)
  })

  it('emits one compact envelope per JSONL event', () => {
    const stdout = new MemoryStream(false)
    const writer = new OutputWriter({
      mode: 'jsonl',
      stdout,
      stderr: new MemoryStream(false),
      now: FIXED_NOW,
    })
    writer.event('sync.checked', { changed: false })
    expect(stdout.value.split('\n').filter(Boolean)).toHaveLength(1)
    expect(JSON.parse(stdout.value)).toEqual({
      data: { changed: false },
      kind: 'event',
      name: 'sync.checked',
      schemaVersion: 1,
      timestamp: '2026-09-04T12:00:00.000Z',
    })
  })

  it('recursively redacts credentials, command output, and local paths', () => {
    const stdout = new MemoryStream(false)
    const writer = new OutputWriter({
      mode: 'jsonl',
      stdout,
      stderr: new MemoryStream(false),
      now: FIXED_NOW,
    })
    writer.result('safe', {
      nested: {
        accessToken: 'never-visible',
        stdout: 'raw command result',
        note: 'read C:\\Users\\Ada\\project\\file.txt',
      },
      canary: 'Bearer abcdefghijklmnop',
    })

    expect(stdout.value).not.toContain('never-visible')
    expect(stdout.value).not.toContain('raw command result')
    expect(stdout.value).not.toContain('Users')
    expect(stdout.value).not.toContain('abcdefghijklmnop')
    expect(stdout.value).toContain('[REDACTED]')
    expect(stdout.value).toContain('[LOCAL_PATH]')
  })

  it('suppresses progress under redirection and all structured output', () => {
    const redirected = new MemoryStream(false)
    const human = new OutputWriter({
      mode: 'human',
      stdout: new MemoryStream(false),
      stderr: redirected,
    })
    expect(human.progress('working')).toBe(false)
    expect(redirected.value).toBe('')

    const structuredTty = new MemoryStream(true)
    const json = new OutputWriter({
      mode: 'json',
      stdout: new MemoryStream(true),
      stderr: structuredTty,
    })
    expect(json.progress('working')).toBe(false)
    expect(structuredTty.value).toBe('')
  })

  it('honors no-color while retaining TTY progress', () => {
    const stderr = new MemoryStream(true)
    const writer = new OutputWriter({
      mode: 'human',
      stdout: new MemoryStream(true),
      stderr,
      noColor: true,
    })
    expect(writer.progress('working')).toBe(true)
    writer.error(new Error('safe failure'))
    expect(stderr.value).toBe('working\nsafe failure\n')
    expect(stderr.value).not.toContain('\u001B[')
  })

  it('uses the same no-secret/no-local-path policy for telemetry', () => {
    const safe = sanitizeTelemetryPayload({
      path: '/home/ada/project',
      refreshToken: 'never-visible',
      commandOutput: 'raw output',
    })
    const serialized = JSON.stringify(safe)
    expect(serialized).not.toContain('/home/ada')
    expect(serialized).not.toContain('never-visible')
    expect(serialized).not.toContain('raw output')
  })

  it('excludes source and environment metadata from telemetry even without secret-shaped values', () => {
    expect(
      sanitizeTelemetryPayload({
        event: 'session.started',
        success: true,
        durationMilliseconds: 123,
        environmentName: 'customer-production',
        fileName: 'business-plan.txt',
        settings: { FEATURE: 'private-value' },
        message: 'arbitrary command output',
      }),
    ).toEqual({ event: 'session.started', success: true, durationMilliseconds: 123 })
  })
})
