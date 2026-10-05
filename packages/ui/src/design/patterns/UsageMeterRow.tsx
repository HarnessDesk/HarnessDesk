import type { ReactNode } from 'react'
import { Progress } from '../ui/progress'
import { Clipped, Text } from './Settings'
import type { Tone } from '../ui/tone'

/** The same four readings in a plan card, a quota popover and an account menu.
 * Fixed foundation tracks align the reading and reset columns across rows.
 * The 4px meter and its row use phrasing content so they can sit in a button.
 */
export const UsageMeterRow = ({ name, percent, countdown, tone = 'neutral', standalone = false, label, barless = false, countdownTitle }: {
  name: ReactNode
  percent: number | null
  countdown: string
  tone?: Tone
  standalone?: boolean
  label?: string
  /** Narrow callers keep the name, remaining figure and reset without spending a bar column. */
  barless?: boolean
  countdownTitle?: string
}) => (
  <span data-slot="usage-meter-row" className={`grid w-full min-w-0 ${barless ? 'grid-cols-[minmax(0,1fr)_var(--hd-usage-meter-reading)_var(--hd-usage-meter-reset)]' : 'grid-cols-[minmax(0,2fr)_minmax(32px,1fr)_var(--hd-usage-meter-reading)_var(--hd-usage-meter-reset)]'} items-center gap-(--hd-space-2)`}>
    <Clipped title={typeof name === 'string' ? undefined : label} className="min-w-0 truncate text-sm text-(--hd-secondary-foreground)">{name}</Clipped>
    {!barless && <Progress as="span" size="sm" value={percent} tone={tone} measure="remaining" label={false} aria-label={label ?? (typeof name === 'string' ? `${name} — what is left` : 'What is left')} />}
    <Text role="muted" align="end" tone={tone} numeric>{percent === null ? '—' : `${percent}%${standalone ? ' left' : ''}`}</Text>
    <Text role="meta" align="end" numeric title={countdownTitle}>{countdown}</Text>
  </span>
)
