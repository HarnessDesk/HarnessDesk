import { useEffect, useState } from 'react'
import type { FlowOrigin } from '@harnessdesk/protocol'
import { ActionError, Button, Dialog, EmptyState, Field, FlowCard, FlowCardGrid, MenuItem, NativeSelect, Note, Page, Search } from '../design'
import { DestinationBar, useDestinationActive } from '../panels/destination-page'
import { useSnapshot, useStore } from '../state/context'
import { runsForPolicy, useFlowCatalogue, useFlowRunCoverage } from '../lib/flow-catalogue'
import { FrontDoor } from './FrontDoor'
import { ProjectTriggers } from './ProjectTriggers'
import { TriggerSettings } from './TriggerSettings'
import { ClockIcon } from './Icons'

export const FlowsWindow = ({ onOpen, onNew }: {
  readonly onOpen: (root: string, id: string, origin: FlowOrigin) => void
  readonly onNew: (root: string) => void
}) => {
  const active = useDestinationActive(), store = useStore(), snapshot = useSnapshot()
  const { rows, roots, loading, problems } = useFlowCatalogue(active)
  const [origin, setOrigin] = useState('all'), [query, setQuery] = useState(''), [newTeam, setNewTeam] = useState(false)
  const [triggersOpen, setTriggersOpen] = useState(false)
  const [triggerRoot, setTriggerRoot] = useState<string | null>(null)
  const countKnown = useFlowRunCoverage(active)
  useEffect(() => { if (!active) { setNewTeam(false); setTriggersOpen(false); setTriggerRoot(null) } }, [active])
  const selectedRoot = roots.find(root => root === origin) ?? roots[0] ?? null
  const currentTriggerRoot = roots.find(root => root === triggerRoot) ?? selectedRoot
  const words = query.trim().toLocaleLowerCase()
  const visible = rows.filter(({ root, entry }) =>
    (origin === 'all' || origin === 'builtin' ? origin === 'all' || entry.origin === 'builtin' : entry.origin === 'project' && root === origin)
    && `${entry.name} ${entry.summary ?? ''} ${entry.description ?? ''}`.toLocaleLowerCase().includes(words))
  const plain = (origin === 'all' || origin === 'builtin') && 'just a team'.includes(words)
  const projectName = (root: string) => snapshot.workspaces.find(workspace => workspace.path === root)?.name ?? root.split('/').filter(Boolean).at(-1) ?? root

  return <>
    <DestinationBar place="Flows" more={close => <MenuItem label="Manage triggers…" icon={<ClockIcon size={16} />} onSelect={() => { setTriggerRoot(selectedRoot); setTriggersOpen(true); close() }} />} />
    <Page width="wide">
      <div className="flex flex-wrap items-center gap-(--hd-space-3)">
        <Button variant="default" disabled={!selectedRoot} title={selectedRoot ? undefined : 'Open a project folder to build a Flow.'} onClick={() => { if (selectedRoot) onNew(selectedRoot) }}>New Flow</Button>
        <NativeSelect aria-label="Flow origin" value={origin} onChange={event => setOrigin(event.target.value)}>
          <option value="all">All origins</option><option value="builtin">Built in</option>
          {roots.map(root => <option key={root} value={root}>{projectName(root)}</option>)}
        </NativeSelect>
        <Search aria-label="Search Flows" placeholder="Search Flows" value={query} onChange={setQuery} />
      </div>
      {problems.map(problem => <ActionError key={problem}>{problem}</ActionError>)}
      {loading && <Note>Reading Flows…</Note>}
      {!roots.length && <Note>Open a project folder to build or start a Flow.</Note>}
      <FlowCardGrid>
        {plain && <FlowCard name="Just a Team" origin="Built in" empty policy={null} summary="Work together without prescribed steps." runs={countKnown() ? [...snapshot.goals.values()].filter(goal => goal.goal.origin.kind === 'person' && ![...snapshot.flowExecutions.values()].some(run => run.goal === goal.goal.id)).length : null} disabled={!selectedRoot} onClick={() => setNewTeam(true)} />}
        {visible.map(({ root, entry }) => <FlowCard key={JSON.stringify([root, entry.origin, entry.id])} name={entry.name}
          origin={entry.origin === 'builtin' ? 'Built in' : entry.origin === 'user' ? 'Yours' : projectName(root)} policy={entry.policy}
          summary={entry.problem ?? entry.summary ?? entry.description ?? 'The seed round runs, then the Team finishes.'}
          runs={countKnown(entry.origin === 'project' ? root : undefined) ? runsForPolicy(entry.policy, [...snapshot.flowExecutions.values()].filter(run => entry.origin !== 'project' || snapshot.goals.get(run.goal)?.goal.root === root)) : null}
          disabled={!!entry.problem} onClick={() => onOpen(root, entry.id, entry.origin)} />)}
      </FlowCardGrid>
      {!loading && visible.length === 0 && !plain && <EmptyState variant="inline" title="No matching Flows" />}
    </Page>
    {active && newTeam && selectedRoot && <FrontDoor context={{ kind: 'project', root: selectedRoot }} initialPlain onClose={() => setNewTeam(false)} onStarted={execution => { setNewTeam(false); store.openGoal(execution.goal) }} />}
    {active && triggersOpen && <Dialog title="Triggers" size="lg" onClose={() => setTriggersOpen(false)} footer={<Button variant="default" onClick={() => setTriggersOpen(false)}>Close</Button>}>
      {currentTriggerRoot && <>
        <Field label="Project">{control => <NativeSelect {...control} value={currentTriggerRoot} onChange={event => setTriggerRoot(event.target.value)}>{roots.map(root => <option key={root} value={root}>{projectName(root)}</option>)}</NativeSelect>}</Field>
        <ProjectTriggers key={currentTriggerRoot} root={currentTriggerRoot} />
      </>}
      <TriggerSettings />
    </Dialog>}
  </>
}
