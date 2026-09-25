import { useEffect, useMemo } from 'react'

import type { AgentItem, Turn } from '@harnessdesk/protocol'

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
}

/*
 * A message as one line of the ledger. Not cut to a character count: the row
 * ellipsises at whatever width the panel has, and a label cut at 80 characters
 * ended mid-word with no ellipsis at all ("… Can you f"). The cap only keeps a
 * pasted log from becoming a megabyte of DOM.
 */
const oneLine = (text: string): string => text.slice(0, 400).replace(/\s+/g, ' ').trim()

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
      return oneLine(item.text) || 'Response'
    case 'reasoning':
      return item.summary[0] ?? 'Thinking'
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
      return oneLine(item.content.find((part) => part.type === 'text')?.text ?? '') || 'Message'
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
            roleOf(item).toLowerCase().includes(needle)
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
        <section aria-label="Where the time went" className={styles.overview}>
          <GroupLine left="Where the time went" right={`${formatMs(overview.measured)} measured`} />
          <ProgressStack
            label="Measured time by kind of step"
            parts={overview.segments.map((segment) => ({
              id: segment.kind,
              value: segment.share * 100,
              ...colourOfKind(segment.kind),
            }))}
          />
          <ChartKeys className={styles.keys}>
            {overview.segments.map((segment) => (
              <ChartKey
                key={segment.kind}
                {...colourOfKind(segment.kind)}
                label={
                  <>
                    {KIND_LABEL[segment.kind] ?? 'Other'}
                    <Text role="meta" numeric>{formatMs(segment.ms)}</Text>
                  </>
                }
              />
            ))}
          </ChartKeys>
          <Separator className={styles.rule} />
        </section>
      )}

      {filtered.length === 0 && <PanelEmpty>No steps match that filter.</PanelEmpty>}
      {filtered.map(({ turn, items }) => {
        const facts = [
          turn.durationMs ? formatMs(turn.durationMs) : null,
          turn.status !== 'completed' ? (TURN_STATE[turn.status] ?? turn.status) : null,
        ].filter(Boolean).join(' · ')
        return (
          <div key={turn.id}>
            <GroupLine sticky left={`Turn ${turns.indexOf(turn) + 1}`} right={facts || undefined} />
            {items.map((item) => {
              const duration = durationOf(item)
              const label = labelOf(item)
              const colour = colourOfKind(item.type)
              return (
                <PanelRow
                  key={item.id}
                  lead={<span className={styles.role}>{roleOf(item)}</span>}
                  mark={colour.tone ? <SeriesDot tone={colour.tone} /> : <SeriesDot tint={colour.tint} />}
                  title={
                    item.type === 'command' || item.type === 'toolCall'
                      ? <CodeText className={styles.label}>{label}</CodeText>
                      : <span className={styles.label}>{label}</span>
                  }
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
