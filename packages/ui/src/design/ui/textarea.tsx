import type * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (textarea); ring utilities dropped for the app's
 * own focus outline. */

const textareaVariants = cva(
  'placeholder:text-muted-foreground flex field-sizing-content w-full rounded-md border text-sm transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
  {
    variants: {
      variant: {
        default: 'border-input bg-transparent dark:bg-input/30',
        editor: 'border-(--hd-border) bg-(--hd-background)',
        inline: 'border-(--hd-accent) bg-(--hd-card)',
        /* The composer's shell answers focus for the whole control, so the
           field inside it draws neither ring. `outline-none` in the base
           ties with app.css's global `:focus-visible` and loses on source
           order; the focus-visible variant outranks it. */
        composer:
          'border-transparent bg-transparent text-base focus-visible:shadow-none focus-visible:outline-none',
      },
      size: {
        default: 'min-h-14 resize-y px-2.5 py-1.5',
        compact: 'min-h-8 resize-y px-2 py-1',
        composer:
          'min-h-(--hd-composer-min) max-h-(--hd-composer-max) resize-none px-4 pt-4 pb-1.5 leading-(--hd-composer-line)',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type TextareaVariants = VariantProps<typeof textareaVariants>
type TextareaProps = React.ComponentProps<'textarea'> & {
  variant?: NonNullable<TextareaVariants['variant']>
  controlSize?: NonNullable<TextareaVariants['size']>
}

const Textarea = ({ className, variant = 'default', controlSize = 'default', ...props }: TextareaProps) => (
  <textarea
    data-slot="textarea"
    spellCheck={false}
    className={cn(textareaVariants({ variant, size: controlSize }), className)}
    {...props}
  />
)

export { Textarea, textareaVariants, type TextareaProps }
