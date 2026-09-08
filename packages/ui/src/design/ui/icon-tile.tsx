import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { softTint, softTone, type Tint, type Tone } from './tone'

/**
 * A glyph on a soft ground of its own.
 *
 * The single most-repeated shape in every dashboard worth reading: the medallion
 * beside a figure, the marker at the head of a choice, the frame a service logo
 * sits in. It exists because an icon dropped straight onto a card has no weight —
 * it reads as an afterthought at the end of a sentence rather than the thing the
 * row is about.
 *
 * The tile takes `tone` **or** `tint`, never both, and the distinction is the one
 * tone.ts draws: a warning tile says the number beside it is bad news, a violet
 * tile says nothing except "Codex, not Claude". Passing neither gives the neutral
 * ground, which is the right answer for a glyph that is pure decoration — a
 * service logo, a file type.
 *
 * `shape` is a real choice and not a style: a circle reads as a person or an
 * account, a rounded square as a thing or a category. The app already holds that
 * rule for avatars; this keeps the two consistent.
 */

const tileVariants = cva(
  'inline-flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      size: {
        sm: 'size-6 [&_svg]:size-3.5',
        default: 'size-8 [&_svg]:size-4',
        lg: 'size-10 [&_svg]:size-5',
      },
      shape: {
        square: 'rounded-(--hd-radius-sm)',
        round: 'rounded-full',
      },
    },
    defaultVariants: { size: 'default', shape: 'square' },
  },
)

/* Tone or tint, and the type says so: passing both is a compile error rather
   than a colour someone has to notice is wrong. */
type IconTileProps = React.ComponentProps<'span'> &
  VariantProps<typeof tileVariants> &
  ({ tone?: Tone; tint?: never } | { tint: Tint; tone?: never })

const IconTile = ({ className, size, shape, tone, tint, ...props }: IconTileProps) => (
  <span
    data-slot="icon-tile"
    className={cn(
      tileVariants({ size, shape }),
      tint ? softTint({ tint }) : softTone({ tone }),
      className,
    )}
    {...props}
  />
)

export { IconTile, tileVariants }
