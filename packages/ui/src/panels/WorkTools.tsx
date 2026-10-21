import { effectiveWindowMode } from '../editor'
import { MenuItem, TopBarToolButton } from '../design'
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
export const WorkTools = ({ draft = false, changesRefusal, menu = false, close }: { draft?: boolean; changesRefusal?: string; menu?: boolean; close?: () => void }) => {
  const store = useStore(), snapshot = useSnapshot()
  const subject = store.workSubject()
  if (!subject) return null
  const current = snapshot.workbench.frameTools[subject]
  const available = effectiveWindowMode(snapshot.windowMode, snapshot.workbench) === 'editor'
    ? [{ value: 'conversation', label: 'Conversation', Icon: SessionIcon } as const, ...tools] : tools
  const activate = (value: typeof available[number]['value']) => {
    const pressed = current?.open === true && current.tool === value
    if (value === 'browser' && !pressed) { void store.openBrowser(); return }
    store.chooseWorkTool(value, current?.tool === value ? current.mode : value, true)
  }
  return <>
    {menu ? <MenuItem icon={<SquareMenuIcon />} label="Toggle rail" selected={workRailOpen(snapshot.workbench)} onSelect={() => { store.toggleWorkRail(); close?.() }} /> : <>
      <TopBarToolButton data-work-rail-toggle aria-label="Toggle rail" title="Toggle rail"
        aria-expanded={workRailOpen(snapshot.workbench)} aria-pressed={workRailOpen(snapshot.workbench)} onClick={() => store.toggleWorkRail()}><SquareMenuIcon /></TopBarToolButton>
      <span data-work-tools-divider aria-hidden="true" />
    </>}
    {available.map(one => {
      const reason = draft && one.value === 'changes' ? 'Available after the first message' : one.value === 'changes' ? changesRefusal : undefined
      const pressed = current?.open === true && current.tool === one.value
      return menu ? <MenuItem key={one.value} icon={<one.Icon />} label={one.label} selected={pressed} disabled={reason ?? false}
        onSelect={() => { activate(one.value); close?.() }} /> : <TopBarToolButton key={one.value} data-work-tool={one.value} aria-label={one.label} title={reason ?? one.label}
        disabled={Boolean(reason)} aria-pressed={pressed} onClick={() => activate(one.value)}><one.Icon /></TopBarToolButton>
    })}
  </>
}
