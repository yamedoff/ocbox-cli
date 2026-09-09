import { posix } from 'node:path'
import {
  ExecCommandSchema,
  ExecEnvironmentSchema,
  SessionIdSchema,
  type ExecCommand,
  type ExecEnvironment,
  type SessionId,
} from '../contracts.js'
import {
  findSensitiveMaterial,
  isProviderCredentialEnvironmentName,
} from '../security/redaction.js'

export type ExecutionOutputMode = 'human' | 'json' | 'jsonl'

export interface ParsedExecArguments {
  readonly command: ExecCommand
  readonly sessionId: SessionId | null
  readonly workingDirectory: string | null
  readonly timeoutMilliseconds: number | null
  readonly environment: ExecEnvironment
  readonly outputMode: ExecutionOutputMode
}

export class ExecArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecArgumentError'
  }
}

function takeValue(input: readonly string[], index: number, flag: string): string {
  const value = input[index + 1]
  if (value === undefined) throw new ExecArgumentError(`${flag} requires a value`)
  return value
}

function parseWorkingDirectory(value: string): string {
  if (!posix.isAbsolute(value) || value.includes('\\') || posix.normalize(value) !== value) {
    throw new ExecArgumentError('--cwd must be a normalized absolute sandbox path')
  }
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw new ExecArgumentError('--cwd is invalid')
  }
  return value
}

function parseTimeout(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ExecArgumentError('--timeout must be a positive integer in milliseconds')
  }
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) {
    throw new ExecArgumentError('--timeout is outside the supported range')
  }
  return milliseconds
}

function addEnvironment(environment: Record<string, string>, assignment: string): void {
  const separator = assignment.indexOf('=')
  if (separator < 1) throw new ExecArgumentError('--env requires NAME=VALUE')
  const name = assignment.slice(0, separator)
  const value = assignment.slice(separator + 1)
  const parsed = ExecEnvironmentSchema.safeParse({ ...environment, [name]: value })
  if (!parsed.success) throw new ExecArgumentError('--env contains an invalid name or value')
  if (
    isProviderCredentialEnvironmentName(name) ||
    findSensitiveMaterial(value).some((finding) => finding.kind === 'credential-value')
  ) {
    throw new ExecArgumentError('--env accepts non-secret settings only')
  }
  environment[name] = value
}

/** Parses the strict `ocbox exec` grammar without ever joining argv into a command string. */
export function parseExecArguments(input: readonly string[]): ParsedExecArguments {
  let sessionId: SessionId | null = null
  let workingDirectory: string | null = null
  let timeoutMilliseconds: number | null = null
  let outputMode: ExecutionOutputMode = 'human'
  let shell: string | undefined
  let argv: readonly string[] | undefined
  const environment: Record<string, string> = {}

  for (let index = 0; index < input.length; index++) {
    const item = input[index]
    if (item === '--') {
      argv = input.slice(index + 1)
      break
    }
    if (item === '--session') {
      const value = takeValue(input, index, item)
      const parsed = SessionIdSchema.safeParse(value)
      if (!parsed.success) throw new ExecArgumentError('--session requires a valid Session ID')
      sessionId = parsed.data
      index++
    } else if (item === '--cwd') {
      workingDirectory = parseWorkingDirectory(takeValue(input, index, item))
      index++
    } else if (item === '--timeout') {
      timeoutMilliseconds = parseTimeout(takeValue(input, index, item))
      index++
    } else if (item === '--env') {
      addEnvironment(environment, takeValue(input, index, item))
      index++
    } else if (item === '--shell') {
      shell = takeValue(input, index, item)
      index++
    } else if (item === '--json' || item === '--jsonl') {
      const requested = item.slice(2) as ExecutionOutputMode
      if (outputMode !== 'human')
        throw new ExecArgumentError('--json and --jsonl are mutually exclusive')
      outputMode = requested
    } else {
      throw new ExecArgumentError(
        'Unknown exec option; use -- before the executable and its arguments',
      )
    }
  }

  if (shell !== undefined && argv !== undefined) {
    throw new ExecArgumentError('--shell and structured argv are mutually exclusive')
  }
  const command = ExecCommandSchema.safeParse(
    shell === undefined ? { mode: 'argv', argv: argv ?? [] } : { mode: 'shell', shell },
  )
  if (!command.success) {
    throw new ExecArgumentError('Use `ocbox exec -- ARGV...` or `ocbox exec --shell COMMAND`')
  }
  return {
    command: command.data,
    sessionId,
    workingDirectory,
    timeoutMilliseconds,
    environment: ExecEnvironmentSchema.parse(environment),
    outputMode,
  }
}
