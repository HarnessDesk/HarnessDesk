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
 *
 * A listing that brings its own mark — a plugin's or a skill's logo — puts the
 * `<img>` inside, and the tile crops it to its corner. One that brings only its
 * own colour passes `color`: that colour is the ground and the initial on it is
 * in the ink the accent carries, as the listing's store draws it. `color` is
 * data from the listing, never a colour a screen picked, which is why it is a
 * third option beside `tone` and `tint` rather than either of them.
 */

const tileVariants = cva(
  'inline-flex shrink-0 items-center justify-center overflow-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&>img]:size-full [&>img]:object-contain',
  {
    variants: {
      size: {
        xs: 'size-4.5 [&_svg]:size-3',
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
  (
    | { tone?: Tone; tint?: never; color?: never }
    | { tint: Tint; tone?: never; color?: never }
    | { color: string; tone?: never; tint?: never }
  )

const IconTile = ({ className, size, shape, tone, tint, color, style, ...props }: IconTileProps) => (
  <span
    data-slot="icon-tile"
    {...(color ? { 'data-color': '' } : {})}
    className={cn(
      tileVariants({ size, shape }),
      color
        ? 'bg-(--tile-color) text-(--hd-accent-foreground)'
        : tint
          ? softTint({ tint })
          : softTone({ tone }),
      className,
    )}
    style={color ? ({ ...style, '--tile-color': color } as React.CSSProperties) : style}
    {...props}
  />
)

export { IconTile, tileVariants }
