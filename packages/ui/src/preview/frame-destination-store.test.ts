import { DEFAULT_LANE_PREFERENCES } from '@harnessdesk/protocol'
import { expect, it } from 'vitest'
import { AppStore } from '../state/store'
import { previewStore } from './harness'
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
