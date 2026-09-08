import { z } from 'zod'
import { ExecCommandSchema } from '../domain/execution.js'
import { ExecutionIdSchema } from '../domain/ids.js'
import { SandboxPathSchema } from '../domain/remote-path.js'
import {
  findSensitiveMaterial,
  isProviderCredentialEnvironmentName,
} from '../security/redaction.js'

/** Limits apply to encoded bytes, including JSON escaping, before allocation. */
export const MAX_HELPER_REQUEST_BYTES = 1_048_576

const EnvironmentSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    z
      .string()
      .max(32_768)
      .refine((value) => !value.includes('\0')),
  )
  .superRefine((environment, context) => {
    if (Object.keys(environment).length > 128) {
      context.addIssue({ code: 'custom', message: 'Too many environment settings' })
    }
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

/** Safe diagnostic: malformed input is never included in an error message. */
export class HelperProtocolError extends Error {
  constructor() {
    super('Invalid or unsupported execution helper request')
    this.name = 'HelperProtocolError'
  }
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
