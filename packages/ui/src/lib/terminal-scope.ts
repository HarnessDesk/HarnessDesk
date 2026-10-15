import type { AppSnapshot } from '../state/store'

/** The folder a terminal may open in on the currently shown destination. */
export const terminalCwdForSnapshot = (snapshot: Pick<AppSnapshot,
  'workbench' | 'activeSessionKey' | 'sessions' | 'workspace'>): string | null => {
  const destination = snapshot.workbench.navigation.current
  if (destination.kind === 'changes-review') return destination.root || null
  if (destination.kind === 'settings' && destination.route.kind === 'project') return destination.route.root
  if (destination.kind !== 'work') return snapshot.workspace?.path || null
  const session = snapshot.activeSessionKey ? snapshot.sessions.get(snapshot.activeSessionKey) : undefined
  return session?.cwd || snapshot.workspace?.path || null
}
