import { useEffect, useMemo, useRef, useState } from 'react'
import type { FlowEntry, FlowOrigin } from '@harnessdesk/protocol'
import { ActionError, Banner, BannerAction, Button, Dialog, EmptyState, Field, FlowCard, FlowCardGrid, FlowExample, MenuItem, NativeSelect, Note, Page, SectionHead, PageOptions, Row, Rows, ToolFold } from '../design'
import { DestinationBar, useDestinationActive } from '../panels/destination-page'
import { useSnapshot, useStore } from '../state/context'
import { runsForPolicy, useFlowCatalogue, useFlowRunCoverage } from '../lib/flow-catalogue'
import { flowModel } from '../lib/flow-model'
import { FrontDoor } from './FrontDoor'
import { ProjectTriggers } from './ProjectTriggers'
import { TriggerSettings } from './TriggerSettings'
import { ClockIcon } from './Icons'

export const FlowsWindow = ({ onOpen, onNew }: {
  readonly onOpen: (root: string, id: string, origin: FlowOrigin) => void
  readonly onNew: (root: string) => void
}) => {
  const active = useDestinationActive(), store = useStore(), snapshot = useSnapshot()
  const { rows, roots, loading, problems, retry } = useFlowCatalogue(active)
  const [origin, setOrigin] = useState('all'), [query, setQuery] = useState(''), [newTeam, setNewTeam] = useState(false)
  useEffect(() => {
    if (!loading && origin !== 'all' && origin !== 'builtin' && !roots.includes(origin)) setOrigin('all')
  }, [loading, origin, roots])
  const [selection, setSelected] = useState<{ root: string; id: string; origin: FlowOrigin } | null>(null)
  const selected = rows.find(row => row.root === selection?.root && row.entry.id === selection.id && row.entry.origin === selection.origin) ?? null
  const detailRef = useRef<HTMLElement>(null)
  const exampleModel = useMemo(() => selected?.entry.policy ? flowModel(selected.entry.policy) : null, [selected?.entry.policy])
  useEffect(() => {
    if (!selected) return
    detailRef.current?.focus({ preventScroll: true })
    detailRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selection])
  const [startFlow, setStartFlow] = useState<{ root: string; entry: FlowEntry } | null>(null)
  const [triggersOpen, setTriggersOpen] = useState(false)
  const [triggerRoot, setTriggerRoot] = useState<string | null>(null)
  const countKnown = useFlowRunCoverage(active)
  useEffect(() => { if (!active) { setNewTeam(false); setSelected(null); setStartFlow(null); setTriggersOpen(false); setTriggerRoot(null) } }, [active])
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
      <PageOptions title="Flows" action={{ label: 'New Flow', disabled: !selectedRoot && 'Open a project folder to build a Flow.', run: () => { if (selectedRoot) onNew(selectedRoot) } }}
        choices={[{ id: 'origin', label: 'Flow origin', value: origin, items: [{ value: 'all', label: 'All origins' }, { value: 'builtin', label: 'Built in' }, ...roots.map(root => ({ value: root, label: projectName(root) }))], change: value => { setOrigin(value); setSelected(null) } }]}
        search={{ label: 'Search Flows', value: query, change: value => { setQuery(value); setSelected(null) } }} />
      {problems.length > 0 && <Banner tone="warning" measure="container" layout="stack"
        title={`Flows could not be read from ${problems.length} project ${problems.length === 1 ? 'folder' : 'folders'}.`}
        actions={<BannerAction variant="secondary" onClick={retry}>Retry</BannerAction>}>
        <ToolFold label="Folder details"><Rows>{problems.map(problem => <Row key={problem.root} title={projectName(problem.root)} tooltip={problem.root} desc={problem.message} />)}</Rows></ToolFold>
      </Banner>}
      {loading && <Note>Reading Flows…</Note>}
      {!loading && !roots.length && <Note>Open a project folder to build or start a Flow.</Note>}
      {selected && <section ref={detailRef} tabIndex={-1} aria-label={selected.entry.name}>
        <SectionHead name={selected.entry.name} action={<>
            <Button variant="outline" size="sm" disabled={!selectedRoot || !!selected.entry.problem} onClick={() => { if (selected.entry.problem) return; setStartFlow({ root: selected.entry.origin === 'project' ? selected.root : selectedRoot ?? selected.root, entry: selected.entry }) }}>Start Team</Button>
            <Button variant="outline" size="sm" onClick={() => onOpen(selected.root, selected.entry.id, selected.entry.origin)}>Edit Flow</Button>
            <Button variant="outline" size="sm" onClick={() => setSelected(null)}>Close</Button>
        </>} />
        {selected.entry.problem ? <ActionError>{selected.entry.problem}</ActionError> : exampleModel ? <FlowExample key={JSON.stringify([selected.root, selected.entry.origin, selected.entry.id])} model={exampleModel} rounds={selected.entry.policy?.budget?.rounds ?? 3} /> : <Note>This earlier Flow format has no drawable policy. Edit Flow to inspect its source.</Note>}
      </section>}
      <FlowCardGrid size="large">
        {plain && <FlowCard previewSize="large" name="Just a Team" origin="Built in" empty policy={null} summary="Work together without prescribed steps." runs={countKnown() ? [...snapshot.goals.values()].filter(goal => goal.goal.origin.kind === 'person' && ![...snapshot.flowExecutions.values()].some(run => run.goal === goal.goal.id)).length : null} disabled={!selectedRoot} onClick={() => setNewTeam(true)} />}
        {visible.map(({ root, entry }) => <FlowCard previewSize="large" key={JSON.stringify([root, entry.origin, entry.id])} name={entry.name}
          origin={entry.origin === 'builtin' ? 'Built in' : entry.origin === 'user' ? 'Yours' : projectName(root)} policy={entry.policy}
          summary={entry.problem ?? entry.summary ?? entry.description ?? 'The seed round runs, then the Team finishes.'}
          runs={countKnown(entry.origin === 'project' ? root : undefined) ? runsForPolicy(entry.policy, [...snapshot.flowExecutions.values()].filter(run => entry.origin !== 'project' || snapshot.goals.get(run.goal)?.goal.root === root)) : null}
          disabled={!!entry.problem} selected={selected?.root === root && selected.entry.id === entry.id && selected.entry.origin === entry.origin} onClick={() => setSelected({ root, id: entry.id, origin: entry.origin })} />)}
      </FlowCardGrid>
      {!loading && visible.length === 0 && !plain && <EmptyState variant="inline" title="No matching Flows" />}
    </Page>
    {active && startFlow && <FrontDoor context={{ kind: 'project', root: startFlow.root }} initial={{ id: startFlow.entry.id, origin: startFlow.entry.origin }} onClose={() => setStartFlow(null)} onStarted={execution => { setStartFlow(null); store.openGoal(execution.goal) }} />}
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
