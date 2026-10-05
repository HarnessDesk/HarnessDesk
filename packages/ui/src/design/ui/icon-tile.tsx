import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { softTint, softTone, solidTint, type Tint, type Tone } from './tone'

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
 * `shape` is a real choice and not a style. `face` is someone: an agent's mark
 * or a person's picture, at whatever corner the person chose for faces
 * (`--hd-face-radius`, square unless they picked round), so every face in the
 * app is one shape. `round` is an account's ring or a status coin, `square` a
 * thing or a category. A tile that holds an agent's mark is a face, never a
 * bare `square`: a thing's tile does not follow the setting, and a face that
 * does not would be the one face in the app with the wrong corner.
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
        navigation: 'size-4 [&_svg]:size-4',
        stack: 'size-(--hd-space-5) [&_svg]:size-3',
        xs: 'size-4.5 [&_svg]:size-3',
        sm: 'size-6 [&_svg]:size-3.5',
        default: 'size-8 [&_svg]:size-4',
        lg: 'size-10 [&_svg]:size-5',
      },
      shape: {
        square: 'rounded-(--hd-radius-sm)',
        round: 'rounded-full',
        face: 'rounded-(--hd-face-radius)',
      },
    },
    defaultVariants: { size: 'default', shape: 'square' },
  },
)

/* Tone or tint, and the type says so: passing both is a compile error rather
   than a colour someone has to notice is wrong. */
type IconTileProps = React.ComponentProps<'span'> &
  VariantProps<typeof tileVariants> & {
    /** One identity qualifier at bottom-right. Top-right is reserved for attention. */
    badge?: React.ReactNode
  } &
  (
    | { tone?: Tone; tint?: never; color?: never }
    | { tint: Tint; tone?: never; color?: never }
    | { color: string; tone?: never; tint?: never }
  )

const IconTile = ({ className, size, shape, tone, tint, color, style, badge, children, ...props }: IconTileProps) => (
  <span
    data-slot="icon-tile"
    {...(color ? { 'data-color': '' } : {})}
    {...(tint ? { 'data-tint': tint } : {})}
    {...(!color && !tint ? { 'data-tone': tone ?? 'neutral' } : {})}
    className={cn(
      tileVariants({ size, shape }),
      badge != null && "relative overflow-visible",
      color
        ? 'bg-(--tile-color) text-(--hd-accent-foreground)'
        : tint
          ? shape === 'face' ? solidTint({ tint }) : softTint({ tint })
          : softTone({ tone }),
      className,
    )}
    style={color ? ({ ...style, '--tile-color': color } as React.CSSProperties) : style}
    {...props}
    /* Declared, so the faces rule (`e2e/ui-system/faces.spec.ts`) can find
       every place someone is drawn without guessing from a class. After the
       spread, so a caller's attribute cannot hide a face from it. */
    data-shape={shape ?? 'square'}
  >
    {badge == null ? children : <>
      <span data-slot="icon-tile-content" className="inline-flex size-full items-center justify-center overflow-hidden rounded-[inherit] [&>img]:size-full [&>img]:object-contain">{children}</span>
      <FaceBadge>{badge}</FaceBadge>
    </>}
  </span>
)

/** Shared by tiles and stack members; the caller supplies the words in its title. */
const FaceBadge = ({ children }: { children: React.ReactNode }) => (
  <span data-slot="face-badge" data-corner="bottom-right" aria-hidden="true"
    className="absolute -bottom-1 -right-1 flex min-w-3 h-3 items-center justify-center rounded-full bg-(--hd-foreground) px-0.5 text-xs leading-none font-medium text-(--hd-background) ring-2 ring-[var(--stack-surface,var(--hd-background))]">
    {children}
  </span>
)

export { IconTile, tileVariants, FaceBadge }
