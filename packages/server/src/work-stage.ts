import { leadStage, type GoalView } from '@harnessdesk/protocol'

/** Shared by the Team snapshot and the phone work item; no prose determines attention. */
export const teamLeadStage = (view: Pick<GoalView, 'goal' | 'activity' | 'reservation'>, execution: { readonly state: string } | null) => leadStage({
  kind: 'team',
  status: view.goal.state === 'wrapped' || view.activity === null ? 'done'
    : view.activity === 'needs-you' ? 'needs-you' : view.activity === 'ready-to-wrap' ? 'ready'
      : execution?.state === 'stopped' || execution?.state === 'stalled' ? 'stopped' : 'working',
  prepared: view.reservation !== undefined && execution === null,
})
