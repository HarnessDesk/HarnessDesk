import type { FindingRunView, FlowExecution, TriggerPreferences } from '@harnessdesk/protocol'
import { overviewTeamStore } from './team-overview-fixture'
import { triggerGoalStatus, triggerPreferences, triggerProjectView, triggerView } from './intake-fixture'
import type { AppSnapshot } from '../state/snapshot'
import { PREVIEW_FINDINGS } from './findings-fixture'
import { emptyFindingsState } from '../lib/findings'

/** Repeat starts of one pull request's Team, with no live account or host. */
export const triggerRunsStore = () => {
  const store = overviewTeamStore('running')
  const snapshot = store.getSnapshot()
  const goal = snapshot.goals.get('overview-team')!
  const base = snapshot.flowExecutions.get('overview-run')!
  const document = base.document
  if (document.format !== 'agents') throw new Error('The Runs preview requires an Agent flow')
  const now = Date.now()
  const runs = (['settled', 'stopped', 'running'] as const).map((state, n): FlowExecution => ({
    ...base, id: `trigger-run-${n + 1}`, state: state as FlowExecution['state'], startedAt: now - [172_800_000, 10_800_000, 240_000][n]!,
    currentEndedAt: n < 2 ? now - [172_380_000, 10_080_000][n]! : null,
    end: n === 0 ? { kind: 'complete' } : n === 1 ? { kind: 'stopped', by: 'person' } : null,
    target: { kind: 'pull-request', label: 'Retry checkout after a payment timeout', pr: 7, head: 'a1b2c3d4e5f6', base: null, dirty: false },
    intake: { key: `firing-${n}`, trigger: 'review-pr', closureDigest: 'demo', dispatchHeld: false, again: null },
    document: { ...document, flow: { ...document.flow, name: 'Review checkout changes' } },
  }))
  const finding: FindingRunView = { run: base.id, goal: base.goal, round: 2, finished: 2, total: 3,
    embargoed: false, open: 0, blocking: 0, reason: null, ceilingStop: false, stamp: 'demo', publication: 'local',
    rounds: [], reviewersFinished: 2, reviewersTotal: 3, pendingExceptions: [], repair: null,
    boundPr: { repo: 'acme/storefront', pr: 7 }, unbound: null, undecidable: null }
  const findings = new Map(runs.map((run, n) => [run.id, {
    ...finding, run: run.id, goal: run.goal, open: n === 1 ? 2 : 0, blocking: n === 1 ? 2 : 0,
    reviewersFinished: n === 2 ? 2 : 3, reviewersTotal: 3,
  } as FindingRunView]))
  let prefs: TriggerPreferences = triggerPreferences({ day: new Date(now).toISOString().slice(0, 10), chargedUsd: 6, dailyUsd: 20 })
  const patch = (values: Partial<AppSnapshot>) => (store as unknown as { patch: (values: Partial<AppSnapshot>) => void }).patch(values)
  patch({ goals: new Map([[goal.goal.id, { ...goal, activity: null, reservation: undefined,
    goal: { ...goal.goal, sentence: 'Review checkout pull request', origin: { kind: 'trigger', trigger: 'review-pr', event: 'firing-3' } } }]]),
    flowExecutions: new Map(runs.map(run => [run.id, run])), findingRuns: findings,
    findings: new Map([[goal.goal.id, { ...emptyFindingsState(), totals: { all: 2, open: 2, blocking: 2 },
      rows: PREVIEW_FINDINGS.slice(0, 2).map(one => ({ ...one, ownerGoal: goal.goal.id,
        origin: { ...one.origin, goal: goal.goal.id, run: runs[1]!.id } })) }]]) })
  Object.assign(store, {
    loadFindings: async () => {},
    loadFindingRun: async () => {},
    loadVisibleFindingRun: async () => {},
    releaseVisibleFindingRun: () => {},
    triggerGoal: async () => triggerGoalStatus({ goal: goal.goal.id, url: 'https://github.com/acme/storefront/pull/7', budget: null, waits: [] }),
    projectTriggers: async () => triggerProjectView({ project: goal.goal.root, triggers: [triggerView({ armed: true, state: prefs.paused ? 'paused' : 'armed' })] }),
    triggerPreferences: async () => prefs,
    setTriggerPreferences: async (_revision: number, paused: boolean, dailyUsd: number) => {
      prefs = { ...prefs, revision: prefs.revision + 1, paused, dailyUsd }
      patch({ triggerPreferences: prefs })
      return prefs
    },
  })
  return store
}
