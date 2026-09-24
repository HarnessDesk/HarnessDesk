import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  EvidenceRecord, FindingOverride, FindingRunState, FlowExecution,
} from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import type { FindingRunSnapshot, RunDecisionOps } from '../src/flow-execution.js'
import { Serial } from '../src/goals/assignments.js'
import { FindingsPlane, type FindingsPort } from '../src/findings/plane.js'
import { tempDir } from './scratch.js'

/*
 * `finding/decide`: a person's bounded actions on a stopped run. Every action
 * is bound to the run/round/stamp the person actually read — a stamp that
 * does not match refuses before anything is touched — and only `adjudicate`
 * writes a finding event; the rest are the run's own bookkeeping, or a
 * hand-off to an action this plane never performs itself.
 */

const ROOT = '/work/repo'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const GOAL = 'g1'
const RUN = 'run-1'

const raise = (n: number, over: Partial<EvidenceRecord['finding']> = {}): EvidenceRecord => ({
  id: `raise-${n}`,
  fact: { kind: 'finding', id: `finding-${String(n).padStart(4, '0')}`, state: 'open', at: A },
  card: { board: GOAL, id: 2 }, checkout: { cwd: ROOT, branch: 'fix' }, seat: 'seat-r', round: 2, observedAt: n, posted: null,
  finding: {
    version: 1, sequence: 1, operation: `op-raise-${n}`,
    origin: { goal: GOAL, run: RUN, round: 2, card: 2, seat: 'seat-r', at: A },
    event: { kind: 'raise', title: `Finding ${n}`, body: 'Details.', category: 'ordinary', blocking: true, related: null, anchor: null },
    ...over,
  } as EvidenceRecord['finding'],
})

const startingFindings = (over: Partial<FindingRunState> = {}): FindingRunState => ({
  version: 1, budget: { rounds: 3, withoutProgress: 2 }, closedRounds: [1], idleRounds: 0, progress: [],
  series: [{ id: `reviewer@${ROOT}`, role: 'reviewer', checkout: { cwd: ROOT, branch: 'fix' }, reviewedAt: A, reviewRounds: [1], initial: ['finding-0001'], exceptions: [], pending: [] }],
  stopped: { round: 1, reason: 'Round 1 ended with 1 open findings.' }, extraRound: null, overrides: [], lastDecision: null,
  ...over,
})

interface Rig {
  readonly store: EvidenceStore
  readonly plane: FindingsPlane
  now: number
  headAt: string
  snapshot: FindingRunSnapshot
  readonly calls: {
    authorizeExtraRound: { run: string; round: number; reason: string }[]
    recordExceptionDecision: { run: string; findings: readonly string[]; admit: boolean }[]
    recordOverride: { run: string; override: FindingOverride }[]
    stopRun: { run: string; reason: string }[]
  }
}

const execution = (snapshot: FindingRunSnapshot): FlowExecution => ({
  version: 2, id: snapshot.id, goal: snapshot.goal, document: { format: 'agents', flow: {} as never },
  state: 'stalled', rounds: [], operations: [], legacyRun: null, reason: null, findings: snapshot.findings ?? undefined,
})

/** A fake run's decision actions, as `FlowExecutions.withDecision` hands them: its own queued methods, called in order. */
const opsOf = (flows: FindingsPort['flows'], run: string): RunDecisionOps => ({
  authorizeExtraRound: async (round, reason) => { await flows.authorizeExtraRound!(run, round, reason) },
  recordExceptionDecision: async (findings, admit) => { await flows.recordExceptionDecision!(run, findings, admit) },
  recordOverride: async (override) => { await flows.recordOverride!(run, override) },
  recordDecisionStamp: async (stamp, key) => { await flows.recordDecisionStamp!(run, stamp, key) },
  stop: async (why) => { await flows.stopRun!(run, why) },
})

const rig = async (findingsOver: Partial<FindingRunState> = {}): Promise<Rig> => {
  const decisions = new Serial()
  const home = tempDir('hd-findings-decisions-')
  const store = new EvidenceStore(home)
  await store.append(ROOT, 'evidence', [raise(1)].map((record) => ({ type: 'evidence', record }) as const))
  const out = {
    store, now: 1_000, headAt: A,
    snapshot: {
      id: RUN, goal: GOAL, state: 'stalled', findings: startingFindings(findingsOver),
      rounds: [{ n: 1, role: 'reviewer', cards: [1], seats: ['seat-r'], evidence: [], state: 'closed', cause: 'seed', reviews: true }],
      slots: {}, pendingFindings: 0, pinned: {}, leads: {},
    },
    calls: { authorizeExtraRound: [], recordExceptionDecision: [], recordOverride: [], stopRun: [] },
  } as unknown as Rig
  const port: FindingsPort = {
    store: { read: (project, file) => store.read(project, file), append: (project, file, lines) => store.append(project, file, lines) },
    seats: { byId: () => null, latestKeptOf: () => null },
    flows: {
      binding: () => null, candidate: async () => null, journal: async () => { throw new Error('unused') }, pending: () => [],
      run: (run) => (run === RUN ? out.snapshot : null),
      seriesOfGoal: () => out.snapshot.findings?.series ?? [],
      facts: async () => [],
      authorizeExtraRound: async (run, round, reason) => {
        out.calls.authorizeExtraRound.push({ run, round, reason })
        out.snapshot = { ...out.snapshot, findings: { ...out.snapshot.findings!, extraRound: { after: round, reason } } }
        return execution(out.snapshot)
      },
      recordExceptionDecision: async (run, findings, admit) => {
        out.calls.recordExceptionDecision.push({ run, findings, admit })
        const names = new Set(findings)
        const series = out.snapshot.findings!.series.map((one) => ({
          ...one,
          pending: one.pending.filter((id) => !names.has(id)),
          exceptions: admit ? [...one.exceptions, ...one.pending.filter((id) => names.has(id))] : one.exceptions,
        }))
        out.snapshot = { ...out.snapshot, findings: { ...out.snapshot.findings!, series } }
        return execution(out.snapshot)
      },
      recordOverride: async (run, override) => {
        out.calls.recordOverride.push({ run, override })
        out.snapshot = { ...out.snapshot, findings: { ...out.snapshot.findings!, overrides: [...out.snapshot.findings!.overrides, override] } }
        return execution(out.snapshot)
      },
      stopRun: async (run, reason) => {
        out.calls.stopRun.push({ run, reason })
        out.snapshot = { ...out.snapshot, state: 'stopped' }
        return execution(out.snapshot)
      },
      recordDecisionStamp: async (run, stamp, key) => {
        out.snapshot = { ...out.snapshot, findings: { ...out.snapshot.findings!, lastDecision: { stamp, key } } }
        return execution(out.snapshot)
      },
      // The run's queue, as FlowExecutions.withDecision holds it: this fake's actions, one decision at a time.
      decide: (run, step) => decisions.run(() => step(opsOf(port.flows, run))),
    },
    projectOf: async (goal) => { if (goal !== GOAL) throw new Error('That Goal is not on this desk.'); return ROOT },
    headOf: async () => ({ at: out.headAt, dirty: false }),
    now: () => out.now,
    log: () => {},
  }
  Object.assign(out, { plane: new FindingsPlane(port) })
  return out
}

const currentView = async (rig: Rig) => rig.plane.runView(RUN)

test('a forged Goal and a wrong-run decision both refuse before any state moves', async () => {
  const state = await rig()
  const view = await currentView(state)
  await assert.rejects(
    state.plane.decideRun({ goal: 'not-g1', run: RUN, round: 1, stamp: view.stamp, action: { kind: 'another-round' }, reason: 'ceiling' }),
    /does not belong to this Goal/,
  )
  await assert.rejects(
    state.plane.decideRun({ goal: GOAL, run: 'no-such-run', round: 1, stamp: view.stamp, action: { kind: 'another-round' }, reason: 'ceiling' }),
    /no flow run/,
  )
  assert.deepEqual(state.calls.authorizeExtraRound, [])
})

test('a stale stamp — the head moved since it was read — invalidates a merge override', async () => {
  const state = await rig()
  const view = await currentView(state)
  state.headAt = B // the writer committed between the preview and the decision
  await assert.rejects(
    state.plane.decideRun({ goal: GOAL, run: RUN, round: 1, stamp: view.stamp, action: { kind: 'merge-anyway' }, reason: 'shipping regardless' }),
    /changed since you read it/,
  )
  assert.deepEqual(state.calls.recordOverride, [], 'no override at the moved head, and nothing else attempted a merge')
})

test('one additional round is one durable allowance: a duplicate press replays it, a conflicting one refuses', async () => {
  const state = await rig()
  const view = await currentView(state)
  const input = { goal: GOAL, run: RUN, round: 1, stamp: view.stamp, action: { kind: 'another-round' as const }, reason: 'let it try once more' }
  const first = await state.plane.decideRun(input)
  assert.equal(state.calls.authorizeExtraRound.length, 1)
  // A duplicate press — the exact same stamp, action and reason, as a lost answer's retry would resend — replays
  // the same outcome. The port's own action is not asked again: this is the decision already applied, not a second one.
  const replay = await state.plane.decideRun(input)
  assert.equal(state.calls.authorizeExtraRound.length, 1, 'still exactly one round opened')
  assert.deepEqual(replay, first)
  // A different action resubmitted under that same, now-consumed stamp is a genuine conflict, not a replay.
  await assert.rejects(
    state.plane.decideRun({ ...input, action: { kind: 'drop' }, reason: 'actually just drop it' }),
    /already used for a different decision/,
  )
  assert.deepEqual(state.calls.stopRun, [], 'the conflicting resubmission never reached the drop action')
  // A fresh read — a new stamp, since granting the round moved the view — may authorize the same round again;
  // this is the person pressing the same button twice from two different page loads, not a lost-answer retry.
  const again = await currentView(state)
  await state.plane.decideRun({ ...input, stamp: again.stamp })
  assert.equal(state.calls.authorizeExtraRound.length, 2, 'asked again, but at the same round — no budget was reset')
  assert.equal(state.calls.authorizeExtraRound[1]!.round, 1)
})

test('a merge-anyway override records disagreement without clearing any fact', async () => {
  const state = await rig()
  const view = await currentView(state)
  const before = state.snapshot.findings!.series[0]!.initial
  await assert.rejects(
    state.plane.decideRun({ goal: GOAL, run: RUN, round: 1, stamp: view.stamp, action: { kind: 'merge-anyway' }, reason: 'time pressure' }),
    /Publish a pull request/,
  )
  assert.equal(state.calls.recordOverride.length, 0, 'no bound pull request: merge-anyway refuses, it does not silently record')
  assert.deepEqual(state.snapshot.findings!.series[0]!.initial, before, 'the blocking baseline is untouched either way')
})

test('merge-anyway records the exact unresolved blockers once a pull request is bound', async () => {
  const state = await rig()
  await state.store.append(ROOT, 'evidence', [{
    type: 'evidence',
    record: {
      id: 'pr-1', fact: { kind: 'pr', number: 9, state: 'open', head: A, url: 'https://github.com/org/repo/pull/9' },
      card: null, checkout: null, seat: null, round: null, observedAt: 1, posted: null,
    } as unknown as EvidenceRecord,
  }])
  // Rebuild the plane's port so `facts` actually returns the pr fact this test just wrote.
  const port2: FindingsPort = {
    store: { read: (project, file) => state.store.read(project, file), append: (project, file, lines) => state.store.append(project, file, lines) },
    seats: { byId: () => null, latestKeptOf: () => null },
    flows: {
      binding: () => null, candidate: async () => null, journal: async () => { throw new Error('unused') }, pending: () => [],
      run: (run) => (run === RUN ? state.snapshot : null),
      seriesOfGoal: () => state.snapshot.findings?.series ?? [],
      facts: async () => (await state.store.read(ROOT, 'evidence')).lines.flatMap((line) => (line.type === 'evidence'
        ? [{ record: line.record, freshness: { state: 'fresh' as const }, by: null }]
        : [])),
      authorizeExtraRound: async () => { throw new Error('unused') },
      recordExceptionDecision: async () => { throw new Error('unused') },
      recordOverride: async (run, override) => {
        state.calls.recordOverride.push({ run, override })
        state.snapshot = { ...state.snapshot, findings: { ...state.snapshot.findings!, overrides: [...state.snapshot.findings!.overrides, override] } }
        return execution(state.snapshot)
      },
      stopRun: async () => { throw new Error('unused') },
      recordDecisionStamp: async (_run, stamp, key) => {
        state.snapshot = { ...state.snapshot, findings: { ...state.snapshot.findings!, lastDecision: { stamp, key } } }
        return execution(state.snapshot)
      },
      decide: (run, step) => new Serial().run(() => step(opsOf(port2.flows, run))),
    },
    projectOf: async () => ROOT,
    headOf: async () => ({ at: state.headAt, dirty: false }),
    now: () => state.now,
    log: () => {},
  }
  const plane2 = new FindingsPlane(port2)
  const view = await plane2.runView(RUN)
  await plane2.decideRun({ goal: GOAL, run: RUN, round: 1, stamp: view.stamp, action: { kind: 'merge-anyway' }, reason: 'time pressure' })
  assert.equal(state.calls.recordOverride.length, 1)
  const override = state.calls.recordOverride[0]!.override
  assert.equal(override.by, 'person')
  assert.deepEqual(override.findings, ['finding-0001'])
  assert.equal(override.reason, 'time pressure')
})

test('Drop hands off to the existing stop action and records nothing else', async () => {
  const state = await rig()
  const view = await currentView(state)
  await state.plane.decideRun({ goal: GOAL, run: RUN, round: 1, stamp: view.stamp, action: { kind: 'drop' }, reason: 'no longer needed' })
  assert.deepEqual(state.calls.stopRun, [{ run: RUN, reason: 'no longer needed' }])
  assert.deepEqual(state.calls.recordOverride, [])
})

test('exception admission is explicit and scoped to currently pending ids', async () => {
  const state = await rig({
    series: [{
      id: `reviewer@${ROOT}`, role: 'reviewer', checkout: { cwd: ROOT, branch: 'fix' }, reviewedAt: A, reviewRounds: [1],
      initial: ['finding-0001'], exceptions: [], pending: ['finding-0002'],
    }],
  })
  const view = await currentView(state)
  await state.plane.decideRun({ goal: GOAL, run: RUN, round: 1, stamp: view.stamp, action: { kind: 'admit-exceptions', findings: ['finding-0002'] }, reason: 'reviewed and it is real' })
  assert.deepEqual(state.calls.recordExceptionDecision, [{ run: RUN, findings: ['finding-0002'], admit: true }])
  assert.deepEqual(state.snapshot.findings!.series[0]!.exceptions, ['finding-0002'])
  assert.deepEqual(state.snapshot.findings!.series[0]!.pending, [])
  // The baseline set from before is unchanged by an exception decision.
  assert.deepEqual(state.snapshot.findings!.series[0]!.initial, ['finding-0001'])
})

test('exception admission surfaces the currently pending ids on the view, and clears them once decided', async () => {
  const state = await rig({
    series: [{
      id: `reviewer@${ROOT}`, role: 'reviewer', checkout: { cwd: ROOT, branch: 'fix' }, reviewedAt: A, reviewRounds: [1],
      initial: ['finding-0001'], exceptions: [], pending: ['finding-0002'],
    }],
  })
  const before = await currentView(state)
  assert.deepEqual(before.pendingExceptions, ['finding-0002'])
  await state.plane.decideRun({
    goal: GOAL, run: RUN, round: 1, stamp: before.stamp,
    action: { kind: 'admit-exceptions', findings: ['finding-0002'] }, reason: 'reviewed and it is real',
  })
  const after = await currentView(state)
  assert.deepEqual(after.pendingExceptions, [])
})

test('an exception decision naming an id that is not currently pending refuses the whole action', async () => {
  const state = await rig({
    series: [{
      id: `reviewer@${ROOT}`, role: 'reviewer', checkout: { cwd: ROOT, branch: 'fix' }, reviewedAt: A, reviewRounds: [1],
      initial: ['finding-0001'], exceptions: [], pending: ['finding-0002'],
    }],
  })
  const view = await currentView(state)
  await assert.rejects(
    state.plane.decideRun({
      goal: GOAL, run: RUN, round: 1, stamp: view.stamp,
      action: { kind: 'admit-exceptions', findings: ['finding-0002', 'finding-9999'] }, reason: 'reviewed and it is real',
    }),
    /pending exception/,
  )
  // A partly-valid request is refused whole. The genuinely pending id is not admitted either.
  assert.deepEqual(state.calls.recordExceptionDecision, [])
  assert.deepEqual(state.snapshot.findings!.series[0]!.pending, ['finding-0002'])
})

test('a run with nothing pending refuses any exception decision, naming that there is nothing to decide', async () => {
  const state = await rig()
  const view = await currentView(state)
  assert.deepEqual(view.pendingExceptions, [])
  await assert.rejects(
    state.plane.decideRun({
      goal: GOAL, run: RUN, round: 1, stamp: view.stamp,
      action: { kind: 'admit-exceptions', findings: ['finding-0001'] }, reason: 'reviewed and it is real',
    }),
    /pending exception/,
  )
  assert.deepEqual(state.calls.recordExceptionDecision, [])
})

test('a later round exposes its repair lead: from/to and the exact claimed/unresolved ids', async () => {
  const state = await rig()
  const lead = { series: `reviewer@${ROOT}`, from: A, to: B, claimed: ['finding-0001'], unresolved: ['finding-0003'] }
  state.snapshot = { ...state.snapshot, leads: { '1': [lead] } }
  const view = await currentView(state)
  assert.deepEqual(view.repair, [lead])
})

test('a first review round, or one with no packet pinned, exposes no repair lead', async () => {
  const state = await rig()
  const view = await currentView(state)
  assert.equal(view.repair, null)
})

test('a bare reason is required, and an empty or oversize one refuses before any port call', async () => {
  const state = await rig()
  const view = await currentView(state)
  await assert.rejects(
    state.plane.decideRun({ goal: GOAL, run: RUN, round: 1, stamp: view.stamp, action: { kind: 'drop' }, reason: '   ' }),
    /Say why/,
  )
  await assert.rejects(
    state.plane.decideRun({ goal: GOAL, run: RUN, round: 1, stamp: view.stamp, action: { kind: 'drop' }, reason: 'x'.repeat(4097) }),
    /Say why/,
  )
  assert.deepEqual(state.calls.stopRun, [])
})

test('adjudicate writes the same verdict event a Seat would, with actor Seat null and by person', async () => {
  const state = await rig()
  const view = await currentView(state)
  const decided = await state.plane.decideRun({
    goal: GOAL, run: RUN, round: 1, stamp: view.stamp,
    action: { kind: 'adjudicate', finding: 'finding-0001', state: 'withdrawn' }, reason: 'not applicable after all',
  })
  assert.equal(decided.open, 0)
  const found = await state.plane.list({ goal: GOAL })
  const row = found.rows.find((one) => one.id === 'finding-0001')!
  assert.equal(row.lifecycle.state, 'withdrawn')
  assert.equal(row.lifecycle.confirmed, true)
  const records = (await state.store.read(ROOT, 'evidence')).lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
  const verdict = records.find((record) => record.finding?.event.kind === 'verdict')!
  assert.equal(verdict.seat, null)
  assert.equal((verdict.finding!.event as { by: string }).by, 'person')

  // A duplicate submission with the same stamp finds the same recorded event rather than writing a second.
  await state.plane.decideRun({
    goal: GOAL, run: RUN, round: 1, stamp: view.stamp,
    action: { kind: 'adjudicate', finding: 'finding-0001', state: 'withdrawn' }, reason: 'not applicable after all',
  })
  const after = (await state.store.read(ROOT, 'evidence')).lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
  assert.equal(after.filter((record) => record.finding?.event.kind === 'verdict').length, 1)
})

test('a confirmed finding cannot reopen through adjudicate', async () => {
  const state = await rig()
  const view = await currentView(state)
  await state.plane.decideRun({
    goal: GOAL, run: RUN, round: 1, stamp: view.stamp,
    action: { kind: 'adjudicate', finding: 'finding-0001', state: 'withdrawn' }, reason: 'done',
  })
  const later = await state.plane.runView(RUN)
  await assert.rejects(
    state.plane.decideRun({
      goal: GOAL, run: RUN, round: 1, stamp: later.stamp,
      action: { kind: 'adjudicate', finding: 'finding-0001', state: 'open' }, reason: 'changed my mind',
    }),
    /resolved/,
  )
})
