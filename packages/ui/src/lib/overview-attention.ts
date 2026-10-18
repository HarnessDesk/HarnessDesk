import type { NeedsYouItem, teamOverview } from './team-overview'
import { runPublication } from './review-publication'

export type OverviewAttention =
  | { kind: 'request'; item: NeedsYouItem }
  | { kind: 'seat'; seat: string; title: string; reason: string | null }
  | { kind: 'findings' | 'publication' | 'run' | 'board' | 'person'; title: string; reason: string | null }

/** One list owns both the Overview badge and its answerable body rows. */
export function overviewAttention(model: ReturnType<typeof teamOverview>, extras: {
  needsYou?: boolean
  runReason?: string | null
  personWaits?: readonly { summary: string }[]
} = {}): OverviewAttention[] {
  const rows: OverviewAttention[] = model.needsYou.map(item => ({ kind: 'request', item }))
  for (const seat of model.seats) {
    if (seat.state === 'needs-you' && !model.needsYou.some(item => item.seat === seat.seat)) {
      rows.push({ kind: 'seat', seat: seat.seat, title: seat.name, reason: seat.reason })
    }
  }
  if (model.run?.waitingFindings) rows.push({kind:'findings',title:'Review the findings',reason:extras.runReason ?? null})
  if (runPublication(model.run?.findingRun, model.run?.publicationOn !== false)?.needsYou) {
    rows.push({kind:'publication',title:'Post the review',reason:model.run?.findingRun?.reason ?? null})
  }
  for (const wait of extras.personWaits ?? []) rows.push({kind:'person',title:wait.summary,reason:null})
  if (rows.length === 0 && (model.run?.needsYou || model.run?.state === 'stalled')) {
    rows.push({kind:'run',title:'Review the Run',reason:null})
  }
  if (rows.length === 0 && extras.needsYou) rows.push({kind:'board',title:'Review the Board',reason:null})
  return rows
}
