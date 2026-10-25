import { NO_CAPABILITIES, runtimeId, type LeadAcceptanceContract, type LeadCard, type LeadMemory, type LeadSchedule, type LeadWindowProjection, type RuntimeInfo } from '@harnessdesk/protocol'

/** Synthetic data only. No desktop, key store, transport connection or provider. */
export const leadRuntime: RuntimeInfo = { id: runtimeId('fixture'), name: 'Fixture', capabilities: NO_CAPABILITIES, presentation: { name: 'Demo runtime' } }
export const leadContract: LeadAcceptanceContract = { version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Make the empty state keyboard accessible',
  project: { id: 'demo', path: '/workspace/demo' }, policyRevision: 1,
  steps: [{ id: 'work', title: 'Implement and review', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: { task: 'Check focus order' }, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture', model: 'demo-model' }, ceiling: 'edit' },
      { role: 'review', agent: 'reviewer', seat: { runtime: 'fixture', model: 'demo-model' }, ceiling: 'read' }] }],
  assertions: [{ id: 'checks', kind: 'check', description: 'Keyboard checks pass' }, { id: 'review', kind: 'review', description: 'Fresh review approves' }, { id: 'findings', kind: 'blocking-findings', description: 'Blocking findings resolved' }],
  caps: { usdMicros: 5000000, rounds: 4 } }
export const leadPlan: Extract<LeadCard, { type: 'plan' }> = { version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: leadContract.digest, contract: leadContract }
export const leadBudget = { version: 1 as const, revision: 3, caps: leadContract.caps, leadUsdMicros: 12000, workerUsdMicros: 250000, reservedUsdMicros: 0, roundsAdmitted: 1, spend: 'known' as const, stop: null }
export const leadWaiting: Extract<LeadCard, { type: 'waiting' }> = { version: 1, id: 'waiting', revision: 2, type: 'waiting', kind: 'person', runId: 'run-demo', personCardId: 'person-demo', summary: 'The empty state now keeps focus on its next action.', contractDigest: leadContract.digest,
  assertions: [{ assertionId: 'checks', status: 'passed', revision: 2, contractRevision: 1, evidence: [{ kind: 'check', id: 'keyboard', revision: 'head-demo' }], reason: null }] }
export const leadResult: Extract<LeadCard, { type: 'result' }> = { version: 1, id: 'result', revision: 3, type: 'result', outcome: 'reviewed', contractDigest: leadContract.digest, summary: 'Ready for your acceptance. Inspect the patch in Changes.', assertions: leadContract.assertions.map(assertion => ({ assertionId: assertion.id, status: 'passed', revision: 3, contractRevision: leadContract.revision, evidence: [{ kind: assertion.kind === 'review' ? 'review' : assertion.kind === 'blocking-findings' ? 'finding' : 'check', id: assertion.id, revision: 'head-demo' }], reason: null })), budget: leadBudget }
export const leadProjection = (over: Partial<LeadWindowProjection> = {}): LeadWindowProjection => ({ version: 1, revision: 10,
  settings: { version: 1, name: 'dex', nameChosen: true, model: 'demo-model', key: { configured: true, protection: 'encrypted' }, policy: { version: 1, revision: 1, mode: 'default', rules: [] }, caps: leadContract.caps, follow: { checks: true, reviews: true } },
  thread: { version: 1, id: 'lead', revision: 10, state: 'draft', project: leadContract.project, olderMessages: 0, messages: [], cards: [] },
  requestInFlight: false, wayOut: null, waitReason: null, planConsentExpiresAt: null, ...over })

/** The person's own files, as Settings › Lead shows them: one weekday task, quiet nights, one kept line and one offered. */
export const leadSchedule: LeadSchedule = { version: 1, quiet: { from: '22:00', to: '07:00' }, tasks: [
  { id: 'task-tidy', title: 'Morning tidy', goal: 'Close branches merged last week and list what is left.', every: 'weekdays', at: '09:00', enabled: true, lastRunAt: null },
  { id: 'task-notes', title: 'Release notes draft', goal: 'Draft the notes for what landed this week.', every: 'fridays', at: '16:00', enabled: false, lastRunAt: null }] }
export const leadMemory: LeadMemory = { version: 1, items: [
  { id: 'memory-small', text: 'Keep each pull request small enough to review in one sitting.', state: 'kept', at: 1 },
  { id: 'memory-lint', text: 'Run the linter before asking for review.', state: 'suggested', at: 2 }] }
export const LEAD_SCENES = ['wake-ledger', 'first-name', 'settings-seeds', 'opening-jobs', 'proactive', 'away-digest', 'following', 'handback-running', 'push-card', 'branch-released', 'branch-rewritten', 'handback-limit', 'settings-triggers', 'loading', 'empty', 'goal-composer', 'pending-plan', 'missing-plan', 'predecessor-unavailable', 'predecessor-unverifiable', 'planning', 'running', 'running-message', 'stopped', 'waiting', 'result-person-gate', 'worker-approval', 'required-check', 'resume', 'consent-expired', 'renewal-blocked', 'settings-configured', 'settings-unconfigured', 'stale-card-replacement', 'narrow', 'app-shell'] as const
export type LeadScene = typeof LEAD_SCENES[number]
export const leadSceneProjection = (scene: LeadScene): LeadWindowProjection => {
  const base = leadProjection(), thread = { ...base.thread }
  let projection = base
  if (!['loading', 'empty', 'goal-composer', 'opening-jobs', 'wake-ledger'].includes(scene) && !scene.startsWith('settings-')) thread.messages = [{ version: 1, id: 'goal', revision: 1, role: 'user', text: leadContract.goal }]
  if (['pending-plan', 'consent-expired', 'stale-card-replacement', 'narrow', 'app-shell'].includes(scene)) { thread.cards = [{ ...leadPlan, revision: scene === 'consent-expired' || scene === 'stale-card-replacement' ? 2 : 1 }]; thread.state = 'awaiting-plan'; thread.cardPositions = { plan: 2 } }
  if (scene === 'stale-card-replacement') thread.cards = [{ ...leadPlan, revision: 2, contractDigest: 'b'.repeat(64), contract: { ...leadContract, revision: 2, digest: 'b'.repeat(64), goal: 'Keep focus after the empty state action completes' } }]
  if (thread.cards.some(card => card.type === 'plan')) projection = { ...projection, wayOut: 'decide-plan' }
  if (scene === 'waiting') { thread.cards = [leadWaiting]; thread.state = 'waiting-for-user'; thread.contract = leadContract; thread.budget = leadBudget; thread.cardPositions = { waiting: 3 } }
  if (scene === 'result-person-gate') { thread.cards = [leadResult]; thread.state = 'waiting-for-user'; thread.contract = leadContract; thread.cardPositions = { result: 3 } }
  if (['following', 'handback-running', 'branch-released', 'branch-rewritten'].includes(scene)) {
    const head = 'b'.repeat(40)
    thread.state = scene === 'handback-running' ? 'running' : scene === 'branch-rewritten' ? 'waiting-for-user' : 'following'
    thread.contract = leadContract
    thread.pr = { repository: 'acme/widgets', number: 12, branch: 'repair-focus', head, state: 'open', at: 1,
      branchOwner: scene.startsWith('branch-') ? 'person' : 'lead', check: { head, state: scene === 'handback-running' ? 'failed' : 'pending', total: 3 }, review: { id: 1, head, state: 'approved' },
      ...(scene.startsWith('branch-') ? { observedHead: 'c'.repeat(40), branchChange: scene === 'branch-rewritten' ? 'rewrite' : 'fast-forward', releaseReason: 'Another writer updated the branch.' } : {}) }
    if (scene === 'handback-running') thread.handback = { key: 'repair-2', event: 'checks-failed', kind: 'checks', head, runId: 'run-demo', teamId: 'team-demo', round: 2, at: 1, stage: 'running', publishedHead: null }
    if (scene.startsWith('branch-')) thread.cards = [{ version: 1, id: 'branch', type: 'branch-ownership', revision: 1, contractDigest: leadContract.digest, repository: 'acme/widgets', number: 12, observedHead: 'c'.repeat(40), summary: scene === 'branch-rewritten' ? 'The branch was rewritten outside this goal. Automatic repairs are paused.' : 'Someone else pushed to this branch. Automatic repairs are paused.' }]
  }
  if (scene === 'handback-limit') { thread.state = 'waiting-for-user'; projection = { ...projection, wayOut: 'resume', waitReason: 'lead-handback-limit' } }
  if (scene === 'push-card') { thread.state = 'waiting-for-user'; thread.contract = leadContract; thread.cards = [{ ...leadResult, publication: 'push' }] }
  if (scene === 'pending-plan') thread.origin = { source: 'pull-request', event: 'checks-failed', subject: 'acme/widgets#12', url: 'https://github.com/acme/widgets/pull/12' }
  if (scene === 'required-check') { thread.state = 'running'; thread.contract = leadContract; projection = { ...projection, personActions: [{ kind: 'check', id: 'check-demo', runId: 'run-demo', name: 'verify', command: 'node --test' }] } }
  if (scene === 'worker-approval') { projection = { ...projection, personActions: [{ kind: 'worker-approval', id: 'waiting', runId: 'run-demo', role: 'code reviewer', request: 'read the git log', choices: ['yes-once', 'no'] }] }; thread.cards = [{ ...leadWaiting, kind: 'worker-approval', personCardId: null, summary: 'The code reviewer wants to read the git log. Answer on the card.' }]; thread.state = 'waiting-for-user'; thread.contract = leadContract; thread.budget = { ...leadBudget, spend: 'unknown' }; thread.cardPositions = { waiting: 3 } }
  if (scene === 'planning') { thread.state = 'planning'; projection = { ...projection, requestInFlight: true } }
  if (scene === 'running' || scene === 'running-message' || scene === 'stopped') {
    const running = scene !== 'stopped'
    thread.state = running ? 'running' : 'stopped'; thread.contract = leadContract
    projection = { ...projection, requestInFlight: running, ...(running && { progress: { step: 1, steps: leadContract.steps.length, runs: 1, since: Date.now() - 12 * 60_000 },
      presence: { checked: 3, quiet: 3, lastCheckedAt: Date.now(), readings: [{ runId: 'run-1', kind: 'advanced' }] },
      ...(scene === 'running-message' && { steers: [{ id: 'steer-1', text: 'Keep the public API unchanged.', at: Date.now() - 60_000, state: 'acknowledged' as const }] }) }) }
    thread.messages = [...thread.messages, { version: 1, id: 'reply', revision: 2, role: 'assistant', text: 'The approved Flow is running. I will read its checks and review before asking you to accept.' }]
  }
  if (scene === 'proactive' || scene === 'away-digest') thread.messages = [{ version: 1, id: 'proactive', revision: 2, role: 'assistant', text: 'The review is ready.\nChecks still need you.\nOpen changes', proactive: { finding: 'The review is ready.', caveat: 'Checks still need you.', ask: 'Open changes', action: 'changes' } }]
  if (scene === 'first-name') { thread.messages = []; projection = { ...projection, settings: { ...base.settings, nameChosen: false } } }
  if (scene === 'missing-plan') projection = { ...projection, wayOut: 'decide-plan' }
  if (scene === 'predecessor-unavailable' || scene === 'predecessor-unverifiable') { thread.state = 'waiting-for-user'; projection = { ...projection, wayOut: null, waitReason: `lead-${scene}` } }
  if (scene === 'resume') { thread.state = 'waiting-for-user'; projection = { ...projection, wayOut: 'resume', waitReason: 'lead-request-failed' } }
  // Renewal adds only the expiry fact above the same docked plan decision.
  if (scene === 'consent-expired') { thread.contract = leadContract; thread.budget = leadBudget; thread.cardPositions = { plan: 2 } }
  if (scene === 'consent-expired') projection = { ...projection, wayOut: 'decide-plan', planConsentExpiresAt: Date.parse('2026-10-18T12:00:00Z') }
  if (scene === 'renewal-blocked') { thread.state = 'waiting-for-user'; thread.contract = leadContract; projection = { ...projection, waitReason: 'lead-renewal-blocked', planConsentExpiresAt: Date.parse('2026-10-18T12:00:00Z') } }
  if (scene === 'settings-unconfigured' || scene === 'empty') projection = { ...projection, settings: { ...base.settings, key: { configured: false, protection: 'encrypted' } } }
  return { ...projection, thread }
}

export const leadWakeFixture = [
  { id: 'silent-1', at: Date.now() - 180_000, source: 'desk-change' as const, decision: 'silent' as const, modelTurn: false, usdMicros: null },
  { id: 'scheduled-1', at: Date.now() - 60_000, source: 'schedule' as const, decision: 'asked' as const, modelTurn: true, usdMicros: 1200 },
]
