import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { TeamOverview } from '../components/TeamOverview'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { SessionTree } from '../components/SessionTree'
import { RailSection } from '../design'
import { StoreProvider } from '../state/context'
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
export const OverviewExample = ({scene}:{scene:OverviewScene}) => <TeamOverview model={overviewModel(scene)} runName="Build and review" runReason={scene==='stalled'?'Choose the target before this Run can continue':null} defaultExpanded={scene==='done-open'} />
export const TeamOverviewBoard = () => <div className="flex flex-col gap-4">{OVERVIEW_STATES.map(scene=><section key={scene} data-catalog-state={scene} className={scene==='narrow'?'max-w-sm':''}><OverviewExample scene={scene} /></section>)}
 {NEEDS_YOU_STATES.map(scene=><section key={scene} data-catalog-state={`answer-${scene}`} className={scene==='narrow'?'max-w-sm':''}><NeedsYouExample scene={scene} /></section>)}</div>
export const TeamOverviewFrames = () => {
 const store=useMemo(() => overviewTeamStore(),[])
 const sidebarStore=useMemo(() => overviewTeamStore('running'),[])
 const liveStores=useMemo(() => (['running','needs-you','stalled','waiting-evidence','unrouted'] as const).map(scene=>({scene,store:overviewTeamStore(scene)})),[])
 return <div className="flex flex-col gap-4 p-4">{OVERVIEW_STATES.map(scene=><section key={scene} id={`team-overview-${scene}`} className={scene==='narrow'?'max-w-sm':''}><h2>{scene}</h2><div className={scene==='narrow'?'max-w-sm':''}><OverviewExample scene={scene} /></div></section>)}
 {NEEDS_YOU_STATES.map(scene=><section key={scene} id={`team-overview-answer-${scene}`} className={scene==='narrow'?'max-w-sm':''}><h2>answer {scene}</h2><NeedsYouExample scene={scene} /></section>)}
 {liveStores.map(({scene,store})=><section key={scene} id={`team-overview-live-${scene}`} className="h-144"><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>)}
 <section id="team-overview-team" className="h-96"><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>
 <section id="team-overview-sidebar" className="w-72"><StoreProvider store={sidebarStore}><RailSection stretch="list"><SessionTree now={Date.now()} /></RailSection></StoreProvider></section></div>
}
