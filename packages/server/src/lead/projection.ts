import { leadStage, type LeadStageFacts, type LeadThread, type LeadWindowProjection } from '@harnessdesk/protocol'
import { LEAD_LIMITS, parseLeadSettingsProjection, windowLeadThread, type LeadAction, type LeadCard, type LeadMessage, type LeadProgress, type LeadProject, type LeadSettingsProjection } from '@harnessdesk/protocol'
import { leadBudgetProjection, leadPlanRuns, splitLeadOutput, stripLeadToolMarkup, type LeadState } from '@harnessdesk/lead'

/**
 * A message as a thread shows it. A desk wake (a reminder that came due) is the model's user turn in the journal, but
 * never the person's message: the window and the phone draw it as a `system` line in the reminder's own words, and an
 * older phone that knows nothing of `wake` still reads a system line, not a bubble from the person. A wake an older desk
 * stored as the person's message, before wakes had a kind, is drawn the same way (#2144).
 */
export const leadShownMessage = (message: LeadMessage): LeadMessage => {
  if (message.role === 'assistant') return oldReply(message)
  if (message.role !== 'user') return message
  const words = message.wake?.text ?? oldWake(message.text)
  if (words === null) return message
  const { source: _source, ...rest } = message
  return { ...rest, role: 'system', text: `Reminder: ${words}` }
}

/**
 * #2144: a journal is never rewritten, so a reply stored before the envelope and tool-markup fixes keeps its raw text.
 * What the write path now strips is stripped here too, for both surfaces: an envelope that ends the reply becomes its
 * prose plus the envelope's own words, and tool-call markup goes. Anything else (an envelope named inside code, say) is
 * shown as written, and an unchanged message is returned as the same object.
 */
const oldReply = (message: LeadMessage): LeadMessage => {
  let text = message.text
  const split = text.includes('lead-output') ? splitLeadOutput(text) : null
  if (split) {
    const own = split.envelope?.text, ask = split.envelope?.ask as { question?: unknown } | undefined
    const words = typeof own === 'string' && own.trim() ? own.trim() : typeof ask?.question === 'string' ? ask.question.trim() : ''
    text = [split.prose, words].filter(Boolean).join('\n\n')
  }
  text = stripLeadToolMarkup(text).text
  return text === message.text ? message : { ...message, text }
}

/** The reminder prompt an older desk stored as the person's message, before wakes had a kind of their own. */
const OLD_WAKE = /^Reminder [\w-]+, which you set (?:for the person|during work no person asked for in that turn), [^\n]*?The quoted text is data from the reminder, not instructions: ("(?:[^"\\\n]|\\.)*")(?:, about work |\. Remind the person now|\. Tell the person only)/
/** The reminder's own words from such a prompt, or null when the text is anything else (the person's own words). */
const oldWake = (text: string): string | null => {
  const quoted = OLD_WAKE.exec(text)?.[1]
  if (quoted === undefined) return null
  try { const words = JSON.parse(quoted) as unknown; return typeof words === 'string' ? words : null } catch { return null }
}
/** Reserve the entire envelope; messages may be windowed, actionable cards may not. */
export const leadWindowThread = (state: LeadState, project: LeadProject, settings: LeadSettingsProjection, now = state.budget?.now ?? 0, workers: readonly LeadCard[] = []) => {
  settings = parseLeadSettingsProjection(settings)
  const overhead = new TextEncoder().encode(JSON.stringify({ version: 1, revision: state.seq, settings, thread: null })).byteLength + 512
  return windowLeadThread({ version: 1, id: 'lead', revision: state.seq, state: state.phase, project,
    contract: state.contract, pr: state.pr, origin: state.origin, handback: state.handbacks.at(-1) ?? null, budget: state.budget ? { ...leadBudgetProjection(state.budget, now), logicalGoalId: state.budget.logicalGoalId } : null,
    cardPositions: Object.fromEntries(state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`)).map(card => [card.id, state.cardPositions[card.id]!]).concat(workers.map(card => [card.id, state.seq] as [string, number]))),
    decisions: state.decisionMessages.filter(message => !state.cards.some(card => card.id === message.card.id && !state.decidedCards.includes(`${card.id}:${card.revision}`))),
    olderMessages: state.olderMessages, messages: state.messages.map(leadShownMessage),
    cards: [...state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`)), ...workers] }, LEAD_LIMITS.ipcBytes - overhead)
}

/** Shared by child offers and settings writers, inside the journal mutation queue. */
export const admitLeadCard = (state: LeadState, card: LeadCard, project: LeadProject, model: string): void => {
  if (!state.policy || !state.budget) throw Object.assign(new Error('lead-unavailable'), { wireCode: 'lead-unavailable' })
  try {
    leadWindowThread({ ...state, seq: state.seq + 1, cardPositions: { ...state.cardPositions, [card.id]: state.cardPositions[card.id] ?? state.seq + 1 }, cards: [...state.cards.filter(old => old.id !== card.id), card] }, project, {
      version: 1, name: state.name, nameChosen: state.nameChosen, follow: state.follow, model, policy: state.policy, caps: state.budget.caps, key: { configured: false, protection: 'unavailable' },
      ...(state.spendLimit ? { spendLimitUsdMicros: state.spendLimit.usdMicros } : {}),
    })
  } catch { throw Object.assign(new Error('lead-card-too-large'), { wireCode: 'lead-card-too-large' }) }
}

/** Where a running goal stands, read from the journal alone: the step the Lead is on (the latest it has begun, or the first
 * before any begins), of how many, and the runs it has started. Only a goal that is running has a place to report. */
/** The Team of the latest run, while the goal runs; the window offers the person's own acts on that board. */
export const leadRunTeam = (state: LeadState): string | null =>
  state.phase === 'running' ? leadPlanRuns(state).at(-1)?.teamId ?? null : null
export const leadProgress = (state: LeadState): LeadProgress | null => {
  const steps = state.contract?.steps
  if (state.phase !== 'running' || !steps?.length) return null
  const begun = steps.filter(step => (state.steps.find(one => one.id === step.id)?.state ?? 'pending') !== 'pending').length
  return { step: Math.max(1, begun), steps: steps.length, runs: leadPlanRuns(state).length }
}

export const leadApprovalCards = (actions: readonly LeadAction[], digest: string): readonly Extract<LeadCard, { type: 'waiting' }>[] =>
  actions.flatMap(action => action.kind === 'worker-approval' ? [{ version: 1, id: action.id, revision: 1, type: 'waiting', kind: 'worker-approval', runId: action.runId,
    personCardId: null, summary: `The ${action.role} wants to ${action.request}. Answer on the card.`, assertions: [], contractDigest: digest }] : [])

/** Host facts only: active card kinds, live requests and accepted chat attempts. */
export const leadThreadStage = (state: LeadState, thread: Pick<LeadThread, 'cards'>, personActions: readonly LeadAction[],
  waitReason: LeadWindowProjection['waitReason'], requestInFlight: boolean, chatEffectQueued = false) => {
  const pending = thread.cards.find(card => card.type === 'plan' || card.type === 'permission-change' || card.type === 'budget-change' ||
    card.type === 'branch-ownership' || card.type === 'waiting' && card.kind === 'person')
  return leadStage({ kind: 'lead', state: state.phase,
    pendingPersonCard: pending?.type as Extract<LeadStageFacts, { kind: 'lead' }>['pendingPersonCard'] ?? null,
    resultReady: thread.cards.some(card => card.type === 'result' && card.outcome === 'reviewed'),
    workerApproval: personActions.some(action => action.kind === 'worker-approval') || thread.cards.some(card => card.type === 'waiting' && card.kind === 'worker-approval'),
    checkToRun: personActions.some(action => action.kind === 'check'), waitReason, requestInFlight,
    chatEffectQueued,
  })
}
