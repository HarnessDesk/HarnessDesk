import { useEffect, useMemo, useState } from 'react'
import type { FlowPreview, FlowRunOptions } from '@harnessdesk/protocol'
import type { RunTimelineInput } from '../lib/run-timeline'
import { Button } from '../design'
import { runTimeline } from '../lib/run-timeline'
import { RunAgain } from '../components/RunAgain'
import { RetryCheck } from '../components/RetryCheck'
import { RunFlow } from '../components/RunFlow'
import { RunView, type RunViewTab } from '../components/RunView'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { TeamRunView } from '../components/TeamRunView'
import { StoreProvider } from '../state/context'
import { RUN_VIEW_STATES, runFixture, runModel, runTeamStore, type RunScene } from './run-view-fixture'

/** One store for every example on a page: *Open the file* reads the catalogue through it, as the app does. */
let shared: ReturnType<typeof runTeamStore> | undefined
const sharedStore = () => (shared ??= runTeamStore())

export const RunExample = ({ scene, input }: { scene: RunScene; input?: RunTimelineInput }) => {
  const [selected, setSelected] = useState<string | null>(null)
  const execution = useMemo(() => input?.execution ?? runFixture(scene).execution, [scene, input])
  const [again, setAgain] = useState(false)
  const [retry, setRetry] = useState(false)
  return <StoreProvider store={sharedStore()}><RunView model={input ? runTimeline(input) : runModel(scene)} number={1} selectedRow={selected} onSelect={setSelected}
    doing={new Map([['seat-0', 'Editing src/checkout/retry.ts']])}
    pending={scene === 'pending'} problem={scene === 'failed' ? 'Check evidence is unavailable.' : null}
    onRunAgain={() => setAgain(true)} onWrap={() => setSelected('end')} onBoard={() => setSelected('end')} onReviewCheck={() => setRetry(true)}
    flow={<RunFlow execution={execution} root="/repo" seats={[]} />} />
    {again && <RunAgain execution={execution} root="/repo" sentence="Retry the checkout call" onClose={() => setAgain(false)} onStarted={() => setAgain(false)} />}
    {retry && <RetryCheck run={execution.id} card={execution.operations.find(one => one.kind === 'check' && one.state === 'uncertain')?.card ?? 1} onClose={() => setRetry(false)} />}
  </StoreProvider>
}
/** The Run as the app mounts it: the timeline with the inspector beside it, and the Flow when it is chosen. */
export const RunWorkspaceExample = ({ scene = 'running', view: first = 'timeline' }: { scene?: RunScene; view?: RunViewTab }) => {
  const source = useMemo(() => runFixture(scene), [scene])
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<RunViewTab>(first)
  return <StoreProvider store={sharedStore()}><TeamRunView execution={source.execution} origin="Started by you" onOpenSeat={() => {}}
    model={runModel(scene)} number={1} selectedRow={selected} onSelect={setSelected}
    flow={<RunFlow execution={source.execution} root="/repo" seats={[]} />} view={view} onView={setView} /></StoreProvider>
}
export const RunViewBoard = () => <div className="flex flex-col gap-4">{RUN_VIEW_STATES.map(scene =>
  <section key={scene} data-catalog-state={scene} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><RunExample scene={scene} /></section>)}
  <section data-catalog-state="flow" className="flex h-144 flex-col"><RunWorkspaceExample view="flow" /></section></div>
export const RunViewFrames = () => {
  const store = useMemo(() => runTeamStore('settled'), [])
  return <div className="flex flex-col gap-4 p-4">{RUN_VIEW_STATES.map(scene =>
    <section key={scene} id={`run-view-${scene}`} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><RunExample scene={scene} /></section>)}
    <section id="run-view-flow" className="flex h-144 flex-col"><RunWorkspaceExample view="flow" /></section>
    <section id="run-view-team" className="h-144"><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>
  </div>
}

/** Browser tests feed records produced by the real Flow engine's synthetic rig. */
export const RunEndingRigFrames = () => {
  const [input, setInput] = useState<RunTimelineInput | null>(null)
  useEffect(() => { void fetch('/run-ending-rig.json').then(response => response.json()).then(setInput) }, [])
  return input ? <section id="run-ending-rig" className="flex h-144 flex-col"><RunExample scene="settled" input={input} /></section> : null
}

export const RUN_AGAIN_STATES = ['default', 'empty', 'pending', 'failed', 'superseded', 'multiple-seats'] as const
export type RunAgainScene = typeof RUN_AGAIN_STATES[number]
export const RunAgainExample = ({ scene = 'default', opened = false }: { scene?: RunAgainScene; opened?: boolean }) => {
  const [open, setOpen] = useState(opened)
  const execution = useMemo(() => runFixture('stopped').execution, [])
  const store = useMemo(() => {
    const base = runTeamStore('stopped')
    return new Proxy(base, { get(target, key) {
      if (key === 'flowExecutionSource' && scene === 'empty') return async () => ({ ...await target.flowExecutionSource(execution.id), vars: { brief: '', task: '' } })
      if (key === 'flowExecutionSource' && scene === 'pending') return () => new Promise(() => {})
      if (key === 'flowExecutionSource' && scene === 'failed') return async () => { throw new Error('The earlier Run’s source could not be read.') }
      if (key === 'previewFlow' && scene === 'superseded') return async () => supersededPreview()
      if (key === 'previewFlow' && scene === 'multiple-seats') return async (...args: Parameters<typeof target.previewFlow>) => multipleSeatPreview(await target.previewFlow(...args), args[3])
      return Reflect.get(target, key)
    } })
  }, [scene])
  return <StoreProvider store={store}><Button onClick={() => setOpen(true)}>Run again… · {scene}</Button>
    {open && <RunAgain execution={execution} root="/repo" sentence="Retry the checkout call" onClose={() => setOpen(false)} onStarted={() => setOpen(false)} />}
  </StoreProvider>
}
export const RunAgainCases = () => {
  const [scene, setScene] = useState<RunAgainScene | null>(null)
  const execution = useMemo(() => runFixture('stopped').execution, [])
  const store = useMemo(() => new Proxy(runTeamStore('stopped'), { get(target, key) {
    if (key === 'flowExecutionSource' && scene === 'empty') return async () => ({ ...await target.flowExecutionSource(execution.id), vars: { brief: '', task: '' } })
    if (key === 'flowExecutionSource' && scene === 'pending') return () => new Promise(() => {})
    if (key === 'flowExecutionSource' && scene === 'failed') return async () => { throw new Error('The earlier Run’s source could not be read.') }
    if (key === 'previewFlow' && scene === 'superseded') return async () => supersededPreview()
    if (key === 'previewFlow' && scene === 'multiple-seats') return async (...args: Parameters<typeof target.previewFlow>) => multipleSeatPreview(await target.previewFlow(...args), args[3])
    return Reflect.get(target, key)
  } }), [scene])
  return <StoreProvider store={store}><div className="flex flex-wrap gap-3">{RUN_AGAIN_STATES.map(state => <section key={state} data-catalog-state={state}><Button onClick={() => setScene(state)}>Run again… · {state}</Button></section>)}</div>
    {scene && <RunAgain key={scene} execution={execution} root="/repo" sentence="Retry the checkout call" onClose={() => setScene(null)} onStarted={() => setScene(null)} />}
  </StoreProvider>
}

// Matches the host's empty preview when continuation resolution refuses.
const supersededPreview = (): FlowPreview => ({
  token: null,
  compiled: { document: { format: 'legacy', flow: { name: '', roles: [], rules: [], inputs: [], seed: { role: '', title: '' }, wait: 0 } }, bindings: [], problems: [] },
  seats: [], commands: [], guards: [], messaging: 'board-only',
  problems: [{ level: 'error', at: 'run', text: 'A newer Run continues this one. Start work on that Run instead.' }],
})

const multipleSeatPreview = (preview: FlowPreview, options?: FlowRunOptions): FlowPreview => {
  if (preview.compiled.document.format !== 'agents') return preview
  return {
    ...preview,
    compiled: { ...preview.compiled, document: { ...preview.compiled.document, flow: { ...preview.compiled.document.flow,
      roles: preview.compiled.document.flow.roles.map(role => role.id === 'writer' && role.kind === 'agent'
        ? { ...role, seats: [{ runtime: 'codex' }, { runtime: 'codex', effort: 'high' }] } : role),
    } } },
    seats: [0, 1].map(index => {
      const seat = preview.seats[0]!
      const chosen = options?.seats?.writer?.[index]?.effort === 'high' ? 1 : options?.seats?.writer ? 0 : index
      return { ...seat, index, plan: { ...seat.plan, winner: chosen, candidates: seat.plan.candidates.map((candidate, n) => ({ ...candidate, state: n === chosen ? 'taken' : 'untried' })) } }
    }),
  }
}
