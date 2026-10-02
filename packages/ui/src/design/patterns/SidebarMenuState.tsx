import type { ComponentProps } from 'react'

import { Chip, Dot } from './Settings'

export type SidebarMenuStateProps = {
  label: string
  tone: NonNullable<ComponentProps<typeof Chip>['tone']>
  state: ComponentProps<typeof Dot>['state']
}

/** A conversation or room's earned state chip yields to the row's action rail. */
export const SidebarMenuState = ({ label, tone, state }: SidebarMenuStateProps) => (
  <span data-slot="sidebar-menu-state" role="img" aria-label={label} title={label} className="inline-flex min-w-0 shrink-0 items-center">
    <span data-sidebar-menu-state-full aria-hidden="true" className="inline-flex min-w-0 group-hover/menu-item:hidden group-focus-within/menu-item:hidden"><Chip tone={tone}>{label}</Chip></span>
    <span data-sidebar-menu-state-compact aria-hidden="true" className="hidden shrink-0 group-hover/menu-item:inline-flex group-focus-within/menu-item:inline-flex"><Dot state={state} variant="navigation" /></span>
  </span>
)
