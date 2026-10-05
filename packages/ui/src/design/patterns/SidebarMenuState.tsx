import type { ComponentProps } from 'react'

import { Chip, Dot } from './Settings'

export type SidebarMenuStateProps = {
  label: string
  /** A fuller explanation shown on hover when the state label needs a next step. */
  title?: string
  tone: NonNullable<ComponentProps<typeof Chip>['tone']>
  state: ComponentProps<typeof Dot>['state']
  /** Fold the full label to its compact mark at narrow row widths. */
  compactAtNarrow?: boolean
}

/** A quiet conversation or room state ends on the inset rail and folds to a dot for its own row's actions. */
export const SidebarMenuState = ({ label, title = label, tone, state, compactAtNarrow = false }: SidebarMenuStateProps) => (
  <span data-slot="sidebar-menu-state" role="img" aria-label={label} title={title}
    {...(compactAtNarrow ? { 'data-compact-at-narrow': '' } : {})}
    className="inline-flex min-w-0 shrink-0 items-center">
    <span data-sidebar-menu-state-full aria-hidden="true" className="inline-flex min-w-0"><Chip tone={tone} variant="quiet">{label}</Chip></span>
    <span data-sidebar-menu-state-compact aria-hidden="true" className="hidden shrink-0"><Dot state={state} variant="navigation" /></span>
  </span>
)
