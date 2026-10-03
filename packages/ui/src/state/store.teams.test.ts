import { expect, it, vi } from 'vitest'
import { AppStore } from './store'
import { overviewTeamStore } from '../preview/team-overview-fixture'
import type { WireNotification } from '@harnessdesk/protocol'

it('persists Hide and read marks on the machine and reloads them without a renderer origin',async()=>{
 const store=new AppStore('ws://localhost:0/')
 const writes=vi.spyOn(store.transport,'request').mockResolvedValue({} as never)
 const view=overviewTeamStore().getSnapshot().goals.get('overview-team')!
 const handlers=(store.transport as unknown as {handlers:{onNotification(n:WireNotification):void}}).handlers
 handlers.onNotification({method:'goal/changed',params:{view:{...view,activity:'ready-to-wrap'}}})
 store.setTeamHidden('overview-team',true)
 store.markTeamSeen('overview-team','observed-change')
 expect(store.getSnapshot().teamsPrefs.hidden['overview-team']).toEqual(expect.any(String))
 expect(writes).toHaveBeenCalledWith('app/state/set',expect.objectContaining({patch:{teamsPrefs:store.getSnapshot().teamsPrefs}}))
 const prefs=store.getSnapshot().teamsPrefs
 writes.mockResolvedValue({teamsPrefs:prefs} as never)
 await store.loadPreferences()
 expect(store.getSnapshot().teamsPrefs).toEqual(prefs)
})
it('refuses to Hide active work, and a failed preference write reports that it will not survive relaunch',async()=>{
 const store=new AppStore('ws://localhost:0/')
 const view=overviewTeamStore('running').getSnapshot().goals.get('overview-team')!
 const handlers=(store.transport as unknown as {handlers:{onNotification(n:WireNotification):void}}).handlers
 handlers.onNotification({method:'goal/changed',params:{view}})
 const writes=vi.spyOn(store.transport,'request').mockRejectedValue(new Error('disk unavailable'))
 store.setTeamHidden('overview-team',true)
 expect(writes).not.toHaveBeenCalled()
 store.markTeamSeen('overview-team','changed')
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(store.getSnapshot().notices.some(one=>one.message.includes('disk unavailable'))).toBe(true)
})
it('opening a Team through any door marks it read without consuming a later unseen revision',async()=>{
 const store=new AppStore('ws://localhost:0/')
 vi.spyOn(store.transport,'request').mockResolvedValue({} as never)
 const view=overviewTeamStore('running').getSnapshot().goals.get('overview-team')!
 const handlers=(store.transport as unknown as {handlers:{onNotification(n:WireNotification):void}}).handlers
 handlers.onNotification({method:'goal/changed',params:{view}})
 store.openTeamRoom('overview-team','revision-shown-in-the-page')
 expect(store.getSnapshot().teamsPrefs.seen['overview-team']).toBe('revision-shown-in-the-page')
 store.openTeamRoom('overview-team')
 expect(store.getSnapshot().teamsPrefs.seen['overview-team']).not.toBe('revision-shown-in-the-page')
 store.markTeamSeen('overview-team','old-revision')
 store.openGoal('overview-team')
 expect(store.getSnapshot().teamsPrefs.seen['overview-team']).not.toBe('old-revision')
})
