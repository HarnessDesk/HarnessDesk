import { CrossIcon, PlusIcon } from '../../components/Icons'
import { Button } from '../ui/button'
import { Tabs, TabsList } from '../ui/tabs'
import { DockPanelBar, DockPanelTab } from './DockPanel'

export interface TerminalShellTab {
  readonly id: string
  readonly label: string
  readonly title: string
  readonly onClose: () => void
}

/** The shell tabs and panel actions share one row above the terminal screen. */
export const TerminalShellTabs = ({
  tabs,
  value,
  newShellTitle,
  onValueChange,
  onNewShell,
  onCloseTerminal,
}: {
  readonly tabs: readonly TerminalShellTab[]
  readonly value: string | null
  readonly newShellTitle: string
  readonly onValueChange: (id: string) => void
  readonly onNewShell: () => void
  readonly onCloseTerminal: () => void
}) => (
  <DockPanelBar data-terminal-shell-tabs="">
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(String(next))}
      className="min-w-0 flex-1 gap-0"
    >
      <TabsList aria-label="Terminal shells" variant="line" className="max-w-full overflow-x-auto">
        {tabs.map((tab) => (
          <DockPanelTab
            key={tab.id}
            value={tab.id}
            label={tab.label}
            title={tab.title}
            aria-label={tab.label}
            onClose={tab.onClose}
            closeOnHover
          />
        ))}
      </TabsList>
    </Tabs>
    <span data-terminal-shell-actions="" className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="New shell"
        title={newShellTitle}
        onClick={onNewShell}
      ><PlusIcon size={12} /></Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Close terminal"
        title="Close terminal"
        onClick={onCloseTerminal}
      ><CrossIcon size={12} /></Button>
    </span>
  </DockPanelBar>
)
