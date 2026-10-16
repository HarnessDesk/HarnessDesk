import { effectiveWindowMode } from '../editor'
import { TopBarToolButton } from '../design'
import { FilePlusIcon, FolderIcon, GlobeIcon, SquareMenuIcon, SessionIcon, TerminalIcon } from '../components/Icons'
import { useSnapshot, useStore } from '../state/context'
import { workRailOpen } from '../state/workbench'
const tools = [
  { value: 'terminal', label: 'Terminal', Icon: TerminalIcon },
  { value: 'changes', label: 'Changes', Icon: FilePlusIcon },
  { value: 'browser', label: 'Browser', Icon: GlobeIcon },
  { value: 'files', label: 'Files', Icon: FolderIcon },
] as const
/** Subject cards are independent of the selected tool pane. */
export const WorkTools = ({ draft = false, changesRefusal }: { draft?: boolean; changesRefusal?: string }) => {
  const store = useStore(), snapshot = useSnapshot()
  const subject = store.workSubject()
  if (!subject) return null
  const current = snapshot.workbench.frameTools[subject]
  const available = effectiveWindowMode(snapshot.windowMode, snapshot.workbench) === 'editor'
    ? [{ value: 'conversation', label: 'Conversation', Icon: SessionIcon } as const, ...tools] : tools
  return <>
    <TopBarToolButton data-work-rail-toggle aria-label="Toggle rail" title="Toggle rail"
      aria-expanded={workRailOpen(snapshot.workbench)} aria-pressed={workRailOpen(snapshot.workbench)} onClick={() => store.toggleWorkRail()}><SquareMenuIcon /></TopBarToolButton>
    <span data-work-tools-divider aria-hidden="true" />
    {available.map(one => {
      const reason = draft && one.value === 'changes' ? 'Send this session before opening this tool' : one.value === 'changes' ? changesRefusal : undefined
      const pressed = current?.open === true && current.tool === one.value
      return <TopBarToolButton key={one.value} data-work-tool={one.value} aria-label={one.label} title={reason ?? one.label}
        disabled={Boolean(reason)} aria-pressed={pressed} onClick={() => {
          if (one.value === 'browser' && !pressed) { void store.openBrowser(); return }
          store.chooseWorkTool(one.value, current?.tool === one.value ? current.mode : one.value, true)
        }}><one.Icon /></TopBarToolButton>
    })}
  </>
}
