import { Avatar as AvatarPrimitive } from '@base-ui/react/avatar'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (avatar). An avatar is a face, so its corner is the
 * one chosen for faces (`--hd-face-radius`: round unless the person picked
 * square) rather than a corner of its own, and a chat's avatar column always
 * agrees with the faces beside it. */

const Avatar = ({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) => (
  <AvatarPrimitive.Root
    data-slot="avatar"
    className={cn('relative flex size-6 shrink-0 overflow-hidden rounded-(--hd-face-radius)', className)}
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
      'flex size-full items-center justify-center rounded-[inherit] bg-muted text-xs font-semibold',
      className,
    )}
    {...props}
  />
)

export { Avatar, AvatarImage, AvatarFallback }
