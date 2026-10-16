import type { AppSnapshot } from '../state/snapshot'
import type { AppStore } from '../state/store'
import { INBOX_LIMIT, type InboxEntry } from './inbox'
import { teamsInput } from './teams-snapshot'

const KIND = 'team:waiting'

/** Live waits use the same facts as Needs you; no timers or separate lifecycle. */
export const reconcileTeamInbox = (next: AppSnapshot, previous: AppSnapshot): readonly InboxEntry[] => {
  if (next.inbox === previous.inbox && next.teams === previous.teams && next.goals === previous.goals && next.flowExecutions === previous.flowExecutions && next.approvals === previous.approvals) return next.inbox
  const live: InboxEntry[] = []
  for (const { team, goal, execution, overview } of teamsInput(next)) {
    if (goal?.goal.state === 'wrapped' || (execution && execution.state !== 'running' && execution.state !== 'stalled')) continue
    for (const wait of overview.needsYou) {
      const id = JSON.stringify([KIND, team.id, execution?.id, wait.kind, wait.sessionKey ?? null, wait.approval ?? wait.card])
      const old = next.inbox.find(entry => entry.id === id)
      live.push({ id, kind: KIND, tone: 'warning', title: team.name, body: wait.summary, at: old?.at ?? wait.since, read: old?.read ?? false, open: `team:${team.id}` })
    }
  }
  return [...live, ...next.inbox.filter(entry => entry.kind !== KIND)].sort((a, b) => b.at - a.at).slice(0, INBOX_LIMIT)
}

/** A kept destination is data; resolve it to the Team's ordinary door on use. */
export const teamInboxAction = (entry: InboxEntry, store: Pick<AppStore, 'openTeamRoom'>) => entry.open?.startsWith('team:')
  ? { go: () => store.openTeamRoom(entry.open!.slice('team:'.length)), goLabel: 'Open the Team' }
  : {}
