import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (card), tightened one step for a desktop app's
 * density: py-4/px-4 where upstream says 6. */

type CardProps<T extends React.ElementType = 'div'> = {
  as?: T
  variant?: 'default' | 'muted'
} & Omit<React.ComponentPropsWithoutRef<T>, 'as' | 'variant'>

const Card = <T extends React.ElementType = 'div'>({
  as,
  className,
  variant,
  ...props
}: CardProps<T>) => {
  const Component = as ?? 'div'
  return (
    <Component
      data-slot="card"
      data-variant={variant ?? 'default'}
      className={cn(
        'bg-card text-card-foreground flex flex-col gap-4 rounded-lg border py-4',
        variant === 'muted' && 'border-dashed bg-(--hd-muted)',
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

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent }
