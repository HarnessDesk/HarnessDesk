import type { ReactNode } from 'react'
import { Progress } from '../ui/progress'
import { Text } from './Settings'
import type { Tone } from '../ui/tone'

/** The same four readings in a plan card, a quota popover and an account menu. */
export const UsageMeterRow = ({ name, percent, countdown, tone = 'neutral', standalone = false, label }: {
  name: ReactNode
  percent: number | null
  countdown: string
  tone?: Tone
  standalone?: boolean
  label?: string
}) => (
  <div data-slot="usage-meter-row" className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-(--hd-space-2)">
    <span className="min-w-0 truncate text-sm text-(--hd-secondary-foreground)">{name}</span>
    <Progress value={percent} tone={tone} measure="remaining" label={false} aria-label={label ?? (typeof name === 'string' ? `${name} — what is left` : 'What is left')} />
    <Text role="muted" align="end" tone={tone} numeric>{percent === null ? '—' : `${percent}%${standalone ? ' left' : ''}`}</Text>
    <Text role="meta" align="end" numeric>{countdown}</Text>
  </div>
)
