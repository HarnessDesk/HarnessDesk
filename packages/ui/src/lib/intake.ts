import type {
  IssueEvent,
  PullRequestEvent,
  TriggerBudget,
  TriggerCommentFrom,
  TriggerDefinition,
  TriggerField,
  TriggerFiring,
  TriggerGoalStatus,
  TriggerSource,
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
  if (firing.outcome === 'set-aside') return firing.reason ?? 'Set aside for you; it does not run on its own.'
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

const FIELD_WORDS: Readonly<Record<TriggerField, string>> = {
  pr: 'pull request',
  head: 'head commit',
  event: 'event',
  issue: 'issue',
  slot: 'scheduled time',
}

const joinBoth = (words: readonly string[]): string =>
  words.length <= 1 ? words[0] ?? '' : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`

/** How a trigger's firings share Goals, in words rather than its field ids: "One Goal per pull request." */
export const triggerGroupingWords = (fields: readonly TriggerField[]): string =>
  `One Goal per ${joinBoth(fields.map((field) => FIELD_WORDS[field]))}.`

/** What a later firing on an open Goal is, as the row that says what it does: a new head, a later issue event. */
export const triggerAgainLabel = (source: TriggerSource): string | null =>
  source === 'pull-request' ? 'A new head on an open pull request' : source === 'issue' ? 'A later event on an open issue' : null

/** Whose comments fire a trigger, for the review that arms it. */
export const triggerCommentWords = (from: TriggerCommentFrom): string => {
  switch (from) {
    case 'me':
      return 'Only yours: comments by the forge account this trigger is armed with.'
    case 'collaborators':
      return 'Yours, and anyone the forge says can write to the repository.'
    case 'anyone':
      return 'Anyone who can comment on the repository.'
  }
}

const KEY_WORDS: Readonly<Record<string, string>> = {
  id: 'its id', on: 'its source', events: 'its events', label: 'its label', from: 'whose comments count',
  opens: 'what it opens', goal: 'how it groups Goals', again: 'its later rounds', dedupe: 'what makes a firing new',
  concurrency: 'how many run at once', forks: 'forks', budget: 'its budget', every: 'its interval',
}

/**
 * Where a problem in a triggers file is, in words — "Trigger 1, its budget",
 * "Line 7", "Forge sign-in" — rather than the wire path it arrives as
 * (`[0].budget.usd`), which a surface keeps only as a hover title.
 */
export const triggerProblemPlace = (at: string): string => {
  if (at === '' || at === 'file') return 'The file'
  const line = /^line (\d+)$/.exec(at)
  if (line) return `Line ${line[1]}`
  const entry = /^\[(\d+)\](?:\.([a-z-]+))?/.exec(at)
  if (entry) {
    const words = entry[2] ? KEY_WORDS[entry[2]] : undefined
    return `Trigger ${Number(entry[1]) + 1}${words ? `, ${words}` : ''}`
  }
  if (at === 'account') return 'Forge sign-in'
  if (at === 'repository') return 'Forge repository'
  if (at === 'id') return 'This trigger'
  if (at === 'opens') return 'What it opens'
  if (at === 'forks') return 'Forks'
  const role = /^(?:flow\.)?roles\.([^.]+)/.exec(at)
  if (role) return `Its role ${role[1]}`
  if (at === 'flow' || at.startsWith('flow.')) return 'Its flow'
  return 'This trigger'
}
