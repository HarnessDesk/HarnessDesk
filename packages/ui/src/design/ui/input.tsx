import type * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

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

const inputVariants = cva(
  'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex w-full min-w-0 rounded-md border px-2.5 py-0 text-base transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 shadow-(--hd-input-shadow) focus-visible:border-(--hd-ring) focus-visible:shadow-(--hd-focus-ring) file:text-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium aria-invalid:border-destructive',
  {
    variants: {
      variant: {
        default: 'border-input bg-transparent dark:bg-input/30',
        quiet: 'border-transparent bg-transparent hover:bg-(--hd-hover) focus-visible:bg-(--hd-card)',
        filled: 'border-(--hd-border) bg-(--hd-muted)',
        chrome: 'border-(--hd-border) bg-(--hd-card-raised)',
        code: 'border-(--hd-border-strong) bg-(--hd-card) font-mono tracking-wide',
      },
      size: {
        default: 'h-(--hd-field-h)',
        compact: 'h-6 px-1.5 data-[icon=leading]:pl-6',
        bare: 'h-7 px-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type InputVariants = VariantProps<typeof inputVariants>
type InputProps = Omit<React.ComponentProps<'input'>, 'size'> & {
  variant?: NonNullable<InputVariants['variant']>
  controlSize?: NonNullable<InputVariants['size']>
}

const Input = ({ className, type, hidden, variant = 'default', controlSize = 'default', ...props }: InputProps) => (
  <input
    type={type ?? 'text'}
    hidden={hidden}
    data-slot="input"
    spellCheck={false}
    className={cn(inputVariants({ variant, size: controlSize }), hidden && 'hidden', className)}
    {...props}
  />
)

export { Input, inputVariants, type InputProps }
