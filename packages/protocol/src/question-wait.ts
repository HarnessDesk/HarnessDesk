/**
 * How long an agent's question waits when nobody is here — in a Goal a
 * trigger opened — before its run stops for a person and its turn ends.
 *
 * A machine setting, never a trigger's or a flow's: nothing a repository, an
 * event or a message carries can shorten or lengthen it. A run a person
 * started has no such wait at all: its Seat's question waits for the answer.
 * Answering after the wait ran out still carries the work on.
 */
export const QUESTION_WAIT_PREFERENCE = 'unattendedQuestionWait'

export const QUESTION_WAITS = ['now', '1m', '5m', '1h', 'back'] as const
export type QuestionWait = (typeof QUESTION_WAITS)[number]

export const DEFAULT_QUESTION_WAIT: QuestionWait = '5m'

const MS: Readonly<Record<QuestionWait, number | null>> = {
  now: 0,
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
  back: null,
}

/** The wait in milliseconds; null waits until a person answers. */
export const questionWaitMs = (wait: QuestionWait): number | null => MS[wait]

/** The stored preference, read: an absent, malformed or unknown value is the default. */
export const questionWaitOf = (preferences: Readonly<Record<string, unknown>>): QuestionWait => {
  const stored = preferences[QUESTION_WAIT_PREFERENCE]
  return (QUESTION_WAITS as readonly unknown[]).includes(stored) ? (stored as QuestionWait) : DEFAULT_QUESTION_WAIT
}

/** What happens to a question nobody is here to answer, as one sentence. */
export const questionWaitSentence = (wait: QuestionWait): string => {
  switch (wait) {
    case 'now':
      return 'Its turn stops right away, and what it said is kept.'
    case '1m':
      return 'Its turn stops after a minute, and what it said is kept.'
    case '5m':
      return 'Its turn stops after five minutes, and what it said is kept.'
    case '1h':
      return 'Its turn stops after an hour, and what it said is kept.'
    case 'back':
      return 'It waits for your answer, however long that takes.'
  }
}
