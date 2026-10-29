import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { TeamOverview } from '../components/TeamOverview'
import { TeamFramePreview } from './TeamFramePreview'
import { SessionTree } from '../components/SessionTree'
import { RailSection } from '../design'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { sidebarTeamAttention } from './sidebar-fixture'
import { previewStore } from './harness'
import { overviewModel, overviewTeamStore, OVERVIEW_STATES, type OverviewScene } from './team-overview-fixture'
import { needsYouAnswers, needsYouModel, NEEDS_YOU_STATES, type NeedsYouScene } from './needs-you-fixture'

/** The host's own words for refusing an answer another door already gave. */
const REFUSAL = 'This card was already answered.'

/**
 * A state that only exists after an answer is refused: the answer is pressed once the frame has drawn, as a person
 * would, so the catalogue and the preview show the production row's own refused state and not a picture of it.
 */
const Pressed = ({ label, children }: { label: string; children: ReactNode }) => {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { [...box.current?.querySelectorAll('button') ?? []].find(one => one.textContent === label)?.click() }, [label])
  return <div ref={box}>{children}</div>
}
/** The Overview with its Needs-you rows answerable, as the pane draws it. */
export const NeedsYouExample = ({ scene }: { scene: NeedsYouScene }) => {
  const overview = <TeamOverview model={needsYouModel(scene)} answers={needsYouAnswers(scene, scene === 'refused' ? REFUSAL : null)} onOpen={() => {}} runName="Build and review" />
  return scene === 'refused' ? <Pressed label="Approved">{overview}</Pressed> : overview
}

/** Both the catalogue and preview mount the production component. */
export const OverviewExample = ({scene}:{scene:OverviewScene}) => {
 const model=overviewModel(scene)
 const runtimeName=previewStore().getSnapshot().runtimes[0]!.presentation.name
 return <TeamOverview uncheckedDone={scene==='unchecked'?141:0} onBoard={()=>{}} onWrap={scene==='unchecked'?()=>{}:undefined} model={model} runtimeNames={new Map(model.seats.map(seat=>[seat.seat,runtimeName]))} runRules={[{id:'to-referee'}]} runName={scene==='comparison'?'Compare the changes':'Build and review'} runReason={scene==='comparison'?'Rule to-referee: Waiting for 3 open blocking findings to be confirmed resolved.':scene==='stalled'?'Choose the target before this Run can continue':null} defaultExpanded={scene==='done-open'||scene==='comparison'} onOpen={() => {}} onFindings={() => {}} />
}

export const TeamOverviewBoard = () => <div className="flex flex-col gap-4">{OVERVIEW_STATES.map(scene=><section key={scene} data-catalog-state={scene} className={scene==='narrow'?'max-w-sm':''}><OverviewExample scene={scene} /></section>)}
 {NEEDS_YOU_STATES.map(scene=><section key={scene} data-catalog-state={`answer-${scene}`} className={scene==='narrow'?'max-w-sm':''}><NeedsYouExample scene={scene} /></section>)}</div>

/** The focused specimen's authored account data is available to its frame audit. */
export const overviewPreviewStore = previewStore({
 theme: new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light',
 accountsByRuntime: {},
})
const OverviewTheme = () => { useTheme(); return null }
const OverviewFrame = ({scene}:{scene:OverviewScene}) => <section id={`team-overview-${scene}`} className={scene==='narrow'?'max-w-sm':''}><h2>{scene}</h2><div className={scene==='narrow'?'max-w-sm':''}><OverviewExample scene={scene} /></div></section>

/** The gallery's same narrow allocation, with its own account-free store. */
export const TeamOverviewPreview = () => <StoreProvider store={overviewPreviewStore}><OverviewTheme /><div className="p-4"><div className="flex flex-col gap-4 p-4"><OverviewFrame scene="narrow" /></div></div></StoreProvider>

export const TeamOverviewFrames = () => {
 const store=useMemo(() => overviewTeamStore(),[])
 const sidebarStore=useMemo(() => overviewTeamStore('running'),[])
 const attentionStore=useMemo(() => {
   const source=overviewTeamStore('done').getSnapshot()
   const rows=sidebarTeamAttention(source.goals.get('overview-team')!)
   return previewStore({...source,goals:new Map(rows.map(view=>[view.goal.id,view])),teams:new Map(rows.map(view=>[view.board.id,view.board])),flowExecutions:new Map(),sessions:new Map(),history:[],inbox:[]})
 },[])
 const liveStores=useMemo(() => (['running','needs-you','stalled','waiting-evidence','unreadable-ledger','findings-and-posting','stopped-unknown','unrouted','unchecked'] as const).map(scene=>({scene,store:overviewTeamStore(scene)})),[])
 return <div className="flex flex-col gap-4 p-4">{OVERVIEW_STATES.map(scene=><OverviewFrame key={scene} scene={scene} />)}
 {NEEDS_YOU_STATES.map(scene=><section key={scene} id={`team-overview-answer-${scene}`} className={scene==='narrow'?'max-w-sm':''}><h2>answer {scene}</h2><NeedsYouExample scene={scene} /></section>)}
 {liveStores.map(({scene,store})=><section key={scene} id={`team-overview-live-${scene}`} className="h-144"><StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider></section>)}
 <section id="team-overview-team" className="h-96"><StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider></section>
 <section id="team-attention-sidebar" className="w-72"><StoreProvider store={attentionStore}><RailSection stretch="list"><SessionTree now={Date.now()} /></RailSection></StoreProvider></section>
 <section id="team-overview-sidebar" className="w-72"><StoreProvider store={sidebarStore}><RailSection stretch="list"><SessionTree now={Date.now()} /></RailSection></StoreProvider></section></div>
}
