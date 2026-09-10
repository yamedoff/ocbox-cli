import { OcboxError } from '../errors/ocbox-error.js'
import { redactForOutput, type JsonValue } from '../security/redaction.js'

export const OUTPUT_SCHEMA_VERSION = 1 as const

export type OutputMode = 'human' | 'json' | 'jsonl'
export type OutputEnvelopeKind = 'error' | 'event' | 'result'

export interface OutputStream {
  readonly isTTY?: boolean
  write(chunk: string): unknown
}

export interface OutputEnvelope {
  readonly schemaVersion: typeof OUTPUT_SCHEMA_VERSION
  readonly kind: OutputEnvelopeKind
  readonly name: string
  readonly timestamp: string
  readonly data: JsonValue
}

export interface OutputWriterOptions {
  readonly mode: OutputMode
  readonly stdout: OutputStream
  readonly stderr: OutputStream
  readonly noColor?: boolean
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly now?: () => Date
}

export interface WriteOutputOptions {
  readonly humanMessage?: string
}

function sortedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortedJson(item)]),
    )
  }
  return value
}

function stableJson(value: JsonValue, indentation?: number): string {
  return JSON.stringify(sortedJson(value), null, indentation)
}

function safeHumanMessage(message: string | undefined, fallback: JsonValue): string {
  const redacted = redactForOutput(message ?? fallback)
  return typeof redacted === 'string' ? redacted : stableJson(redacted)
}

/** Stable human/JSON/JSONL output with one centralized recursive redaction pass. */
export class OutputWriter {
  readonly #mode: OutputMode
  readonly #stdout: OutputStream
  readonly #stderr: OutputStream
  readonly #useColor: boolean
  readonly #now: () => Date

  constructor(options: OutputWriterOptions) {
    this.#mode = options.mode
    this.#stdout = options.stdout
    this.#stderr = options.stderr
    this.#useColor =
      options.mode === 'human' &&
      options.stderr.isTTY === true &&
      options.noColor !== true &&
      (options.environment ?? process.env)['NO_COLOR'] === undefined
    this.#now = options.now ?? (() => new Date())
  }

  result(name: string, data: unknown, options: WriteOutputOptions = {}): OutputEnvelope {
    const envelope = this.#envelope('result', name, data)
    if (this.#mode === 'human') {
      this.#stdout.write(`${safeHumanMessage(options.humanMessage, envelope.data)}\n`)
    } else {
      this.#stdout.write(this.#serialize(envelope))
    }
    return envelope
  }

  event(name: string, data: unknown, options: WriteOutputOptions = {}): OutputEnvelope {
    const envelope = this.#envelope('event', name, data)
    if (this.#mode === 'human') {
      this.#stdout.write(`${safeHumanMessage(options.humanMessage, envelope.data)}\n`)
    } else {
      this.#stdout.write(this.#serialize(envelope))
    }
    return envelope
  }

  error(error: unknown, name = 'error'): OutputEnvelope {
    const safeError = error instanceof OcboxError ? error.toJSON() : error
    const envelope = this.#envelope('error', name, safeError)
    if (this.#mode === 'human') {
      const message =
        error instanceof Error
          ? safeHumanMessage(error.message, envelope.data)
          : safeHumanMessage(undefined, envelope.data)
      const line = this.#useColor ? `\u001B[31m${message}\u001B[0m` : message
      this.#stderr.write(`${line}\n`)
    } else {
      this.#stderr.write(this.#serialize(envelope))
    }
    return envelope
  }

  /** Progress is a human TTY affordance and is silent under redirection/structured modes. */
  progress(message: string): boolean {
    if (this.#mode !== 'human' || this.#stderr.isTTY !== true) return false
    const safeMessage = safeHumanMessage(message, '')
    this.#stderr.write(`${safeMessage}\n`)
    return true
  }

  #envelope(kind: OutputEnvelopeKind, name: string, data: unknown): OutputEnvelope {
    const timestamp = this.#now().toISOString()
    return {
      schemaVersion: OUTPUT_SCHEMA_VERSION,
      kind,
      name,
      timestamp,
      data: redactForOutput(data),
    }
  }

  #serialize(envelope: OutputEnvelope): string {
    return `${stableJson(redactForOutput(envelope), this.#mode === 'json' ? 2 : undefined)}\n`
  }
}
