import { type BoardEvidence, type Evidence, type EvidenceView, type FlowExecution, type FlowPolicyRole, type Intent } from '@harnessdesk/protocol'
import type { RunTimelineInput } from '../lib/run-timeline'

export const SHAPE_SCENES = ['shapes', 'comparison', 'independent-review', 'alignment', 'investigation'] as const
export type ShapeScene = typeof SHAPE_SCENES[number]
export const SHAPE_REV = ['a'.repeat(40), 'b'.repeat(40)]
export const DOCUMENT_DIFF = 'diff --git a/docs/answer.md b/docs/answer.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/answer.md\n@@ -0,0 +1,3 @@\n+# Investigation answer\n+\n+Keep the session store behind a flag and measure the change.\n'
const agent = (id: string, grant: 'read' | 'edit' = 'edit', isolate = false): FlowPolicyRole =>
  ({ id, kind: 'agent', uses: [id], seats: [], isolate, grant, independentOf: [] })
const person = (id: string): FlowPolicyRole => ({ id, kind: 'person', outcomes: ['accepted'] })
const check: FlowPolicyRole = { id: 'verify', kind: 'check', check: { run: 'pnpm test', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } }
const base = '0'.repeat(40)
const start = Date.now() - 900_000
export const shapeFixture = (scene: ShapeScene, count = 3): RunTimelineInput => {
  const roles = scene === 'comparison' ? [agent('competitor', 'edit', true), check, agent('judge', 'read'), person('merge')]
    : scene === 'alignment' ? [agent('propose', 'read'), person('align'), agent('build')]
    : scene === 'investigation' ? [agent('investigate'), person('read-answer')]
    : [agent('build'), agent('review', 'read')]
  const groups = scene === 'comparison' ? [[1, 2], [3, 4], [5], [6]] : scene === 'alignment' ? [[1], [2]]
    : scene === 'investigation' ? [[1], [2]] : [[1], Array.from({ length: count }, (_, i) => i + 2)]
  const rounds = groups.map((cards, i) => ({ n: i + 1, role: roles[i]!.id, cards, seats: cards.filter(() => roles[i]!.kind === 'agent').map(id => `seat-${id}`),
    evidence: [], state: (i === groups.length - 1 ? 'running' : 'closed') as 'running' | 'closed', cause: `cause-${i}`, blind: (scene === 'independent-review' || scene === 'shapes') && i === 1 && cards.length > 1 }))
  const execution: FlowExecution = { version: 2, id: `run-${scene}`, goal: 'shape-team', state: 'running', reason: null, legacyRun: null,
    startedAt: start, revision: 'f'.repeat(40), brief: 'Improve the session store and keep the evidence with each step.', rounds,
    operations: rounds.flatMap(round => round.cards.map(card => ({ key: `seat-${card}`, kind: roles.find(role => role.id === round.role)?.kind === 'check' ? 'check' as const : 'seat' as const,
      card, seat: `seat-${card}`, state: 'finished' as const }))),
    document: { format: 'agents', flow: { version: 2, name: scene, inputs: [], roles, messaging: 'board-only', wait: 1,
      seed: { role: roles[0]!.id, title: 'Improve the session store' }, rules: roles.slice(0, -1).map((role, i) => ({ id: `rule-${i}`, on: role.id, then: { role: roles[i + 1]!.id, title: `Continue with ${roles[i + 1]!.id}` },
        ...(scene === 'investigation' ? { when: { evidence: [{ diff: true as const }] } } : {}) })) } } }
  const cards: Intent[] = rounds.flatMap(round => round.cards.map((id, i) => {
    const kind = roles.find(role => role.id === round.role)!.kind
    const waiting = kind === 'person'
    const done = !waiting && !(round.role === 'review' && i > 0)
    return { id, role: round.role, title: waiting ? scene === 'alignment' ? 'Agree on the plan before work starts' : 'Read the recorded result' : `${round.role} the session store`,
      detail: waiting ? 'Read the evidence and choose the next step.' : null, state: done ? 'done' : 'open', outcome: done ? 'delivered' : null,
      note: done ? id === 5 ? 'Attempt A preserves the ordering and passes the checks.' : 'Recorded the result and its evidence.' : null,
      createdAt: start + id * 1000, updatedAt: start + id * 2000, files: [], dependsOn: [] }
  }))
  const facts: EvidenceView[] = []
  const add = (id: number, n: number, fact: Evidence, cwd = '/repo') => facts.push({ freshness: { state: 'fresh' }, by: null,
    record: { id: `${id}-${fact.kind}`, observedAt: start + id * 3000, round: n, card: { board: 'shape-team', id }, fact, checkout: { cwd, branch: `shape/attempt-${id}` } } })
  if (scene === 'comparison') {
    for (let i = 0; i < 2; i++) {
      add(i + 1, 1, { kind: 'diff', from: base, to: SHAPE_REV[i]!, files: 2, added: 40 + i, removed: 10 }, `/repo/attempt-${i}`)
      add(i + 3, 2, { kind: 'check', name: 'verify', run: 'pnpm test', at: SHAPE_REV[i]!, exit: i, timedOut: false, dirty: false, tail: i ? 'One test failed' : 'Tests passed' }, `/repo/attempt-${i}`)
      cards[i + 2] = { ...cards[i + 2]!, outcome: i ? 'fail' : 'pass', dependsOn: [1, 2] }
    }
    add(5, 3, { kind: 'review', at: SHAPE_REV[0]!, verdict: 'picked', by: 'seat-5' as never }, '/repo/attempt-0')
  }
  if (scene === 'investigation') add(1, 1, { kind: 'diff', from: base, to: SHAPE_REV[0]!, files: 1, added: 3, removed: 0 })
  const evidence: BoardEvidence = { room: 'shape-team', stamp: 1, checks: [], refused: [], unreadable: null,
    cards: [...new Set(facts.map(one => one.record.card!.id))].map(card => ({ card, running: [], facts: facts.filter(one => one.record.card!.id === card) })) }
  return { execution, cards, evidence, findings: [] }
}
