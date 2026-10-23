import { LEAD_LIMITS, windowLeadThread, type LeadAction, type LeadCard, type LeadProgress, type LeadProject, type LeadSettingsProjection } from '@harnessdesk/protocol'
import { leadBudgetProjection, leadPlanRuns, type LeadState } from '@harnessdesk/lead'

/** Reserve the entire envelope; messages may be windowed, actionable cards may not. */
export const leadWindowThread = (state: LeadState, project: LeadProject, settings: LeadSettingsProjection, now = state.budget?.now ?? 0, workers: readonly LeadCard[] = []) => {
  const overhead = new TextEncoder().encode(JSON.stringify({ version: 1, revision: state.seq, settings, thread: null })).byteLength + 512
  return windowLeadThread({ version: 1, id: 'lead', revision: state.seq, state: state.phase, project,
    contract: state.contract, budget: state.budget ? leadBudgetProjection(state.budget, now) : null,
    cardPositions: Object.fromEntries(state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`)).map(card => [card.id, state.cardPositions[card.id]!]).concat(workers.map(card => [card.id, state.seq] as [string, number]))),
    decisions: state.decisionMessages.filter(message => !state.cards.some(card => card.id === message.card.id && !state.decidedCards.includes(`${card.id}:${card.revision}`))),
    olderMessages: state.olderMessages, messages: state.messages,
    cards: [...state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`)), ...workers] }, LEAD_LIMITS.ipcBytes - overhead)
}

/** Shared by child offers and settings writers, inside the journal mutation queue. */
export const admitLeadCard = (state: LeadState, card: LeadCard, project: LeadProject, model: string): void => {
  if (!state.policy || !state.budget) throw Object.assign(new Error('lead-unavailable'), { wireCode: 'lead-unavailable' })
  try {
    leadWindowThread({ ...state, seq: state.seq + 1, cardPositions: { ...state.cardPositions, [card.id]: state.cardPositions[card.id] ?? state.seq + 1 }, cards: [...state.cards.filter(old => old.id !== card.id), card] }, project, {
      version: 1, name: state.name, model, policy: state.policy, caps: state.budget.caps, key: { configured: false, protection: 'unavailable' },
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
