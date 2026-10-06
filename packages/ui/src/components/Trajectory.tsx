import { useEffect, useMemo } from 'react'

import { typedUserText, type AgentItem, type Turn } from '@harnessdesk/protocol'

import { ChartKey, ChartKeys, CodeText, ProgressStack, publicationVerb, SeriesDot, Separator, Text, type Tint, type Tone } from '../design'
import { toolWords } from '../lib/tool-names'
import { useActiveSession } from '../state/context'
import type { ReportFoot } from './Details'
import { GroupLine, PanelEmpty, PanelRow, RowTime } from './Panel'
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
 * and `plan` were both amber a step apart. On a small dot at the left of a
 * row, one step of a ramp is not a distinction — the legend named four things
 * and drew two. The identity tints exist for exactly this (eight hues spread
 * so no two read alike, each solved for contrast in both themes), so the
 * ledger names them, and the kinds that carry a role or a *judgement* rather
 * than an identity — the person, the agent's answer, an edit, an error — keep
 * the tones that say so. The series mark draws both.
 */
type KindColour = { tint: Tint; tone?: never } | { tone: Tone; tint?: never }

const KIND_COLOUR: Record<string, KindColour> = {
  userMessage: { tone: 'neutral' },
  assistantMessage: { tone: 'brand' },
  reasoning: { tint: 'violet' },
  toolCall: { tint: 'sky' },
  webSearch: { tint: 'teal' },
  command: { tint: 'orange' },
  fileChange: { tone: 'success' },
  plan: { tint: 'amber' },
  error: { tone: 'danger' },
}

const NEUTRAL: KindColour = { tone: 'neutral' }

const colourOfKind = (kind: string): KindColour => KIND_COLOUR[kind] ?? NEUTRAL

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
  subagent: 'Sub-agent',
  publication: 'Publication',
  modelWaiting: 'Model and waiting',
  notMeasured: 'Not measured',
}

/*
 * A compact label for names and paths. User, assistant and thought prose keep
 * their sentence layout and use the full text as their tooltip.
 */
const oneLine = (text: string): string => text.slice(0, 400).replace(/\s+/g, ' ').trim()

const reasoningSummary = (item: Extract<AgentItem, { type: 'reasoning' }>): string | undefined =>
  item.summary.find((summary) => summary.trim().length > 0) ??
  item.content
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

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
      return item.text.trim() || 'Response'
    case 'reasoning':
      return reasoningSummary(item) ?? 'Thinking'
    case 'webSearch':
      return item.query
    case 'notice':
      return oneLine(item.text)
    case 'subagent': {
      // What it was asked, or who took it — never the wire's action word.
      const who = item.members.find((member) => member.nickname)?.nickname
      return oneLine(item.prompt ?? '') || (who ? `Handed to ${who}` : 'Handed work to a sub-agent')
    }
    case 'publication': {
      const { reference } = item
      const title = reference.title ? ` · ${oneLine(reference.title)}` : ''
      return `${publicationVerb(reference)} #${reference.number}${title}`
    }
    case 'userMessage':
      return typedUserText(item.content).trim() || 'Message'
    default:
      return KIND_LABEL[item.type] ?? 'Step'
  }
}

/**
 * Who produced an entry. A glance down this column tells the story of a turn.
 * Said in sentence case at the meta step; the filter matches it lower-cased.
 */
const ROLE: Record<string, string> = {
  userMessage: 'You',
  assistantMessage: 'Agent',
  reasoning: 'Thinking',
  command: 'Shell',
  fileChange: 'Edit',
  toolCall: 'Tool',
  webSearch: 'Web',
  plan: 'Plan',
  notice: 'System',
  compaction: 'System',
  review: 'System',
  image: 'Media',
  error: 'Error',
  subagent: 'Sub-agent',
  publication: 'Post',
}

const roleOf = (item: AgentItem): string => ROLE[item.type] ?? 'Step'

/** A turn's state in words, not in the wire's spelling. */
const TURN_STATE: Record<string, string> = { inProgress: 'running', interrupted: 'stopped', failed: 'failed' }

const durationOf = (item: AgentItem): number | null =>
  'durationMs' in item && typeof item.durationMs === 'number' ? item.durationMs : null

const formatMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`

const measuredWords: Record<string, string> = {
  assistantMessage: 'responses',
  reasoning: 'thinking',
  command: 'commands',
  fileChange: 'edits',
  toolCall: 'tools',
  webSearch: 'web searches',
  plan: 'planning',
  error: 'errors',
}

const measuredText = (ms: number, segments: readonly { kind: string }[]): string => {
  const kinds = segments.map(({ kind }) => measuredWords[kind] ?? `${KIND_LABEL[kind] ?? 'other'} steps`)
  return kinds.length === 0 ? '0m measured' : `${formatMs(ms)} in ${kinds.join(', ')}`
}

/** Reconcile item time with wall time inside each completed turn. */
const summarise = (turns: readonly Turn[]) => {
  const totals = new Map<string, number>()
  const remainders = new Map<string, number>()
  let measured = 0
  let wallTime = 0
  let wallKnown = false
  let overlap = false
  for (const turn of turns) {
    // Leave running turns out of both totals, so a changing wall clock never
    // gets combined with a frozen item snapshot.
    if (turn.status === 'inProgress') continue
    if (typeof turn.durationMs !== 'number' || turn.durationMs < 0) continue
    const turnWall = turn.durationMs
    wallTime += turnWall
    wallKnown = true
    const turnTotals = new Map<string, number>()
    let turnMeasured = 0
    let hasUntimedStep = false
    for (const item of turn.items) {
      if (measuredWords[item.type] && durationOf(item) === null) hasUntimedStep = true
      const duration = durationOf(item)
      if (duration === null || duration <= 0) continue
      turnTotals.set(item.type, (turnTotals.get(item.type) ?? 0) + duration)
      turnMeasured += duration
    }
    const turnCapped = Math.min(turnMeasured, turnWall)
    if (turnMeasured > turnWall) overlap = true
    const scale = turnMeasured > 0 ? turnCapped / turnMeasured : 0
    for (const [kind, ms] of turnTotals) totals.set(kind, (totals.get(kind) ?? 0) + ms * scale)
    measured += turnCapped
    const remainder = Math.max(0, turnWall - turnCapped)
    if (remainder > 0) {
      const kind = hasUntimedStep ? 'notMeasured' : 'modelWaiting'
      remainders.set(kind, (remainders.get(kind) ?? 0) + remainder)
    }
  }
  const wall = wallKnown ? wallTime : null
  const segments = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, ms]) => ({ kind, ms, share: wall !== null && wall > 0 ? ms / wall : 0 }))
    .filter((segment) => segment.ms > 0)
  for (const [kind, ms] of remainders) {
    if (wall !== null && wall > 0 && ms > 0) segments.push({ kind, ms, share: ms / wall })
  }
  const kinds = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
  const headline = wall === null
    ? ''
    : kinds.length === 0
      ? `${formatMs(wall)} · no measured steps`
      : `${formatMs(wall)} · ${measuredText(measured, kinds.map((kind) => ({ kind })))}`
  return {
    measured,
    wall,
    overlap,
    headline,
    segments,
  }
}

type DisplayRow = {
  item: AgentItem
  items: readonly AgentItem[]
  label: string
  duration: number | null
}

/** Fold only adjacent reasoning entries that have no reader-facing summary. */
const displayRows = (items: readonly AgentItem[]): DisplayRow[] => {
  const result: DisplayRow[] = []
  for (let index = 0; index < items.length;) {
    const item = items[index]!
    if (item.type === 'reasoning' && reasoningSummary(item) === undefined) {
      const start = index
      let duration = 0
      let hasDuration = false
      while (index < items.length) {
        const next = items[index]!
        if (next.type !== 'reasoning' || reasoningSummary(next) !== undefined) break
        const nextDuration = durationOf(next)
        if (nextDuration !== null && nextDuration > 0) {
          duration += nextDuration
          hasDuration = true
        }
        index += 1
      }
      const folded = items.slice(start, index)
      result.push({
        item,
        items: folded,
        label: `${folded.length} step${folded.length === 1 ? '' : 's'}, no summary given`,
        duration: hasDuration ? duration : null,
      })
      continue
    }
    result.push({ item, items: [item], label: labelOf(item), duration: durationOf(item) })
    index += 1
  }
  return result
}

const rowRole = (row: DisplayRow): string =>
  row.item.type === 'reasoning' && row.items.length > 1 ? 'Thinking' : roleOf(row.item)

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
        rows: displayRows(turn.items).filter((row) => {
          if (timedOnly && !row.duration) return false
          if (needle.length === 0) return true
          return (
            row.label.toLowerCase().includes(needle) ||
            rowRole(row).toLowerCase().includes(needle)
          )
        }),
      }))
      // A turn with nothing left after filtering is noise, not a result.
      .filter((entry) => entry.rows.length > 0)
  }, [turns, query, timedOnly])

  const totalItems = turns.reduce((count, turn) => count + turn.items.length, 0)

  const shownItems = filtered.reduce((count, entry) => count + entry.rows.reduce((sum, row) => sum + row.items.length, 0), 0)

  useEffect(() => {
    onFoot(
      `${shownItems} step${shownItems === 1 ? '' : 's'}`,
      overview.measured > 0 || overview.wall !== null ? overview.headline : '',
    )
  }, [shownItems, overview.headline, overview.measured, overview.wall, onFoot])

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
        <section aria-label="Where the time went" className={styles.overview}>
          <GroupLine left="Where the time went" right={overview.headline} />
          <ProgressStack
            label="Time by kind of step"
            title={overview.overlap ? 'Some measured item times overlap turn wall time; displayed totals are capped at wall time.' : undefined}
            parts={overview.segments.map((segment) => ({
              id: segment.kind,
              value: segment.share * 100,
              label: segment.kind === 'modelWaiting' || segment.kind === 'notMeasured' ? KIND_LABEL[segment.kind] : undefined,
              reading: segment.kind === 'modelWaiting' || segment.kind === 'notMeasured' ? formatMs(segment.ms) : undefined,
              ...colourOfKind(segment.kind),
            }))}
          />
          <ChartKeys className={styles.keys}>
            {overview.segments.filter((segment) => segment.kind !== 'modelWaiting' && segment.kind !== 'notMeasured').map((segment) => (
              <ChartKey key={segment.kind} {...colourOfKind(segment.kind)} label={<>{KIND_LABEL[segment.kind] ?? 'Other'}<Text role="meta" numeric>{formatMs(segment.ms)}</Text></>} />
            ))}
          </ChartKeys>
          <Separator className={styles.rule} />
        </section>
      )}

      {filtered.length === 0 && <PanelEmpty>No steps match that filter.</PanelEmpty>}
      {filtered.map(({ turn, rows: turnRows }) => {
        const facts = [
          turn.durationMs ? formatMs(turn.durationMs) : null,
          turn.status !== 'completed' ? (TURN_STATE[turn.status] ?? turn.status) : null,
        ].filter(Boolean).join(' · ')
        return (
          <div key={turn.id}>
            <GroupLine sticky left={`Turn ${turns.indexOf(turn) + 1}`} right={facts || undefined} />
            {turnRows.map((row) => {
              const { item, label, duration } = row
              const colour = colourOfKind(item.type)
              return (
                <PanelRow
                  key={item.id}
                  lead={<span className={styles.role}>{rowRole(row)}</span>}
                  mark={colour.tone ? <SeriesDot tone={colour.tone} /> : <SeriesDot tint={colour.tint} />}
                  title={row.items.length > 1
                    ? <span className={styles.label}>{label}</span>
                    : item.type === 'command' || item.type === 'toolCall'
                      ? <CodeText className={styles.label}>{label}</CodeText>
                      : item.type === 'assistantMessage' || item.type === 'userMessage' || item.type === 'reasoning'
                        ? <span className={`${styles.label} ${styles.messageLabel}`}>{label}</span>
                        : <span className={styles.label}>{label}</span>}
                  wrapTitle={row.items.length === 1 && (item.type === 'assistantMessage' || item.type === 'userMessage' || item.type === 'reasoning')}
                  trail={duration ? <RowTime>{formatMs(duration)}</RowTime> : undefined}
                  tooltip={label}
                />
              )
            })}
          </div>
        )
      })}
    </>
  )
}
