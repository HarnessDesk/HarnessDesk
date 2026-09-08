import { currentTurn, type Session, type SessionKey } from '@harnessdesk/protocol'

import type { PendingApproval } from '../state/store'

/**
 * What one pane is doing, at a glance. Four states because four things can
 * be true of an agent: it is working, it is waiting on you, it is resting, or
 * it has stopped on an error. "Waiting" outranks "running" — an approval
 * request is the one state that needs a person — and "failed" is read from
 * the last turn, because a session that errored an hour ago and sits idle is
 * still a session that failed.
 */
export type PaneStatus = 'running' | 'waiting' | 'idle' | 'failed'

export const paneStatus = (
  session: Session | null,
  approvals: readonly PendingApproval[],
  key: SessionKey | null,
): PaneStatus => {
  if (!session || !key) return 'idle'
  if (approvals.some((entry) => entry.key === key)) return 'waiting'
  if (session.status.type === 'error') return 'failed'
  const turn = currentTurn(session)
  if (turn?.status === 'inProgress' || session.status.type === 'active') return 'running'
  if (turn?.status === 'failed') return 'failed'
  return 'idle'
}

export const STATUS_LABEL: Record<PaneStatus, string> = {
  running: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
  failed: 'Failed',
}
