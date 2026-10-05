import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppWindowMode } from './AppWindow'
import { TeamsWindow } from './TeamsWindow'
import { overviewTeamStore } from '../preview/team-overview-fixture'
import type { FindingRunView } from '@harnessdesk/protocol'
import { teamsInput } from '../lib/teams-snapshot'
import { teamsList } from '../lib/teams-list'
import type { AppStore } from '../state/store'

;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const container=document.createElement('div'); document.body.append(container)
const root=createRoot(container)
beforeEach(()=>{vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:1000} as DOMRect)})
afterEach(()=>{act(()=>root.render(null));vi.restoreAllMocks();vi.unstubAllGlobals()})
const mount=async(scene:Parameters<typeof overviewTeamStore>[0]='running')=>{
 const base=overviewTeamStore(scene)
 const seen=vi.fn(); const hidden=vi.fn(); const open=vi.fn(); const close=vi.fn()
 const store=new Proxy(base,{get(target,key){
  if(key==='markTeamSeen')return seen; if(key==='setTeamHidden')return hidden; if(key==='openTeamRoom')return open
  return Reflect.get(target,key)
 }}) as AppStore
 await act(async()=>root.render(<StoreProvider store={store}><AppWindowMode.Provider value="embedded"><TeamsWindow onClose={close}/></AppWindowMode.Provider></StoreProvider>))
 return {seen,hidden,open,close}
}
const button=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(one=>one.textContent?.includes(label))!
it('opens Active with counts and the real Team sentence, face stack and earned round',async()=>{
 await mount()
 expect(container.querySelector('nav [aria-current="page"]')?.textContent).toContain('Active')
 expect(container.querySelector('[data-team-row]')?.textContent).toContain('Retry the checkout call')
 expect(container.querySelectorAll('[data-team-row] [data-shape="face"]')).toHaveLength(2)
 expect(container.querySelector('[data-team-row]')?.textContent).toContain('Round 2')
})
it('folds Ready to wrap, lets Settled open it, and Hide never deletes it',async()=>{
 const {hidden}=await mount('done')
 expect(container.querySelector('[data-team-row]')).toBeNull()
 await act(async()=>button('Ready to wrap').click())
 expect(container.querySelector('[data-team-row]')).not.toBeNull()
 await act(async()=>container.querySelector<HTMLButtonElement>('button[title="More"]')!.click())
 await act(async()=>button('Hide').click())
 expect(hidden).toHaveBeenCalledWith('overview-team',true)
 await act(async()=>button('Settled').click())
 expect(container.querySelector('[data-team-row]')).not.toBeNull()
})
it('opening a row records exactly its observed change and opens the Team',async()=>{
 const {seen,open,close}=await mount()
 await act(async()=>container.querySelector('[data-team-row]')!.dispatchEvent(new MouseEvent('click',{bubbles:true})))
 expect(seen).toHaveBeenCalledWith('overview-team',expect.any(String))
 expect(open).toHaveBeenCalledWith('overview-team',expect.any(String))
 expect(close).toHaveBeenCalledOnce()
})
it('shows a complete waiting reason, and usage read failures leave a dash',async()=>{
 await mount('needs-you')
 expect(container.querySelector('[data-team-row] [data-slot="team-detail"]')?.textContent).toContain('choose whether to keep the original payment method')
 expect(container.querySelector('[data-team-row] [data-slot="team-detail"]')?.getAttribute('title')).toContain('choose whether')
})

it('keeps pending and failed usage visibly different from a known zero, and names a refresh failure',async()=>{
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 await act(async()=>root.render(<StoreProvider store={teamsPageStore('pending')}><AppWindowMode.Provider value="embedded"><TeamsWindow onClose={()=>{}}/></AppWindowMode.Provider></StoreProvider>))
 expect(container.textContent).toContain('Reading recorded usage')
 expect(container.textContent).not.toContain('$0.00')
 await act(async()=>root.render(<StoreProvider store={teamsPageStore('failed')}><AppWindowMode.Provider value="embedded"><TeamsWindow onClose={()=>{}}/></AppWindowMode.Provider></StoreProvider>))
 expect(container.textContent).toContain('The Team usage record could not be read')
 expect(container.textContent).not.toContain('Reading recorded usage')
})
it('shows the empty desk without inventing a Team',async()=>{
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 await act(async()=>root.render(<StoreProvider store={teamsPageStore('empty')}><AppWindowMode.Provider value="embedded"><TeamsWindow onClose={()=>{}}/></AppWindowMode.Provider></StoreProvider>))
 expect(container.textContent).toContain('No active Teams')
 expect(container.querySelector('[data-team-row]')).toBeNull()
})

it('tints only attention and working states, leaving ready rows in plain words',async()=>{
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 await act(async()=>root.render(<StoreProvider store={teamsPageStore()}><AppWindowMode.Provider value="embedded"><TeamsWindow onClose={()=>{}}/></AppWindowMode.Provider></StoreProvider>))
 await act(async()=>button('Ready to wrap').click())
 const chips=[...container.querySelectorAll('[data-team-row] [data-slot="chip"]')]
 expect(chips).toHaveLength(3)
 expect(chips.map(chip=>[chip.textContent,chip.getAttribute('data-variant'),chip.getAttribute('data-tone')])).toEqual([
  ['Needs you','default','warning'],['Needs you','default','warning'],['Working','default','info'],
 ])
})

it('the rig has differing recorded turn totals consistent with its Seat partitions',async()=>{
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 const store=teamsPageStore()
 const reports=await Promise.all([...store.getSnapshot().goals.keys()].map(id=>store.readGoalInsight(id)))
 const turns=reports.map(report=>report.totals.turns.value)
 expect(new Set(turns).size).toBe(5)
 expect(turns.every(value=>value!==null&&value>0)).toBe(true)
 for(const report of reports) {
  const seats=report.breakdowns.find(group=>group.dimension==='seat')!
  expect(seats.rows.reduce((sum,row)=>sum+(row.amounts.turns.value??0),seats.unattributed.turns.value??0)).toBe(report.totals.turns.value)
 }
})

it('reads an uncached Run and only counts its Team as Needs you after publication is confirmed', async () => {
 const base = overviewTeamStore('done')
 let snapshot = base.getSnapshot()
 const execution = snapshot.flowExecutions.get('overview-run')!
 const listeners = new Set<() => void>()
 let answer!: () => void
 const findingRun: FindingRunView = { run: execution.id, goal: execution.goal, round: 2, finished: 2, total: 3,
  embargoed: false, open: 1, blocking: 1, reason: 'The closed review is waiting to be posted.', ceilingStop: false,
  stamp: 'read-1', publication: 'local', rounds: [{ round: 2, state: 'local', reason: null, pr: 7, cards: [2,3] }],
  reviewersFinished: null, reviewersTotal: null, pendingExceptions: [], repair: null,
  boundPr: { repo: 'acme/widgets', pr: 7 }, unbound: null, undecidable: null }
 const read = vi.fn(() => new Promise<void>(resolve => { answer = () => {
  snapshot = { ...snapshot, findingRuns: new Map([[execution.id, findingRun]]) }
  for (const notify of listeners) notify()
  resolve()
 } }))
 const store = new Proxy(base, { get(target, key) {
  if (key === 'getSnapshot') return () => snapshot
  if (key === 'subscribe') return (notify: () => void) => { listeners.add(notify); return () => listeners.delete(notify) }
  if (key === 'loadFindingRun') return read
  return Reflect.get(target, key)
 } })
 await act(async () => root.render(<StoreProvider store={store}><AppWindowMode.Provider value="embedded"><TeamsWindow onClose={() => {}} /></AppWindowMode.Provider></StoreProvider>))
 expect(read).toHaveBeenCalledWith(execution.goal, execution.id)
 expect(teamsList(teamsInput(snapshot)).counts['needs-you']).toBe(0)
 expect(container.textContent).not.toContain('The closed review is waiting to be posted.')
 await act(async () => answer())
 const input = teamsInput(snapshot)[0]!
 expect(input.overview.run?.needsYou).toBe(true)
 expect(teamsList([input]).counts['needs-you']).toBe(1)
 expect(container.querySelector('[data-team-row]')?.textContent).toContain('Needs you')
 expect(container.querySelector('[data-team-row]')?.textContent).toContain('The closed review is waiting to be posted.')
})

it('keeps unread before the name and separates numeric readings under headers',async()=>{
 await mount('needs-you')
 const row=container.querySelector('[data-team-row]')!
 expect(row.querySelector('[data-slot="team-identity"] [aria-label="Unread changes"]')).not.toBeNull()
 expect([...container.querySelectorAll('th[data-align="end"]')].map(one=>one.textContent)).toEqual(['Time','Turns'])
 expect(row.querySelectorAll('td[data-align="end"]')).toHaveLength(2)
})

it('omits the money column when every displayed Team has unknown money',async()=>{
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 await act(async()=>root.render(<StoreProvider store={teamsPageStore('pending')}><AppWindowMode.Provider value="embedded"><TeamsWindow onClose={()=>{}}/></AppWindowMode.Provider></StoreProvider>))
 expect([...container.querySelectorAll('th')].map(one=>one.textContent)).not.toContain('Cost')
})

it('observes the page after the window mounts it and switches narrow Teams to list rows',async()=>{
 const observed=vi.fn()
 vi.stubGlobal('ResizeObserver',class {
  constructor(private callback:ResizeObserverCallback){}
  observe(node:Element){observed(node);this.callback([{target:node,contentRect:{width:352}}] as ResizeObserverEntry[],this as unknown as ResizeObserver)}
  unobserve(){}
  disconnect(){}
 })
 await mount()
 expect(observed).toHaveBeenCalled()
 expect(container.querySelector('table')).toBeNull()
 expect(container.querySelector('[data-team-row] [data-slot="list-row-content"]')).not.toBeNull()
})

it.each([352,1000])('a portalled Team menu panel does not open its row at %spx',async width=>{
 vi.stubGlobal('ResizeObserver',class {
  constructor(private callback:ResizeObserverCallback){}
  observe(target:Element){if(target.matches('[data-slot="teams-page"]'))this.callback([{target,contentRect:{width}}] as ResizeObserverEntry[],this as unknown as ResizeObserver)}
  unobserve(){}
  disconnect(){}
 })
 const {seen,open,close}=await mount('done')
 await act(async()=>button('Ready to wrap').click())
 const row=container.querySelector('[data-team-row]')!
 await act(async()=>row.querySelector<HTMLButtonElement>('button[title="More"]')!.click())
 const panel=document.querySelector('[data-slot="popover-popup"]')!
 expect(panel).toBeDefined()
 await act(async()=>panel.dispatchEvent(new MouseEvent('click',{bubbles:true})))
 expect(open).not.toHaveBeenCalled();expect(seen).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
 expect(row.querySelector('button[aria-label^="Open "]')?.getAttribute('aria-label')).toBe('Open Retry the checkout call')
 await act(async()=>document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
})

it('explains unavailable time and both known and unavailable money',async()=>{
 await mount('waiting-evidence')
 const time=container.querySelector('[data-team-row] td[data-align="end"] [data-slot="text"]')!
 expect(time.textContent).toBe('—')
 expect(time.getAttribute('title')).toBe('Time in this state is unavailable')
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 const base=teamsPageStore('active')
 const snapshot=base.getSnapshot()
 const meteredSnapshot={...snapshot,runtimes:snapshot.runtimes.map(runtime=>({...runtime,capabilities:{...runtime.capabilities,metered:true}}))}
 const store=new Proxy(base,{get(target,key){
  if(key==='getSnapshot')return ()=>meteredSnapshot
  if(key==='readGoalInsight')return (id:string)=>id==='team-0'?Promise.reject(new Error('Usage unavailable')):target.readGoalInsight(id)
  return Reflect.get(target,key)
 }})
 await act(async()=>root.render(<StoreProvider store={store}><AppWindowMode.Provider value="embedded"><TeamsWindow onClose={()=>{}}/></AppWindowMode.Provider></StoreProvider>))
 const money=(id:string)=>container.querySelector(`[data-team-row="${id}"] td[data-align="end"]:nth-last-child(2) [data-slot="text"]`)!
 expect(money('team-0').textContent).toBe('—')
 expect(money('team-0').getAttribute('title')).toBe('Recorded usage is unavailable')
 expect(money('team-1').getAttribute('title')).toBe('Recorded Team usage; money only from metered accounts with a known rate')
})

it('opens the wide Team once through its named button',async()=>{
 const {open}=await mount()
 const row=container.querySelector('[data-team-row]')!
 const action=row.querySelector<HTMLButtonElement>('button[aria-label^="Open "]')
 expect(action).not.toBeNull()
 await act(async()=>action!.click())
 expect(open).toHaveBeenCalledOnce()
})
