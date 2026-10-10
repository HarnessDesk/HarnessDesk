import { useMemo, useState } from 'react'
import { runtimeId, type UsageReport } from '@harnessdesk/protocol'
import { Menu, Text } from '../design'
import { PlanMeters } from '../components/PlanMeters'
import { TerminalToggle } from '../components/Conversation'
import { StoreProvider, useSnapshot } from '../state/context'
import { dock, dockViews, emptyWorkbench } from '../state/workbench'
import { MountProvider } from '../panels/mount'
import { PanelActionMenuItems } from '../panels/PanelActions'
import { previewStore } from './harness'
import '../panels/builtins'

/** Supported APIs await their planned frame consumer/retirement; these are live catalogue specimens. */
export const PlanMetersSpecimen = () => {
  const store = useMemo(() => {
    const base = previewStore(), snapshot = base.getSnapshot(), runtime = snapshot.runtimes[0]!
    const usage: UsageReport = { runtime: runtime.id, account: 'dev@example.com', plan: 'Pro',
      lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 21, windowMinutes: 10_080, resetsAt: null }],
      credits: null, spend: null, reached: null, source: { kind: 'api', label: 'Synthetic recorded allowance' },
      fetchedAt: Date.now(), staleAfterMs: 60_000, error: null }
    base.patch({ runtimes: [runtime], activeRuntime: runtime.id, usage: [usage] })
    return base
  }, [])
  const [opened, setOpened] = useState(false)
  return <StoreProvider store={store}><div data-frame-id="supported-plan-meters">
    <PlanMeters onOpen={() => setOpened(true)} onSignIn={() => {}} />
    {opened && <Text role="meta">Recorded plan opened</Text>}
  </div></StoreProvider>
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
export const LegacyPanelMenuSpecimen = () => {
  const [store, scope] = useMemo(() => {
    const view = { kind: 'terminal' as const, terminalId: 'catalogue-terminal', runtime: runtimeId('fixture-agent'), cwd: '/repo' }
    const workbench = dock(emptyWorkbench(), 'bottom', view)
    const one = dockViews(workbench.bottom)[0]!
    return [previewStore({ workbench, layout: workbench.main }), { area: 'bottom' as const, id: one.id, view }]
  }, [])
  return <StoreProvider store={store}><MountProvider scope={scope}><div data-frame-id="supported-panel-menu">
    <Menu close={() => {}}><PanelActionMenuItems /></Menu><PanelReading />
  </div></MountProvider></StoreProvider>
}
const PanelReading = () => <Text role="meta">{useSnapshot().workbench.zoom ? 'Panel fills its area' : 'Panel in its layout'}</Text>
