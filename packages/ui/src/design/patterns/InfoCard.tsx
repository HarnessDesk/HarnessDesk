import { useEffect, useState, type ReactElement } from 'react'
import { useDismissOverlays } from './Popover'
import { useMenusOpen } from '../ui/popup-state'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card'
import { MiddleTruncate } from '../ui/key-value'
import { Progress, ProgressStack, type ProgressStackPart } from '../ui/progress'
import { Text } from './Settings'
import type { Tone } from '../ui/tone'
export interface InfoFact {
  readonly id: string
  readonly label: string
  readonly value: string | number
  readonly kind?: 'text' | 'path'
  readonly note?: string
  readonly noteKind?: 'text' | 'path'
}
export type InfoNote = string | { readonly text: string; readonly tone?: Tone }
export interface InfoComposition {
  readonly label: string
  readonly source: string
  readonly measured: string
  readonly approximate: boolean
  readonly parts: readonly ProgressStackPart[]
}
export interface InfoCardData {
  readonly title: string
  readonly rows: readonly InfoFact[]
  readonly notes?: readonly InfoNote[]
  readonly meter?: { readonly label: string; readonly value: number | null; readonly max: number; readonly tone?: Tone; readonly reading: string }
  readonly composition?: InfoComposition
}
export const InfoCardBody = ({ title, rows, notes = [], meter, composition }: InfoCardData) => <>
  <p data-info-title="">{title}</p>
  <dl data-info-facts="">{rows.map(row => <div key={row.id} data-info-pair="">
    <dt>{row.label}</dt><dd>{row.kind === 'path' ? <MiddleTruncate>{String(row.value)}</MiddleTruncate> : row.value}</dd>
    {row.note && <dd data-info-pair-note="">{row.noteKind === 'path' ? <MiddleTruncate>{row.note}</MiddleTruncate> : row.note}</dd>}
  </div>)}</dl>
  {meter && <div data-info-meter=""><Progress value={meter.value} max={meter.max} tone={meter.tone} size="sm" label={false} aria-label={meter.label} /><Text role="meta" numeric>{meter.reading}</Text></div>}
  {composition && <div data-info-composition=""><ProgressStack label={composition.label} parts={composition.parts} /><p data-info-note="">{composition.approximate ? `${composition.measured} tokens, as ${composition.source} estimates them — a composition, not a total, so it will not match the figure above.` : `${composition.measured} tokens, measured by ${composition.source}.`}</p></div>}
  {notes.map((note, at) => <p key={at} data-info-note=""><Text role="meta" tone={typeof note === 'string' ? 'neutral' : note.tone}>{typeof note === 'string' ? note : note.text}</Text></p>)}
</>
export const InfoCard = ({ trigger, side = 'bottom', align = 'start', ...data }: InfoCardData & {
  readonly trigger: ReactElement
  readonly side?: 'top' | 'right' | 'bottom' | 'left'
  readonly align?: 'start' | 'center' | 'end'
}) => {
  const [open, setOpen] = useState(false)
  const blocked = useMenusOpen()
  useEffect(() => { if (blocked) setOpen(false) }, [blocked])
  useDismissOverlays(open, () => setOpen(false))
  return <HoverCard open={open} onOpenChange={next => setOpen(next)}>
    <HoverCardTrigger render={trigger} aria-label={data.title}
      onFocus={() => { if (!blocked) setOpen(true) }}
      onBlur={() => setOpen(false)}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
    </HoverCardTrigger>
    <HoverCardContent data-popup-kind="info-card" side={side} align={align}><InfoCardBody {...data} /></HoverCardContent>
  </HoverCard>
}
