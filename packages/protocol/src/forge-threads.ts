/**
 * Review threads settled by outcome, after a repair round: a thread the fix
 * addressed is resolved and nothing is posted; a suggestion the seat
 * declined gets one sentence, once. The rules for that sentence live here so
 * the plugin, the extension boundary and the host refuse the same things in
 * the same words.
 */

/** The most a declining answer may say, in characters. */
export const THREAD_ANSWER_LIMIT = 280

/** How many repair rounds one bot reviewer's threads may be settled in, on one pull request. */
export const BOT_REVIEWER_ROUNDS = 3

/** A review thread's node id, as the forge spells it. */
export const isReviewThreadId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_=+/-]{4,200}$/.test(value)

/**
 * Why a declining answer cannot be posted, or null when it can: exactly one
 * plain sentence on one line, bounded, with no link, markup or mention. The
 * sentence is checked as trimmed.
 */
export const threadAnswerProblem = (answer: unknown): string | null => {
  if (typeof answer !== 'string') return 'A declined thread needs a one-sentence answer.'
  const text = answer.trim()
  if (text === '') return 'A declined thread needs a one-sentence answer.'
  if (text.length > THREAD_ANSWER_LIMIT) return `The answer must be one sentence of at most ${THREAD_ANSWER_LIMIT} characters.`
  if (/[\r\n\u2028\u2029]/.test(text)) return 'The answer must be one line.'
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'The answer must be plain text.'
  if (/\]\(|\]\[|:\/\/|\bwww\.|</i.test(text)) return 'The answer cannot carry a link or markup.'
  if (/^(?:#|>|[-*+]\s|\d+[.)]\s|```|\|)/.test(text)) return 'The answer must be a sentence, not a heading, quote, list or table.'
  if (/(?:^|[\s(])@[A-Za-z0-9]/.test(text)) return 'The answer cannot mention anyone.'
  if (!/[.!?]["'’”)]*$/.test(text)) return 'The answer must be one sentence, ending with a full stop, question mark or exclamation mark.'
  if (/[.!?]+["'’”)]*\s+\S/.test(text)) return 'The answer must be exactly one sentence.'
  return null
}
