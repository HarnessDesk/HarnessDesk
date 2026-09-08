import type * as React from 'react'

import { cn } from '@/lib/utils'
import { softTint, softTone, type Tint, type Tone } from './tone'

/**
 * A commit, and the ref labels that ride on it.
 *
 * Two small components rather than one big graph, because the graph is the
 * part that is genuinely bespoke — lanes, merges, and where a line bends are a
 * layout computation over a real commit list, and no design system can supply
 * it. What a system *can* supply is everything around it: the shape of a ref
 * chip, the ink of a lane, and the rule for which is which.
 *
 * That rule is the one this file exists to hold. A branch is an **identity** —
 * `main` is not better than `feat/x`, it is other — so branches take tints, in
 * a stable order, and eight of them go by before a hue repeats. A commit's
 * *state* is a judgement — signed, unsigned, failing CI, unpushed — and takes
 * a tone. Templates routinely paint `main` green and a feature branch orange
 * and thereby say something about quality that they did not mean.
 */

/** How far along the tint scale a lane index sits. Stable, so a branch keeps its colour. */
const LANE_TINTS: Tint[] = ['blue', 'teal', 'violet', 'orange', 'green', 'rose', 'amber', 'sky']

const laneTint = (lane: number): Tint => LANE_TINTS[lane % LANE_TINTS.length] as Tint

/**
 * A ref label: a branch, a tag, a remote head.
 *
 * `kind` changes the shape as well as the colour, because a reader scanning a
 * column of chips is reading silhouettes: a tag is squared with a notch of
 * meaning behind it, a branch is rounded, and `HEAD` is filled. Colour alone
 * fails the same reader twice — once for the colourblind, once for anyone
 * looking at a screenshot in greyscale.
 */
const RefChip = ({
  className,
  kind = 'branch',
  lane = 0,
  children,
  ...props
}: React.ComponentProps<'span'> & { kind?: 'branch' | 'remote' | 'tag' | 'head'; lane?: number }) => (
  <span
    data-slot="ref-chip"
    data-kind={kind}
    className={cn(
      'inline-flex h-4 shrink-0 items-center gap-1 px-1.5 text-xs font-medium whitespace-nowrap',
      kind === 'tag' ? 'rounded-(--hd-radius-sm)' : 'rounded-full',
      kind === 'head'
        ? 'bg-(--hd-foreground) text-(--hd-background)'
        : kind === 'remote'
          ? 'bg-(--hd-muted) text-(--hd-muted-foreground)'
          : softTint({ tint: laneTint(lane) }),
      className,
    )}
    {...props}
  >
    {children}
  </span>
)

/**
 * A state a commit is in, said in a word.
 *
 * Only when it is news. A pushed, signed, passing commit says nothing — which
 * is what makes the one that says `unpushed` findable in a column of two
 * hundred.
 */
const CommitState = ({
  className,
  tone = 'neutral',
  children,
  ...props
}: React.ComponentProps<'span'> & { tone?: Tone }) => (
  <span
    data-slot="commit-state"
    className={cn(
      'inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-xs font-medium',
      softTone({ tone }),
      className,
    )}
    {...props}
  >
    {children}
  </span>
)

export { RefChip, CommitState, laneTint, LANE_TINTS }
