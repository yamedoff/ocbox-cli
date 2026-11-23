import { describe, expect, it } from 'vitest'
import { withRefusalEnvelope } from '../../src/api/client/errors.js'
import { OcboxError } from '../../src/errors/index.js'
import {
  HostedSessionSchema as HostedSessionRuntimeSchema,
  sessionLine,
} from '../../src/hosted/session.js'
import { OutputWriter } from '../../src/output/writer.js'
import { HostedSessionSchema as HostedWireSessionSchema } from '../../src/providers/ocbox/wire.js'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const NOW = '2026-11-23T00:00:00.000Z'
const NEXT_STEP = 'Destroy a box, then retry.'

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

function sessionBody(failure: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ses_1',
    createdAt: NOW,
    updatedAt: NOW,
    projectId: 'prj_1',
    requestedSpec: {},
    effectiveSpec: {},
    normalizedState: 'failed',
    rawState: 'admission_denied',
    sandboxes: [],
    primarySandboxId: null,
    failure,
  }
}

describe('hosted session failure fields', () => {
  it('parses the published refusal fields and still fails closed on an unknown failure key', () => {
    const published = sessionBody({
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
      retryAfterSeconds: 30,
    })

    const wire = HostedWireSessionSchema.safeParse(published)
    expect(wire.success).toBe(true)
    expect(wire.success ? wire.data.failure : null).toEqual({
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
      retryAfterSeconds: 30,
    })

    const runtime = HostedSessionRuntimeSchema.safeParse(published)
    expect(runtime.success).toBe(true)
    expect(runtime.success ? runtime.data.failure : null).toEqual({
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
      retryAfterSeconds: 30,
    })

    const unknown = HostedSessionRuntimeSchema.safeParse(
      sessionBody({ reasonCode: 'user_active_limit', nextStep: NEXT_STEP, unexpected: 'value' }),
    )
    expect(unknown.success).toBe(false)
  })

  it('prints the limit name, value and retry hint in the session line and keeps the old line without them', () => {
    const withFields = HostedSessionRuntimeSchema.parse(
      sessionBody({
        reasonCode: 'user_active_limit',
        nextStep: NEXT_STEP,
        limitName: 'boxes_per_account',
        limitValue: 1,
        retryAfterSeconds: 30,
      }),
    )
    expect(sessionLine(withFields)).toBe(
      'ses_1  failed  project=prj_1\nReason user_active_limit; limit boxes_per_account = 1; retry after 30 s.',
    )

    const withoutFields = HostedSessionRuntimeSchema.parse(
      sessionBody({ reasonCode: 'user_active_limit', nextStep: NEXT_STEP }),
    )
    expect(sessionLine(withoutFields)).toBe(
      'ses_1  failed  project=prj_1\nReason user_active_limit.',
    )
  })

  it('carries the fields in the session get JSON result envelope', () => {
    const session = HostedSessionRuntimeSchema.parse(
      sessionBody({
        reasonCode: 'user_active_limit',
        nextStep: NEXT_STEP,
        limitName: 'boxes_per_account',
        limitValue: 1,
        retryAfterSeconds: 30,
      }),
    )
    const stdout = new MemoryStream(false)
    const writer = new OutputWriter({
      mode: 'json',
      stdout,
      stderr: new MemoryStream(false),
    })

    writer.result('session.inspected', { session }, { humanMessage: sessionLine(session) })

    const envelope = JSON.parse(stdout.value) as {
      data: { session: { failure?: Record<string, unknown> } }
    }
    expect(envelope.data.session.failure).toEqual({
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
      retryAfterSeconds: 30,
    })
  })

  it('keeps every refusal field, including when to retry, on the mapped error', () => {
    const base = new OcboxError({
      code: 'USAGE_LIMIT',
      message: 'Box admission was refused',
      requestId: REQUEST_ID as never,
    })
    const mapped = withRefusalEnvelope(base, {
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
      retryAfterSeconds: 30,
    })

    expect(mapped.details).toEqual({
      reasonCode: 'user_active_limit',
      nextStep: NEXT_STEP,
      limitName: 'boxes_per_account',
      limitValue: 1,
      retryAfterSeconds: 30,
    })
    expect(mapped.message).toContain('The boxes_per_account limit is 1.')
  })

  it('prints the limit and retry hint on the human error line, keeps the old line without them, and carries them in JSON', () => {
    const error = new OcboxError({
      code: 'USAGE_LIMIT',
      message: 'Box admission was refused',
      requestId: REQUEST_ID as never,
      details: { limitName: 'boxes_per_account', limitValue: 1, retryAfterSeconds: 30 },
    })

    const humanError = new MemoryStream(false)
    const human = new OutputWriter({
      mode: 'human',
      stdout: new MemoryStream(false),
      stderr: humanError,
    })
    human.error(error)
    expect(humanError.value).toBe(
      'Box admission was refused\nlimit boxes_per_account = 1; retry after 30 s\n',
    )

    const plainError = new MemoryStream(false)
    const plain = new OutputWriter({
      mode: 'human',
      stdout: new MemoryStream(false),
      stderr: plainError,
    })
    plain.error(
      new OcboxError({
        code: 'USAGE_LIMIT',
        message: 'Box admission was refused',
        requestId: REQUEST_ID as never,
      }),
    )
    expect(plainError.value).toBe('Box admission was refused\n')

    const jsonOutput = new MemoryStream(false)
    const json = new OutputWriter({
      mode: 'json',
      stdout: new MemoryStream(false),
      stderr: jsonOutput,
    })
    json.error(error)
    const envelope = JSON.parse(jsonOutput.value) as {
      data: { details?: Record<string, unknown> }
    }
    expect(envelope.data.details).toEqual({
      limitName: 'boxes_per_account',
      limitValue: 1,
      retryAfterSeconds: 30,
    })
  })
})
