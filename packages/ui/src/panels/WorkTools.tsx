import { effectiveWindowMode } from '../editor'
import { Button, TopBarToolButton } from '../design'
import { FilePlusIcon, HistoryIcon, GlobeIcon, SquareMenuIcon, PanelRightIcon, SessionIcon } from '../components/Icons'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { fixedSubject } from '../state/workbench'
const tools = [
  { value: 'details', label: 'Details', Icon: SquareMenuIcon },
  { value: 'changes', label: 'Changes', Icon: FilePlusIcon },
  { value: 'activity', label: 'Activity', Icon: HistoryIcon },
  { value: 'browser', label: 'Browser', Icon: GlobeIcon },
] as const
/** The remembered tool door, shared with Team's retained header until Task 4. */
export const WorkPanelToggle = ({ onToggle }: { onToggle?: (open: boolean) => void }) => {
  const store = useStore(), snapshot = useSnapshot()
  const subject = fixedSubject(snapshot.workbench.main)
  const open = subject !== null && snapshot.workbench.frameTools[subject]?.open === true
  return <Button data-work-panel-toggle variant="ghost" size="icon-sm" aria-label="Toggle right panel" title="Toggle right panel"
    aria-expanded={open} aria-pressed={open} onClick={() => onToggle ? onToggle(open) : store.toggleWorkPanel()}><PanelRightIcon /></Button>
}
export const WorkTools = ({ draft = false, changesRefusal }: { draft?: boolean; changesRefusal?: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const health = session ? snapshot.healthByRuntime[session.runtime] : null
  const runtimeRefusal = health?.state === 'unavailable' ? `${health.message}${health.remediation ? ` ${health.remediation}` : ' Check the runtime in Settings.'}` : undefined
  const subject = store.workSubject()
  if (!subject) return null
  const current = snapshot.workbench.frameTools[subject]
  const running = [...snapshot.tasks.values()].some(tasks => tasks.some(task => task.state === 'running'))
  const available = effectiveWindowMode(snapshot.windowMode, snapshot.workbench) === 'editor'
    ? [{ value: 'conversation', label: 'Conversation', Icon: SessionIcon } as const, ...tools] : tools
  return <>{available.map(one => {
    const reason = one.value === 'activity' && !running && runtimeRefusal ? runtimeRefusal : draft && (one.value === 'changes' || one.value === 'activity' && !running) ? 'Send this session before opening this tool' : one.value === 'changes' ? changesRefusal : undefined
    return <TopBarToolButton key={one.value} attention={one.value === 'activity' && running} data-work-tool={one.value}
      aria-label={one.label} title={reason ?? one.label} disabled={Boolean(reason)}
      aria-pressed={current?.open === true && current.tool === one.value}
      onClick={() => {
        if (one.value === 'browser' && !(current?.open && current.tool === 'browser')) { void store.openBrowser(); return }
        store.chooseWorkTool(one.value, current?.open && current.tool === one.value ? current.mode : one.value, true)
      }}><one.Icon /></TopBarToolButton>
  })}<span data-work-tools-spacer /><WorkPanelToggle /></>
}
