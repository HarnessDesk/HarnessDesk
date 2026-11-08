import type { LeadPullRequest } from '@harnessdesk/protocol'
import type { AppSnapshot } from '../state/snapshot'

export interface LeadOpeningJob { readonly id: string; readonly title: string; readonly goal: string }
/** Suggestions use only observed work in this Lead's project. Opening a suggestion is a person message, never a start approval. */
export const leadOpeningJobs = (desk: Pick<AppSnapshot, 'flowExecutions' | 'goals'>, root: string | null, pr?: LeadPullRequest | null): readonly LeadOpeningJob[] => {
  if (!root) return []
  const jobs: LeadOpeningJob[] = []
  if (pr?.state === 'open' && pr.check?.state === 'failed') jobs.push({ id: `pr-${pr.repository}-${pr.number}`,
    title: `Investigate failed checks on #${pr.number}`,
    goal: `Draft a plan to investigate the failed checks on ${pr.repository}#${pr.number}. Read the current head and CI results before proposing any repair.` })
  for (const run of desk.flowExecutions.values()) {
    const goal = desk.goals.get(run.goal)?.goal
    if (!goal || goal.state !== 'open' || goal.root !== root) continue
    const title = goal.sentence.replace(/[\r\n]/g, ' ').slice(0, 160)
    if (run.state === 'stalled') jobs.push({ id: `run-${run.id}`, title: `Unblock ${title}`,
      goal: `Draft a plan to investigate stalled run ${run.id} for “${title}”. Read the current run and its blocker before proposing work.` })
    else if (run.state === 'settled' && !run.rounds.some(round => round.role === 'review' && round.state === 'closed')) jobs.push({ id: `run-${run.id}`, title: `Review ${title}`,
      goal: `Draft a plan to review finished run ${run.id} for “${title}”. Read its current changes and review evidence first.` })
    if (jobs.length >= 2) break
  }
  return jobs.slice(0, 2)
}
