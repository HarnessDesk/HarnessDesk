import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group'
import { cva, type VariantProps } from 'class-variance-authority'
import { createContext, useContext } from 'react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/*
 * Vendored from shadcn/ui (toggle-group, with toggle's variants inlined);
 * heights on the app's measure tokens, ring utilities dropped. The pressed
 * state stays the registry's own `bg-accent`/`text-accent-foreground` — this
 * app's quiet hover wash (`--accent` resolves to `--hd-hover`), not a raised
 * surface. `Segmented` (`design/patterns/Settings.tsx`) wants the chosen
 * answer lifted out of its track instead, the same shape `TabsTrigger`'s
 * enclosed variant presses with (`design/ui/tabs.tsx`) — it layers its own
 * `data-pressed:` classes on the item (tailwind-merge drops these in favour
 * of theirs) rather than changing what ships here.
 */
const toggleVariants = cva(
    'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-accent data-pressed:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 outline-none transition-colors whitespace-nowrap',
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

const ToggleGroupContext = createContext<VariantProps<typeof toggleVariants> & { type: 'single' | 'multiple' }>({
  size: 'default',
  variant: 'default',
  type: 'single',
})

type ToggleGroupProps = Omit<ToggleGroupPrimitive.Props<string>, 'value' | 'defaultValue' | 'onValueChange' | 'multiple'> &
  VariantProps<typeof toggleVariants> &
  (
    | {
        type: 'single'
        value?: string
        defaultValue?: string
        onValueChange?: (value: string) => void
      }
    | {
        type: 'multiple'
        value?: readonly string[]
        defaultValue?: readonly string[]
        onValueChange?: (value: string[]) => void
      }
  )

const ToggleGroup = ({
  className,
  variant,
  size,
  children,
  type,
  value,
  defaultValue,
  onValueChange,
  ...props
}: ToggleGroupProps) => (
  <ToggleGroupPrimitive
    data-slot="toggle-group"
    data-variant={variant}
    data-size={size}
    role={type === 'single' ? 'radiogroup' : 'group'}
    className={cn(
      'group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs',
      className,
    )}
    multiple={type === 'multiple'}
    value={type === 'multiple' ? value : value == null || value === '' ? [] : [value]}
    defaultValue={
      type === 'multiple'
        ? defaultValue
        : defaultValue == null || defaultValue === ''
          ? []
          : [defaultValue]
    }
    onValueChange={(next) => {
      if (type === 'multiple') onValueChange?.(next)
      else onValueChange?.(next[0] ?? '')
    }}
    {...props}
  >
    <ToggleGroupContext.Provider value={{ variant: variant ?? 'default', size: size ?? 'default', type }}>
      {children}
    </ToggleGroupContext.Provider>
  </ToggleGroupPrimitive>
)

const ToggleGroupItem = ({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof Toggle<string>> &
  VariantProps<typeof toggleVariants>) => {
  const context = useContext(ToggleGroupContext)

  return (
    <Toggle
      data-slot="toggle-group-item"
      data-variant={context.variant ?? variant}
      data-size={context.size ?? size}
      className={cn(
        toggleVariants({
          variant: context.variant ?? variant,
          size: context.size ?? size,
        }),
        // Intrinsic widths keep long labels inside their own segment. Equal
        // zero-basis cells overflow when the group's labels differ in length.
        'flex-none rounded-none shadow-none first:rounded-l-md last:rounded-r-md data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l',
        className,
      )}
      render={(renderProps, state) => (
        <button
          {...renderProps}
          role={context.type === 'single' ? 'radio' : undefined}
          aria-checked={context.type === 'single' ? state.pressed : undefined}
        />
      )}
      {...props}
    >
      {children}
    </Toggle>
  )
}

export { ToggleGroup, ToggleGroupItem, toggleVariants }
