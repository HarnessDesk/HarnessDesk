import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (card), tightened one step for a desktop app's
 * density: py-4/px-4 where upstream says 6.
 *
 * `plate` is the app's own card rather than the registry's: it reads the
 * `--hd-card-*` family (tokens.css), so the Studio interface's brand wash and
 * borderless edge reach it the way they reach a group of settings rows, and
 * Desk draws its fallback — the card ground on the strong hairline, drawn
 * inside the box so the card's size does not depend on its edge. It is the
 * card that stands on a surface of its own kind: the files card under an
 * answer is the first, and every card in the transcript is meant to be. */

type CardProps<T extends React.ElementType = 'div'> = {
  as?: T
  variant?: 'default' | 'muted' | 'flush' | 'plate'
  radius?: 'sm' | 'default' | 'lg'
  /** `flush` zeroes the gap and vertical padding `variant="flush"` also
   *  carries, for a card whose surface is a visual variant on its own — a
   *  dense row on `plate`, say — and whose spacing is flush regardless. */
  spacing?: 'default' | 'compact' | 'flush'
} & Omit<React.ComponentPropsWithoutRef<T>, 'as' | 'variant' | 'radius' | 'spacing'>

const Card = <T extends React.ElementType = 'div'>({
  as,
  className,
  variant,
  radius = 'default',
  spacing = 'default',
  ...props
}: CardProps<T>) => {
  const Component = as ?? 'div'
  return (
    <Component
      data-slot="card"
      data-variant={variant ?? 'default'}
      data-radius={radius}
      data-spacing={spacing}
      className={cn(
        'bg-card text-card-foreground flex flex-col gap-4 rounded-lg border py-4',
        variant === 'muted' && 'border-dashed bg-(--hd-muted)',
        variant === 'flush' && 'gap-0 overflow-hidden py-0',
        variant === 'plate' &&
          'overflow-hidden rounded-(--hd-card-radius,var(--hd-radius-lg)) border-0 bg-(--hd-card-fill,var(--hd-card)) shadow-[inset_0_0_0_1px_var(--hd-card-border,var(--hd-border-strong))]',
        radius === 'sm' && 'rounded-(--hd-radius-sm)',
        radius === 'lg' && 'rounded-(--hd-radius-lg)',
        spacing === 'compact' && 'gap-2 p-3',
        spacing === 'flush' && 'gap-0 py-0',
        className,
      )}
      {...props}
    />
  )
}

const CardHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="card-header"
    className={cn(
      '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto]',
      className,
    )}
    {...props}
  />
)

const CardTitle = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="card-title" className={cn('leading-none font-medium', className)} {...props} />
)

const CardDescription = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="card-description"
    className={cn('text-muted-foreground text-sm', className)}
    {...props}
  />
)

const CardAction = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="card-action"
    className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
    {...props}
  />
)

const CardContent = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="card-content" className={cn('px-4', className)} {...props} />
)

const CardFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="card-footer" className={cn('flex items-center px-4', className)} {...props} />
)

/**
 * A media window inside a card — an editor, most often.
 *
 * `editor` is the fixed height a preview stands at. `lines` is a window that
 * grows with what it shows up to a bound and scrolls past it; the bound is
 * `maxHeight`, in pixels, because it is measured from the content's own type
 * (so many lines at the editor's size and leading), which no token can know.
 */
const CardViewport = ({
  className,
  size = 'editor',
  maxHeight,
  style,
  ...props
}: React.ComponentProps<'div'> & { size?: 'editor' | 'lines'; maxHeight?: number }) => (
  <div
    data-slot="card-viewport"
    data-size={size}
    className={cn(size === 'editor' && 'h-44', size === 'lines' && 'overflow-auto', className)}
    style={size === 'lines' && maxHeight !== undefined ? { ...style, maxHeight } : style}
    {...props}
  />
)

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent, CardViewport }
