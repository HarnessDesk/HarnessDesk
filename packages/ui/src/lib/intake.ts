import type {
  IssueEvent,
  PullRequestEvent,
  TriggerBudget,
  TriggerDefinition,
  TriggerFiring,
  TriggerGoalStatus,
  TriggerStopReason,
} from '@harnessdesk/protocol'

/**
 * Sentences for a project's `.harnessdesk/triggers.yml`, read the same way
 * `lib/agents.ts` and `lib/flows.ts` turn a typed fact into a row's words.
 *
 * Nothing here reaches into a source's own prose (`title`, `body`) — every
 * word is built from the declaration's own closed vocabulary, which is the
 * point of that vocabulary being closed.
 */

const PR_EVENT_WORDS: Readonly<Record<PullRequestEvent, string>> = {
  opened: 'opens',
  pushed: 'is pushed',
}

const ISSUE_EVENT_WORDS: Readonly<Record<IssueEvent, string>> = {
  labelled: 'is labelled',
  closed: 'closes',
  commented: 'is commented on',
}

const joinEither = (words: readonly string[]): string =>
  words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`

const scheduleWords = (everyMinutes: number): string => {
  if (everyMinutes % 60 === 0) {
    const hours = everyMinutes / 60
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${everyMinutes} minute${everyMinutes === 1 ? '' : 's'}`
}

/** What a trigger declares, as one sentence: "When a pull request opens or is pushed, open review-pr, at most 4 at once." */
export const triggerSentence = (definition: TriggerDefinition): string => {
  const opens = 'flow' in definition.opens ? definition.opens.flow : definition.opens.agent
  const times = definition.concurrency === 1 ? 'once at a time' : `at most ${definition.concurrency} at once`
  const when = definition.on.kind === 'schedule'
    ? `Every ${scheduleWords(definition.on.everyMinutes)}`
    : definition.on.kind === 'pull-request'
      ? `When a pull request ${joinEither(definition.on.events.map((event) => PR_EVENT_WORDS[event]))}`
      : `When an issue ${joinEither(definition.on.events.map((event) => ISSUE_EVENT_WORDS[event]))}`
  return `${when}, open ${opens}, ${times}.`
}

/** A trigger's budget, in one line: "Up to $5, 3 rounds, 4 hours; stops after 2 rounds with no progress." */
export const triggerBudgetWords = (budget: TriggerBudget): string => {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  return `Up to $${budget.usd}, ${plural(budget.rounds, 'round')}, ${plural(budget.hours, 'hour')}; stops after ${plural(budget.withoutProgress, 'round')} with no progress.`
}

/** What became of one firing, for a project's visible history — a duplicate is always named as such. */
export const triggerSkipWords = (firing: TriggerFiring): string => {
  if (firing.outcome === 'duplicate') return 'Already recorded.'
  if (firing.outcome === 'pending') return 'Still being applied…'
  if (firing.outcome === 'recorded') return firing.reason ?? 'Recorded — joined its open Goal without a new round.'
  if (firing.outcome === 'skipped') return firing.reason ?? 'Skipped.'
  return firing.reason ?? 'Fired.'
}

/** A trigger Goal's origin, from the host's own label: "Opened from PR #12." */
export const intakeOriginWords = (status: TriggerGoalStatus): string => `Opened ${status.label}`

/**
 * Why unattended work on a trigger's Goal stopped, as a full sentence — the
 * protocol's own exact words always appear in it, verbatim, so a person who
 * has read one stop reason recognises every other one that means the same
 * thing.
 */
export const intakeStopWords = (reason: TriggerStopReason): string => {
  switch (reason) {
    case 'answered':
      return 'Answered.'
    case 'crashed':
      return 'It crashed.'
    case 'timed out':
      return 'Timed out.'
    case 'lease expired':
      return 'Its lease expired.'
    case 'cancelled':
      return 'Cancelled.'
    case 'out of budget':
      return 'Out of budget.'
    case 'asked a question nobody can answer':
      return 'It asked a question nobody can answer.'
    case 'needs a person':
      return 'It needs a person.'
    default:
      return reason
  }
}
