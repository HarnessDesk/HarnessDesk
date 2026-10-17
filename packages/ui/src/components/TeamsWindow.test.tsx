import { act, useState } from 'react'
import { DestinationPageScope } from '../panels/destination-page'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { TopBarProvider } from '../panels/top-bar'
import { type TeamFilter } from '../lib/teams-list'
import { TeamsWindow } from './TeamsWindow'
import { overviewTeamStore } from '../preview/team-overview-fixture'
import type { FindingRunView } from '@harnessdesk/protocol'
import type { AppStore } from '../state/store'

const drawn=vi.hoisted(()=>({marks:0,context:null as import('react').Context<boolean>|null}))
vi.mock('./BrandIcons',async original=>{
 const actual=await original<typeof import('./BrandIcons')>()
 const React=await import('react')
 drawn.context??=React.createContext(false)
 return {...actual,RuntimeMark:(props:Parameters<typeof actual.RuntimeMark>[0])=>{if(React.useContext(drawn.context!))drawn.marks+=1;return actual.RuntimeMark(props)}}
})
// Count only marks inside the page when checking the time-cell-only clock.
vi.mock('../design',async original=>{
 const actual=await original<typeof import('../design')>()
 const React=await import('react')
 drawn.context??=React.createContext(false)
 return {...actual,Page:(props:Parameters<typeof actual.Page>[0])=>React.createElement(drawn.context!.Provider,{value:true},
  React.createElement(actual.Page,props))}
})
const TestPage = ({initialFilter='active',filter:controlled,onFilter:change,onNew=()=>{}}: {initialFilter?:TeamFilter;filter?:TeamFilter;onFilter?:(filter:TeamFilter)=>void;onNew?:()=>void}) => {
 const [filter,setFilter]=useState<TeamFilter>(initialFilter)
 return <TeamsWindow filter={controlled??filter} onFilter={change??setFilter} onNew={onNew}/>
}
const PageScope = ({children}: {children:import('react').ReactNode}) => <TopBarProvider><DestinationPageScope owner="destination:teams" active>{children}</DestinationPageScope></TopBarProvider>
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const container=document.createElement('div'); document.body.append(container)
const root=createRoot(container)
beforeEach(()=>{vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:1000} as DOMRect)})
afterEach(()=>{act(()=>root.render(null));vi.restoreAllMocks();vi.unstubAllGlobals()})
const mount=async(scene:Parameters<typeof overviewTeamStore>[0]='running', withoutFindings=false)=>{
 const base=overviewTeamStore(scene)
 if(withoutFindings)base.patch({findingRuns:new Map()})
 const seen=vi.fn(); const hidden=vi.fn(); const open=vi.fn();
 const store=new Proxy(base,{get(target,key){
  if(key==='markTeamSeen')return seen; if(key==='setTeamHidden')return hidden; if(key==='openTeamRoom')return open
  return Reflect.get(target,key)
 }}) as AppStore
 await act(async()=>root.render(<StoreProvider store={store}><PageScope><TestPage/></PageScope></StoreProvider>))
 return {seen,hidden,open}
}
const button=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(one=>one.textContent?.includes(label))!
it('shows three attention columns, cards and the existing face stack',async()=>{
 await mount('running',true)
 expect([...container.querySelectorAll('[data-slot="teams-board-column"]')].map(el=>el.getAttribute('aria-label'))).toEqual(['Needs you','Working','Ready to wrap'])
 expect(container.querySelector('[data-team-row]')?.textContent).toContain('Retry the checkout call')
 expect(container.querySelectorAll('[data-team-row] [data-shape="face"]')).toHaveLength(2)
 expect(container.querySelector('[data-team-row]')?.textContent).toContain('round 2')
 expect(container.querySelector('[role="tablist"]')).toBeNull()
})
it('keeps ready Teams visible without opening a fold',async()=>{
 await mount('done')
 expect(container.querySelector('[aria-label="Ready to wrap"] [data-team-row]')).not.toBeNull()
})
it('opening a card opens the Team once so the host can mark it seen',async()=>{
 const {seen,open}=await mount()
 await act(async()=>container.querySelector<HTMLButtonElement>('[data-team-row]')!.click())
 expect(seen).not.toHaveBeenCalled()
 expect(open).toHaveBeenCalledOnce()
 expect(open).toHaveBeenCalledWith('overview-team')
})
it('shows complete waiting reasons in the attention column',async()=>{
 await mount('needs-you')
 const detail=container.querySelector('[aria-label="Needs you"] [data-slot="team-detail"]')!
 expect(detail.textContent).toContain('choose whether to keep the original payment method')
 expect(detail.getAttribute('title')).toContain('choose whether')
})
it('searches all columns and filters by the projects actually held on the desk',async()=>{
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 await act(async()=>root.render(<StoreProvider store={teamsPageStore()}><PageScope><TestPage/></PageScope></StoreProvider>))
 const search=container.querySelector<HTMLInputElement>('input[aria-label="Search Teams"]')!
 expect(search).not.toBeNull()
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'invoice');search.dispatchEvent(new Event('input',{bubbles:true}))})
 expect(container.querySelectorAll('[data-team-row]')).toHaveLength(1)
 expect(container.querySelector('[data-team-row]')?.textContent).toContain('invoice')
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'');search.dispatchEvent(new Event('input',{bubbles:true}))})
 await act(async()=>container.querySelector<HTMLButtonElement>('button[title="Filter Teams by project"]')!.click())
 const billing=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(el=>el.textContent?.includes('billing'))!
 await act(async()=>billing.click())
 expect(container.querySelectorAll('[data-team-row]')).toHaveLength(1)
 expect(container.querySelector('[data-team-row="team-3"]')).not.toBeNull()
})
it('shows the empty desk and keeps New Team in the body',async()=>{
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 const onNew=vi.fn()
 await act(async()=>root.render(<StoreProvider store={teamsPageStore('empty')}><PageScope><TestPage onNew={onNew}/></PageScope></StoreProvider>))
 expect(container.textContent).toContain('No Teams yet')
 expect(container.querySelector('[data-team-row]')).toBeNull()
 await act(async()=>button('New Team').click())
 expect(onNew).toHaveBeenCalledOnce()
})
it('keeps refresh failures visible',async()=>{
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 await act(async()=>root.render(<StoreProvider store={teamsPageStore('failed')}><PageScope><TestPage/></PageScope></StoreProvider>))
 expect(container.textContent).toContain('The Team usage record could not be read')
})
it('moves a Team to Needs you only after publication is confirmed',async()=>{
 const base=overviewTeamStore('done')
 base.patch({findingRuns:new Map()})
 await act(async()=>root.render(<StoreProvider store={base}><PageScope><TestPage/></PageScope></StoreProvider>))
 expect(container.querySelector('[aria-label="Needs you"] [data-team-row]')).toBeNull()
 const execution=base.getSnapshot().flowExecutions.get('overview-run')!
 const review:FindingRunView={run:execution.id,goal:execution.goal,publication:'local',rounds:[{round:2,state:'local',reason:null,pr:7,cards:[2,3]}],boundPr:{repo:'acme/widgets',pr:7},reason:'The review is waiting to be posted.',
  round:2,finished:2,total:2,embargoed:false,open:0,blocking:0,ceilingStop:false,stamp:'read-1',reviewersFinished:null,reviewersTotal:null,pendingExceptions:[],repair:null,unbound:null,undecidable:null}
 await act(async()=>base.patch({findingRuns:new Map([[execution.id,review]])}))
 expect(container.querySelector('[aria-label="Needs you"] [data-team-row]')?.textContent).toContain(review.reason)
})

type Snapshot=ReturnType<AppStore['getSnapshot']>
/** The teams-page rig with some Goals edited and every read the page makes recorded; `land` changes what the store holds, as an answer does. */
const recorded=async(edit:(snapshot:Snapshot)=>Partial<Snapshot>=()=>({}))=>{
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 const base=teamsPageStore('active')
 let snapshot={...base.getSnapshot(),...edit(base.getSnapshot())}
 const listeners=new Set<()=>void>()
 const land=(change:(snapshot:Snapshot)=>Partial<Snapshot>)=>{snapshot={...snapshot,...change(snapshot)};for(const notify of listeners)notify()}
 const insights=vi.fn(async()=>({reports:[],failed:[]}))
 const runs=vi.fn(async(_runs:readonly string[])=>{})
 const findings=vi.fn(async(_goal:string,_run:string)=>{})
 const store=new Proxy(base,{get(target,key){
  if(key==='getSnapshot')return ()=>snapshot
  if(key==='subscribe')return (notify:()=>void)=>{listeners.add(notify);return ()=>listeners.delete(notify)}
  if(key==='readGoalInsights')return insights
  if(key==='readFlowExecutions')return runs
  if(key==='loadFindingRun')return findings
  return Reflect.get(target,key)
 }}) as AppStore
 return {store,base,insights,runs,findings,land}
}

it('filters and refreshes the board without requesting unused usage reports',async()=>{
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']})
 try {
  const {store,insights,land}=await recorded()
  await act(async()=>root.render(<StoreProvider store={store}><PageScope><TestPage/></PageScope></StoreProvider>))
  const search=container.querySelector<HTMLInputElement>('input[aria-label="Search Teams"]')!
  for(const value of ['r','re','rev',''])await act(async()=>{
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,value)
   search.dispatchEvent(new Event('input',{bubbles:true}))
  })
  await act(async()=>land(snapshot=>({teams:new Map([...snapshot.teams].map(([id,team])=>[id,{...team,intents:team.intents.map(card=>({...card,state:'done' as const}))}]))})))
  await act(async()=>button('Wrapped').click())
  await act(async()=>vi.advanceTimersByTimeAsync(60_000))
  expect(insights).not.toHaveBeenCalled()
 } finally {act(()=>root.render(null));vi.useRealTimers()}
})

it('reads a wrapped Team\'s Run once its row is shown, and never its review',async()=>{
 const {store,runs,findings}=await recorded(snapshot=>{
  const goals=new Map(snapshot.goals)
  for(const id of ['team-3','team-4']){const view=goals.get(id)!;goals.set(id,{...view,goal:{...view.goal,state:'wrapped'}})}
  const flowExecutions=new Map(snapshot.flowExecutions);flowExecutions.delete('team-3-run')
  return {goals,flowExecutions}
 })
 await act(async()=>root.render(<StoreProvider store={store}><PageScope><TestPage/></PageScope></StoreProvider>))
 expect(runs).not.toHaveBeenCalled()
 expect(findings.mock.calls.map(([goal])=>goal).sort()).toEqual(['team-0','team-1','team-2'])
 await act(async()=>button('Wrapped').click())
 expect(runs.mock.calls).toEqual([[['team-3-run']]])
 expect(findings.mock.calls.map(([goal])=>goal).sort()).toEqual(['team-0','team-1','team-2'])
})

it('asks for each Run and review once while the page is open, however many answers land',async()=>{
 const missing=['team-0-run','team-1-run','team-2-run']
 const {store,base,runs,findings,land}=await recorded(snapshot=>{
  const flowExecutions=new Map(snapshot.flowExecutions);for(const run of missing)flowExecutions.delete(run)
  return {flowExecutions}
 })
 await act(async()=>root.render(<StoreProvider store={store}><PageScope><TestPage/></PageScope></StoreProvider>))
 expect(runs.mock.calls).toEqual([[missing]])
 for(const run of missing){
  await act(async()=>land(snapshot=>({flowExecutions:new Map([...snapshot.flowExecutions,[run,base.getSnapshot().flowExecutions.get(run)!]])})))
 }
 await act(async()=>land(snapshot=>({findingRuns:new Map([...snapshot.findingRuns,['team-0-run',{run:'team-0-run',goal:'team-0',round:1,finished:1,total:1,embargoed:false,open:0,blocking:0,reason:null,ceilingStop:false,stamp:'read-1',publication:'local',rounds:[],reviewersFinished:null,reviewersTotal:null,pendingExceptions:[],repair:null,boundPr:null,unbound:null,undecidable:null} satisfies FindingRunView]])})))
 expect(runs).toHaveBeenCalledOnce()
 expect(findings.mock.calls.map(([goal,run])=>`${goal} ${run}`).sort()).toEqual(['team-0 team-0-run','team-1 team-1-run','team-2 team-2-run','team-3 team-3-run','team-4 team-4-run'])
})

it('retries only failed Run and review reads after a delay, without duplicating pending or successful reads',async()=>{
 vi.useFakeTimers()
 try {
  const missing=['team-0-run','team-1-run']
  const {store,base,runs,findings,land}=await recorded(snapshot=>{
   const flowExecutions=new Map(snapshot.flowExecutions);for(const run of missing)flowExecutions.delete(run)
   return {flowExecutions}
  })
  let finish!:()=>void
  // The real batch reader resolves even when one request was refused.
  runs.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=()=>{
   land(snapshot=>({flowExecutions:new Map([...snapshot.flowExecutions,['team-0-run',base.getSnapshot().flowExecutions.get('team-0-run')!]])}))
   resolve()
  }})).mockImplementation(async ids=>{
   land(snapshot=>({flowExecutions:new Map([...snapshot.flowExecutions,...ids.map(id=>[id,base.getSnapshot().flowExecutions.get(id)!] as const)])}))
  })
  findings.mockImplementation(async goal=>{if(goal==='team-2')throw new Error('temporarily unavailable')})
  await act(async()=>root.render(<StoreProvider store={store}><PageScope><TestPage/></PageScope></StoreProvider>))
  await act(async()=>land(snapshot=>({goals:new Map(snapshot.goals)})))
  await act(async()=>vi.advanceTimersByTimeAsync(5_000))
  expect(runs.mock.calls).toEqual([[missing]])
  expect(findings.mock.calls.filter(([goal])=>goal==='team-2')).toHaveLength(2)
  await act(async()=>finish())
  findings.mockImplementation(async()=>{})
  const succeeded=findings.mock.calls.filter(([goal])=>goal!=='team-2')
  await act(async()=>vi.advanceTimersByTimeAsync(5_000))
  expect(runs.mock.calls).toEqual([[missing],[['team-1-run']]])
  expect(findings.mock.calls.filter(([goal])=>goal==='team-2')).toHaveLength(3)
  // Two refusals, then success; further snapshots and time never reread it.
  await act(async()=>land(snapshot=>({goals:new Map(snapshot.goals)})))
  await act(async()=>vi.advanceTimersByTimeAsync(60_000))
  expect(runs).toHaveBeenCalledTimes(2)
  expect(findings.mock.calls.filter(([goal])=>goal==='team-2')).toHaveLength(3)
  for(const [goal,run] of succeeded)expect(findings.mock.calls.filter(call=>call[0]===goal&&call[1]===run)).toHaveLength(1)
 } finally {act(()=>root.render(null));vi.useRealTimers()}
})

it('bounds permanent Run and review refusals to three attempts and cancels retries on close',async()=>{
 vi.useFakeTimers()
 try {
  const {store,runs,findings,land}=await recorded(snapshot=>{
   const flowExecutions=new Map(snapshot.flowExecutions);flowExecutions.delete('team-0-run')
   return {flowExecutions}
  })
  runs.mockRejectedValue(new Error('Run unavailable'))
  findings.mockRejectedValue(new Error('review unavailable'))
  const render=()=>root.render(<StoreProvider store={store}><PageScope><TestPage/></PageScope></StoreProvider>)
  await act(async()=>render())
  await act(async()=>vi.advanceTimersByTimeAsync(5_000))
  await act(async()=>vi.advanceTimersByTimeAsync(5_000))
  await act(async()=>vi.advanceTimersByTimeAsync(50_000))
  await act(async()=>land(snapshot=>({goals:new Map(snapshot.goals)})))
  expect(runs).toHaveBeenCalledTimes(3)
  for(const goal of ['team-1','team-2','team-3','team-4'])expect(findings.mock.calls.filter(call=>call[0]===goal)).toHaveLength(3)
  act(()=>root.render(null));runs.mockClear();findings.mockClear()
  await act(async()=>render())
  act(()=>root.render(null))
  await act(async()=>vi.advanceTimersByTimeAsync(60_000))
  expect(runs).toHaveBeenCalledOnce()
  expect(findings).toHaveBeenCalledTimes(4)
 } finally {act(()=>root.render(null));vi.useRealTimers()}
})

it('says time in a state in hours and days, and only the time cells follow a minute clock',async()=>{
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']})
 try {
  const now=Date.now()
  const {store}=await recorded(snapshot=>{
   const flowExecutions=new Map(snapshot.flowExecutions)
   for(const [run,endedAt] of [['team-3-run',now-63*3_600_000],['team-4-run',now-5*3_600_000-20*60_000]] as const)flowExecutions.set(run,{...flowExecutions.get(run)!,startedAt:endedAt,endedAt})
  const goals=new Map(snapshot.goals)
  for(const [id,createdAt] of [['team-3',now-63*3_600_000],['team-4',now-5*3_600_000-20*60_000]] as const){const view=goals.get(id)!;goals.set(id,{...view,goal:{...view.goal,createdAt}})}
  return {flowExecutions,goals}
  })
  await act(async()=>root.render(<StoreProvider store={store}><PageScope><TestPage/></PageScope></StoreProvider>))
  const time=(id:string)=>container.querySelector(`[data-team-row="${id}"] [data-slot="team-age"]`)!.textContent
  expect([time('team-3'),time('team-4')]).toEqual(['3d','5h'])
  const before=time('team-2'); const marks=drawn.marks
  expect(marks).toBeGreaterThan(0)
  await act(async()=>{vi.advanceTimersByTime(59_000)})
  expect(drawn.marks).toBe(marks)
  await act(async()=>{vi.advanceTimersByTime(1_000)})
  expect(time('team-2')).not.toBe(before)
  expect(drawn.marks).toBe(marks)
 } finally { vi.useRealTimers() }
})


it('keeps New Team, project scope and search in the first body row',async()=>{
 await mount()
 const first=container.querySelector('[data-slot="page"]')!.firstElementChild!
 expect(first.getAttribute('data-slot')).toBe('teams-board-toolbar')
 expect(first.textContent).toContain('New Team')
 expect(first.textContent).toContain('All projects')
 expect(first.querySelector('input[aria-label="Search Teams"]')).not.toBeNull()
})

it('E5 retained inactive Teams stops retry timers',async()=>{
 vi.useFakeTimers()
 try {
  const {store,insights,runs,findings,land}=await recorded(snapshot=>{const flowExecutions=new Map(snapshot.flowExecutions);flowExecutions.delete('team-0-run');return {flowExecutions}})
  runs.mockRejectedValue(new Error('Run unavailable'));findings.mockRejectedValue(new Error('Review unavailable'))
  const render=(active:boolean)=>root.render(<StoreProvider store={store}><PageScope><DestinationPageScope owner="destination:teams" active={active}><TestPage/></DestinationPageScope></PageScope></StoreProvider>)
  await act(async()=>render(true))
  expect(insights).not.toHaveBeenCalled()
  await act(async()=>render(false))
  await act(async()=>vi.advanceTimersByTimeAsync(60_000))
  await act(async()=>land(snapshot=>({goals:new Map(snapshot.goals)})))
  expect(insights).not.toHaveBeenCalled();expect(runs).toHaveBeenCalledOnce()
  expect(findings).toHaveBeenCalledTimes(4)
 } finally {act(()=>root.render(null));vi.useRealTimers()}
})

it('E5 controlled page opens a room exactly once',async()=>{
 const base=overviewTeamStore('running'),open=vi.fn(),close=vi.fn()
 const store=new Proxy(base,{get(target,key){if(key==='openTeamRoom')return open;return Reflect.get(target,key)}}) as AppStore
 await act(async()=>root.render(<StoreProvider store={store}><TopBarProvider><DestinationPageScope owner="destination:teams" active><TeamsWindow filter="active" onFilter={()=>{}} onNew={()=>{}}/></DestinationPageScope></TopBarProvider></StoreProvider>))
 await act(async()=>container.querySelector<HTMLButtonElement>('[data-team-row][aria-label^="Open "]')!.click())
 expect(open).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled()
})
