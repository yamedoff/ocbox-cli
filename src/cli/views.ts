import type { SessionView } from '../lifecycle/index.js'

/** Compact human summary; structured output retains the complete view. */
export function sessionViewLine(view: SessionView): string {
  const marker = view.selected ? '* ' : '  '
  const providerState = view.sandbox?.lifecycle.normalizedState ?? 'unbound'
  const rawState = view.sandbox?.lifecycle.rawState ?? 'unbound'
  const operation = view.operation === null ? '' : ` operation=${view.operation.action}`
  const projectId = view.hostedProjectId ?? view.session.projectId
  return `${marker}session=${view.session.id} state=${view.session.state} project=${projectId} provider=${providerState} raw=${rawState}${operation}`
}
