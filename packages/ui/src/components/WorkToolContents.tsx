import { useEffect, useState } from 'react'
import type { SessionKey } from '@harnessdesk/protocol'
import { usePane, useSnapshot, useStore, PaneProvider } from '../state/context'
import { SummaryList, SummaryItem, Text, ToolBody, ToolBodySections, ToolSection, ToolProse, ToolFooterSuppressed } from '../design'
import { ChangesView, TrajectoryView } from './Details'
import { Activity } from './Activity'
import { BackgroundTasksView } from './BackgroundTasks'
import { DiffView } from './Diff'
import { teamSeats, hasConversation } from '../lib/team-seats'
import { goalRunOf } from '../lib/goal-run'
import { sanitizeText } from '../lib/sanitize'

const TeamChanges = ({ room }: { room: string }) => {
  const store = useStore(), snapshot = useSnapshot()
  const goal = snapshot.goals.get(room), execution = goalRunOf(room, goal, snapshot.flowExecutions)
  const root = goal?.goal.root ?? null, from = execution?.target?.base ?? null, to = execution?.target?.head ?? null
  const branch = snapshot.worktrees.find(one => one.path === root)?.branch
    ?? (snapshot.workspace?.path === root ? snapshot.workspace.git?.branch : null)
  const key = root && branch && from && to ? JSON.stringify([root, from, to]) : null
  const [range, setRange] = useState<{ key: string; diff: string | null; problem: string | null } | null>(null)
  useEffect(() => {
    if (!key || !root || !from || !to) return
    let live = true
    void store.readWorkDiff(root, from, to).then(
      value => { if (live) setRange({ key, diff: value.diff, problem: null }) },
      () => { if (live) setRange({ key, diff: null, problem: 'The Team branch diff could not be read.' }) },
    )
    return () => { live = false }
  }, [store, key, root, from, to])
  const shown = range?.key === key ? range : null
  return <ToolBody><ToolSection label="Changes">
    {!key ? <ToolProse>The Team branch and base are not recorded yet.</ToolProse>
      : shown?.problem ? <ToolProse>{shown.problem}</ToolProse>
      : shown?.diff == null ? <Text role="meta">Reading the branch diff…</Text>
      : <><SummaryList surface="panel"><SummaryItem label="Branch" kind="path">{sanitizeText(branch ?? '')}</SummaryItem>
          <SummaryItem label="From" kind="path">{sanitizeText(from ?? '')}</SummaryItem>
          <SummaryItem label="To" kind="path">{sanitizeText(to ?? '')}</SummaryItem></SummaryList>
        <DiffView diff={shown.diff} wrap /></>}
  </ToolSection></ToolBody>
}
export const WorkChangesView = () => {
  const pane = usePane()
  return pane?.view.kind === 'room' ? <TeamChanges room={pane.view.room} /> : <ToolBody><ToolBodySections><ToolSection label="Changes"><ChangesView /></ToolSection></ToolBodySections></ToolBody>
}
const ignoreFoot = () => {}
export const WorkActivityView = () => {
  const pane = usePane(), snapshot = useSnapshot()
  const room = pane?.view.kind === 'room' ? pane.view.room : null
  const keys: readonly SessionKey[] = room
    ? teamSeats(snapshot.goals.get(room), snapshot.teams.get(room), goalRunOf(room, snapshot.goals.get(room), snapshot.flowExecutions))
      .filter(hasConversation).map(one => one.key)
    : pane?.sessionKey ? [pane.sessionKey] : []
  const runningKeys = [...snapshot.tasks].filter(([, tasks]) => tasks.some(task => task.state === 'running')).map(([key]) => key)
  const taskKeys = [...new Set([...runningKeys, ...keys.filter(key => (snapshot.tasks.get(key)?.length ?? 0) > 0)])]
  return <ToolBody><ToolBodySections><ToolFooterSuppressed>
    {taskKeys.map(key => <PaneProvider key={key} scope={{ ...pane, paneId: pane?.paneId ?? '', view: { kind: 'conversation', session: key }, sessionKey: key }}>
      <ToolSection label="Background work"><BackgroundTasksView /></ToolSection>
    </PaneProvider>)}
    <ToolSection label="Events"><Activity query="" sessionKeys={keys} onFoot={ignoreFoot} /></ToolSection>
    {keys.map(key => <PaneProvider key={key} scope={{ ...pane, paneId: pane?.paneId ?? '', view: { kind: 'conversation', session: key }, sessionKey: key }}>
      <ToolSection label="Trajectory"><TrajectoryView /></ToolSection>
    </PaneProvider>)}
  </ToolFooterSuppressed></ToolBodySections></ToolBody>
}
