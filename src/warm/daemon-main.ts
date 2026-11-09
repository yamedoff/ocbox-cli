import { createOcboxProvider } from '../providers/ocbox/factory.js'
import { WarmSessionServer } from './daemon.js'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    process.stderr.write(`The warm session daemon requires ${name}\n`)
    process.exit(2)
  }
  return value
}

function milliseconds(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const socketPath = required('OCBOX_WARM_SOCKET')
const apiUrl = required('OCBOX_WARM_API_URL')
const projectId = required('OCBOX_WARM_PROJECT_ID')
const stateDirectory = required('OCBOX_WARM_STATE_DIR')

const server = new WarmSessionServer({
  idleTimeoutMilliseconds: milliseconds('OCBOX_WARM_IDLE_MS', 10 * 60_000),
  onIdle: () => {
    process.exit(0)
  },
  provider: () => createOcboxProvider({ apiUrl, projectId, stateDirectory }),
  sessionTtlMilliseconds: milliseconds('OCBOX_WARM_TTL_MS', 10 * 60_000),
  socketPath,
})

const shutdown = (): void => {
  void server.close().then(() => process.exit(0))
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

await server.listen()
await server.closed
