/**
 * The Lead's current step, in the words both surfaces show while a request runs.
 *
 * The host names the step from the desk call in flight and publishes the
 * words in `LeadWindowProjection.activity.step`, so the desktop's live line and
 * the phone's strip say the same thing without each keeping its own map of
 * method names. The words are plain: a method name never reaches a person.
 */
export const LEAD_STEP_THINKING = 'Thinking'
/** The child has handed its answer over and the host is keeping it. */
export const LEAD_STEP_REPLYING = 'Writing the reply'

const LEAD_STEP_WORDS: Readonly<Record<string, string>> = {
  'lead/usage/summary': 'Checking what is left',
  'lead/desk/summary': 'Reading the desk',
  'lead/chat/list': 'Finding chats',
  'lead/chat/read': 'Reading a chat',
  'lead/chat/start': 'Starting a chat',
  'lead/chat/send': 'Messaging a chat',
  'lead/chat/stop': 'Stopping a chat',
  'lead/context/use': 'Checking its context',
  'goal/list': 'Finding Teams',
  'goal/read': 'Reading a Team',
  'flow/catalog': 'Finding workflows',
  'flow/source': 'Reading a workflow',
  'flow/preview': 'Checking the plan',
  'flow/start-goal': 'Starting work',
  'flow/execution': 'Checking work',
  'flow/execution/stop': 'Stopping work',
  'flow/executions': 'Checking runs',
  'evidence/board': 'Reading the board',
  'evidence/seat': 'Checking a worker',
  'insight/goal': 'Checking a Team',
  'library/usage': 'Counting skill use',
  'lead/work/list': 'Reading your work',
  'lead/work/read': 'Reading a work item',
  'lead/work/note': 'Noting progress',
  'lead/memory/propose': 'Offering a note to keep',
  'lead/memory/search': 'Looking back',
  'lead/autonomy/propose': 'Proposing a setting',
  'lead/rules/propose': 'Proposing a rule',
}

/** The words for a desk call, or null for one that names no step of its own (the step before it stays). */
export const leadStepWords = (method: string): string | null =>
  Object.hasOwn(LEAD_STEP_WORDS, method) ? LEAD_STEP_WORDS[method]! : null
