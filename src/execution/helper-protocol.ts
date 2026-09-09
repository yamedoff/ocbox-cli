import { z } from 'zod'
import { ExecCommandSchema, ExecEnvironmentSchema } from '../domain/execution.js'
import { ExecutionIdSchema } from '../domain/ids.js'
import { SandboxPathSchema } from '../domain/remote-path.js'
import { UtcTimestampSchema } from '../domain/timestamps.js'
import {
  findSensitiveMaterial,
  isProviderCredentialEnvironmentName,
} from '../security/redaction.js'

/** Limits apply to encoded bytes, including JSON escaping, before allocation. */
export const MAX_HELPER_REQUEST_BYTES = 1_048_576

const EnvironmentSchema = ExecEnvironmentSchema.superRefine((environment, context) => {
  for (const [name, value] of Object.entries(environment)) {
    if (
      isProviderCredentialEnvironmentName(name) ||
      findSensitiveMaterial(value).some((finding) => finding.kind === 'credential-value')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only non-secret environment settings are allowed',
      })
    }
  }
})

/** Versioned, provider-independent request consumed only inside the sandbox. */
export const HelperRequestSchema = z.strictObject({
  version: z.literal(1),
  executionId: ExecutionIdSchema,
  command: ExecCommandSchema,
  workingDirectory: SandboxPathSchema.nullable(),
  environment: EnvironmentSchema,
  timeoutMilliseconds: z.number().int().positive().max(2_147_483_647).nullable(),
})

export type HelperRequest = z.infer<typeof HelperRequestSchema>

const HelperEventBaseSchema = z.strictObject({
  version: z.literal(1),
  executionId: ExecutionIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  timestamp: z.string().datetime({ offset: true }),
})

const HelperResultSchema = z
  .strictObject({
    exitCode: z.number().int().min(0).max(255),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    signal: z.string().min(1).max(128).nullable(),
    startedAt: UtcTimestampSchema,
    completedAt: UtcTimestampSchema,
  })
  .superRefine((result, context) => {
    if (result.completedAt < result.startedAt) {
      context.addIssue({ code: 'custom', message: 'Execution cannot complete before it starts' })
    }
    if (result.timedOut && result.cancelled) {
      context.addIssue({ code: 'custom', message: 'Execution cannot be timed out and cancelled' })
    }
  })

/** Binary payloads use base64 only at the helper transport boundary. */
export const HelperEventFrameSchema = z.discriminatedUnion('type', [
  HelperEventBaseSchema.extend({ type: z.literal('started') }),
  HelperEventBaseSchema.extend({ type: z.enum(['stdout', 'stderr']), data: z.string().base64() }),
  HelperEventBaseSchema.extend({
    type: z.literal('completed'),
    result: HelperResultSchema,
  }),
])

export type HelperEventFrame = z.infer<typeof HelperEventFrameSchema>

/** Safe diagnostic: malformed input is never included in an error message. */
export class HelperProtocolError extends Error {
  constructor() {
    super('Invalid or unsupported execution helper request')
    this.name = 'HelperProtocolError'
  }
}

/** Encodes one bounded helper event frame using the request framing format. */
export function encodeHelperEventFrame(value: unknown): Uint8Array {
  const parsed = HelperEventFrameSchema.safeParse(value)
  if (!parsed.success) throw new HelperProtocolError()
  const body = Buffer.from(JSON.stringify(parsed.data), 'utf8')
  if (body.byteLength > MAX_HELPER_REQUEST_BYTES) throw new HelperProtocolError()
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32BE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

/** Incrementally decodes helper events without buffering more than one bounded frame. */
export async function* decodeHelperEventFrames(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<HelperEventFrame> {
  const header = Buffer.alloc(4)
  let headerBytes = 0
  let body: Buffer | undefined
  let bodyBytes = 0
  for await (const chunk of chunks) {
    let offset = 0
    while (offset < chunk.byteLength) {
      if (body === undefined) {
        const count = Math.min(4 - headerBytes, chunk.byteLength - offset)
        header.set(chunk.subarray(offset, offset + count), headerBytes)
        headerBytes += count
        offset += count
        if (headerBytes < 4) continue
        const length = header.readUInt32BE(0)
        if (length === 0 || length > MAX_HELPER_REQUEST_BYTES) throw new HelperProtocolError()
        body = Buffer.allocUnsafe(length)
        bodyBytes = 0
      }
      const count = Math.min(body.byteLength - bodyBytes, chunk.byteLength - offset)
      body.set(chunk.subarray(offset, offset + count), bodyBytes)
      bodyBytes += count
      offset += count
      if (bodyBytes < body.byteLength) continue
      try {
        const json = new TextDecoder('utf-8', { fatal: true }).decode(body)
        const parsed = HelperEventFrameSchema.safeParse(JSON.parse(json))
        if (!parsed.success) throw new HelperProtocolError()
        yield parsed.data
      } catch {
        throw new HelperProtocolError()
      }
      headerBytes = 0
      body = undefined
      bodyBytes = 0
    }
  }
  if (headerBytes !== 0 || body !== undefined) throw new HelperProtocolError()
}

function parseRequest(value: unknown): HelperRequest {
  const result = HelperRequestSchema.safeParse(value)
  if (!result.success) throw new HelperProtocolError()
  return result.data
}

/** Four-byte unsigned big-endian length followed by exactly one UTF-8 JSON body. */
export function encodeHelperRequest(value: unknown): Uint8Array {
  const request = parseRequest(value)
  const body = Buffer.from(JSON.stringify(request), 'utf8')
  if (body.byteLength > MAX_HELPER_REQUEST_BYTES) throw new HelperProtocolError()
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32BE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

/**
 * Incremental bounded decoder. It waits for EOF before returning so trailing
 * frames cannot cause a valid prefix to execute. Transports must close stdin
 * after the request; command stdin/TTY is outside protocol version 1.
 */
export async function decodeHelperRequest(
  chunks: AsyncIterable<Uint8Array>,
): Promise<HelperRequest> {
  const header = Buffer.alloc(4)
  let headerBytes = 0
  let body: Buffer | undefined
  let bodyBytes = 0
  for await (const chunk of chunks) {
    let offset = 0
    if (headerBytes < 4) {
      const count = Math.min(4 - headerBytes, chunk.byteLength)
      header.set(chunk.subarray(0, count), headerBytes)
      headerBytes += count
      offset += count
      if (headerBytes === 4) {
        const length = header.readUInt32BE(0)
        if (length === 0 || length > MAX_HELPER_REQUEST_BYTES) throw new HelperProtocolError()
        body = Buffer.allocUnsafe(length)
      }
    }
    if (body !== undefined) {
      const remaining = chunk.byteLength - offset
      if (remaining > body.byteLength - bodyBytes) throw new HelperProtocolError()
      body.set(chunk.subarray(offset), bodyBytes)
      bodyBytes += remaining
    }
  }
  if (body === undefined || bodyBytes !== body.byteLength) throw new HelperProtocolError()
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return parseRequest(JSON.parse(json))
  } catch {
    throw new HelperProtocolError()
  }
}

/** No input interpolation: the helper passes this vector to spawn(shell:false). */
export function helperSpawnArguments(
  request: HelperRequest,
  supportsBash: boolean,
): { executable: string; args: readonly string[] } {
  const validated = parseRequest(request)
  if (validated.command.mode === 'shell') {
    if (!supportsBash) throw new HelperProtocolError()
    return { executable: '/bin/bash', args: ['-lc', validated.command.shell] }
  }
  const [executable, ...args] = validated.command.argv
  if (executable === undefined) throw new HelperProtocolError()
  return { executable, args }
}
