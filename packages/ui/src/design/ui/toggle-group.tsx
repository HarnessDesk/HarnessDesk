import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { createContext, useContext } from 'react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (toggle-group, with toggle's variants inlined);
 * heights on the app's measure tokens, ring utilities dropped. */

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 outline-none transition-colors whitespace-nowrap",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-(--hd-control-h) px-2 min-w-(--hd-control-h)',
        sm: 'h-(--hd-control-h-sm) px-1.5 min-w-(--hd-control-h-sm)',
        lg: 'h-8 px-2.5 min-w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

const ToggleGroupContext = createContext<VariantProps<typeof toggleVariants>>({
  size: 'default',
  variant: 'default',
})

const ToggleGroup = ({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants>) => (
  <ToggleGroupPrimitive.Root
    data-slot="toggle-group"
    data-variant={variant}
    data-size={size}
    className={cn(
      'group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs',
      className,
    )}
    {...props}
  >
    <ToggleGroupContext.Provider value={{ variant: variant ?? 'default', size: size ?? 'default' }}>
      {children}
    </ToggleGroupContext.Provider>
  </ToggleGroupPrimitive.Root>
)

const ToggleGroupItem = ({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleVariants>) => {
  const context = useContext(ToggleGroupContext)

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant ?? variant}
      data-size={context.size ?? size}
      className={cn(
        toggleVariants({
          variant: context.variant ?? variant,
          size: context.size ?? size,
        }),
        'min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l',
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem, toggleVariants }
