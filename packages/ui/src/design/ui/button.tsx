import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/*
 * Vendored from shadcn/ui — the **Base UI** button, not the Radix one.
 *
 * The API difference is the one to know: composition is `render`, not
 * `asChild`. `<Button render={<a href="…" />}>Open</Button>` gives an anchor
 * wearing the button, where the Radix build wanted a `<Slot>` and a child.
 * Nothing outside this folder was using `asChild`, so the change costs the app
 * nothing and buys it the primitive's own behaviour.
 *
 * What is taken from the registry, because each earns its place:
 *
 *   Icon-slot padding.   `has-data-[icon=inline-start]:pl-2` — a button with a
 *                        leading glyph tightens its own padding on that side.
 *                        Optical, and previously a thing every call site got
 *                        slightly differently or not at all.
 *   An open trigger      `aria-expanded:` keeps a menu button lit while its
 *   stays lit.           menu is open. It reads from ARIA the app already sets,
 *                        so no call site has to remember a second flag.
 *   The press nudge.     `active:translate-y-px`, skipped on anything with a
 *                        popup — a menu trigger that sinks under the menu it
 *                        just opened looks like a glitch.
 *
 * What is NOT taken: the numbers. Every height, padding, radius, weight, label
 * size and fill still comes from the `--hd-btn-*` component tokens, which is
 * the whole mechanism behind the explorer's foundations and the contract
 * `button.test.tsx` pins from both sides. The registry's stock
 * `h-8`/`rounded-lg` would restyle the app and silently unhook it from Kit's
 * `Btn`. The label size is the newest of those and the one that had already
 * drifted: this carried Tailwind's `text-sm` while Kit's `.btn` set
 * `--hd-text`, so the app shipped 13px and 14px buttons side by side
 * depending on which file drew them. Both now read `--hd-btn-text`.
 *
 * The one variant that moved: `destructive` is now soft — danger-coloured ink
 * on a transparent ground that fills on hover — because that is what Kit's
 * `Btn variant="danger"` has always drawn, and having the two spellings
 * disagree about the loudest button in the app was the exact failure the test
 * exists to prevent. Both now read `--hd-btn-danger-*`.
 */

const buttonVariants = cva(
  [
    'group/button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap',
    'rounded-(--hd-btn-radius) border border-transparent bg-clip-padding',
    /* `leading-none` because the height token owns the box: Tailwind's
       `text-sm` used to bring a line-height with it, and swapping in the
       token spelling silently left the body's 21px line box inside a 26px
       button. It centred anyway — but a line box taller than its control is
       the thing that makes a two-line label overflow instead of wrap, and
       Kit's `.btn` has always said `line-height: 1`. */
    'text-(length:--hd-btn-text) leading-none font-(--hd-btn-weight) transition-colors outline-none select-none',
    /* The focus mark. `outline-none` above kills the document's, and until
       now nothing put one back: a button in this app could be focused with
       no way to tell. The reference's answer is two marks at once — the ring
       colour on the border, and its wash outside it — so the control reads
       as live rather than as circled. */
    'focus-visible:border-(--hd-ring) focus-visible:shadow-(--hd-focus-ring)',
    'active:not-aria-[haspopup]:translate-y-px',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    'aria-invalid:border-(--hd-destructive)',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ].join(' '),
  {
    variants: {
      variant: {
        default:
          'bg-(--hd-btn-primary-fill) text-(--hd-btn-primary-foreground) hover:bg-(--hd-btn-primary-hover)',
        outline:
          'border-(--hd-btn-border) bg-(--hd-background) hover:bg-(--hd-hover) hover:text-(--hd-foreground) aria-expanded:bg-(--hd-hover) aria-expanded:text-(--hd-foreground)',
        secondary:
          'bg-(--hd-btn-fill) text-(--hd-foreground) hover:bg-(--hd-hover) aria-expanded:bg-(--hd-hover)',
        ghost:
          'hover:bg-(--hd-hover) hover:text-(--hd-foreground) aria-expanded:bg-(--hd-hover) aria-expanded:text-(--hd-foreground)',
        destructive:
          'text-(--hd-btn-danger-ink) hover:bg-(--hd-btn-danger-hover) aria-expanded:bg-(--hd-btn-danger-hover)',
        link: 'text-(--hd-primary-ink) underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-(--hd-btn-h) p-(--hd-btn-padding) has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-5 gap-1 px-1.5 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-(--hd-btn-h-sm) gap-1 p-(--hd-btn-padding-sm) text-(length:--hd-btn-text-sm) has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
        /* The one size with no token behind it: `lg` exists for a dialog's
           confirm and a sign-in's submit, which are the two places the app
           deliberately stands a button taller than a row. */
        lg: 'h-8 px-4',
        icon: 'size-(--hd-btn-h) p-0',
        'icon-xs': 'size-5 p-0',
        'icon-sm': 'size-(--hd-btn-h-sm) p-0',
        'icon-lg': 'size-8 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

const Button = ({
  className,
  variant = 'default',
  size = 'default',
  type,
  render,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) => (
  <ButtonPrimitive
    data-slot="button"
    className={cn(buttonVariants({ variant, size, className }))}
    /* A bare <button> submits the form around it; nothing in this app means
       that, so the default is the safe one — the same rule Kit's Btn holds.
       Skipped when `render` is given, because the element being rendered may
       not be a button at all and `type` on an anchor is a different attribute. */
    {...(render ? { render } : { type: type ?? 'button' })}
    {...props}
  />
)

export { Button, buttonVariants }
