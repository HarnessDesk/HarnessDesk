import { CaretIcon, ChevronIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'
import { inkTone } from './tone'

const DISCLOSURE_CHEVRON_SIZE = { xs: 11, sm: 12, default: 13, lg: 14 } as const

/**
 * The mark on a control that shows or hides content in place: pointing right
 * while the content is folded away, down while it is open.
 *
 * One drawing owns the three things every disclosure used to spell for
 * itself — the quarter turn and its timing, the size, and the ink. The turn is
 * the same `rotate` a button already gives any `[data-chevron][data-open]`
 * inside it, so a chevron drawn here and one inside a button cannot turn
 * twice. The ink is the muted tier; `tone="warning"` is for a fold whose
 * contents are in trouble, so the mark says so while it is closed. The size is
 * the one step that matches the words beside it: `xs` beside meta text, `sm`
 * on a nested fold, `default` on a turn's work fold, `lg` on a full-size row.
 *
 * `placement="trailing"` is the same fold at a row's end: down while folded,
 * up while open. At the end of a row a right-pointing chevron already means
 * "go to" — a settings row's drill-in — so a fold there turns the other way,
 * and it is not the attribute a button turns, since its turn is its own.
 */
const DisclosureChevron = ({
  open,
  tone = 'neutral',
  size = 'default',
  placement = 'leading',
  className,
}: {
  open: boolean
  tone?: 'neutral' | 'warning'
  size?: keyof typeof DISCLOSURE_CHEVRON_SIZE
  /** `leading` points right then down; `trailing`, at a row's end, points down then up. */
  placement?: 'leading' | 'trailing'
  className?: string
}) => {
  const Glyph = placement === 'trailing' ? CaretIcon : ChevronIcon
  return (
    <Glyph
      data-slot="disclosure-chevron"
      data-placement={placement}
      {...(placement === 'leading' ? { 'data-chevron': '' } : {})}
      data-tone={tone}
      data-size={size}
      {...(open ? { 'data-open': '' } : {})}
      aria-hidden
      size={DISCLOSURE_CHEVRON_SIZE[size]}
      className={cn(
        'shrink-0 transition-transform duration-(--hd-duration-fast) ease-(--hd-ease)',
        placement === 'trailing' ? 'data-[open]:rotate-180' : 'data-[open]:rotate-90',
        tone === 'warning' ? inkTone({ tone: 'warning' }) : 'text-(--hd-muted-foreground)',
        className,
      )}
    />
  )
}

export { DisclosureChevron }
