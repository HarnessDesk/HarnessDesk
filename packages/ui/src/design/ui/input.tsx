import type * as React from 'react'

import { cn } from '@/lib/utils'

/*
 * Vendored from shadcn/ui (input); height from the app's measure token.
 *
 * The ring utilities are back, spelled in the app's tokens. They were dropped
 * on the way in "for the app's own focus outline", and the app's own focus
 * outline is a document-level rule that `outline-none` on the line below
 * cancels — so the field that most needs to say where the cursor is was the
 * one control in the app that said nothing. The reference marks it twice: the
 * border takes the ring colour, and the wash sits outside it.
 *
 * The elevation is a token rather than a constant, because it is a taste
 * question the Interface setting owns: `--hd-input-shadow` is nothing under
 * Desk and the smallest rung under Studio, where a transparent field with a
 * hairline on a white page is a rectangle drawn on paper.
 */

const Input = ({ className, type, ...props }: React.ComponentProps<'input'>) => (
  <input
    type={type ?? 'text'}
    data-slot="input"
    spellCheck={false}
    className={cn(
      'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input flex h-(--hd-field-h) w-full min-w-0 rounded-md border bg-transparent px-2.5 py-0 text-sm transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
      'shadow-(--hd-input-shadow)',
      'focus-visible:border-(--hd-ring) focus-visible:shadow-(--hd-focus-ring)',
      'file:text-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium',
      'aria-invalid:border-destructive dark:bg-input/30',
      className,
    )}
    {...props}
  />
)

export { Input }
