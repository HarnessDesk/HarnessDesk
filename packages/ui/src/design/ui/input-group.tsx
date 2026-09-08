import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { Button } from './button'

/**
 * Vendored from shadcn/ui (input-group), replacing the three-part version this
 * app grew.
 *
 * Ours had a start affix, an end affix and a bare input, and that covers a
 * prefix and a unit. What it could not do is the two arrangements that turn up
 * the moment a form gets real: an addon *above or below* the field rather than
 * beside it &mdash; which is how a search box carries its filters, and how a
 * composer carries its toolbar &mdash; and a button welded to the edge that is
 * still separately clickable.
 *
 * The alignment is a prop rather than four components, and the group reads it
 * off the DOM (`has-[>[data-align=block-start]]`) to decide whether it is a row
 * or a column. So a caller adds an addon and the group re-lays itself out; it
 * is never told twice.
 *
 * One behaviour worth keeping from theirs: pressing anywhere on an addon that
 * is not a button focuses the input. An addon looks like part of the field, so
 * it should behave like part of the field.
 */

const InputGroup = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="input-group"
    role="group"
    className={cn(
      'group/input-group relative flex w-full items-center rounded-(--hd-radius-sm) border border-(--hd-border-strong) bg-(--hd-input) outline-none',
      'h-(--hd-field-h) has-[>textarea]:h-auto',
      'has-[>[data-align=inline-start]]:[&>input]:pl-2 has-[>[data-align=inline-end]]:[&>input]:pr-2',
      'has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col',
      'has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col',
      /* One ring on the group, not on the input: the whole control is one
         object to the reader, and pressing the addon has not left it. */
      'has-[[data-slot=input-group-control]:focus-visible]:outline has-[[data-slot=input-group-control]:focus-visible]:outline-2 has-[[data-slot=input-group-control]:focus-visible]:-outline-offset-1 has-[[data-slot=input-group-control]:focus-visible]:outline-(--hd-ring)',
      'has-[[data-slot][aria-invalid=true]]:border-(--hd-danger)',
      className,
    )}
    {...props}
  />
)

const inputGroupAddonVariants = cva(
  'flex h-auto cursor-text items-center justify-center gap-1.5 text-xs font-medium text-(--hd-muted-foreground) select-none [&>svg:not([class*=size-])]:size-3.5',
  {
    variants: {
      align: {
        'inline-start': 'order-first pl-2 has-[>button]:-ml-1',
        'inline-end': 'order-last pr-2 has-[>button]:-mr-1',
        'block-start': 'order-first w-full justify-start px-2 pt-1.5',
        'block-end': 'order-last w-full justify-start px-2 pb-1.5',
      },
    },
    defaultVariants: { align: 'inline-start' },
  },
)

const InputGroupAddon = ({
  className,
  align = 'inline-start',
  onClick,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>) => (
  <div
    role="group"
    data-slot="input-group-addon"
    data-align={align}
    className={cn(inputGroupAddonVariants({ align }), className)}
    onClick={(event) => {
      // A button inside the addon is its own target; anything else is chrome
      // on the field, so pressing it should put the caret in the field.
      if (!(event.target as HTMLElement).closest('button')) {
        event.currentTarget.parentElement
          ?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
          ?.focus()
      }
      onClick?.(event)
    }}
    {...props}
  />
)

/** A word or a unit in an addon. Not pressable, and says so by not reacting. */
const InputGroupText = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="input-group-text"
    className={cn('whitespace-nowrap', className)}
    {...props}
  />
)

/** A real button welded to the field's edge. Sized down to sit inside it. */
const InputGroupButton = ({
  className,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: React.ComponentProps<typeof Button>) => (
  <Button
    data-slot="input-group-button"
    variant={variant}
    size={size}
    className={cn('rounded-(--hd-radius-sm)', className)}
    {...props}
  />
)

/** The field itself. No chrome of its own, because the group wears it. */
const InputGroupInput = ({ className, ...props }: React.ComponentProps<'input'>) => (
  <input
    data-slot="input-group-control"
    className={cn(
      'min-w-0 flex-1 bg-transparent px-2 text-base outline-none placeholder:text-(--hd-muted-foreground)',
      className,
    )}
    {...props}
  />
)

const InputGroupTextarea = ({ className, ...props }: React.ComponentProps<'textarea'>) => (
  <textarea
    data-slot="input-group-control"
    className={cn(
      'field-sizing-content min-h-0 w-full flex-1 resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-(--hd-muted-foreground)',
      className,
    )}
    {...props}
  />
)

export {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
  inputGroupAddonVariants,
}
