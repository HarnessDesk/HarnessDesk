import type { WireNotification } from '@harnessdesk/protocol'
import type { AppStore } from '../state/store'
import { installNoticesD3 } from './notices-d3-fixture'

/** In-memory preferences for exercising read/clear and staged hydration in the real store. */
export const installNoticesD3Repair = (store: AppStore) => {
  installNoticesD3(store)
  const { teams, goals, flowExecutions } = store.getSnapshot()
  const push = (value: WireNotification) => (store.transport as unknown as { handlers: { onNotification(value: WireNotification): void } }).handlers.onNotification(value)
  const control = {
    replay: () => { for (const execution of flowExecutions.values()) push({ method: 'flow/execution-changed', params: { execution } }) },
    reload: async () => {
      store.markInboxRead(null)
      Object.assign(store.getSnapshot(), { inbox: [], preferencesLoaded: false, teams: new Map(), goals: new Map(), flowExecutions: new Map() })
      await store.loadPreferences()
      for (const state of teams.values()) push({ method: 'team/changed', params: { state } })
      for (const view of goals.values()) push({ method: 'goal/changed', params: { view } })
      control.replay()
    },
  }
  const surface = window as unknown as { noticesD3Repair?: { controls: typeof control[]; replay(): void; reload(): Promise<void> } }
  surface.noticesD3Repair ??= { controls: [], replay() { this.controls.forEach(one => one.replay()) }, async reload() { await Promise.all(this.controls.map(one => one.reload())) } }
  surface.noticesD3Repair.controls.push(control)
}
