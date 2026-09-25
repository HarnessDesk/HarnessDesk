import { useMemo } from 'react'

import type { Session, Turn } from '@harnessdesk/protocol'

import { cacheHealthOf } from '../lib/cache-health'
import { instant } from '../lib/clock'
import { formatTokens } from '../lib/context-usage'
import { delegatedIn } from '../lib/turn-summary'
import { ActionError, Alert, AlertContent, AlertDescription, Text, Tooltip, TooltipContent, TooltipTrigger } from '../design'
import { AlertIcon } from './Icons'
import { MessageActions } from './MessageActions'
import styles from './Conversation.module.css'

/**
 * The line under a finished turn.
 *
 * Actions and the clock stay in the transcript. The figures wait on the
 * clock's tooltip: every one comes from the runtime, and anything the runtime
 * did not report is absent rather than guessed at.
 */

const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`

/** Items that represent work, as opposed to the prose describing it. */
const STEP_TYPES = new Set(['command', 'fileChange', 'toolCall', 'webSearch'])

export const TurnTail = ({
  turn,
  session,
  answer = '',
}: {
  turn: Turn
  session: Session
  /** The turn's answer, for the copy / rate / retry row. */
  answer?: string
}) => {
  const parts = useMemo(() => {
    // Each part is one fact on the clock's hover line.
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

    return out
  }, [turn, session])

  // A turn that completed with nothing the reader can see — no message, no
  // work — must say so. Silence here looks like a broken app; it once hid a
  // bridge that acknowledged prompts without ever answering them.
  const visible = turn.items.some((item) => item.type !== 'userMessage')
  const silent = turn.status === 'completed' && !visible

  const actions = answer.trim().length > 0 && turn.status === 'completed'
  const stamp = instant(turn.completedAt ?? turn.startedAt)
  const when = stamp === null
    ? null
    : new Date(stamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const figures = parts.map((part) => part.text).join(' · ')
  const details = parts.flatMap((part) => part.title ? [part.title] : [])
  if (!silent && !actions && when === null && !(turn.status === 'failed' && turn.error)) return null

  return (
    <>
      {/* Drawn as a failure, but announced politely: nothing the person did
          was refused, and the turn is over, so there is nothing to interrupt. */}
      {silent && (
        <Alert tone="danger" role="status" className={styles.turnError}>
          <AlertIcon />
          <AlertContent>
            <AlertDescription>The agent finished this turn without any output.</AlertDescription>
          </AlertContent>
        </Alert>
      )}
      {/* A failed turn says why, in the transcript, where the reader is —
          not only as a toast that has already faded by the time they look. */}
      {turn.status === 'failed' && turn.error && (
        <ActionError className={styles.turnError}>
          {turn.error.message}
          {turn.error.retrying ? ' Retrying…' : ''}
        </ActionError>
      )}
      {(actions || when !== null) && (
        <Text as="div" role="meta" numeric className={styles.turnTail}>
          {actions && <MessageActions text={answer} />}
          <span className={styles.turnTailSpacer} />
          {when !== null && figures.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className={styles.turnTailTime} tabIndex={0} data-testid="turn-time" />}
              >
                {when}
              </TooltipTrigger>
              <TooltipContent>
                {figures}
                {details.map((detail, index) => (
                  <span key={`${index}-${detail}`}>
                    <br />
                    {detail}
                  </span>
                ))}
              </TooltipContent>
            </Tooltip>
          ) : when !== null ? (
            <span className={styles.turnTailTime} data-testid="turn-time">{when}</span>
          ) : null}
        </Text>
      )}
    </>
  )
}
