import { DEFAULT_LANE_PREFERENCES } from '@harnessdesk/protocol'
import { expect, it } from 'vitest'
import { AppStore } from '../state/store'
import { PREVIEW_AGENTS, previewStore } from './harness'
import { frameDestinationStore, setFrameConnection } from './frame-destination-store'
it('uses real store navigation, connection events and resource reads without connecting',async()=>{
  const fixture=previewStore(),store=frameDestinationStore(fixture)
  expect(store).toBeInstanceOf(AppStore)
  const work=store.getSnapshot().workbench.navigation.current
  store.openDestination({kind:'settings',route:{kind:'section',section:'general',focus:null}})
  await store.navigateBack();expect(store.getSnapshot().workbench.navigation.current).toEqual(work)
  await store.navigateForward();expect(store.getSnapshot().workbench.navigation.current.kind).toBe('settings')
  expect(await store.runtimeResources()).toEqual(await fixture.runtimeResources())
  let wakes=0;const off=store.subscribe(()=>wakes++)
  setFrameConnection(store,'reconnecting');expect(store.getSnapshot().status).toBe('reconnecting');await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));expect(wakes).toBeGreaterThan(0);off()
  await store.loadLanePreferences();expect(store.getSnapshot().lanePreferences).toEqual(fixture.getSnapshot().lanePreferences ?? DEFAULT_LANE_PREFERENCES)
})

it('page reads retain seeded Agent definitions and dry-run plans when no ids are requested',async()=>{
  const entry={...PREVIEW_AGENTS[0]!,definition:{...PREVIEW_AGENTS[0]!.definition!,runtimeServers:[]}}
  const fixture=previewStore({agents:[entry]}),store=frameDestinationStore(fixture)
  await store.loadAgents()
  expect(store.getSnapshot().agents).toEqual([entry])
  expect(store.getSnapshot().agentPlans).toEqual(fixture.getSnapshot().agentPlans)
  expect(store.getSnapshot().agentPlansFailed).toBe(false)
})
it('a page plugin switch applies the fixture answer before the real store reloads plugins',async()=>{
  const fixture=previewStore(), plugin=fixture.getSnapshot().plugins[0]!
  Object.assign(fixture,{setPluginEnabled:async(pluginId:string,enabled:boolean)=>fixture.patch({plugins:fixture.getSnapshot().plugins.map(one=>one.identity.id===pluginId?{...one,enabled}:one)})})
  const store=frameDestinationStore(fixture)
  await store.setPluginEnabled(plugin.identity.id,false)
  expect(store.getSnapshot().plugins.find(one=>one.identity.id===plugin.identity.id)?.enabled).toBe(false)
  await store.setPluginEnabled(plugin.identity.id,true)
  expect(store.getSnapshot().plugins.find(one=>one.identity.id===plugin.identity.id)?.enabled).toBe(true)
})

it('the real page store reads the seeded branch list from its fixture',async()=>{
  const fixture=previewStore(),branches=[{name:'main',current:true,committedAt:1},{name:'feature/checkout',current:false,committedAt:2}]
  fixture.listBranches=async root=>{expect(root).toBe('/repo');return branches}
  expect(await frameDestinationStore(fixture).listBranches('/repo')).toEqual(branches)
})
