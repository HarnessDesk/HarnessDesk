import { useCallback, useState } from 'react'

import { instant } from '../lib/clock'
import { useSessionKey, useStore } from '../state/context'
import { CheckIcon, CopyIcon, RetryIcon, ThumbsDownIcon, ThumbsUpIcon } from './Icons'
import styles from './Items.module.css'

/**
 * The actions under an answer: copy, rate, try again — once per turn, at the
 * end of everything the turn produced, the way Codex places them. They act
 * on the whole answer, not one paragraph of it.
 *
 * Feedback is stored locally rather than sent anywhere: HarnessDesk has no
 * telemetry endpoint, and pretending a thumbs-down went somewhere would be
 * worse than saying it did not. It marks the message for the user's own review
 * and seeds the retry prompt.
 */

export const MessageActions = ({ text, at }: { text: string; at?: number | null }) => {
  const store = useStore()
  const key = useSessionKey()
  const [copied, setCopied] = useState(false)
  const [vote, setVote] = useState<'up' | 'down' | null>(null)
  // A runtime that stamped the turn with something that is not a clock reading
  // gets no time here; a 1969 timestamp under an answer is worse than none.
  const when = instant(at)

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => store.notice('warning', 'Could not copy to the clipboard.'))
  }, [text, store])

  // Queued rather than sent: the user may click this while the agent has
  // already started something else, and "try again" must not be the one
  // message the app throws away.
  const retry = useCallback(() => {
    void store.queue(
      [
        {
          type: 'text',
          text: 'That last response was not right. Please reconsider and try again.',
        },
      ],
      key,
    )
  }, [key, store])

  return (
    <div className={styles.actions} {...(copied || vote ? { 'data-sticky': '' } : {})}>
      <button
        type="button"
        className={styles.action}
        onClick={copy}
        aria-label="Copy this message"
        title="Copy"
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
      <button
        type="button"
        className={styles.action}
        {...(vote === 'up' ? { 'data-on': '' } : {})}
        onClick={() => setVote(vote === 'up' ? null : 'up')}
        aria-label="Mark this response as good"
        title="Good response"
      >
        <ThumbsUpIcon size={13} />
      </button>
      <button
        type="button"
        className={styles.action}
        {...(vote === 'down' ? { 'data-on': '' } : {})}
        onClick={() => setVote(vote === 'down' ? null : 'down')}
        aria-label="Mark this response as poor"
        title="Poor response"
      >
        <ThumbsDownIcon size={13} />
      </button>
      <button
        type="button"
        className={styles.action}
        onClick={retry}
        aria-label="Ask the agent to try again"
        title="Try again"
      >
        <RetryIcon size={13} />
      </button>
      {copied && <span className={styles.actionLabel}>Copied</span>}
      {vote === 'down' && <span className={styles.actionLabel}>Marked for review</span>}
      {!copied && vote !== 'down' && when !== null && (
        <span className={styles.actionLabel}>
          {new Date(when).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        </span>
      )}
    </div>
  )
}
