import { useMemo } from 'react'
import { TeamOverview } from '../components/TeamOverview'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { SessionTree } from '../components/SessionTree'
import { StoreProvider } from '../state/context'
import { overviewModel, overviewTeamStore, OVERVIEW_STATES, type OverviewScene } from './team-overview-fixture'

/** Both the catalogue and preview mount the production component. */
export const OverviewExample = ({scene}:{scene:OverviewScene}) => <TeamOverview model={overviewModel(scene)} runName="Build and review" runReason={scene==='stalled'?'Choose the target before this Run can continue':null} defaultExpanded={scene==='done-open'} />
export const TeamOverviewBoard = () => <div className="flex flex-col gap-4">{OVERVIEW_STATES.map(scene=><section key={scene} data-catalog-state={scene} className={scene==='narrow'?'max-w-sm':''}><OverviewExample scene={scene} /></section>)}</div>
export const TeamOverviewFrames = () => {
 const store=useMemo(overviewTeamStore,[])
 return <div className="flex flex-col gap-4 p-4">{OVERVIEW_STATES.map(scene=><section key={scene} id={`team-overview-${scene}`} className={scene==='narrow'?'max-w-sm':''}><h2>{scene}</h2><div className={scene==='narrow'?'max-w-sm':''}><OverviewExample scene={scene} /></div></section>)}
 <section id="team-overview-team" className="h-96"><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>
 <section id="team-overview-sidebar" className="w-72"><StoreProvider store={store}><SessionTree now={Date.now()} /></StoreProvider></section></div>
}
