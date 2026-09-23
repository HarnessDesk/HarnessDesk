import { join } from 'node:path'

import type { AgentEntry, EvidenceRecord, FindingView, Intent, ReviewCandidate } from '@harnessdesk/protocol'

import { EvidenceStore } from '../../src/evidence/store.js'
import { FindingsPlane, type FindingsPort } from '../../src/findings/plane.js'
import { agent, goalRig, type GoalRig } from './flow-goal-rig.js'

/**
 * The findings plane over the flow engine's real Goal rig: a real board, a
 * real run journal, the real `FlowReview` candidates, and a real evidence
 * store on disk. One fixer, then two reviewers (two different Agents), then
 * the fixer again, then both reviewers again — enough to raise, repair and
 * decide with every Seat the host would really have.
 */

export const SHA1 = '1'.repeat(40)
export const SHA2 = '2'.repeat(40)
export const SHA3 = '3'.repeat(40)

export const REVIEWER = (id: string, runtime = 'beta'): AgentEntry => ({
  id, origin: 'project', path: `.harnessdesk/agents/${id}/AGENT.md`, digest: `${id}-digest`, shadows: [], problems: [],
  definition: {
    id, name: id, ceiling: 'read', ceilingFrom: 'ceiling', answers: ['approve', 'request-changes'], produces: ['review'], skills: [],
    prefer: [{ runtime }], brief: `${id} brief`,
  },
})

export const FIX_AND_REVIEW = `
version: 2
name: Fix and review
roles:
  fixer: { kind: agent, uses: implementer, grant: edit, independentOf: [] }
  reviewer: { kind: agent, uses: [code-reviewer, security-reviewer], grant: read, independentOf: [] }
seed: { role: fixer, title: "Fix it" }
rules:
  - { id: to-review, on: fixer, then: { role: reviewer, title: "Review the fix" } }
  - { id: again, on: reviewer, when: { any: [request-changes] }, then: { role: fixer, title: "Repair the findings" } }
messaging: board-only
wait: 240
`

export const AGENTS = (): AgentEntry[] => [agent('implementer', ['done'], 'alpha'), REVIEWER('code-reviewer'), REVIEWER('security-reviewer')]

export interface FindingsRig {
  readonly rig: GoalRig
  readonly store: EvidenceStore
  plane: FindingsPlane
  readonly port: FindingsPort
  goal: string
  run: string
  /** Appends pass through here: a test may delay or refuse one. */
  appendHook: ((record: EvidenceRecord) => Promise<void>) | null
  /** Cards of a role, in order. */
  cards(role: string): Intent[]
  scope(seat: string): { runtime: string; sessionId: string }
  candidate(card: number, seat: string): Promise<ReviewCandidate>
  /** Records a verdict and completes every reviewer card still open with it. */
  finishReviews(verdict: 'approve' | 'request-changes'): Promise<void>
  finishFixer(): Promise<void>
  records(): Promise<EvidenceRecord[]>
  view(id: string): Promise<FindingView>
  /** A fresh plane (and flow engine) over the same files: a restart. */
  restart(): Promise<void>
}

export const findingsRig = async (t: { after(fn: () => Promise<void>): void }): Promise<FindingsRig> => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: SHA1, dirty: false })
  const store = new EvidenceStore(join(rig.dir, 'evidence'))
  const out = {
    rig, store, appendHook: null, goal: '', run: '',
  } as unknown as FindingsRig
  const port: FindingsPort = {
    store: {
      read: (project, file) => store.read(project, file),
      append: async (project, file, lines) => {
        for (const line of lines) if (line.type === 'evidence' && out.appendHook) await out.appendHook(line.record)
        await store.append(project, file, lines)
      },
    },
    seats: {
      byId: (id) => rig.seats.get(id) ?? null,
      latestKeptOf: (runtime, sessionId) =>
        [...rig.seats.values()].filter((seat) => seat.session.runtime === runtime && seat.session.sessionId === sessionId).at(-1) ?? null,
    },
    flows: {
      binding: (goal, card, caller) => rig.flows.findingBinding(goal, card, caller),
      candidate: (id, card, scope) => rig.flows.heldCandidate(id, card, scope),
      journal: (run, step) => rig.flows.withFindingJournal(run, step),
      pending: () => rig.flows.pendingFindings(),
    },
    projectOf: async () => '/repo',
    headOf: async (cwd) => rig.heads.get(cwd) ?? { at: null, dirty: false },
    now: () => Date.now(),
    log: () => {},
  }
  Object.assign(out, { port, plane: new FindingsPlane(port) })
  rig.team.attachFindings(out.plane)
  const execution = await rig.start(FIX_AND_REVIEW, AGENTS())
  await rig.flows.flush()
  out.goal = execution.goal
  out.run = execution.id
  out.cards = (role) => rig.board(out.goal).intents.filter((one) => one.role === role)
  out.scope = (seat) => rig.sessionOf(seat)
  out.candidate = async (card, seat) => {
    const [first] = await rig.review.candidates(card, rig.sessionOf(seat))
    if (!first) throw new Error(`no candidate for card ${card}`)
    return first
  }
  const holder = (card: Intent): string => {
    const found = [...rig.seats.values()].find((seat) => seat.session.sessionId === card.claim?.sessionId)
    if (!found) throw new Error(`nobody holds card ${card.id}`)
    return String(found.id)
  }
  out.finishReviews = async (verdict) => {
    for (const card of out.cards('reviewer').filter((one) => one.state === 'claimed')) {
      const seat = holder(card)
      const candidate = await out.candidate(card.id, seat)
      await rig.review.record({ intent: card.id, candidate: candidate.id, verdict }, rig.sessionOf(seat))
      await rig.team.complete(card.id, { outcome: verdict }, rig.sessionOf(seat))
    }
    await rig.flows.flush()
  }
  out.finishFixer = async () => {
    for (const card of out.cards('fixer').filter((one) => one.state === 'claimed')) {
      await rig.team.complete(card.id, { outcome: 'done' }, rig.sessionOf(holder(card)))
    }
    await rig.flows.flush()
  }
  out.records = async () =>
    (await store.read('/repo', 'evidence')).lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
  out.view = async (id) => {
    const { foldFindings } = await import('../../src/findings/model.js')
    const found = foldFindings(await out.records()).find((one) => one.id === id)
    if (!found) throw new Error(`no finding ${id}`)
    return found
  }
  out.restart = async () => {
    await out.plane.close()
    await rig.restart()
    out.plane = new FindingsPlane(port)
    rig.team.attachFindings(out.plane)
    await out.plane.recover()
  }
  return out
}
