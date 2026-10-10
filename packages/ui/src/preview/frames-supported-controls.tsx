import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type UsageReport } from '@harnessdesk/protocol'
import { Text } from '../design'
import { PlanMeters } from '../components/PlanMeters'
import { TerminalToggle } from '../components/Conversation'
import { StoreProvider, useSnapshot } from '../state/context'
import { dockViews } from '../state/workbench'
import { MountProvider } from '../panels/mount'
import { MainWorkActions } from '../panels/MainWorkActions'
import { previewStore } from './harness'
import '../panels/builtins'

/** Supported APIs await their planned frame consumer/retirement; these are live catalogue specimens. */
export const PlanMetersSpecimen = ({ fixtureUsage = false }: { fixtureUsage?: boolean } = {}) => {
  const store = useMemo(() => {
    const base = previewStore(), snapshot = base.getSnapshot(), runtime = snapshot.runtimes[0]!
    const usage: UsageReport = { runtime: runtime.id, account: 'dev@example.com', plan: 'Pro',
      lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 21, windowMinutes: 10_080, resetsAt: null }],
      credits: null, spend: null, reached: null, source: { kind: 'api', label: 'Synthetic recorded allowance' },
      fetchedAt: Date.now(), staleAfterMs: 60_000, error: null }
    const other = snapshot.runtimes[1]!
    const reports = fixtureUsage
      ? [runtime, other].map(info => snapshot.usage.find(report => report.runtime === info.id && report.lanes.length)!).filter(Boolean)
      : [usage, { ...usage, runtime: other.id, account: 'analyst@example.com' }]
    base.patch({ runtimes: [runtime, other], activeRuntime: runtime.id, usage: reports })
    ;(window as unknown as { __hdPlanMetersStore: typeof base }).__hdPlanMetersStore = base
    return base
  }, [fixtureUsage])
  const [opened, setOpened] = useState(false)
  return <StoreProvider store={store}><div data-frame-id="supported-plan-meters">
    <PlanMeters onOpen={() => setOpened(true)} onSignIn={() => {}} />
    {opened && <Text role="meta">Recorded plan opened</Text>}
  </div></StoreProvider>
}
/** Browser probes mount the retained control without restoring retired app chrome. */
export const mountPlanMetersSpecimen = (container: HTMLElement, fixtureUsage = false) => {
  createRoot(container).render(<PlanMetersSpecimen fixtureUsage={fixtureUsage} />)
}
export const TerminalToggleSpecimen = () => {
  const store = useMemo(previewStore, [])
  return <StoreProvider store={store}><div data-frame-id="supported-terminal-toggle"><TerminalToggle /><TerminalReading /></div></StoreProvider>
}
const TerminalReading = () => {
  const snapshot = useSnapshot()
  const count = [...dockViews(snapshot.workbench.bottom), ...dockViews(snapshot.workbench.right)].filter(one => one.view.kind === 'terminal').length
  return <Text role="meta">{count} terminal resources</Text>
}
export const MainWorkActionsSpecimen = () => {
  const [store, scope] = useMemo(() => {
    const store = previewStore(), one = store.getSnapshot().layout
    return [store, { area: 'main' as const, id: one.focused, view: { kind: 'conversation' as const, session: null } }]
  }, [])
  return <StoreProvider store={store}><MountProvider scope={scope}><div data-frame-id="supported-work-actions"><MainWorkActions /></div></MountProvider></StoreProvider>
}
