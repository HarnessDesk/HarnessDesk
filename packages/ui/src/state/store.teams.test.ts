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
 expect(writes).toHaveBeenCalledWith('goal/seen',{goal:'overview-team'})
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
it('opening a Team through any door asks the host to mark it seen',async()=>{
 const store=new AppStore('ws://localhost:0/')
 const view=overviewTeamStore('running').getSnapshot().goals.get('overview-team')!
 const writes=vi.spyOn(store.transport,'request').mockResolvedValue({...view,lastSeenAt:123} as never)
 const handlers=(store.transport as unknown as {handlers:{onNotification(n:WireNotification):void}}).handlers
 handlers.onNotification({method:'goal/changed',params:{view}})
 store.openTeamRoom('overview-team')
 store.openGoal('overview-team')
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(writes).toHaveBeenCalledWith('goal/seen',{goal:'overview-team'})
 expect(store.getSnapshot().goals.get('overview-team')).toMatchObject({lastSeenAt:123})
})

it('the Team list preview keeps seen marks and navigation in the same snapshot', async () => {
 const {teamsPageStore}=await import('../preview/teams-page-fixture')
 const store=teamsPageStore('active')
 store.openTeamRoom('team-4')
 expect(store.getSnapshot().goals.get('team-4')?.lastSeenAt).toBeGreaterThan(0)
 expect(store.getSnapshot().layout.root).toMatchObject({kind:'pane',view:{kind:'room',room:'team-4'}})
})
