import type { SessionView } from '../lifecycle/index.js'

/** Compact human summary; structured output retains the complete view. */
export function sessionViewLine(view: SessionView): string {
  const marker = view.selected ? '* ' : '  '
  const providerState = view.sandbox?.lifecycle.normalizedState ?? 'unbound'
  const rawState = view.sandbox?.lifecycle.rawState ?? 'unbound'
  const operation = view.operation === null ? '' : ` operation=${view.operation.action}`
  return `${marker}${view.session.id} ${view.session.state} provider=${providerState} raw=${rawState}${operation}`
}
