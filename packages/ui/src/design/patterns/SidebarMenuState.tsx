import type { ComponentProps } from 'react'

import { Chip, Dot } from './Settings'

export type SidebarMenuStateProps = {
  label: string
  tone: NonNullable<ComponentProps<typeof Chip>['tone']>
  state: ComponentProps<typeof Dot>['state']
}

/** A whole conversation or room state chip ends on the inset rail and folds to a dot for its own row's actions. */
export const SidebarMenuState = ({ label, tone, state }: SidebarMenuStateProps) => (
  <span data-slot="sidebar-menu-state" role="img" aria-label={label} title={label} className="inline-flex min-w-0 shrink-0 items-center">
    <span data-sidebar-menu-state-full aria-hidden="true" className="inline-flex min-w-0"><Chip tone={tone}>{label}</Chip></span>
    <span data-sidebar-menu-state-compact aria-hidden="true" className="hidden shrink-0"><Dot state={state} variant="navigation" /></span>
  </span>
)
