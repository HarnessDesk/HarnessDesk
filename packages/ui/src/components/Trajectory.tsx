import { useEffect, useMemo } from 'react'

import type { AgentItem, Turn } from '@harnessdesk/protocol'

import { toolWords } from '../lib/tool-names'
import { useActiveSession } from '../state/context'
import type { ReportFoot } from './Details'
import { PanelEmpty } from './Panel'
import styles from './Trajectory.module.css'

/**
 * The trajectory ledger.
 *
 * A conversation view answers "what did the agent say"; this answers "where did
 * the time go". Both read the same items, so they cannot disagree — the ledger
 * is a projection, not a parallel recording.
 */

/*
 * A hue per kind, and they have to be nine different hues.
 *
 * This map used to reach past the design system into the platform's raw
 * ramps, and two of its pairs were the same colour by accident: `reasoning`
 * and `assistantMessage` were both the brand blue a step apart, and `command`
 * and `plan` were both amber a step apart. On a 6px dot at the left of a row,
 * one step of a ramp is not a distinction — the legend named four things and
 * drew two. The identity tints exist for exactly this (eight hues spread so
 * no two read alike, each solved for contrast in both themes), so the ledger
 * reads them, and the three kinds that carry a *judgement* rather than an
 * identity keep the state colours that say so.
 */
const KIND_COLOUR: Record<string, string> = {
  userMessage: 'var(--hd-muted-foreground)',
  assistantMessage: 'var(--hd-accent)',
  reasoning: 'var(--hd-tint-violet-ink)',
  toolCall: 'var(--hd-tint-sky-ink)',
  webSearch: 'var(--hd-tint-teal-ink)',
  command: 'var(--hd-tint-orange-ink)',
  fileChange: 'var(--hd-success)',
  plan: 'var(--hd-tint-amber-ink)',
  error: 'var(--hd-danger)',
}

const KIND_LABEL: Record<string, string> = {
  userMessage: 'You',
  assistantMessage: 'Response',
  reasoning: 'Thinking',
  command: 'Command',
  fileChange: 'Edit',
  toolCall: 'Tool',
  webSearch: 'Web search',
  plan: 'Plan',
  notice: 'Notice',
  compaction: 'Compaction',
  review: 'Review',
  image: 'Image',
  error: 'Error',
}

const colourOf = (item: AgentItem): string =>
  KIND_COLOUR[item.type] ?? 'var(--hd-muted-foreground)'

const labelOf = (item: AgentItem): string => {
  switch (item.type) {
    case 'command':
      return item.command
    case 'toolCall':
      // The ledger is a history too, so it reads as words rather than as the
      // identifier — the sentence needs the contributions, which a pure
      // labelling function does not have, so it says the identifier as words.
      return item.source.kind === 'mcp' ? `${item.source.server} · ${toolWords(item.tool)}` : toolWords(item.tool)
    case 'fileChange':
      return item.changes.length === 1
        ? (item.changes[0]?.path.split('/').pop() ?? 'file')
        : `${item.changes.length} files`
    case 'assistantMessage':
      return item.text.slice(0, 80).replace(/\s+/g, ' ') || 'Response'
    case 'reasoning':
      return item.summary[0] ?? 'Thinking'
    case 'webSearch':
      return item.query
    case 'notice':
      return item.text.slice(0, 80)
    case 'userMessage':
      return (
        item.content.find((part) => part.type === 'text')?.text.slice(0, 80) ?? 'Message'
      )
    default:
      return KIND_LABEL[item.type] ?? item.type
  }
}

/** Who produced an entry. A glance down this column tells the story of a turn. */
const ROLE: Record<string, string> = {
  userMessage: 'you',
  assistantMessage: 'agent',
  reasoning: 'thinking',
  command: 'shell',
  fileChange: 'edit',
  toolCall: 'tool',
  webSearch: 'web',
  plan: 'plan',
  notice: 'system',
  compaction: 'system',
  review: 'system',
  image: 'media',
  error: 'error',
}

const durationOf = (item: AgentItem): number | null =>
  'durationMs' in item && typeof item.durationMs === 'number' ? item.durationMs : null

const formatMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`

/** Aggregates measured time per item kind. Unmeasured items are simply absent. */
const summarise = (turns: readonly Turn[]) => {
  const totals = new Map<string, number>()
  let measured = 0
  for (const turn of turns) {
    for (const item of turn.items) {
      const duration = durationOf(item)
      if (duration === null || duration <= 0) continue
      totals.set(item.type, (totals.get(item.type) ?? 0) + duration)
      measured += duration
    }
  }
  return {
    measured,
    segments: [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, ms]) => ({ kind, ms, share: measured > 0 ? ms / measured : 0 })),
  }
}

export const Trajectory = ({
  query,
  timedOnly,
  onFoot,
}: {
  query: string
  timedOnly: boolean
  onFoot: ReportFoot
}) => {
  const session = useActiveSession()

  const turns = session?.turns ?? []
  const overview = useMemo(() => summarise(turns), [turns])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return turns
      .map((turn) => ({
        turn,
        items: turn.items.filter((item) => {
          if (timedOnly && !durationOf(item)) return false
          if (needle.length === 0) return true
          return (
            labelOf(item).toLowerCase().includes(needle) ||
            (ROLE[item.type] ?? item.type).includes(needle)
          )
        }),
      }))
      // A turn with nothing left after filtering is noise, not a result.
      .filter((entry) => entry.items.length > 0)
  }, [turns, query, timedOnly])

  const totalItems = turns.reduce((count, turn) => count + turn.items.length, 0)

  const shownItems = filtered.reduce((count, entry) => count + entry.items.length, 0)

  useEffect(() => {
    onFoot(
      `${shownItems} step${shownItems === 1 ? '' : 's'}`,
      overview.measured > 0 ? `${formatMs(overview.measured)} measured` : '',
    )
  }, [shownItems, overview.measured, onFoot])

  if (totalItems === 0) {
    return (
      <PanelEmpty>
        Nothing has happened in this session yet. The trajectory shows every step the
        agent took, and where the time went.
      </PanelEmpty>
    )
  }

  return (
    <>
      {overview.segments.length > 0 && (
        <div className={styles.overview}>
          <div className={styles.overviewLabel}>
            Where the time went · {formatMs(overview.measured)} measured
          </div>
          <div className={styles.bar}>
            {overview.segments.map((segment) => (
              <span
                key={segment.kind}
                className={styles.segment}
                style={{
                  width: `${segment.share * 100}%`,
                  background: KIND_COLOUR[segment.kind] ?? 'var(--hdp-alias-label-tertiary)',
                }}
                title={`${KIND_LABEL[segment.kind] ?? segment.kind}: ${formatMs(segment.ms)}`}
              />
            ))}
          </div>
          <div className={styles.legend}>
            {overview.segments.map((segment) => (
              <span key={segment.kind} className={styles.legendItem}>
                <span
                  className={styles.swatch}
                  style={{ background: KIND_COLOUR[segment.kind] ?? 'var(--hdp-alias-label-tertiary)' }}
                />
                {KIND_LABEL[segment.kind] ?? segment.kind}
                <span>{formatMs(segment.ms)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className={styles.list}>
        {filtered.length === 0 && <PanelEmpty>No steps match that filter.</PanelEmpty>}
        {filtered.map(({ turn, items }) => (
          <div key={turn.id}>
            <div className={styles.turnLabel}>
              Turn {turns.indexOf(turn) + 1}
              {turn.durationMs ? ` · ${formatMs(turn.durationMs)}` : ''}
              {turn.status !== 'completed' ? ` · ${turn.status}` : ''}
            </div>
            {items.map((item) => {
              const duration = durationOf(item)
              return (
                <div key={item.id} className={styles.row}>
                  <span className={styles.role}>{ROLE[item.type] ?? item.type}</span>
                  <span className={styles.rowDot} style={{ background: colourOf(item) }} />
                  <span
                    className={`${styles.rowLabel} ${
                      item.type === 'command' || item.type === 'toolCall' ? styles.rowMono : ''
                    }`}
                    title={labelOf(item)}
                  >
                    {labelOf(item)}
                  </span>
                  <span className={styles.rowTime}>{duration ? formatMs(duration) : ''}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </>
  )
}