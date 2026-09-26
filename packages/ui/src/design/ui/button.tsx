import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import type { CSSProperties } from 'react'

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

/* What every button does, whoever draws its box: the pointer, the press, the
   disabled and dragging states, and the icon slots. */
const BEHAVIOUR = [
  'group/button min-w-0 shrink-0',
  'cursor-pointer transition-colors select-none data-[draggable]:cursor-grab',
  /* The document-level focus rule owns the one ring. A component shadow
     here would draw a second mark around the same button under Desk. */
  'active:not-aria-[haspopup]:translate-y-px',
  'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[dragging]:opacity-40',
  // Icons carry their own dimensions through the app's icon facade. A
  // descendant-wide size override also shrank avatar marks and nested art.
  '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  '[&_[data-chevron]]:transition-transform [&_[data-chevron][data-open]]:rotate-90',
]

/* The button's own box: its layout, gap, corner, hairline and type. Every size
   but `pattern` wears it. */
const BOX = [
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
  'rounded-(--hd-btn-radius) border border-transparent bg-clip-padding aria-invalid:border-(--hd-destructive)',
  /* `leading-none` because the height token owns the box: Tailwind's
     `text-sm` used to bring a line-height with it, and swapping in the
     token spelling silently left the body's 21px line box inside a 26px
     button. It centred anyway — but a line box taller than its control is
     the thing that makes a two-line label overflow instead of wrap, and
     Kit's `.btn` has always said `line-height: 1`. */
  'text-(length:--hd-btn-text) leading-none font-(--hd-btn-weight)',
]

const VARIANTS = {
  /* Disabled, a filled act (this and `danger`) keeps its own hue, dimmed
     toward the footer's ground — `--hd-btn-*-disabled-*` — instead of the
     shared half opacity, which mixed the ink into whatever was under it and
     drew a mid-grey slab. One treatment for both, so a disabled Delete and a
     disabled Save read as the same state. */
  default:
    'bg-(--hd-btn-primary-fill) text-(--hd-btn-primary-foreground) hover:bg-(--hd-btn-primary-hover) disabled:opacity-100 aria-disabled:opacity-100 disabled:bg-(--hd-btn-primary-disabled-fill) aria-disabled:bg-(--hd-btn-primary-disabled-fill) disabled:text-(--hd-btn-primary-disabled-foreground) aria-disabled:text-(--hd-btn-primary-disabled-foreground)',
  outline:
    'border-(--hd-btn-border) bg-(--hd-background) text-(--hd-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) aria-expanded:bg-(--hd-hover) aria-expanded:text-(--hd-foreground)',
  /* In a dialog's footer that holds a filled act, the confirm is the one
     filled button, so the ordinary action beside it — Cancel, Close — is
     drawn quiet: no fill, the secondary ink, the hover fill. The screen still
     writes `secondary`; the footer decides, and only when a filled act
     (`data-filled`, below) stands in it. A footer is never a lone
     `secondary` — its one button is the act, filled, which the design audit
     holds — because a secondary's grey is the footer's own ground. */
  secondary:
    'bg-(--hd-btn-fill) text-(--hd-foreground) hover:bg-(--hd-hover) aria-expanded:bg-(--hd-hover) [[data-slot=dialog-footer]:has([data-filled])_&]:bg-transparent [[data-slot=dialog-footer]:has([data-filled])_&]:text-(--hd-secondary-foreground) [[data-slot=dialog-footer]:has([data-filled])_&]:hover:bg-(--hd-hover) [[data-slot=dialog-footer]:has([data-filled])_&]:hover:text-(--hd-foreground)',
  ghost:
    'hover:bg-(--hd-hover) hover:text-(--hd-foreground) data-[refused]:opacity-45 aria-expanded:bg-(--hd-hover) aria-expanded:text-(--hd-foreground) data-[swatch]:data-[on]:shadow-[0_0_0_2px_var(--hd-card),0_0_0_4px_var(--hd-ring)]',
  /* A control that floats over content needs its own ground so its edge
     does not disappear into whatever happens to scroll beneath it. */
  floating:
    'rounded-full bg-(--hd-card) shadow-[var(--hd-shadow-raised),inset_0_0_0_1px_var(--hd-border-strong)] hover:bg-(--hd-hover) hover:text-(--hd-foreground) data-[refused]:opacity-45 aria-expanded:bg-(--hd-hover) aria-expanded:text-(--hd-foreground)',
  /* The act of a destructive confirm: a filled red button, the footer's one
     filled button. `destructive` stays the soft, ink-only spelling for a
     remove action set among others on a page or in a row. */
  danger:
    'bg-(--hd-btn-danger-fill) text-(--hd-btn-danger-foreground) hover:bg-(--hd-btn-danger-fill-hover) disabled:opacity-100 aria-disabled:opacity-100 disabled:bg-(--hd-btn-danger-disabled-fill) aria-disabled:bg-(--hd-btn-danger-disabled-fill) disabled:text-(--hd-btn-danger-disabled-foreground) aria-disabled:text-(--hd-btn-danger-disabled-foreground)',
  destructive:
    'text-(--hd-btn-danger-ink) hover:bg-(--hd-btn-danger-hover) aria-expanded:bg-(--hd-btn-danger-hover) data-[overlay]:border-2 data-[overlay]:border-(--hd-card) data-[overlay]:bg-(--hd-solid) data-[overlay]:text-(--hd-solid-foreground) data-[overlay]:hover:bg-(--hd-danger) data-[overlay]:hover:text-(--hd-destructive-foreground)',
  link: 'text-(--hd-primary-ink) underline-offset-4 hover:underline',
  /* Product surfaces select a semantic role; they never redraw the
     control from a screen stylesheet. These roles are deliberately
     opinionated rather than an `unstyled` escape hatch. */
  /* Every state that marks one row among its neighbours — picked,
     open, on, the current branch in a list of branches, or the checked
     answer in a list of answers — is the same fill; none of them
     changes the weight. */
  row:
    'justify-start text-left bg-transparent hover:bg-(--hd-hover) data-[selected]:bg-(--hd-active) data-[active]:bg-(--hd-active) data-[open]:bg-(--hd-active) data-[on]:bg-(--hd-active) data-[current]:bg-(--hd-active) aria-checked:bg-(--hd-active) data-[insert=into]:bg-(--hd-accent-dim) data-[insert=into]:shadow-[inset_0_0_0_1px_var(--hd-accent)]',
  navigation:
    'justify-start text-left bg-transparent text-(--hd-sidebar-foreground) hover:bg-(--hd-sidebar-hover) data-[active]:bg-(--hd-sidebar-selected) data-[current]:bg-(--hd-sidebar-selected) data-[open]:bg-(--hd-sidebar-selected) data-[selected]:bg-(--hd-sidebar-selected) data-[active]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[current]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[open]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[selected]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[active]:[&_[data-slot=text]]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[current]:[&_[data-slot=text]]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[open]:[&_[data-slot=text]]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[selected]:[&_[data-slot=text]]:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] data-[active]:[&_[data-role=meta]]:text-[var(--hd-sidebar-selected-muted-foreground,var(--hd-muted-foreground))] data-[current]:[&_[data-role=meta]]:text-[var(--hd-sidebar-selected-muted-foreground,var(--hd-muted-foreground))] data-[open]:[&_[data-role=meta]]:text-[var(--hd-sidebar-selected-muted-foreground,var(--hd-muted-foreground))] data-[selected]:[&_[data-role=meta]]:text-[var(--hd-sidebar-selected-muted-foreground,var(--hd-muted-foreground))] data-[insert=before]:shadow-[inset_0_2px_0_0_var(--hd-primary)] data-[insert=after]:shadow-[inset_0_-2px_0_0_var(--hd-primary)]',
  /* A chosen option is filled whichever way its caller says so:
     `data-selected`, `data-on`, or the radio's own `aria-checked`.
     Hover takes the plain hover fill, so pointing at an option never
     reads as having chosen it. */
  /* Unlike `ghost`/`floating`'s whole-control `data-[refused]:opacity-45`,
     a refused choice keeps its reason in the same control — measured
     at ~1.9:1 in light mode when the whole row faded with it, well
     under body-text contrast for the one sentence a refused row exists
     to let a person read. Only the lead glyph and the name (the row's
     own `data-role`) fade; nothing marked `data-role=muted` — the
     reason — is touched, so it keeps its ink. */
  choice:
    'justify-start text-left border-(--hd-btn-border) bg-(--hd-card) text-(--hd-foreground) hover:border-(--hd-accent) hover:bg-(--hd-hover) data-[selected]:border-(--hd-accent) data-[selected]:bg-(--hd-accent-dim) data-[on]:border-(--hd-ring) data-[on]:bg-(--hd-accent-dim) aria-checked:border-(--hd-ring) aria-checked:bg-(--hd-accent-dim) data-[hard]:data-[on]:border-(--hd-danger) data-[hard]:data-[on]:bg-(--hd-danger-dim) data-[refused]:[&_[data-slot=icon-tile]]:opacity-45 data-[refused]:[&_[data-role=row]]:opacity-45',
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
  /* `subtle` in the accent tone: a chip that is tinted because pressing
     it is the next thing to do. The plan strip's sign-in chip was drawn
     this way in a screen stylesheet, and when its box moved onto the
     canonical control there was no role here carrying the tint, so it
     came out looking like the ambient strip around it. The ink is the
     step solved for AA on a dim ground, not the accent itself. */
  primary:
    'bg-(--hd-accent-dim) text-(--hd-primary-ink) hover:bg-(--hd-btn-primary-fill) hover:text-(--hd-btn-primary-foreground)',
  action:
    'bg-(--hd-solid) text-(--hd-solid-foreground) transition-[background,box-shadow,transform] hover:bg-(--hd-solid-hover) active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100 data-[when=later]:bg-[color-mix(in_srgb,var(--hd-accent)_22%,transparent)] data-[when=later]:hover:bg-[color-mix(in_srgb,var(--hd-accent)_32%,transparent)] data-[when=later]:text-[color-mix(in_srgb,var(--hd-accent)_74%,var(--hd-foreground))] data-[when=later]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--hd-accent)_78%,transparent)] data-[when=nothing]:bg-(--hd-muted) data-[when=nothing]:text-(--hd-muted-foreground) data-[when=nothing]:active:scale-100',
} as const

const boxedVariants = cva(
  [...BEHAVIOUR, ...BOX].join(' '),
  {
    variants: {
      variant: VARIANTS,
      size: {
      /* Type follows the kind, not the component: a row, a navigation item
         and an inline chip carry the interface's chrome step, while button
         sizes carry `--hd-btn-text`. Selection is the fill behind that type;
         its weight stays put so moving through a list does not reflow or
         restate the label. */
        default:
          'h-(--hd-btn-h) p-(--hd-btn-padding) has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-5 gap-1 px-1.5 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-(--hd-btn-h-sm) gap-1 p-(--hd-btn-padding-sm) text-(length:--hd-btn-text-sm) has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
        icon: 'size-(--hd-btn-h) p-0',
        /* The floor, not a literal. This was `size-5` — 20px, four under the
           target the system declares and names twice (`--hd-target-min`,
           `--hd-icon-target`), so the one icon size small enough to be used
           in a dense row was the one that could not be reliably hit. */
        'icon-xs': 'size-(--hd-icon-target) p-0',
        'icon-sm': 'size-(--hd-btn-h-sm) p-0',
        content: 'h-auto p-0 whitespace-normal',
        /* A row of a hand-windowed table: fixed to the pitch the list's own
           arithmetic assumes (`--hd-table-row-h`), with only the right inset
           a table row keeps clear of its own scrollbar. Distinct from `row`
           earlier in this list, which is a navigation destination sized off `--hd-nav-h`. */
        'table-row': 'h-(--hd-table-row-h) p-0 pr-(--hd-space-3) whitespace-normal',
        /* The box belongs to a design-system pattern's own stylesheet — a
           settings `RowButton`, `RowChoice` — and the button brings only its
           behaviour and its variant's states. Not a reset: `content`'s `p-0`
           was one, and in this app a utility wins every tie with a stylesheet
           class by order, so the reset beat the row's own padding in one build
           and lost to it in another, depending on which sheet loaded last. A
           size with nothing to say has nothing to tie with. */
        pattern: '',
        /* A chip: the pill a summary or status strip is made of. Sized
           from the touch target rather than the control height, so it
           sits inside running text without setting the line. */
        chip: 'h-auto min-h-(--hd-target-min) gap-(--hd-space-1) rounded-full px-(--hd-space-2) text-(length:--hd-text-xs)',
        inline: 'h-auto rounded-(--hd-radius-sm) p-1 text-(length:--hd-text) font-normal whitespace-normal',
        panel: 'h-auto w-full p-4 whitespace-normal',
        /* The same row as `navigation`, in a different palette — so the same
           floor, corner, gap and inset. It had four of its own: it stood on
           `--hd-btn-h`, which is a *control* height solved for box over cap
           and happens to be one pixel taller; it wore the button's 8px corner
           beside the rail's 10px one; it kept the base's 6px gap; and it said
           its inset as `px-2`. The vertical padding stays, because unlike a
           rail row this one regularly carries a name over a description and
           the floor alone would crowd it. */
        row: 'h-auto min-h-(--hd-nav-h) gap-(--hd-nav-gap) rounded-(--hd-nav-radius) px-(--hd-nav-inset) data-[indent]:pl-6 py-1 text-(length:--hd-text-sm) leading-(--hd-line-sm) font-normal whitespace-normal in-data-[register=light]:min-h-(--hd-control-h) in-data-[register=light]:py-0.5 in-data-[register=light]:pl-0.5 in-data-[register=light]:pr-1.5 in-data-[register=light]:rounded-(--hd-radius-sm)',
        /* A destination row owns its height, so inherited window-rail density
           cannot make one destination taller than its neighbours. A list the
           person asked to be comfortable is the exception: its rows carry a
           second line and keep the air around it. */
        navigation: 'h-auto min-h-(--hd-nav-h) gap-(--hd-nav-gap) rounded-(--hd-nav-radius) p-(--hd-nav-padding) text-(length:--hd-text-sm) leading-(--hd-line-sm) font-normal data-[density=comfortable]:py-2 data-[density=compact]:py-1',
        fill: 'h-full w-full p-0',
        'icon-circle': 'size-(--hd-btn-h) rounded-full p-0',
      },
    },
    /* The row's ink, said here rather than in the variant: a row that draws
       its own box sets foreground ink, and a `pattern` row takes the ink its
       pattern's sheet gives it. In the variant it tied with that sheet, and
       which one won depended on load order. The indent moved to the `row`
       size for the same reason — it is the box's inset, not a state. */
    compoundVariants: [{ variant: 'row', class: 'text-(--hd-foreground)' }],
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type ButtonVariants = VariantProps<typeof boxedVariants>

/* The same variants over the behaviour alone, for `size="pattern"`. */
const unboxedVariants = cva(BEHAVIOUR.join(' '), {
  variants: { variant: VARIANTS },
  defaultVariants: { variant: 'default' },
})

const buttonVariants = (props: NonNullable<Parameters<typeof boxedVariants>[0]> = {}): string => {
  if (props.size !== 'pattern') return boxedVariants(props)
  const { size: _pattern, ...rest } = props
  return unboxedVariants(rest)
}
type ButtonProps = Omit<ButtonPrimitive.Props, 'className'> & {
  className?: string
  variant?: NonNullable<ButtonVariants['variant']>
  size?: NonNullable<ButtonVariants['size']>
  /** Remove the canonical hairline when adjoining content has to meet the control edge. */
  bordered?: boolean
  /** Selection rows may keep the platform cursor while retaining button semantics. */
  cursor?: 'default' | 'pointer'
  /** A quiet row may brighten its inherited label on hover without changing warning ink. */
  quietHover?: boolean
  /**
   * A colour that is itself the choice — an accent to pick. The button is
   * filled with it and keeps it under the pointer; the ring that marks the one
   * chosen is the `data-swatch` ring every swatch wears. The colour is data,
   * the thing being chosen, never a screen's own paint.
   */
  swatch?: string
}

/* The variants that fill their button. A filled button says so on the
   element, which is what a footer reads to quiet the buttons beside it. */
const FILLED = new Set<string>(['default', 'primary', 'danger'])

const Button = ({
  className,
  variant = 'default',
  size = 'default',
  bordered = true,
  cursor = 'pointer',
  quietHover = false,
  swatch,
  style,
  type,
  render,
  ...props
}: ButtonProps) => (
  <ButtonPrimitive
    data-slot="button"
    data-variant={variant}
    {...(FILLED.has(variant) ? { 'data-filled': '' } : {})}
    {...(swatch !== undefined ? { 'data-swatch': '' } : {})}
    className={cn(
      buttonVariants({ variant, size, className }),
      !bordered && 'border-0',
      cursor === 'default' && 'cursor-default',
      quietHover && 'not-data-[trouble]:hover:text-(--hd-secondary-foreground)',
      swatch !== undefined && 'bg-(--swatch) bg-clip-border hover:bg-(--swatch)',
    )}
    style={swatch !== undefined && typeof style !== 'function' ? ({ ...style, '--swatch': swatch } as CSSProperties) : style}
    /* A bare <button> submits the form around it; nothing in this app means
       that, so the default is the safe one — the same rule Kit's Btn holds.
       Skipped when `render` is given, because the element being rendered may
       not be a button at all and `type` on an anchor is a different attribute. */
    {...(render ? { render } : { type: type ?? 'button' })}
    {...props}
  />
)

export { Button, buttonVariants, type ButtonProps }
