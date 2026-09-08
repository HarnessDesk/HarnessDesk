import { Avatar as AvatarPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (avatar). The default is squared rather than a
 * circle: the app's identity marks are 6px-cornered tiles (see
 * ChannelMessage), and a chat where the avatar column disagrees with the
 * account chips reads as two products. */

const Avatar = ({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) => (
  <AvatarPrimitive.Root
    data-slot="avatar"
    className={cn('relative flex size-6 shrink-0 overflow-hidden rounded-md', className)}
    {...props}
  />
)

const AvatarImage = ({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) => (
  <AvatarPrimitive.Image
    data-slot="avatar-image"
    className={cn('aspect-square size-full', className)}
    {...props}
  />
)

const AvatarFallback = ({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) => (
  <AvatarPrimitive.Fallback
    data-slot="avatar-fallback"
    className={cn(
      'flex size-full items-center justify-center rounded-md bg-muted text-xs font-semibold',
      className,
    )}
    {...props}
  />
)

export { Avatar, AvatarImage, AvatarFallback }
