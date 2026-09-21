import { describe, expect, it } from 'vitest'
import { ExecArgumentError, parseExecArguments } from '../../src/execution/cli-arguments.js'

describe('exec CLI grammar', () => {
  it('preserves argv values exactly, including empty, Unicode, spaces and metacharacters', () => {
    const argv = ['node', '', 'two words', '日本語🙂', '$HOME', '$(command)', '&|;<>()']
    const parsed = parseExecArguments([
      '--session',
      '22222222-2222-4222-8222-222222222222',
      '--cwd',
      '/workspace/app',
      '--timeout',
      '1500',
      '--env',
      'NODE_ENV=test',
      '--jsonl',
      '--',
      ...argv,
    ])
    expect(parsed.command).toEqual({ mode: 'argv', argv })
    expect(parsed).toMatchObject({
      workingDirectory: '/workspace/app',
      timeoutMilliseconds: 1500,
      environment: { NODE_ENV: 'test' },
      outputMode: 'jsonl',
    })
  })

  it('accepts explicit shell mode as a distinct command variant', () => {
    expect(parseExecArguments(['--shell', 'printf "%s" "$HOME"']).command).toEqual({
      mode: 'shell',
      shell: 'printf "%s" "$HOME"',
    })
  })

  it('accepts the oclif-compatible --flag=VALUE forms', () => {
    const parsed = parseExecArguments([
      '--session=22222222-2222-4222-8222-222222222222',
      '--cwd=/workspace/app',
      '--timeout=1500',
      '--env=NODE_ENV=test',
      '--jsonl=true',
      '--',
      'node',
    ])
    expect(parsed).toMatchObject({
      sessionId: '22222222-2222-4222-8222-222222222222',
      workingDirectory: '/workspace/app',
      timeoutMilliseconds: 1500,
      environment: { NODE_ENV: 'test' },
      outputMode: 'jsonl',
      command: { mode: 'argv', argv: ['node'] },
    })
  })

  it('keeps a value-bearing token after -- out of the option grammar', () => {
    const parsed = parseExecArguments(['--env=NODE_ENV=test', '--', '--env=MALICIOUS=1'])
    expect(parsed.environment).toEqual({ NODE_ENV: 'test' })
    expect(parsed.command).toEqual({ mode: 'argv', argv: ['--env=MALICIOUS=1'] })
  })

  const invalidInputs: readonly (readonly string[])[] = [
    [],
    ['node', '-v'],
    ['--shell', 'true', '--', 'node'],
    ['--json', '--jsonl', '--', 'node'],
    ['--cwd', '../host', '--', 'node'],
    ['--cwd', '/workspace/../host', '--', 'node'],
    ['--timeout', '0', '--', 'node'],
    ['--env', 'OPENAI_API_KEY=plain', '--', 'node'],
    ['--env', 'SAFE=sk-secret-value', '--', 'node'],
    ['--unknown', '--', 'node'],
  ]

  it.each(invalidInputs.map((input) => [input] as const))(
    'rejects ambiguous or unsafe input %#',
    (input) => {
      expect(() => parseExecArguments(input)).toThrow(ExecArgumentError)
    },
  )

  it('does not echo an unknown credential-shaped argument in diagnostics', () => {
    const credential = 'sk-secret-canary-value'
    expect(() => parseExecArguments([credential])).toThrow(
      'Unknown exec option; use -- before the executable and its arguments',
    )
    try {
      parseExecArguments([credential])
    } catch (error) {
      expect(String(error)).not.toContain(credential)
    }
  })
})
