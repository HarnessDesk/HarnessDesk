import type { ReactNode } from 'react'
import { Progress } from '../ui/progress'
import { Clipped, Text } from './Settings'
import type { Tone } from '../ui/tone'

/** The same four readings in a plan card, a quota popover and an account menu.
 * Fixed foundation tracks align the reading and reset columns across rows.
 * The 4px meter and its row use phrasing content so they can sit in a button.
 *
 * A row with nothing to read — no usage reported, a sign-in needed — passes
 * `note` instead of a reading: the sentence takes the meter's, the figure's
 * and the reset's columns, so it starts where the bars do in the rows above
 * rather than straight after its name, and the name column stays one width.
 */
export const UsageMeterRow = ({ name, percent, countdown, tone = 'neutral', standalone = false, label, barless = false, countdownTitle, note, popup = false }: {
  name: ReactNode
  percent: number | null
  countdown: string
  tone?: Tone
  standalone?: boolean
  label?: string
  /** Narrow callers keep the name, remaining figure and reset without spending a bar column. */
  barless?: boolean
  countdownTitle?: string
  /** Why there is no reading, in the reading's place. */
  note?: ReactNode
  popup?: boolean
}) => {
  const progressLabel = label ?? (typeof name === 'string' ? `${name} — what is left` : 'What is left')
  const figure = percent === null ? '—' : `${percent}%${standalone ? ' left' : ''}`
  if (popup) return <span data-slot="usage-meter-row" data-meter-popup="" data-barless={barless ? '' : undefined}>
    <span data-meter-column="name">{name}</span>
    {note != null ? <span data-meter-column="reading" data-meter-note="">{note}</span> : <>
      {!barless && <span data-meter-column="bar"><Progress as="span" size="sm" value={percent} tone={tone} measure="remaining" label={false} aria-label={progressLabel} /></span>}
      <span data-meter-column="reading"><Text role="muted" align="end" tone={tone} numeric>{figure}</Text></span>
      <span data-meter-column="reset"><Text role="meta" align="end" numeric title={countdownTitle}>{countdown}</Text></span>
    </>}
  </span>
  return (
  <span data-slot="usage-meter-row" className={`grid w-full min-w-0 ${barless ? 'grid-cols-[minmax(0,1fr)_var(--hd-usage-meter-reading)_var(--hd-usage-meter-reset)]' : 'grid-cols-[minmax(0,2fr)_minmax(32px,1fr)_var(--hd-usage-meter-reading)_var(--hd-usage-meter-reset)]'} items-center gap-(--hd-space-2)`}>
    <Clipped title={typeof name === 'string' ? undefined : label} className="min-w-0 truncate text-sm text-(--hd-secondary-foreground)">{name}</Clipped>
    {note != null ? (
      <Text role="muted" truncate className="col-span-full col-start-2 min-w-0">{note}</Text>
    ) : (
      <>
        {!barless && <Progress as="span" size="sm" value={percent} tone={tone} measure="remaining" label={false} aria-label={label ?? (typeof name === 'string' ? `${name} — what is left` : 'What is left')} />}
        <Text role="muted" align="end" tone={tone} numeric>{percent === null ? '—' : `${percent}%${standalone ? ' left' : ''}`}</Text>
        <Text role="meta" align="end" numeric title={countdownTitle}>{countdown}</Text>
      </>
    )}
  </span>
  )
}
