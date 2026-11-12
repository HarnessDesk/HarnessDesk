import { createContext, useContext, useId, useState, type ReactNode, type HTMLAttributes } from 'react'
import { SectionHead, Text } from './Settings'
import { GroupLabel } from '../ui/group-label'
import { ToolPaneBody } from '../ui/tool-pane'
import { SectionBody } from '../ui/section'
import { Button } from '../ui/button'
import { DisclosureChevron } from '../ui/disclosure-chevron'
import { ChipLook } from '../ui/tone'

/** Registered sections share the shell's one scroll owner; standalone bodies keep theirs. */
const SectionsOnly = createContext(false)
export const useToolBodySections = () => useContext(SectionsOnly)
export const ToolBodySections = ({ children }: { children: ReactNode }) => <SectionsOnly.Provider value>{children}</SectionsOnly.Provider>
export const ToolBody = ({ children }: { children: ReactNode }) => useContext(SectionsOnly) ? <>{children}</> : <div
  data-slot="tool-body" className="flex min-h-0 min-w-0 flex-1 flex-col">
  <ToolPaneBody data-slot="tool-scroll" inset="tool">{children}</ToolPaneBody>
</div>

/**
 * One card of the right panel (docs/design.md).
 *
 * The header is the card's label, a disclosure when it folds, and its `value`
 * — the summary a folded card still shows, so a glance down the panel reads
 * every card's state without opening one. A card's rows keep their own 12px
 * edge, which is the card's side padding; the card adds the top and bottom.
 *
 * So everything in a card stands on that row edge through a part that knows
 * it: rows (`Row`, `ListRows surface="panel"`, `SummaryList surface="panel"`,
 * `Checklist surface="panel"`), a group's label (`ToolGroup`), a sentence or a
 * note (`ToolProse`), buttons (`ToolBodyControls`). A bare `Button`, `Text` or
 * `SectionHead` has no edge of its own and lands on the card's border;
 * `e2e/ui-system/tool-section-inset.spec.ts` measures every card it reaches.
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
  const summary = value !== undefined && value !== null
    ? <span id={`${bodyId}-summary`} data-slot="tool-section-value" title={typeof value === 'string' ? value : undefined}
      className="ms-auto min-w-0 max-w-1/2 shrink-0 truncate tabular-nums"><Text role="muted" ink="secondary" truncate className="block"><ChipLook.Provider value="quiet">{value}</ChipLook.Provider></Text></span> : null
  return <section data-slot="tool-section" data-folded={shown ? undefined : ''} aria-label={label}
    className="min-w-0 rounded-(--hd-panel-card-radius) border border-(--hd-panel-card-border) bg-(--hd-panel-card-fill) py-(--hd-panel-card-pad-y) [[data-slot=tool-section]+&]:shadow-[inset_0_1px_0_var(--hd-panel-card-rule)]">
    <GroupLabel as="div" surface="tool">
      {fold ? <Button variant="ghost" size="content-min" bordered={false} data-slot="tool-section-fold" aria-label={label} aria-describedby={summary ? `${bodyId}-summary` : undefined} aria-expanded={open} aria-controls={bodyId}
        className="hd-no-drag min-w-0 flex-1 shrink justify-start gap-(--hd-space-1) text-left aria-expanded:bg-transparent aria-expanded:hover:bg-(--hd-hover)" onClick={() => setOpen(value => !value)}>
        {/* The chevron follows the label, and open has no fill: the chevron
            already says open, and a lit header read as a menu left open. */}
        <Text role="row" ink="primary" truncate title={label} className="min-w-0">{label}</Text><DisclosureChevron open={open} size="sm" />{summary}
      </Button> : <><Text role="row" ink="primary" truncate title={label}>{label}</Text>{summary}</>}
      {action && <span data-slot="tool-section-actions" data-edge-pull-slot="" className={`${fold || summary ? '' : 'ms-auto '}flex shrink-0 items-center gap-(--hd-space-1)`}>{action}</span>}
    </GroupLabel>
    {children !== undefined && children !== null && <div id={bodyId} data-slot="tool-section-body" hidden={!shown} className="mt-(--hd-space-1) min-w-0">{children}</div>}
  </section>
}
/** The rest of a card behind one quiet line: "All facts", "Show all". */
export const ToolFold = ({ label, children }: { label: string; children: ReactNode }) => {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return <div data-slot="tool-fold">
    <div className="flex min-h-(--hd-panel-row-h) items-center px-(--hd-inset-row)">
      <Button variant="ghost" size="content-min" bordered={false} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}
        className="hd-no-drag gap-(--hd-space-1)">
        <Text role="muted" ink="secondary">{label}</Text><DisclosureChevron open={open} size="sm" placement="trailing" />
      </Button>
    </div>
    <div id={bodyId} hidden={!open}>{open && children}</div>
  </div>
}

/**
 * A group of a card's rows under its own label: "Needs you · 1", "Rules".
 * The label stands on the card's row edge; the rows under it bring their own
 * edge, so the group adds none. The region is named by its visible label
 * (`aria-labelledby`), so a reader hears it once: `heading` when it carries
 * more than `label` (a count), `label` otherwise.
 *
 * The label is a quiet band, in muted ink: the card's own title keeps the
 * secondary ink above it and the rows' names the foreground below, so it reads
 * as a label of its rows rather than one more row. It sits nearer the rows it
 * names (4px) than the group before it (12px more above every group after the
 * first). Only the group's own label takes that 4px; a head inside its rows
 * keeps its own rhythm.
 */
export const ToolGroup = ({ label, heading, children, ...props }: { label: string; heading?: ReactNode; children: ReactNode } & Omit<HTMLAttributes<HTMLElement>, 'className' | 'style' | 'aria-label' | 'aria-labelledby'>) => {
  const headId = useId()
  return <section {...props} data-slot="tool-group" aria-labelledby={headId} className="[[data-slot=tool-group]+&]:mt-(--hd-space-3) [&>[data-tool-group-head]>[data-section-head]]:mb-(--hd-space-1)">
    <SectionBody spacing="inline" data-tool-group-head=""><SectionHead id={headId} level="label" ink="muted" name={heading ?? label} /></SectionBody>
    {children}
  </section>
}

/** Prose and a missing-fact note stand on the card's row edge; a note takes second-line type. */
export const ToolProse = ({ children, variant = 'prose' }: { children: ReactNode; variant?: 'prose' | 'note' }) => <SectionBody data-slot="tool-prose" spacing={variant === 'note' ? 'inline' : 'tool-prose'}><Text role={variant === 'note' ? 'meta' : 'prose'} ink="secondary">{children}</Text></SectionBody>

/** A card's buttons, on the card's row edge: "Review update…". Never a bare `Button` in a card. */
export const ToolBodyControls = ({ children, ...props }: { children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'>) => <div {...props} data-slot="tool-controls" data-surface=""
  className="hd-no-drag flex min-w-0 shrink-0 flex-wrap items-center gap-(--hd-space-2) px-(--hd-inset-row) py-(--hd-space-2)">{children}</div>
