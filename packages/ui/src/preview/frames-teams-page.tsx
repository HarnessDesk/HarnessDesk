import { useMemo } from 'react'
import { AppWindowMode } from '../components/AppWindow'
import { TeamsWindow } from '../components/TeamsWindow'
import { StoreProvider } from '../state/context'
import { teamsPageStore, TEAMS_PAGE_STATES, type TeamsScene } from './teams-page-fixture'

export const TeamsExample=({scene}:{scene:TeamsScene})=>{
 const store=useMemo(()=>teamsPageStore(scene),[scene])
 return <div className={scene==='narrow'?'relative h-176 max-w-sm':'relative h-144'} style={{transform:'translateZ(0)'}}><StoreProvider store={store}><AppWindowMode.Provider value="embedded"><TeamsWindow onClose={()=>{}} initialFilter={scene==='needs-you'||scene==='settled'?scene:'active'}/></AppWindowMode.Provider></StoreProvider></div>
}
export const TeamsPageBoard=()=> <div className="flex flex-col gap-4">{TEAMS_PAGE_STATES.map(scene=><section key={scene} data-catalog-state={scene}><TeamsExample scene={scene}/></section>)}</div>
export const TeamsPageFrames=()=> <div className="flex flex-col gap-4 p-4">{TEAMS_PAGE_STATES.map(scene=><section key={scene} id={`teams-page-${scene}`}><TeamsExample scene={scene}/></section>)}</div>
