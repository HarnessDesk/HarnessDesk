import { sessionKey, type GoalView, type SeatRecord } from '@harnessdesk/protocol'
import { PREVIEW_GOAL } from './goal-fixture'
import { PREVIEW_ROOM, previewStore } from './harness'
import { shapeFixture } from './run-shapes-fixture'
import { SIDE_BY_SIDE_KEYS, SIDE_BY_SIDE_MEMBERS, sideBySideStore } from './side-by-side-fixture'
import type { AppStore } from '../state/store'

export type ComparisonScene = 'before' | 'picked' | 'person' | 'no-pass' | 'approval' | 'long-reason' | 'merged' | 'stopped' | 'combined'
/** Recorded synthetic Run facts drive the real Team pane, chips, Run door and shared attempt dialog. */
export const comparisonVerdictStore = (scene: ComparisonScene = 'picked'): AppStore => {
  const base = sideBySideStore({ noGoal: true, waiting: scene === 'approval', browsers: scene === 'combined' })
  const snapshot = base.getSnapshot()
  const input = shapeFixture('comparison')
  const picked = ['picked', 'approval', 'long-reason', 'merged', 'stopped', 'combined'].includes(scene)
  const person = scene === 'person'
  const seatIds = ['seat-1', 'seat-2', 'seat-5']
  const members = SIDE_BY_SIDE_MEMBERS.slice(0, 3).map((member, i): SeatRecord => ({
    id: seatIds[i]! as SeatRecord['id'], session: { runtime: member.runtime, sessionId: member.id }, role: i === 2 ? 'judge' : 'competitor', openedAt: 0, closed: null, agent: null, seatLabel: member.nickname,
    briefDigest: null, seat: { runtime: member.runtime, model: member.model }, passedOver: [], standing: { kind: 'unknown' }, ceiling: null,
    checkout: { cwd: scene === 'combined' ? snapshot.sessions.get(SIDE_BY_SIDE_KEYS[i]!)!.cwd : '/workspace/demo-client', project: '/workspace/demo-client', branch: `attempt-${i + 1}`, head: null }, board: PREVIEW_ROOM,
  }))
  const run = { ...input.execution, goal: PREVIEW_ROOM,
    rounds: input.execution.rounds.filter(round => picked || round.n <= (scene === 'no-pass' ? 2 : 3)).map(round => ({ ...round, ...(round.n === 3 && !picked ? { state: 'running' as const, ...(person ? { seats: [] } : {}) } : {}) })),
  }
  if (scene === 'stopped') { run.state = 'stopped'; run.endedAt = Date.now(); run.end = { kind: 'stopped', by: 'person' } }
  if (scene === 'merged') { run.state = 'settled'; run.endedAt = Date.now(); run.end = { kind: 'complete' }; run.rounds = run.rounds.map(round => ({ ...round, state: 'closed' })) }
  if (person && run.document.format === 'agents') run.document = { ...run.document, flow: { ...run.document.flow,
    roles: run.document.flow.roles.map(role => role.id === 'judge' ? { id: 'judge', kind: 'person', outcomes: ['picked'] } : role),
    rules: [{ id: 'after-judge', on: 'judge', when: { every: ['picked'], evidence: [{ review: 'picked' }] }, then: { role: 'merge', title: 'Merge the picked change' } }],
  } }
  const cards = input.cards.filter(card => run.rounds.some(round => round.cards.includes(card.id))).map(card => ({ ...card,
    title: card.id <= 2 ? 'Make the client retry a 502 before giving up' : card.id === 5 ? 'Pick the better attempt' : card.id === 6 ? 'Merge the picked change' : card.title,
    ...(card.id === 5 ? { state: picked ? 'done' as const : 'open' as const, outcome: picked ? 'picked' : null, note: picked ? 'Attempt A keeps retries inside the client and passes the checks.' : null } : {}),
    ...(card.id === 5 && scene === 'long-reason' ? { note: `Attempt A keeps ${'the retries and ordering inside the client, '.repeat(12)}preserves the original request and passes the checks.` } : {}),
    ...(card.id === 6 && scene === 'merged' ? { state: 'done' as const, outcome: 'accepted' } : {}),
    ...(scene === 'no-pass' && card.role === 'verify' ? { outcome: 'fail' } : {}),
  }))
  const evidence = { ...input.evidence!, room: PREVIEW_ROOM, cards: input.evidence!.cards.filter(card => picked || card.card !== 5).map(card => scene !== 'no-pass' ? card : { ...card, facts: card.facts.map(view => view.record.fact.kind === 'check' ? { ...view, record: { ...view.record, fact: { ...view.record.fact, exit: 1 } } } : view) }) }
  const team = { ...snapshot.teams.get(PREVIEW_ROOM)!, channel: [], nicknames: Object.fromEntries(SIDE_BY_SIDE_KEYS.map((key, i) => [key, SIDE_BY_SIDE_MEMBERS[i]!.nickname])), name: 'Compare the retry changes', members: SIDE_BY_SIDE_KEYS.slice(0, person ? 2 : 3), intents: cards }
  const goal: GoalView = { ...PREVIEW_GOAL, activity: scene === 'merged' ? 'ready-to-wrap' : scene === 'stopped' ? 'working' : PREVIEW_GOAL.activity,
    goal: { ...PREVIEW_GOAL.goal, id: PREVIEW_ROOM, sentence: team.name, origin: { kind: 'flow', run: run.id } }, reservation: { run: run.id }, board: team, members: person ? members.slice(0, 2) : members }
  const sessions = new Map([...snapshot.sessions].map(([key, session]) => [key, { ...session, status: { type: 'idle' as const } }]))
  const own = previewStore({ ...snapshot, sessions, teams: new Map([[PREVIEW_ROOM, team]]), goals: new Map([[PREVIEW_ROOM, goal]]),
    flowExecutions: new Map([[run.id, run]]), flowRuns: new Map(), boardEvidence: new Map([[PREVIEW_ROOM, evidence]]),
  })
  return Object.assign(own, {
    teamPeers: async () => (await base.teamPeers(PREVIEW_ROOM)).slice(0, person ? 2 : 3),
    flowReviewCandidates: async () => input.evidence!.cards.filter(card => card.card <= 2).map(card => {
      const diff = card.facts.find(view => view.record.fact.kind === 'diff')!.record
      return { id: `candidate-${card.card}`, card: card.card, at: diff.fact.kind === 'diff' ? diff.fact.to : '', branch: `attempt-${card.card}`, evidence: [], holder: SIDE_BY_SIDE_MEMBERS[card.card - 1]!.nickname }
    }),
    decideFlowReview: async () => {},
  })
}
