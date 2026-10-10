import { Button } from '../design'
import { FilePlusIcon, HistoryIcon, GlobeIcon, SquareMenuIcon, PanelRightIcon } from '../components/Icons'
import { useSnapshot, useStore } from '../state/context'
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
  const subject = store.workSubject()
  if (!subject) return null
  const current = snapshot.workbench.frameTools[subject]
  return <>{tools.map(one => {
    const reason = draft && (one.value === 'changes' || one.value === 'activity') ? 'Send this session before opening this tool' : one.value === 'changes' ? changesRefusal : undefined
    return <Button key={one.value} variant="ghost" size="icon-sm" data-work-tool={one.value}
      aria-label={one.label} title={reason ?? one.label} disabled={Boolean(reason)}
      aria-pressed={current?.open === true && current.tool === one.value}
      onClick={() => {
        if (one.value === 'browser' && !(current?.open && current.tool === 'browser')) { void store.openBrowser(); return }
        store.chooseWorkTool(one.value, current?.open && current.tool === one.value ? current.mode : one.value, true)
      }}><one.Icon /></Button>
  })}<span data-work-tools-spacer /><WorkPanelToggle /></>
}
