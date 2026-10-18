import { expect, it, vi } from 'vitest'
import { AppStore } from './store'
import { overviewTeamStore } from '../preview/team-overview-fixture'
import type { WireNotification } from '@harnessdesk/protocol'

it('persists Hide in preferences and Team seen time through the Goal on the host',async()=>{
 const store=new AppStore('ws://localhost:0/')
 const view={...overviewTeamStore().getSnapshot().goals.get('overview-team')!,activity:'ready-to-wrap' as const}
 const writes=vi.spyOn(store.transport,'request').mockResolvedValue({...view,lastSeenAt:123} as never)
 const handlers=(store.transport as unknown as {handlers:{onNotification(n:WireNotification):void}}).handlers
 handlers.onNotification({method:'goal/changed',params:{view}})
 store.setTeamHidden('overview-team',true)
 store.markTeamSeen('overview-team')
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(store.getSnapshot().teamsPrefs.hidden['overview-team']).toEqual(expect.any(String))
 expect(writes).toHaveBeenCalledWith('goal/seen',{goal:'overview-team',newsAt:0})
 expect(store.getSnapshot().goals.get('overview-team')).toMatchObject({lastSeenAt:123})
})
it('refuses to Hide active work and reports a failed host read-mark write',async()=>{
 const store=new AppStore('ws://localhost:0/')
 const view=overviewTeamStore('running').getSnapshot().goals.get('overview-team')!
 const handlers=(store.transport as unknown as {handlers:{onNotification(n:WireNotification):void}}).handlers
 handlers.onNotification({method:'goal/changed',params:{view}})
 const writes=vi.spyOn(store.transport,'request').mockRejectedValue(new Error('disk unavailable'))
 store.setTeamHidden('overview-team',true)
 expect(writes).not.toHaveBeenCalled()
 store.markTeamSeen('overview-team')
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(store.getSnapshot().notices.some(one=>one.message.includes('disk unavailable'))).toBe(true)
})
it('opening a Team through any door shows its room, and only the room marks it seen',async()=>{
 const store=new AppStore('ws://localhost:0/')
 const view=overviewTeamStore('running').getSnapshot().goals.get('overview-team')!
 const writes=vi.spyOn(store.transport,'request').mockResolvedValue({...view,lastSeenAt:123} as never)
 const handlers=(store.transport as unknown as {handlers:{onNotification(n:WireNotification):void}}).handlers
 handlers.onNotification({method:'goal/changed',params:{view}})
 const shown=vi.spyOn(store,'openDefaultView')
 store.openTeamRoom('overview-team')
 store.openGoal('overview-team')
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(shown.mock.calls.map(([target])=>target)).toEqual([{kind:'room',room:'overview-team'},{kind:'room',room:'overview-team'}])
 // TeamRoomPane marks the Team seen once it is on screen (TeamRoomPane.test.tsx), so a door never writes twice.
 expect(writes).not.toHaveBeenCalledWith('goal/seen',expect.anything())
})

it('the Team list preview keeps seen marks and navigation in the same snapshot', async () => {
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 const store=teamsPageStore('active')
 store.openTeamRoom('team-4')
 expect(store.getSnapshot().goals.get('team-4')?.lastSeenAt).toBeGreaterThan(0)
 expect(store.getSnapshot().layout.root).toMatchObject({kind:'pane',view:{kind:'room',room:'team-4'}})
})


it('sends observed news as a hint while its inbox save is still pending', async () => {
 const store = new AppStore('ws://localhost:0/')
 const view = {...overviewTeamStore('running').getSnapshot().goals.get('overview-team')!, lastSeenAt: 10}
 const handlers = (store.transport as unknown as {handlers:{onNotification(n:WireNotification):void}}).handlers
 handlers.onNotification({method:'goal/changed',params:{view}})
 const writes = vi.spyOn(store.transport,'request').mockImplementation(async method => {
  if (method === 'app/state/set') return await new Promise(() => {})
  return {...view,lastSeenAt:20} as never
 })
 store.keep({id:'seat-news',at:15,tone:'neutral',title:'New output',from:{runtime:'fake',sessionId:'earlier',name:'Agent'}})
 store.markTeamSeen('overview-team',15)
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(writes).toHaveBeenCalledWith('goal/seen',{goal:'overview-team',newsAt:15})
 expect(store.getSnapshot().goals.get('overview-team')?.lastSeenAt).toBe(20)
})
