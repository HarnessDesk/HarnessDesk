import { useMemo } from 'react'

import type { Session, Turn } from '@harnessdesk/protocol'

import { cacheHealthOf } from '../lib/cache-health'
import { formatTokens } from '../lib/context-usage'
import { delegatedIn, summariseTurn } from '../lib/turn-summary'
import { openExternal } from '../lib/desktop'
import { useStore } from '../state/context'
import { KindGlyph } from '../design/patterns/PublicationCard'
import { AlertIcon, CheckIcon, DiffIcon, QuestionIcon, TerminalIcon } from './Icons'
import { MessageActions } from './MessageActions'
import styles from './Conversation.module.css'

/**
 * The line under a finished turn.
 *
 * Reports what the turn cost, because that is the question a user actually has
 * after watching an agent work. Every figure comes from the runtime; nothing is
 * estimated, and anything the runtime did not report is simply absent rather
 * than guessed at.
 */

const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`

/** Items that represent work, as opposed to the prose describing it. */
const STEP_TYPES = new Set(['command', 'fileChange', 'toolCall', 'webSearch'])

export const TurnTail = ({
  turn,
  session,
  hideFiles = false,
  answer = '',
}: {
  turn: Turn
  session: Session
  /** The files card above already lists them. */
  hideFiles?: boolean
  /** The turn's answer, for the copy / rate / retry row. */
  answer?: string
}) => {
  const store = useStore()
  const summary = useMemo(() => summariseTurn(turn, session.cwd), [turn, session.cwd])
  const parts = useMemo(() => {
    // A part carries its own hover line where it has one to give. The cache
    // chip is a verdict, and a verdict has to be able to show its working.
    const out: { text: string; title?: string }[] = []

    const steps = turn.items.filter((item) => STEP_TYPES.has(item.type)).length
    if (steps > 0) out.push({ text: `${steps} step${steps === 1 ? '' : 's'}` })

    if (turn.durationMs) out.push({ text: formatDuration(turn.durationMs) })

    // Usage is reported per session, so only the final turn can claim it as its
    // own. Attributing a running total to every turn would be a lie.
    const isLast = session.turns[session.turns.length - 1]?.id === turn.id
    const usage = isLast ? session.usage : null
    if (usage) {
      const last = usage.last
      if (last.inputTokens > 0 || last.outputTokens > 0) {
        out.push({ text: `${formatTokens(last.inputTokens)} in · ${formatTokens(last.outputTokens)} out` })
      }
      if (last.reasoningOutputTokens > 0) {
        out.push({ text: `${formatTokens(last.reasoningOutputTokens)} thinking` })
      }
      // Cache health, not a hit ratio: an agent that reports writes gets a
      // verdict, one that reports only reads gets the share it can vouch for
      // and a hover line saying why that is all. See `lib/cache-health.ts`.
      const cache = cacheHealthOf(last)
      if (cache) out.push({ text: cache.label, title: cache.title })
    }

    // What *this turn* handed off, summed from its own delegation rows.
    //
    // Read off the turn rather than from `usage.delegated`, which is
    // cumulative over the session and shares its scope with `usage.total`.
    // Pairing that figure with `usage.last` said a turn had delegated work
    // that an earlier turn did — and, once a session is long enough, that it
    // delegated more tokens than the turn spent.
    const handed = delegatedIn(turn)
    if (handed) {
      out.push({
        text: `${handed.exact ? '' : '≥'}${formatTokens(handed.tokens)} delegated`,
        title: handed.exact
          ? 'Spent by sub-agents this turn handed work to. Part of the totals above, not extra to them.'
          : 'Spent by sub-agents this turn handed work to, and at least this much: one of them was still streaming when its last count was taken. Part of the totals above, not extra to them.',
      })
    }

    if (turn.status === 'interrupted') out.push({ text: 'stopped' })
    if (turn.status === 'failed') out.push({ text: 'failed' })
    return out
  }, [turn, session])

  // What the failed chip says on hover: which steps, and — when the turn
  // finished all the same — that the count is not a verdict on the turn.
  const failuresTitle = summary
    ? [
        summary.failures.join('\n'),
        turn.status === 'completed' ? 'The turn finished anyway; the agent carried on from these.' : '',
      ]
        .filter((part) => part.length > 0)
        .join('\n\n')
    : ''

  // A turn that completed with nothing the reader can see — no message, no
  // work — must say so. Silence here looks like a broken app; it once hid a
  // bridge that acknowledged prompts without ever answering them.
  const visible = turn.items.some((item) => item.type !== 'userMessage')
  const silent = turn.status === 'completed' && !visible

  const actions = answer.trim().length > 0 && turn.status === 'completed'
  if (parts.length === 0 && !silent && !summary && !actions && !(turn.status === 'failed' && turn.error)) return null

  return (
    <>
      {/* Where the turn got, for the reader who did not watch it get there:
          files, commands, tests, and what broke — read off the items, not
          the prose. The files open the Changes panel. */}
      {summary && (
        <div className={styles.turnSummary} role="status">
          {summary.files.length > 0 && !hideFiles && (
            <button
              type="button"
              className={styles.turnSummaryItem}
              onClick={() => store.setDetailsTab('changes')}
              title={summary.files.join('\n')}
            >
              <DiffIcon size={12} />
              <span className={styles.turnSummaryLabel}>
                {summary.files.length === 1
                  ? summary.files[0]
                  : `${summary.files.length} files · ${summary.files.slice(0, 2).join(', ')}${summary.files.length > 2 ? ', …' : ''}`}
              </span>
            </button>
          )}
          {summary.commands > 0 && (
            <span className={styles.turnSummaryItem} data-static="">
              <TerminalIcon size={12} />
              <span className={styles.turnSummaryLabel}>
                {summary.commands} command{summary.commands === 1 ? '' : 's'}
              </span>
            </span>
          )}
          {summary.tests && (
            <span
              className={styles.turnSummaryItem}
              data-static=""
              data-tone={summary.tests.failed > 0 ? 'bad' : 'good'}
            >
              {summary.tests.failed > 0 ? <AlertIcon size={12} /> : <CheckIcon size={12} />}
              <span className={styles.turnSummaryLabel}>
                {summary.tests.failed > 0
                  ? `tests failed (${summary.tests.failed} of ${summary.tests.ran} run${summary.tests.ran === 1 ? '' : 's'})`
                  : `tests passed${summary.tests.ran > 1 ? ` (${summary.tests.ran} runs)` : ''}`}
              </span>
            </span>
          )}
          {/* A step that ended badly is worth a count, never the command line:
              a shell one-liner is longer than the column and says nothing at a
              glance. Red only when the turn itself did not finish — inside a
              turn that completed, a non-zero exit is usually a probe the agent
              went on from, and colouring it as a failure misreads the turn. */}
          {summary.failures.length > 0 && (
            <span
              className={styles.turnSummaryItem}
              data-static=""
              {...(turn.status === 'completed' ? {} : { 'data-tone': 'bad' })}
              title={failuresTitle}
            >
              <AlertIcon size={12} />
              <span className={styles.turnSummaryLabel}>
                {summary.failures.length} step{summary.failures.length === 1 ? '' : 's'} failed
              </span>
            </span>
          )}
          {/* What the turn put on the forge, each a door to the page. The
              verb is the transcript row's; here the number is enough. */}
          {summary.published.map((reference, index) => (
            <button
              key={`${reference.url}-${index}`}
              type="button"
              className={styles.turnSummaryItem}
              onClick={() => openExternal(reference.url)}
              title={reference.title ?? reference.url}
            >
              <KindGlyph kind={reference.kind} size={12} />
              <span className={styles.turnSummaryLabel}>
                {reference.kind === 'review'
                  ? `reviewed #${reference.number}`
                  : reference.kind === 'comment'
                    ? `commented on #${reference.number}`
                    : reference.action === 'updated'
                      ? `updated #${reference.number}`
                      : `opened #${reference.number}`}
              </span>
            </button>
          ))}
          {summary.question && (
            <span className={styles.turnSummaryItem} data-static="" data-tone="ask">
              <QuestionIcon size={12} />
              <span className={styles.turnSummaryLabel}>waiting for your answer</span>
            </span>
          )}
        </div>
      )}
      {silent && (
        <div className={styles.turnError} role="status">
          The agent finished this turn without any output.
        </div>
      )}
      {/* A failed turn says why, in the transcript, where the reader is —
          not only as a toast that has already faded by the time they look. */}
      {turn.status === 'failed' && turn.error && (
        <div className={styles.turnError} role="alert">
          {turn.error.message}
          {turn.error.retrying ? ' Retrying…' : ''}
        </div>
      )}
      {(parts.length > 0 || actions) && (
        <div className={styles.turnTail}>
          {actions && <MessageActions text={answer} at={turn.completedAt ?? turn.startedAt} />}
          <span className={styles.turnTailSpacer} />
          <span className={styles.turnTailStats} title={parts.map((part) => part.text).join(' · ')}>
            {parts.map((part, index) => (
              <span key={part.text} {...(part.title ? { title: part.title } : {})}>
                {index > 0 ? ' · ' : ''}
                {part.text}
              </span>
            ))}
          </span>
        </div>
      )}
    </>
  )
}
