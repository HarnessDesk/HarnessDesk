import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeId, type LedgerReport, type LedgerQuery } from '@harnessdesk/protocol'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider } from '../panels/top-bar'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { dashboardDestinationStore } from '../preview/dashboard-destination-fixture'
import { DashboardPage } from './Usage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); document.body.replaceChildren(); vi.useRealTimers() })
const setup = () => {
  const snapshot = {...emptySnapshot(),workspace:{path:'/work/storefront',name:'Storefront',lastOpenedAt:0}}
  const ledger = vi.fn(async (_query:LedgerQuery):Promise<LedgerReport|null> => null), loadUsage = vi.fn(async () => {}), refreshUsage = vi.fn(async () => {}), readUsageInsight = vi.fn(async () => null)
  const store = {getSnapshot:()=>snapshot,subscribe:()=>()=>{},ledger,loadUsage,refreshUsage,readUsageInsight} as unknown as AppStore
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);roots.push(root)
  const draw = async (active:boolean,scope:ReturnType<typeof runtimeId>|null=null) => act(async()=>root.render(<StoreProvider store={store}><TopBarProvider>
    <DestinationPageScope owner="destination:dashboard" active={active}><DashboardPage view="spend" scope={scope} onView={()=>{}} onScope={()=>{}} /></DestinationPageScope>
  </TopBarProvider></StoreProvider>))
  return {node,store,draw,ledger,loadUsage,refreshUsage,readUsageInsight}
}
it('pauses clock, usage refresh and corpus reads while hidden, then resumes once',async()=>{
  vi.useFakeTimers()
  const fixture=setup()
  await fixture.draw(false)
  expect(fixture.ledger).not.toHaveBeenCalled();expect(fixture.loadUsage).not.toHaveBeenCalled();expect(fixture.readUsageInsight).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  await fixture.draw(true)
  expect(fixture.ledger).toHaveBeenCalledTimes(3);expect(fixture.loadUsage).toHaveBeenCalledTimes(1);expect(fixture.readUsageInsight).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(2)
  await fixture.draw(false)
  await act(async()=>vi.advanceTimersByTime(240_000))
  expect(fixture.refreshUsage).not.toHaveBeenCalled();expect(fixture.ledger).toHaveBeenCalledTimes(3);expect(vi.getTimerCount()).toBe(0)
  await fixture.draw(true)
  expect(fixture.ledger).toHaveBeenCalledTimes(6);expect(fixture.loadUsage).toHaveBeenCalledTimes(2)
  await act(async()=>vi.advanceTimersByTime(120_000))
  expect(fixture.refreshUsage).toHaveBeenCalledTimes(1)
})
it('keeps an unavailable scope identifiable and sends its identity to every read',async()=>{
  const fixture=setup(), scope=runtimeId('missing-account')
  await fixture.draw(true,scope)
  expect(fixture.node.querySelector('[data-slot="page-options"]')?.textContent).toContain('Unavailable account')
  expect(fixture.node.textContent).not.toContain(scope)
  for(const [query] of fixture.ledger.mock.calls as unknown as Array<[{runtime:string}]>) expect(query.runtime).toBe(scope)
  expect(fixture.readUsageInsight).toHaveBeenCalledWith(expect.objectContaining({runtime:scope}))
})
it('ignores an older ledger completion after leaving the page',async()=>{
  const fixture=setup()
  let finish:(report:LedgerReport)=>void=()=>{}
  fixture.ledger.mockImplementation(query=>new Promise(resolve=>{if(query.days===30) finish=resolve}))
  await fixture.draw(true)
  await fixture.draw(false)
  const before=fixture.node.textContent
  await act(async()=>finish({days:365,currency:'USD',totalCost:99,totalTokens:0,provenance:'listPrice',coverage:{priced:1,unpriced:0,unmetered:0,estimated:0,daysCovered:1,daysRequested:365},rows:[],daily:[],scannedAt:1}))
  expect(fixture.node.textContent).not.toContain('$99')
  expect(fixture.node.textContent).toBe(before)
})

it('the lane fixture uses real destination history and synthetic scoped source answers',async()=>{
  const store=dashboardDestinationStore()
  const runtime=store.getSnapshot().usage.find(report=>report.lanes.length>0)!.runtime
  await store.loadUsage()
  expect(store.getSnapshot().usage.length).toBeGreaterThan(0)
  const reading=await store.ledger({days:7,groupBy:'runtime',runtime})
  expect(reading?.daily.length).toBeGreaterThan(0)
  expect(reading?.daily.every(day=>day.runtime===runtime)).toBe(true)
  expect(reading?.rows.every(row=>row.runtime===runtime)).toBe(true)
  store.openDestination({kind:'dashboard',view:'plans',scope:runtime})
  store.openDestination({kind:'settings',route:{kind:'section',section:'general',focus:null}})
  await store.navigateBack()
  expect(store.getSnapshot().workbench.navigation.current).toEqual({kind:'dashboard',view:'plans',scope:runtime})
  await store.navigateForward()
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('settings')
  const borrowed=dashboardDestinationStore({view:'plans',scope:runtime,borrowed:true})
  expect(borrowed.getSnapshot().usage.find(report=>report.runtime===runtime)?.unverified?.whose).toBe('other@example.com sign-in')
})
