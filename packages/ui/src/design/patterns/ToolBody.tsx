import { createContext, useContext, useId, useState, type ReactNode, type HTMLAttributes } from 'react'
import { Text } from './Settings'
import { GroupLabel } from '../ui/group-label'
import { ToolPaneBody } from '../ui/tool-pane'
import { SectionBody } from '../ui/section'
import { Button } from '../ui/button'
import { DisclosureChevron } from '../ui/disclosure-chevron'

/** Registered sections share the shell's one scroll owner; standalone bodies keep theirs. */
const SectionsOnly = createContext(false)
export const useToolBodySections = () => useContext(SectionsOnly)
export const ToolBodySections = ({ children }: { children: ReactNode }) => <SectionsOnly.Provider value>{children}</SectionsOnly.Provider>
export const ToolBody = ({ children }: { children: ReactNode }) => useContext(SectionsOnly) ? <>{children}</> : <div
  data-slot="tool-body" className="flex min-h-0 min-w-0 flex-1 flex-col">
  <ToolPaneBody data-slot="tool-scroll" inset="tool">{children}</ToolPaneBody>
</div>

/**
 * One card of the right panel (docs/superpowers/specs/2026-10-14-panel-cards-and-team-bar.md).
 *
 * The header is the card's label, a disclosure when it folds, and its `value`
 * — the summary a folded card still shows, so a glance down the panel reads
 * every card's state without opening one. A card's rows keep their own 12px
 * edge, which is the card's side padding; the card adds the top and bottom.
 */
export const ToolSection = ({ label, children, action, value, fold, defaultOpen = true }: {
  label: string
  children?: ReactNode
  action?: ReactNode
  /** The card's summary, read whether or not it is open: a state, a count. */
  value?: ReactNode
  /** The card folds to its header; `defaultOpen` says how it starts. */
  fold?: boolean
  defaultOpen?: boolean
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  const shown = !fold || open
  return <section data-slot="tool-section" data-folded={shown ? undefined : ''} aria-label={label}
    className="min-w-0 rounded-(--hd-panel-card-radius) border border-(--hd-border-strong) bg-(--hd-background) py-(--hd-panel-card-pad-y)">
    <GroupLabel as="div" surface="tool">
      {fold ? <Button variant="ghost" size="content" data-slot="tool-section-fold" aria-expanded={open} aria-controls={bodyId}
        className="hd-no-drag min-w-0 gap-(--hd-space-1)" onClick={() => setOpen(value => !value)}>
        <Text role="row" ink="primary" truncate>{label}</Text><DisclosureChevron open={open} size="sm" placement="trailing" />
      </Button> : <Text role="row" ink="primary" truncate>{label}</Text>}
      {value !== undefined && value !== null && <span data-slot="tool-section-value" className="ms-auto min-w-0 shrink-0 tabular-nums"><Text role="muted" ink="secondary">{value}</Text></span>}
      {action && <span className={value === undefined || value === null ? 'ms-auto flex items-center' : 'flex items-center'}>{action}</span>}
    </GroupLabel>
    {children !== undefined && children !== null && <div id={bodyId} data-slot="tool-section-body" hidden={!shown} className="mt-(--hd-space-1) min-w-0">{children}</div>}
  </section>
}
/** One line of a card: a 16px icon, a label, one trailing fact and at most one action. */
export const ToolRow = ({ icon, label, value, action, title }: {
  icon?: ReactNode
  label: ReactNode
  value?: ReactNode
  action?: ReactNode
  /** The whole label on hover, for a label that truncates. */
  title?: string
}) => <div data-slot="tool-row" title={title}
  className="flex min-h-(--hd-panel-row-h) min-w-0 items-center gap-(--hd-space-2) px-(--hd-inset-row) text-(--hd-foreground)">
  {icon && <span aria-hidden="true" className="flex shrink-0 text-(--hd-secondary-foreground) [&_svg]:size-4">{icon}</span>}
  <Text role="muted" ink="primary" truncate>{label}</Text>
  {value !== undefined && value !== null && <Text role="muted" ink="secondary" className="ms-auto shrink-0 tabular-nums">{value}</Text>}
  {action && <span className={value === undefined || value === null ? 'ms-auto flex shrink-0 items-center' : 'flex shrink-0 items-center'}>{action}</span>}
</div>

/** The rest of a card behind one quiet line: "All facts", "Show all". */
export const ToolFold = ({ label, children }: { label: string; children: ReactNode }) => {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return <div data-slot="tool-fold">
    <div className="flex min-h-(--hd-panel-row-h) items-center px-(--hd-inset-row)">
      <Button variant="ghost" size="content" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}
        className="hd-no-drag gap-(--hd-space-1)">
        <Text role="muted" ink="secondary">{label}</Text><DisclosureChevron open={open} size="sm" placement="trailing" />
      </Button>
    </div>
    <div id={bodyId} hidden={!open}>{open && children}</div>
  </div>
}

/** Prose and a missing-fact note stand on the card's row edge; a note takes second-line type. */
export const ToolProse = ({ children, variant = 'prose' }: { children: ReactNode; variant?: 'prose' | 'note' }) => <SectionBody data-slot="tool-prose" spacing={variant === 'note' ? 'inline' : 'tool-prose'}><Text role={variant === 'note' ? 'meta' : 'prose'} ink="secondary">{children}</Text></SectionBody>

export const ToolBodyControls = ({ children, ...props }: { children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'>) => <div {...props} data-slot="tool-controls" data-surface=""
  className="hd-no-drag flex min-w-0 shrink-0 flex-wrap items-center gap-(--hd-space-2) px-(--hd-inset-row) py-(--hd-space-2)">{children}</div>
