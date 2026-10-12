import type { Session } from '@harnessdesk/protocol'
import type { AppSnapshot } from '../state/store'

/** Kept history can be read even when its owning agent cannot run. */
export const sessionUnavailable = (snapshot: Pick<AppSnapshot, 'runtimes' | 'healthByRuntime' | 'activeRuntime' | 'health'>, session: Session | null): string | null => {
  if (!session) return null
  if (!snapshot.runtimes.some(runtime => runtime.id === session.runtime)) {
    return "This conversation can't run because its runtime isn't installed. Add it in Settings, then reopen this conversation."
  }
  const health = snapshot.healthByRuntime[session.runtime] ?? (session.runtime === snapshot.activeRuntime ? snapshot.health : null)
  return health?.state === 'unavailable'
    ? `${health.message}${health.remediation ? ` ${health.remediation}` : ' Check the runtime in Settings, then reopen this conversation.'}`
    : null
}
