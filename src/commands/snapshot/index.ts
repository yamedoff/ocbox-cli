import { Command } from '@oclif/core'
import { resolve } from 'node:path'
import { z } from 'zod'
import { mapApiFailureToOcboxError, toRequestId } from '../../api/client/errors.js'
import type { OcboxApiClient } from '../../api/client/index.js'
import type { ApiResult } from '../../api/generated/client.js'
import { runtimeFlags } from '../../cli/base-command.js'
import {
  createLifecycleService,
  loadProjectConfig,
  resolveAccountStateDirectory,
  resolveStateDirectory,
  type RuntimeFlags,
} from '../../cli/runtime.js'
import { OcboxError } from '../../errors/index.js'
import { parseHostedResponse } from '../../hosted/response.js'
import { LifecycleStore, projectIdForPath } from '../../lifecycle/index.js'
import { HostedOperationSchema } from '../../metadata/client.js'
import { hostedFlags } from '../../metadata/command.js'
import { waitForHostedOperation } from '../../providers/ocbox/operations.js'

const USAGE = [
  'Take, list, restore and delete snapshots of a Session.',
  '',
  'USAGE',
  '  $ ocbox snapshot save [<box>] [--no-wait] [--idempotency-key]',
  '  $ ocbox snapshot list [<box>]',
  '  $ ocbox snapshot restore <snapshot-id> [<box>] [--idempotency-key]',
  '  $ ocbox snapshot delete <snapshot-id> [<box>] [--idempotency-key]',
  '',
  'COMMANDS',
  '  save     Take a snapshot and wait for its Operation',
  '  list     List the snapshots a box keeps, newest first',
  '  restore  Restore a box from one of its snapshots and wait',
  '  delete   Delete one snapshot and wait',
  '',
  'NOTES',
  '  <box> is a tracked Session ID; it defaults to the selected Session,',
  '  the same way ocbox stop and ocbox exec pick it.',
  '  Refusals print the API reason and next step; snapshot_unsupported means',
  '  this box cannot take snapshots, and snapshot_limit_reached means delete',
  '  one with ocbox snapshot delete to free a slot.',
].join('\n')

/** Topic command so `ocbox snapshot` prints usage instead of an unknown-command error. */
export default class SnapshotTopic extends Command {
  static override description = 'Take, list, restore and delete Session snapshots'
  static override flags = {}

  async run(): Promise<void> {
    this.log(USAGE)
  }
}

/** Output, authentication and project flags shared by the snapshot commands. */
export const snapshotFlags = {
  ...hostedFlags,
  project: runtimeFlags.project,
}

/**
 * One user snapshot as the hosted route publishes it. `sizeBytes` is optional
 * because an older or newer service may not know the size yet.
 */
export const SessionSnapshotSchema = z.strictObject({
  id: z.string().min(1).max(256),
  createdAt: z.iso.datetime({ offset: true }),
  sizeBytes: z.number().int().min(0).optional(),
})
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>

export const SessionSnapshotListSchema = z.strictObject({
  snapshots: z.array(SessionSnapshotSchema),
})
export type SessionSnapshotList = z.infer<typeof SessionSnapshotListSchema>

/** The Operation fields the snapshot commands read, from either wire schema. */
export interface SnapshotOperationError {
  readonly code: string
  readonly message: string
  readonly reasonCode?: string | undefined
  readonly nextStep?: string | undefined
  readonly limitName?: string | undefined
  readonly limitValue?: number | undefined
  readonly retryAfterSeconds?: number | undefined
}

export interface SnapshotOperation {
  readonly id: string
  readonly state: 'pending' | 'running' | 'succeeded' | 'cancelled' | 'failed'
  readonly requestId: string
  readonly error: SnapshotOperationError | null
}

function amount(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    const gib = bytes / 1024 ** 3
    return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`
  }
  if (bytes >= 1024 ** 2) {
    const mib = bytes / 1024 ** 2
    return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`
  }
  if (bytes >= 1024) {
    const kib = bytes / 1024
    return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`
  }
  return `${bytes} B`
}

/** One line per snapshot: id, creation time, and size when the service knows it. */
export function snapshotLine(snapshot: SessionSnapshot): string {
  const size = snapshot.sizeBytes === undefined ? '' : `  ${amount(snapshot.sizeBytes)}`
  return `${snapshot.id}  ${snapshot.createdAt}${size}`
}

/** Human list, in the order the hosted route returns it (newest first). */
export function snapshotListLine(snapshots: readonly SessionSnapshot[]): string {
  return snapshots.length === 0 ? 'No snapshots' : snapshots.map(snapshotLine).join('\n')
}

/**
 * Resolves `[<box>]` the same way stop and exec resolve the selected Session,
 * then maps the tracked Session to the hosted `ses_` ID the snapshot routes
 * take. A tracked Session without a hosted mapping (for example one owned by
 * the fake provider) falls back to its local ID, which the hosted API refuses.
 */
export async function resolveSnapshotSession(
  flags: RuntimeFlags,
  box: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const config = await loadProjectConfig(flags)
  const stateDirectory = resolveStateDirectory(flags)
  const lifecycleStateDirectory = await resolveAccountStateDirectory(
    flags,
    stateDirectory,
    config.provider.name === 'ocbox',
    signal,
  )
  const view = await (await createLifecycleService(flags, signal, lifecycleStateDirectory)).status(
    box,
  )
  const store = new LifecycleStore(
    lifecycleStateDirectory,
    projectIdForPath(resolve(process.cwd())),
  )
  const state = await store.load()
  const mapped = Object.values(state.hostedMappings)
    .flatMap((records) => Object.values(records))
    .filter((record) => record.localSessionId === view.session.id && !record.deleted)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  return mapped?.hostedSessionId ?? view.session.id
}

function operationOf(
  api: OcboxApiClient,
  operation: string,
  response: ApiResult<unknown>,
): SnapshotOperation {
  const { resource } = parseHostedResponse(
    api,
    operation,
    response,
    [202],
    HostedOperationSchema,
    'operation',
  )
  return resource as SnapshotOperation
}

/** Starts snapshot_create and returns its durable Operation. */
export async function createSnapshotOperation(
  api: OcboxApiClient,
  sessionId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<SnapshotOperation> {
  const response = await api.createSnapshot(sessionId, idempotencyKey, signal)
  return operationOf(api, 'snapshot.create', response)
}

/** Starts snapshot_restore and returns its durable Operation. */
export async function restoreSnapshotOperation(
  api: OcboxApiClient,
  sessionId: string,
  snapshotId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<SnapshotOperation> {
  const response = await api.restoreSnapshot(sessionId, snapshotId, idempotencyKey, signal)
  return operationOf(api, 'snapshot.restore', response)
}

/** Starts snapshot_delete and returns its durable Operation. */
export async function deleteSnapshotOperation(
  api: OcboxApiClient,
  sessionId: string,
  snapshotId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<SnapshotOperation> {
  const response = await api.deleteSnapshot(sessionId, snapshotId, idempotencyKey, signal)
  return operationOf(api, 'snapshot.delete', response)
}

/** Reads the snapshots one box keeps. */
export async function listSnapshots(
  api: OcboxApiClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionSnapshotList> {
  const response = await api.listSnapshots(sessionId, signal)
  const { resource } = parseHostedResponse(
    api,
    'snapshot.list',
    response,
    [200],
    SessionSnapshotListSchema,
    'snapshot list',
  )
  return resource
}

/** Names the CLI command that frees a slot or lists snapshots. */
function snapshotNextStep(reasonCode: string | undefined, nextStep: string | undefined) {
  if (nextStep === undefined) return undefined
  if (reasonCode === 'snapshot_limit_reached')
    return nextStep.replaceAll('snapshot_delete', '`ocbox snapshot delete`')
  if (reasonCode === 'snapshot_not_found')
    return nextStep.replaceAll('snapshot_list', '`ocbox snapshot list`')
  return nextStep
}

/**
 * Waits for a snapshot Operation and turns a terminal failure into the same
 * mapped error a direct refusal produces, keeping the API reason and next step.
 */
export async function waitForSnapshotOperation(
  api: OcboxApiClient,
  operationId: string,
  signal?: AbortSignal,
): Promise<SnapshotOperation> {
  const { operation } = await waitForHostedOperation(api, operationId, {
    returnTerminalFailure: true,
    ...(signal === undefined ? {} : { signal }),
  })
  if (operation.state === 'succeeded') return operation as SnapshotOperation
  if (operation.state === 'cancelled') {
    throw new OcboxError({
      code: 'OPERATION_CANCELLED',
      message: 'The snapshot operation was cancelled',
      requestId: toRequestId(operation.requestId),
    })
  }
  const failure = operation.error
  throw mapApiFailureToOcboxError({
    operation: 'snapshot',
    requestId: operation.requestId,
    responseRequestId: operation.requestId,
    serverCode: failure?.code,
    serverMessage: failure?.message,
    reasonCode: failure?.reasonCode,
    nextStep: snapshotNextStep(failure?.reasonCode, failure?.nextStep),
    limitName: failure?.limitName,
    limitValue: failure?.limitValue,
    retryAfterSeconds: failure?.retryAfterSeconds ?? null,
    status: 409,
  })
}
