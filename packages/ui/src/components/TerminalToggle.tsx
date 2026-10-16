import { Button, MenuItem } from '../design'
import { TerminalIcon } from './Icons'
import { fixedSubject } from '../state/workbench'
import { useSnapshot, useStore } from '../state/context'
import { chordOf, SHORTCUTS } from '../lib/shortcuts'
import { terminalCwdForSnapshot } from '../lib/terminal-scope'
import type { AppStore } from '../state/store'

/** Menu and keyboard use the same subject-scoped pane intent as its bar door. */
export const toggleTerminal = (store: AppStore): void => {
  if (!terminalCwdForSnapshot(store.getSnapshot())) return
  store.chooseWorkTool('terminal', 'terminal', true)
}
const useTerminalToggle = () => {
  const store = useStore(), snapshot = useSnapshot()
  const subject = fixedSubject(snapshot.workbench.main)
  const intent = subject ? snapshot.workbench.frameTools[subject] : undefined
  return { on: intent?.tool === 'terminal' && intent.open, run: () => toggleTerminal(store) }
}
export const TerminalToggle = () => {
  const { on, run } = useTerminalToggle()
  return <Button variant="ghost" size="icon-sm" aria-label={on ? 'Close terminal' : 'Open terminal'}
    title={on ? 'Close terminal' : 'Open terminal'} aria-pressed={on} onClick={run}><TerminalIcon /></Button>
}
export const TerminalMenuItem = ({ close }: { close: () => void }) => {
  const { on, run } = useTerminalToggle()
  const snapshot = useSnapshot()
  const cwd = terminalCwdForSnapshot(snapshot)
  if (!cwd) return null
  return <MenuItem label="Terminal" icon={<TerminalIcon size={16} />} selected={on}
    shortcut={chordOf(SHORTCUTS.find(one => one.action === 'toggle-terminal')!)}
    onSelect={() => { run(); close() }} />
}
