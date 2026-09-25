import { createElement, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The word over a group: a card of rows, a list in a rail, a section of a page.
 *
 * There used to be three of these, and no two agreed. The sidebar set its
 * groups at 13px in the secondary ink, the settings window at 13px in the
 * faint one, and the room's rail, the agent card and the trajectory spelled
 * theirs in 12px capitals with tracking. Each was a value somebody had looked
 * at and accepted, which is how a system ends up with a style per screen.
 *
 * One style now: the chrome step (13px), the secondary ink, sentence case. It
 * names the group quietly, so the rows under it stay the reading subject, and
 * it never shouts — **no label in the app is set in capitals** except a key on
 * a `Keycap`, which is a physical thing with printing on it. The design audit
 * counts every `uppercase` outside that one place (`uppercaseLabel`).
 *
 * The interfaces may vary the label's weight and the air above a rail's group
 * (`--hd-label-weight`, `--hd-label-space`, both Studio-only tokens with this
 * look as their fallback); they do not vary its size, its ink or its case.
 */
export type GroupLabelProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** A real heading for a page section; a plain span over a card or a rail list. */
  as?: 'span' | 'h2' | 'h3' | 'div' | 'legend'
  children: ReactNode
}

export const groupLabelClass =
  'm-0 text-(length:--hd-text-sm) leading-(--hd-line-sm) font-[number:var(--hd-label-weight,var(--hd-weight-normal))] text-(--hd-secondary-foreground)'

export const GroupLabel = ({ as = 'span', className, children, ...props }: GroupLabelProps) =>
  createElement(as, { 'data-slot': 'group-label', className: cn(groupLabelClass, className), ...props }, children)
