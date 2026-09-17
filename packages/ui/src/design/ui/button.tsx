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
    'group/button inline-flex min-w-0 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap',
    'rounded-(--hd-btn-radius) border border-transparent bg-clip-padding',
    /* `leading-none` because the height token owns the box: Tailwind's
       `text-sm` used to bring a line-height with it, and swapping in the
       token spelling silently left the body's 21px line box inside a 26px
       button. It centred anyway — but a line box taller than its control is
       the thing that makes a two-line label overflow instead of wrap, and
       Kit's `.btn` has always said `line-height: 1`. */
    'cursor-pointer text-(length:--hd-btn-text) leading-none font-(--hd-btn-weight) transition-colors outline-none select-none data-[draggable]:cursor-grab',
    /* The focus mark. `outline-none` above kills the document's, and until
       now nothing put one back: a button in this app could be focused with
       no way to tell. The reference's answer is two marks at once — the ring
       colour on the border, and its wash outside it — so the control reads
       as live rather than as circled. */
    'focus-visible:border-(--hd-ring) focus-visible:shadow-(--hd-focus-ring)',
    'active:not-aria-[haspopup]:translate-y-px',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    'aria-invalid:border-(--hd-destructive)',
    // Icons carry their own dimensions through the app's icon facade. A
    // descendant-wide size override also shrank avatar marks and nested art.
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
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
          'hover:bg-(--hd-hover) hover:text-(--hd-foreground) data-[refused]:opacity-45 aria-expanded:bg-(--hd-hover) aria-expanded:text-(--hd-foreground) data-[swatch]:data-[on]:shadow-[0_0_0_2px_var(--hd-card),0_0_0_4px_var(--hd-ring)]',
        destructive:
          'text-(--hd-btn-danger-ink) hover:bg-(--hd-btn-danger-hover) aria-expanded:bg-(--hd-btn-danger-hover) data-[overlay]:bg-(--hd-solid) data-[overlay]:text-(--hd-solid-foreground) data-[overlay]:hover:bg-(--hd-danger) data-[overlay]:hover:text-(--hd-destructive-foreground)',
        link: 'text-(--hd-primary-ink) underline-offset-4 hover:underline',
        /* Product surfaces select a semantic role; they never redraw the
           control from a screen stylesheet. These roles are deliberately
           opinionated rather than an `unstyled` escape hatch. */
        row:
          'justify-start bg-transparent text-(--hd-foreground) hover:bg-(--hd-hover) data-[selected]:bg-(--hd-active) data-[active]:bg-(--hd-active) data-[open]:bg-(--hd-active) data-[on]:bg-(--hd-active) data-[current]:font-semibold data-[indent]:pl-6 data-[insert=into]:bg-(--hd-accent-dim) data-[insert=into]:shadow-[inset_0_0_0_1px_var(--hd-accent)] data-[done]:opacity-60 data-[done]:line-through aria-expanded:bg-(--hd-active)',
        navigation:
          'justify-start bg-transparent text-(--hd-sidebar-foreground) hover:bg-(--hd-sidebar-hover) data-[active]:bg-(--hd-sidebar-selected) data-[current]:bg-(--hd-sidebar-selected) data-[open]:bg-(--hd-sidebar-selected) data-[selected]:bg-(--hd-sidebar-selected) data-[active]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[current]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[open]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[selected]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[selected]:font-[number:var(--hd-nav-weight-selected,var(--hd-weight-medium))]',
        choice:
          'justify-start border-(--hd-btn-border) bg-(--hd-card) text-(--hd-foreground) hover:border-(--hd-accent) hover:bg-(--hd-accent-dim) data-[selected]:border-(--hd-accent) data-[selected]:bg-(--hd-accent-dim) data-[on]:border-(--hd-ring) aria-checked:border-(--hd-ring) aria-checked:font-semibold data-[hard]:data-[on]:border-(--hd-danger)',
        quiet:
          'bg-transparent text-(--hd-secondary-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) aria-expanded:bg-(--hd-hover) aria-pressed:bg-(--hd-hover) data-[on]:bg-(--hd-active) data-[on]:text-(--hd-foreground) data-[active]:bg-(--hd-accent-dim) data-[active]:text-(--hd-accent) data-[live]:bg-(--hd-success-dim) data-[live]:text-(--hd-success-ink)',
        muted:
          'bg-transparent text-(--hd-muted-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) aria-expanded:bg-(--hd-hover)',
        warning:
          'bg-transparent text-(--hd-warning-ink) hover:bg-(--hd-hover) hover:text-(--hd-foreground)',
        reveal:
          'rounded-(--hd-radius-sm) bg-transparent p-1 text-(--hd-muted-foreground) opacity-0 group-hover/member:opacity-100 group-hover/tab:opacity-70 group-data-[active]/tab:opacity-70 group-hover/copy:opacity-100 hover:bg-(--hd-active) hover:text-(--hd-foreground) hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
        subtle:
          'bg-(--hd-muted) text-(--hd-foreground) hover:bg-(--hd-hover)',
        action:
          'bg-(--hd-solid) text-(--hd-solid-foreground) transition-[background,box-shadow,transform] hover:bg-(--hd-solid-hover) active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100 data-[when=later]:bg-[color-mix(in_srgb,var(--hd-accent)_22%,transparent)] data-[when=later]:hover:bg-[color-mix(in_srgb,var(--hd-accent)_32%,transparent)] data-[when=later]:text-[color-mix(in_srgb,var(--hd-accent)_74%,var(--hd-foreground))] data-[when=later]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--hd-accent)_78%,transparent)] data-[when=nothing]:bg-(--hd-muted) data-[when=nothing]:text-(--hd-muted-foreground) data-[when=nothing]:active:scale-100',
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
        content: 'h-auto p-0 whitespace-normal',
        inline: 'h-auto rounded-(--hd-radius-sm) p-1 whitespace-normal',
        panel: 'h-auto w-full p-4 whitespace-normal',
        row: 'h-auto min-h-(--hd-btn-h) px-2 py-1 whitespace-normal in-data-[register=light]:min-h-(--hd-control-h) in-data-[register=light]:py-0.5 in-data-[register=light]:pl-0.5 in-data-[register=light]:pr-1.5 in-data-[register=light]:rounded-(--hd-radius-sm)',
        navigation: 'h-auto min-h-(--hd-nav-h) p-(--hd-nav-padding) data-[density=comfortable]:py-2 data-[density=compact]:py-1',
        fill: 'h-full w-full p-0',
        'icon-circle': 'size-(--hd-btn-h) rounded-full p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type ButtonVariants = VariantProps<typeof buttonVariants>
type ButtonProps = Omit<ButtonPrimitive.Props, 'className'> & {
  className?: string
  variant?: NonNullable<ButtonVariants['variant']>
  size?: NonNullable<ButtonVariants['size']>
}

const Button = ({
  className,
  variant = 'default',
  size = 'default',
  type,
  render,
  ...props
}: ButtonProps) => (
  <ButtonPrimitive
    data-slot="button"
    data-variant={variant}
    className={cn(buttonVariants({ variant, size, className }))}
    /* A bare <button> submits the form around it; nothing in this app means
       that, so the default is the safe one — the same rule Kit's Btn holds.
       Skipped when `render` is given, because the element being rendered may
       not be a button at all and `type` on an anchor is a different attribute. */
    {...(render ? { render } : { type: type ?? 'button' })}
    {...props}
  />
)

export { Button, buttonVariants, type ButtonProps }
