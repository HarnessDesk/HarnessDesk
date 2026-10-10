import { useEffect, useState } from 'react'
import { StatusBar } from '../design'
import { PlanMeters } from '../components/PlanMeters'
import { TerminalToggle } from '../components/TerminalToggle'
import { desktop, type AppUpdateFact } from '../lib/desktop'
import { useSnapshot, useStore } from '../state/context'
import { useShell } from './views'

export const WorkStatusBar = () => {
  const store = useStore(), snapshot = useSnapshot(), shell = useShell()
  const [update, setUpdate] = useState<AppUpdateFact | null>(null)
  useEffect(() => {
    const bridge = desktop()
    let live = true, pushed = false
    const off = bridge?.onAppUpdate?.(fact => { pushed = true; if (live) setUpdate(fact) })
    void bridge?.readAppUpdate?.().then(fact => { if (live && !pushed) setUpdate(fact) }).catch(() => {})
    return () => { live = false; off?.() }
  }, [])
  const running = [...snapshot.tasks.values()].flat().filter(task => task.state === 'running').length
  const connection = { connecting: 'Connecting', open: 'Connected', reconnecting: 'Reconnecting', closed: 'Disconnected' }[snapshot.status]
  return <StatusBar usage={<PlanMeters onOpen={shell.openUsage} onSignIn={shell.signIn} />} facts={[
    { id: 'tasks', label: `${running} background ${running === 1 ? 'task' : 'tasks'}`, detail: 'Running background work across the app',
      run: () => store.openDetailsTab('tasks'), disabled: store.workSubject() === null },
    { id: 'sync', label: connection, detail: 'Connection to the local host' },
    ...(update ? [{ id: 'updates', label: update.label, run: () => desktop()?.appUpdateAction?.(), disabled: !update.enabled }] : []),
  ]} terminal={<TerminalToggle />} />
}
