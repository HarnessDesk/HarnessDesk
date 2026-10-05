import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { approvalId, itemId, runtimeId, sessionId, turnId, currentTurn, inFlightItem, isBusy, seatDoing, sessionKey, type SeatActivity } from '@harnessdesk/protocol'

import type { AgentItem, Approval, FlowExecution, InsightAmounts, InsightMetric, InsightReport, Intent, Session, TeamSignal, SeatRecord, GoalView, TeamState } from '@harnessdesk/protocol'

import { doingLine, teamOverview, type TeamOverviewInput, type TeamOverviewSeat } from '../../src/views/team-overview.js'
import type { ClientSnapshot } from '../../src/views/snapshot.js'
import { teamOverviewOf } from '../../src/views/index.js'

const card = (id: number, patch: Partial<Intent> = {}): Intent => ({
  id, title: `Task ${id}`, state: 'open', files: [], dependsOn: [], createdAt: 100, updatedAt: 200, ...patch,
})
const session = (id: string, items: readonly AgentItem[] = [], running = true): Session => ({
  id: sessionId(id), runtime: runtimeId('agent-a'), cwd: '/project', status: { type: running ? 'active' : 'idle' },
  createdAt: 100, updatedAt: 300, itemsLoaded: true,
  turns: [{ id: turnId('turn'), status: running ? 'inProgress' : 'completed', startedAt: 250, completedAt: running ? null : 300, items }],
})
const seat = (id: string, patch: Partial<TeamOverviewSeat> = {}): TeamOverviewSeat => ({
  record: { id, session: { runtime: 'agent-a', sessionId: id }, role: 'builder', openedAt: 100 },
  name: id, runtime: { capabilities: { metered: false } }, session: null, unreadSince: null, approvals: [], ...patch,
})
const claim = (id: string) => ({ runtime: runtimeId('agent-a'), sessionId: id, at: 220 })
const blockedSignal = (id: string, patch: Partial<TeamSignal> = {}): TeamSignal => ({
  id: 'blocked', kind: 'signal', at: 200, signal: 'blocked', intent: 1, title: 'Task 1',
  by: { kind: 'agent', runtime: runtimeId('agent-a'), sessionId: id, title: id }, ...patch,
})
const execution = (patch: Partial<FlowExecution> = {}): FlowExecution => ({
  version: 2, id: 'run', goal: 'team', state: 'running', reason: null, legacyRun: null, operations: [],
  rounds: [{ n: 1, role: 'builder', cards: [1], seats: ['Alpha'], evidence: [], state: 'running', cause: 'seed' }],
  document: { format: 'agents', flow: {
    version: 2, name: 'Build', inputs: [], roles: [{ id: 'person', kind: 'person', outcomes: ['approved'] }],
    rules: [], seed: { role: 'builder', title: 'Build' }, messaging: 'board-only', wait: 1,
  } }, ...patch,
})
const input = (patch: Partial<TeamOverviewInput> = {}): TeamOverviewInput => ({
  team: 'team', seats: [], cards: [], run: null, report: null, ...patch,
})
const metric = (value: number | null, patch: Partial<InsightMetric> = {}): InsightMetric => ({
  value, quality: value === null ? 'unknown' : 'exact', unit: 'count', basis: 'observed',
  sourceIds: ['source'], coverage: value === null ? 'none' : 'complete', missing: [], ...patch,
})
const amounts = (usd = metric(1.5, { unit: 'usd', basis: 'listPrice', quality: 'estimate' }), turns = metric(4)): InsightAmounts => ({
  usd, turns, tokens: metric(100, { unit: 'tokens' }), activeMs: metric(20, { unit: 'milliseconds' }),
})
const report = (rows: readonly { seat: string; amounts: InsightAmounts; goal?: string; runtime?: string }[], patch: Partial<InsightReport> = {}): InsightReport => ({
  id: 'report', generatedAt: 500, query: { root: '/project', from: 0, to: 500 }, goal: 'team', receipt: null,
  goals: [], seats: [], totals: amounts(), elapsedMs: metric(20), sources: [], recordedSpend: [],
  provenance: { state: 'available', note: '' }, gaps: [],
  breakdowns: [{ dimension: 'seat', unattributed: amounts(), reason: null, rows: rows.map((row) => ({
    key: row.seat, label: row.seat, seat: row.seat, goal: row.goal ?? 'team', session: row.runtime ? { runtime: row.runtime, sessionId: row.seat } : null, message: null,
    note: null, elapsedMs: metric(20), amounts: row.amounts,
  })) }], ...patch,
})
const tool = (toolName: string, args: unknown = {}, patch: Partial<Extract<AgentItem, { type: 'toolCall' }>> = {}): AgentItem => ({
  id: itemId(toolName), type: 'toolCall', tool: toolName, args, status: 'inProgress', source: { kind: 'builtin' }, ...patch,
})
const approval = (id: string, patch: Partial<Approval> = {}): Approval => ({
  id: 'approval', sessionId: id, requestedAt: 275, type: 'permission', summary: 'Use a tool', options: [], ...patch,
} as Approval)

describe('teamOverview', () => {
  it('does not need attention for an empty release, but preserves a clean local review', () => {
    const run = { execution: execution({ state: 'settled' }), startedAt: 150 }
    const findingRun = { run: 'run', goal: 'team', publication: 'local', boundPr: { repo: 'acme/widgets', pr: 7 },
      rounds: [{ round: 1, state: 'none', reason: null, pr: 7, cards: [1] }], open: 0, blocking: 0,
    } as unknown as import('@harnessdesk/protocol').FindingRunView
    assert.equal(teamOverview(input({ run, findingRun })).run?.needsYou, false)
    assert.equal(teamOverview(input({ run, findingRun: { ...findingRun,
      rounds: [{ ...findingRun.rounds[0]!, state: 'local' }] } })).run?.needsYou, true)
  })
  it('orders needs-you, unread, working, idle before card number', () => {
    const data = input({
      seats: [seat('Idle'), seat('Working', { session: session('Working') }), seat('Unread', { unreadSince: 260, session: session('Unread') }), seat('Waiting', { approvals: [approval('Waiting')] })],
      cards: [card(1, { claim: claim('Idle'), state: 'blocked', blockedBy: 'graph' }), card(2, { claim: claim('Working'), state: 'claimed' }), card(3, { claim: claim('Unread'), state: 'claimed' }), card(4, { claim: claim('Waiting'), state: 'claimed' })],
    })
    assert.deepEqual(teamOverview(data).seats.map((row) => [row.name, row.state]), [
      ['Waiting', 'needs-you'], ['Unread', 'unread'], ['Working', 'working'], ['Idle', 'idle'],
    ])
  })

  it('breaks ties by card number and puts a seat without a card last', () => {
    const result = teamOverview(input({ seats: [seat('None'), seat('Later'), seat('First')], cards: [
      card(8, { claim: claim('Later'), state: 'blocked', blockedBy: 'graph' }), card(2, { claim: claim('First'), state: 'blocked', blockedBy: 'graph' }),
    ] }))
    assert.deepEqual(result.seats.map((row) => row.name), ['First', 'Later', 'None'])
  })

  it('uses only the window unread mark, including its timestamp', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [], false) }), seat('Beta', { unreadSince: 280 })] }))
    assert.partialDeepStrictEqual(result.seats[0], { name: 'Beta', state: 'unread', since: 280 })
    assert.equal(result.seats[1]?.state, 'idle')
  })

  it('counts a claim as working without a running conversation', () => {
    assert.partialDeepStrictEqual(teamOverview(input({ seats: [seat('Alpha')], cards: [card(1, { state: 'claimed', claim: claim('Alpha') })] })).seats[0], { state: 'working', since: 220, card: { id: 1, title: 'Task 1' } })
  })

  it('does not match a different runtime with the same session id', () => {
    const result = teamOverview(input({ seats: [seat('Alpha')], cards: [card(1, { state: 'claimed', claim: { ...claim('Alpha'), runtime: runtimeId('agent-b') } })] }))
    assert.partialDeepStrictEqual(result.seats[0], { state: 'idle', card: null })
  })

  it('keeps a hand block reason on the original seat after its claim is cleared', () => {
    const run = execution({ operations: [{ key: 'seat:1:0', kind: 'seat', state: 'finished', card: 1, seat: 'Alpha' }] })
    const result = teamOverview(input({ seats: [seat('Alpha', { unreadSince: 260 })], cards: [card(1, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target' })], run: { execution: run, startedAt: 150 } }))
    assert.partialDeepStrictEqual(result.seats[0], { state: 'needs-you', reason: 'Choose a target', since: 200, round: 1 })
  })

  it('attributes a hand block from its channel signal without a Run', () => {
    const result = teamOverview(input({
      seats: [seat('Alpha', { unreadSince: 260 }), seat('Beta')],
      cards: [card(1, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target' })],
      signals: [blockedSignal('Alpha')],
    }))
    assert.partialDeepStrictEqual(result.seats[0], { seat: 'Alpha', state: 'needs-you', reason: 'Choose a target', since: 200, card: { id: 1 }, round: null })
    assert.partialDeepStrictEqual(result.seats[1], { seat: 'Beta', state: 'idle', card: null })
  })

  it('retains a hand block after asynchronous stop capture updates the card', () => {
    const result = teamOverview(input({
      seats: [seat('Alpha')],
      cards: [card(1, { state: 'blocked', claim: null, blockedBy: 'hand', blockedReason: 'Choose a target', updatedAt: 201, until: 'a'.repeat(40) })],
      signals: [blockedSignal('Alpha')],
    }))
    assert.partialDeepStrictEqual(result.seats[0], { seat: 'Alpha', state: 'needs-you', reason: 'Choose a target', card: { id: 1 }, round: null })
  })

  for (const signal of ['added', 'claimed', 'released', 'unblocked', 'completed', 'abandoned', 'reopened'] as const) it(
    `does not revive a hand block superseded by a ${signal} signal`, () => {
      const result = teamOverview(input({
        seats: [seat('Alpha')],
        cards: [card(1, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target' })],
        // Lifecycle order is authoritative even when timestamps share a millisecond.
        signals: [blockedSignal('Alpha'), blockedSignal('Alpha', { id: 'later', signal })],
      }))
      assert.partialDeepStrictEqual(result.seats[0], { state: 'idle', card: null, reason: null })
    },
  )

  it('uses the latest blocker despite later metadata and unrelated or conflict signals', () => {
    const result = teamOverview(input({
      seats: [seat('Alpha'), seat('Beta')],
      cards: [card(1, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target', updatedAt: 202 })],
      signals: [blockedSignal('Alpha'), blockedSignal('Beta', { id: 'new-block', at: 201 }),
        blockedSignal('Alpha', { id: 'other-card', intent: 2, at: 202 }),
        blockedSignal('Alpha', { id: 'refused-claim', signal: 'conflict', at: 203 })],
    }))
    assert.partialDeepStrictEqual(result.seats[0], { seat: 'Beta', state: 'needs-you', card: { id: 1 }, reason: 'Choose a target' })
    assert.partialDeepStrictEqual(result.seats[1], { seat: 'Alpha', state: 'idle', card: null })
  })

  it('does not attribute another runtime\'s block or a later person block to a seat', () => {
    for (const by of [{ kind: 'agent', runtime: runtimeId('agent-b'), sessionId: 'Alpha', title: 'Alpha' }, { kind: 'user' }] as const) {
      const result = teamOverview(input({
        seats: [seat('Alpha')],
        cards: [card(1, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target' })],
        signals: [blockedSignal('Alpha'), blockedSignal('Alpha', { id: 'new-block', by })],
      }))
      assert.partialDeepStrictEqual(result.seats[0], { state: 'idle', card: null })
    }
  })

  it('does not ask for a person when a hand block supplies no reason', () => {
    assert.equal(teamOverview(input({ seats: [seat('Alpha')], cards: [card(1, { claim: claim('Alpha'), state: 'blocked', blockedBy: 'hand', blockedReason: '' })] })).seats[0]?.state, 'idle')
  })

  it('shows unfinished graph dependencies in the card and leaves the seat idle', () => {
    const result = teamOverview(input({ seats: [seat('Alpha')], cards: [card(1, { state: 'done' }), card(2), card(3, { state: 'blocked', blockedBy: 'graph', dependsOn: [1, 2], claim: claim('Alpha') })] }))
    assert.partialDeepStrictEqual(result.seats[0], { state: 'idle', reason: null, card: { id: 3, title: 'Task 3 · after #2' } })
  })

  it('keeps an abandoned dependency waiting, while a trimmed dependency is settled', () => {
    const result = teamOverview(input({ seats: [seat('Alpha')], cards: [card(2, { state: 'abandoned' }), card(3, { state: 'blocked', blockedBy: 'graph', dependsOn: [1, 2], claim: claim('Alpha') })] }))
    assert.equal(result.seats[0]?.card?.title, 'Task 3 · after #2')
  })

  it('gathers waiting person cards without assigning them to unrelated seats', () => {
    const run = execution({ rounds: [{ n: 2, role: 'person', cards: [2, 3, 4], seats: [], evidence: [], state: 'running', cause: 'answer' }] })
    const result = teamOverview(input({ seats: [seat('Alpha')], cards: [card(2, { role: 'person' }), card(3, { role: 'person', state: 'done' }), card(4, { role: 'person', state: 'blocked', blockedBy: 'graph', dependsOn: [1] })], run: { execution: run, startedAt: 150 } }))
    assert.deepEqual(result.needsYou, [{ kind: 'card', seat: null, card: 2, summary: 'Task 2', since: 200 }])
    assert.equal(result.seats[0]?.state, 'idle')
  })

  for (const state of ['settled', 'stopped'] as const) it(`does not ask for an unanswered person card from a ${state} Run`, () => {
    const run = execution({ state, rounds: [{ n: 2, role: 'person', cards: [2], seats: [], evidence: [], state: 'running', cause: 'answer' }] })
    assert.deepEqual(teamOverview(input({ cards: [card(2, { role: 'person' })], run: { execution: run, startedAt: 150 } })).needsYou, [])
  })

  it('ignores person role names on unrelated cards and cards in closed rounds', () => {
    const run = execution({ rounds: [{ n: 2, role: 'person', cards: [2], seats: [], evidence: [], state: 'closed', cause: 'answer' }] })
    assert.deepEqual(teamOverview(input({ cards: [card(2, { role: 'person' }), card(3, { role: 'person' })], run: { execution: run, startedAt: 150 } })).needsYou, [])
  })

  it('keeps a stalled Run\'s own open person step waiting', () => {
    const run = execution({ state: 'stalled', rounds: [{ n: 2, role: 'person', cards: [2], seats: [], evidence: [], state: 'running', cause: 'answer' }] })
    assert.deepEqual(teamOverview(input({ cards: [card(2, { role: 'person' })], run: { execution: run, startedAt: 150 } })).needsYou, [
      { kind: 'card', seat: null, card: 2, summary: 'Task 2', since: 200 },
    ])
  })

  it('classifies structured questions and tool approvals with their own times', () => {
    const result = teamOverview(input({ seats: [seat('Jane Doe', { session: session('Jane Doe'), approvals: [approval('Jane Doe'), { id: approvalId('question'), type: 'userInput', tool: 'ask', sessionId: sessionId('Jane Doe'), requestedAt: 260, questions: [{ id: 'target', question: 'Which target?', multiSelect: false, options: [] }] }] })] }))
    assert.deepEqual(result.needsYou, [
      { kind: 'question', seat: 'Jane Doe', card: null, summary: 'Which target?', since: 260, approval: 'question', sessionKey: sessionKey('agent-a', 'Jane Doe') },
      { kind: 'approval', seat: 'Jane Doe', card: null, summary: 'Use a tool', since: 275, approval: 'approval', sessionKey: sessionKey('agent-a', 'Jane Doe') },
    ])
    assert.partialDeepStrictEqual(result.seats[0], { state: 'needs-you', since: 260, reason: 'Which target?' })
  })

  it('names the open request on a question or approval, so two asked in one instant stay apart, and none on a card', () => {
    const first: Approval = { id: approvalId('first'), type: 'userInput', tool: 'ask', sessionId: sessionId('Alpha'), requestedAt: 260, questions: [{ id: 'a', question: 'Which target?', multiSelect: false, options: [] }] }
    const second: Approval = { id: approvalId('second'), type: 'userInput', tool: 'ask', sessionId: sessionId('Alpha'), requestedAt: 260, questions: [{ id: 'b', question: 'Which branch?', multiSelect: false, options: [] }] }
    const result = teamOverview(input({ seats: [seat('Alpha', { approvals: [first, second] })] }))
    assert.deepEqual(result.needsYou.map((one) => [one.summary, one.approval]), [['Which target?', 'first'], ['Which branch?', 'second']])
    const person = teamOverview(input({ cards: [card(2, { role: 'person' })], run: { execution: execution({ rounds: [{ n: 2, role: 'person', cards: [2], seats: [], evidence: [], state: 'running', cause: 'answer' }] }), startedAt: 150 } }))
    assert.equal(person.needsYou[0]?.kind, 'card')
    assert.equal('approval' in person.needsYou[0]!, false)
  })

  it('keeps the session identity on approval rows when two sessions reuse an approval id', () => {
    const alpha: Approval = { id: approvalId('shared'), type: 'userInput', tool: 'ask', sessionId: sessionId('session-a'), requestedAt: 260, questions: [{ id: 'a', question: 'First conversation?', multiSelect: false, options: [] }] }
    const beta: Approval = { id: approvalId('shared'), type: 'userInput', tool: 'ask', sessionId: sessionId('session-b'), requestedAt: 261, questions: [{ id: 'b', question: 'Second conversation?', multiSelect: false, options: [] }] }
    const result = teamOverview(input({ seats: [
      seat('Jane Doe', { record: { id: 'seat-alpha', session: { runtime: runtimeId('agent-a'), sessionId: sessionId('session-a') }, role: 'builder', openedAt: 100 }, approvals: [alpha] }),
      seat('Jane Doe', { record: { id: 'seat-beta', session: { runtime: runtimeId('agent-b'), sessionId: sessionId('session-b') }, role: 'builder', openedAt: 100 }, approvals: [beta] }),
    ] }))
    assert.deepEqual(result.needsYou.map((one) => [one.seat, one.approval, one.sessionKey]), [
      ['seat-alpha', 'shared', sessionKey('agent-a', 'session-a')],
      ['seat-beta', 'shared', sessionKey('agent-b', 'session-b')],
    ])
  })

  it('does not copy command text into an approval summary', () => {
    const request: Approval = { id: approvalId('command'), sessionId: sessionId('Alpha'), requestedAt: 260, type: 'command', command: 'TOKEN=private-value curl https://example.com', cwd: '/project', actions: [], options: [] }
    assert.equal(teamOverview(input({ seats: [seat('Alpha', { approvals: [request] })] })).needsYou[0]?.summary, 'Approve a command')
  })

  it('keeps no-run and empty teams useful', () => {
    assert.deepEqual(teamOverview(input()), { run: null, needsYou: [], seats: [] })
    assert.partialDeepStrictEqual(teamOverview(input({ seats: [seat('Alpha')] })).seats[0], { state: 'idle', round: null, card: null, doing: null, cost: null })
  })

  for (const state of ['stalled', 'settled', 'stopped'] as const) it(`keeps ${state} run attention out of seat state`, () => {
    const result = teamOverview(input({ seats: [seat('Alpha')], run: { execution: execution({ state, reason: 'No rule continues' }), startedAt: 150 } }))
    assert.partialDeepStrictEqual(result.run, { run: 'run', state, startedAt: 150, round: 1, role: 'builder' })
    assert.equal(result.seats[0]?.state, 'idle')
    assert.deepEqual(result.needsYou, [])
  })

  it('reads the frozen review budget and its used rounds', () => {
    const run = execution({ findings: { version: 1, budget: { rounds: 6, withoutProgress: 2 }, closedRounds: [1, 2], idleRounds: 0, progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null } })
    assert.deepEqual(teamOverview(input({ run: { execution: run, startedAt: 150 } })).run?.reviewRounds, { used: 2, of: 6 })
  })

  it('includes further rounds the person has already authorized in the budget', () => {
    const run = execution({ findings: { version: 1, budget: { rounds: 3, withoutProgress: 2 }, closedRounds: [1, 2, 3], idleRounds: 0, progress: [], series: [], stopped: null, extraRound: { after: 3, count: 2, reason: 'Continue' }, overrides: [], lastDecision: null } })
    assert.deepEqual(teamOverview(input({ run: { execution: run, startedAt: 150 } })).run?.reviewRounds, { used: 3, of: 5 })
  })

  it('uses money only for a metered runtime with known rate provenance', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { runtime: { capabilities: { metered: true } } })], report: report([{ seat: 'Alpha', amounts: amounts() }]) }))
    assert.deepEqual(result.seats[0]?.cost, { unit: 'money', value: 1.5, estimated: true })
  })

  it('uses supplied runtime capability facts consistently for a seat and the Run', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { runtime: null })], runtimeCapabilities: new Map([['agent-a', { metered: true }]]), report: report([{ seat: 'Alpha', amounts: amounts() }]), run: { execution: execution(), startedAt: 150 } }))
    assert.deepEqual(result.seats[0]?.cost, { unit: 'money', value: 1.5, estimated: true })
    assert.equal(result.run?.total.money, 1.5)
  })

  it('uses turns for an unmetered runtime even when list-price money exists', () => {
    assert.deepEqual(teamOverview(input({ seats: [seat('Alpha')], report: report([{ seat: 'Alpha', amounts: amounts() }]) })).seats[0]?.cost, { unit: 'turns', value: 4, estimated: false })
  })

  it('falls back to turns when money has no known rate', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { runtime: { capabilities: { metered: true } } })], report: report([{ seat: 'Alpha', amounts: amounts(metric(1.5, { unit: 'usd', basis: 'unknown' }), metric(4, { quality: 'floor', coverage: 'partial' })) }]) }))
    assert.deepEqual(result.seats[0]?.cost, { unit: 'turns', value: 4, estimated: true })
  })

  it('distinguishes unavailable cost, unknown metrics and observed zero', () => {
    assert.equal(teamOverview(input({ seats: [seat('Alpha')] })).seats[0]?.cost, null)
    assert.equal(teamOverview(input({ seats: [seat('Alpha')], report: report([{ seat: 'Alpha', amounts: amounts(metric(null), metric(null)) }]) })).seats[0]?.cost, null)
    assert.deepEqual(teamOverview(input({ seats: [seat('Alpha')], report: report([{ seat: 'Alpha', amounts: amounts(metric(null), metric(0)) }]) })).seats[0]?.cost, { unit: 'turns', value: 0, estimated: false })
  })

  it('never substitutes another team, partition or total for a missing seat cost', () => {
    assert.equal(teamOverview(input({ seats: [seat('Alpha')], report: report([{ seat: 'Alpha', goal: 'other', amounts: amounts() }]) })).seats[0]?.cost, null)
  })

  it('keeps total turns but leaves money unknown without eligible seat partitions', () => {
    const result = teamOverview(input({ seats: [seat('Alpha')], report: report([]), run: { execution: execution(), startedAt: 150 } }))
    assert.deepEqual(result.run?.total, { money: null, turns: 4 })
    assert.deepEqual(teamOverview(input({ report: report([], { goal: 'other' }), run: { execution: execution(), startedAt: 150 } })).run?.total, { money: null, turns: null })
  })

  it('adds only money from metered seats with known rates to the Run total', () => {
    const result = teamOverview(input({
      seats: [seat('Metered', { runtime: { capabilities: { metered: true } } }), seat('Unmetered'), seat('Unknown', { runtime: null }), seat('NoRate', { runtime: { capabilities: { metered: true } } })],
      report: report([
        { seat: 'Metered', amounts: amounts() }, { seat: 'Unmetered', amounts: amounts() },
        { seat: 'Unknown', amounts: amounts() }, { seat: 'NoRate', amounts: amounts(metric(9, { basis: 'unknown' })) },
        { seat: 'Metered', goal: 'other', amounts: amounts() },
      ], { totals: amounts(metric(15, { unit: 'usd', basis: 'listPrice' }), metric(16)) }),
      run: { execution: execution(), startedAt: 150 },
    }))
    assert.deepEqual(result.run?.total, { money: 1.5, turns: 16 })
    assert.equal(teamOverview(input({ seats: [seat('Unmetered')], report: report([{ seat: 'Unmetered', amounts: amounts() }]), run: { execution: execution(), startedAt: 150 } })).run?.total.money, null)
  })

  it('includes historical metered seats once through their recorded runtime identity', () => {
    const usage = report([{ seat: 'Earlier', runtime: 'earlier-agent', amounts: amounts(metric(3, { basis: 'vendorMetered', unit: 'usd' })) }, { seat: 'Subscription', runtime: 'subscription-agent', amounts: amounts() }])
    // Alternate partitions must not be counted as additional contributions.
    const result = teamOverview(input({ report: { ...usage, breakdowns: [...usage.breakdowns, { ...usage.breakdowns[0]!, dimension: 'agent' }] }, runtimeCapabilities: new Map([['earlier-agent', { metered: true }], ['subscription-agent', { metered: false }]]), run: { execution: execution(), startedAt: 150 } }))
    assert.deepEqual(result.run?.total, { money: 3, turns: 4 })
    assert.deepEqual(result.seats, [])
  })

  it('distinguishes unavailable Run money from an observed metered zero', () => {
    for (const value of [null, 0]) {
      const result = teamOverview(input({ seats: [seat('Alpha', { runtime: { capabilities: { metered: true } } })], report: report([{ seat: 'Alpha', amounts: amounts(metric(value, { basis: 'vendorMetered', unit: 'usd' })) }]), run: { execution: execution(), startedAt: 150 } }))
      assert.equal(result.run?.total.money, value)
    }
  })

  it('takes the latest in-flight tool, ignoring finished calls and prose', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [tool('Read', { path: 'src/first.ts' }, { startedAt: 260 }), tool('Edit', { path: 'src/next.ts', old_string: 'old', new_string: 'new' }, { startedAt: 270 }), tool('Read', { path: 'src/finished.ts' }, { status: 'completed' }), { id: itemId('prose'), type: 'assistantMessage', text: 'https://example.com SECRET=value' }]) })] }))
    assert.partialDeepStrictEqual(result.seats[0], { doing: 'Edited src/next.ts', since: 250 })
  })

  it('never puts shell command text, URLs or environment values in the doing line', () => {
    const calls: AgentItem[] = [
      { id: itemId('command'), type: 'command', command: 'TOKEN=private-value curl https://example.com', cwd: '/project', origin: 'agent', status: 'inProgress', actions: [] },
      tool('`TOKEN=private-value curl https://example.com`', { command: 'TOKEN=private-value curl https://example.com' }),
      tool('mcp__desk__exec_command', { cmd: 'TOKEN=private-value curl https://example.com' }),
      tool('Read', { path: 'https://example.com/private' }), tool('Edit', { path: '$TOKEN/private', old_string: 'value' }),
      tool('Read https://example.com/private'), tool('Read', { path: 'TOKEN=private-value' }),
    ]
    for (const call of calls) {
      const line = teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [call]) })] })).seats[0]?.doing
      assert.notEqual(line, null)
      assert.doesNotMatch(line!, /TOKEN|private-value|https:|curl|\$|`/)
    }
    assert.equal(teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [calls[0]!]) })] })).seats[0]?.doing, 'Running a command')
  })

  it('does not revive in-flight items from completed turns', () => {
    assert.equal(teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [tool('Read', { path: 'src/stale.ts' })], false) })] })).seats[0]?.doing, null)
  })

  it('rejects protocol-relative URLs and prose masquerading as a path', () => {
    for (const path of ['//example.com/private', 'src/file.ts echo private-value', 'TOKEN private-value']) {
      assert.equal(teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [tool('Read', { path })]) })] })).seats[0]?.doing, 'Reading a file')
    }
  })

  it('does not mutate the snapshot', () => {
    const data = input({ seats: [seat('Beta'), seat('Alpha', { session: session('Alpha') })], cards: [card(1)], run: { execution: execution(), startedAt: 150 } })
    const before = JSON.stringify(data)
    teamOverview(data)
    assert.equal(JSON.stringify(data), before)
  })
})

describe('doingLine', () => {
  it('shows the first line immediately and holds changes for 2.5 seconds', () => {
    const first = doingLine(null, 'Reading a file', 100)
    assert.deepEqual(first, { line: 'Reading a file', at: 100 })
    assert.deepEqual(doingLine(first, 'Editing a file', 2599), first)
    assert.deepEqual(doingLine(first, 'Editing a file', 2600), { line: 'Editing a file', at: 2600 })
  })

  it('does not postpone a pending update by refreshing an unchanged line', () => {
    const first = { line: 'Reading a file', at: 100 }
    assert.deepEqual(doingLine(first, first.line, 5000), first)
    assert.deepEqual(doingLine(first, null, 2599), first)
    assert.deepEqual(doingLine(first, null, 2600), { line: null, at: 2600 })
  })
})

it('marks three completed Seats done, but never a Seat that held no card', () => {
 const seats = ['Alpha','Beta','Gamma','Idle'].map(id=>seat(id))
 const cards = ['Alpha','Beta','Gamma'].map((id,index)=>card(index+1,{state:'done',claim:claim(id)}))
 assert.deepEqual(teamOverview(input({ seats,cards })).seats.map(row=>[row.name,row.done]), [['Alpha',true],['Beta',true],['Gamma',true],['Idle',false]])
})
for (const kind of ['question','unread','working'] as const) it(`a done Seat leaves the fold when ${kind} arrives`, () => {
 const one = seat('Alpha',kind==='question'?{approvals:[approval('Alpha')]}:kind==='unread'?{unreadSince:280}:{session:session('Alpha')})
 assert.partialDeepStrictEqual(teamOverview(input({seats:[one],cards:[card(1,{state:'done',claim:claim('Alpha')})]})).seats[0], {done:false,state:kind==='question'?'needs-you':kind})
})
it('retains completion attribution after claims clear through the Run seat/card journal', () => {
 const run = execution({ operations:[{key:'seat:1:0',kind:'seat',state:'finished',card:1,seat:'Alpha'}] })
 assert.partialDeepStrictEqual(teamOverview(input({seats:[seat('Alpha')],cards:[card(1,{state:'done'})],run:{execution:run,startedAt:null}})).seats[0], {done:true})
})
it('leaves unknown Run start time null', () => {
 assert.equal(teamOverview(input({run:{execution:execution(),startedAt:null}})).run?.startedAt, null)
})

for (const withRun of [false, true]) it(`keeps a completed manual or earlier-Run card attributed with current Run present: ${withRun}`, () => {
 const result = teamOverview(input({
  seats: [seat('Alpha'), seat('Idle')], cards: [card(1, {state:'done',claim:null,updatedAt:201})],
  signals: [blockedSignal('Alpha', {signal:'completed'}), blockedSignal('Idle', {signal:'conflict'})],
  run: withRun ? {execution:execution({rounds:[],operations:[]}),startedAt:null} : null,
 }))
 assert.deepEqual(result.seats.map(row => [row.seat,row.done]), [['Alpha',true],['Idle',false]])
})
for (const kind of ['question','unread','working'] as const) it(`a signal-attributed done Seat leaves the fold for ${kind}`, () => {
 const one = seat('Alpha',kind==='question'?{approvals:[approval('Alpha')]}:kind==='unread'?{unreadSince:280}:{session:session('Alpha')})
 assert.partialDeepStrictEqual(teamOverview(input({seats:[one],cards:[card(1,{state:'done',claim:null})],signals:[blockedSignal('Alpha',{signal:'completed'})]})).seats[0], {done:false,state:kind==='question'?'needs-you':kind})
})
it('does not invent completion ownership across runtimes, people or superseded signals', () => {
 for (const signals of [
  [blockedSignal('Alpha',{signal:'completed',by:{kind:'agent',runtime:runtimeId('agent-b'),sessionId:'Alpha',title:'Alpha'}})],
  [blockedSignal('Alpha',{signal:'completed',by:{kind:'user'}})],
  [blockedSignal('Alpha',{signal:'completed'}),blockedSignal('Alpha',{id:'reopened',signal:'reopened'})],
 ]) assert.equal(teamOverview(input({seats:[seat('Alpha')],cards:[card(1,{state:'done',claim:null})],signals})).seats[0]?.done, false)
})

describe('host activity input', () => {
  const scenarios = [
    { name: 'idle', live: { ...session('Alpha', [], false), turns: [] }, cards: [], approvals: [] },
    { name: 'read with a path', live: session('Alpha', [tool('Read', { path: 'src/a.ts' })]), cards: [], approvals: [] },
    { name: 'command', live: session('Alpha', [{ id: itemId('command'), type: 'command' as const, command: 'echo demo', cwd: '/project', origin: 'agent' as const, status: 'inProgress' as const, actions: [] }]), cards: [], approvals: [] },
    { name: 'thinking', live: session('Alpha'), cards: [], approvals: [] },
    { name: 'approval', live: session('Alpha'), cards: [], approvals: [approval('Alpha')] },
    { name: 'claim without a turn', live: { ...session('Alpha', [], false), turns: [] }, cards: [card(1, { state: 'claimed', claim: claim('Alpha') })], approvals: [] },
  ]
  for (const scenario of scenarios) it(`matches a session for ${scenario.name}`, () => {
    const one = seat('Alpha', { session: scenario.live, approvals: scenario.approvals })
    const claimed = scenario.cards.find(c => c.state === 'claimed')
    const busy = isBusy(scenario.live)
    const state = scenario.approvals.length ? 'waiting' : busy || claimed ? 'working' : 'idle'
    const latest = state === 'working' ? inFlightItem(scenario.live) : undefined
    const activity: SeatActivity = {
      goal: 'team', seat: 'agent-a:Alpha', role: 'builder', card: claimed?.id ?? null, state,
      doing: state === 'working' ? latest ? seatDoing(latest) : { kind: 'thinking' } : null,
      since: state === 'waiting' ? scenario.approvals[0]?.requestedAt : state === 'working' ? currentTurn(scenario.live)?.startedAt ?? claimed?.claim?.at : undefined,
    }
    const outside = { ...one, session: null, activity }
    assert.deepEqual(teamOverview(input({ seats: [outside], cards: scenario.cards })), teamOverview(input({ seats: [one], cards: scenario.cards })))
  })
  it('prefers a matching conversation and falls back from a different runtime', () => {
    const activity: SeatActivity = { goal: 'team', seat: 'agent-a:Alpha', role: 'builder', card: null, state: 'working', doing: { kind: 'tool', tool: 'command' }, since: 230 }
    const matching = { ...seat('Alpha', { session: session('Alpha', [tool('Read', { path: 'src/a.ts' })]) }), activity }
    assert.equal(teamOverview(input({ seats: [matching] })).seats[0]?.doing, 'Read src/a.ts')
    const different = { ...matching, session: { ...matching.session!, runtime: runtimeId('agent-b') } }
    assert.partialDeepStrictEqual(teamOverview(input({ seats: [different] })).seats[0], { doing: 'Running a command', since: 230 })
  })
  it('does not invent needs-you from activity waiting alone', () => {
    const outside = { ...seat('Alpha'), activity: { goal: 'team', seat: 'agent-a:Alpha', role: 'builder', card: null, state: 'waiting' as const, doing: null, since: 275 } }
    const result = teamOverview(input({ seats: [outside] }))
    assert.deepEqual(result.needsYou, [])
    assert.equal(result.seats[0]?.state, 'idle')
  })
})

describe('teamOverviewOf', () => {
  it('builds the same rows from a scoped snapshot as the equivalent window facts', () => {
    const a = seat('Alpha', { session: session('Alpha', [tool('Read', { path: 'src/a.ts' })]) })
    const b = seat('Beta', { approvals: [approval('Beta')] })
    const cards = [card(1, { state: 'claimed', claim: claim('Alpha') }), card(2, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target' })]
    const signals = [blockedSignal('Beta', { intent: 2 })]
    const run = execution({ startedAt: 150 })
    const usage = report([{ seat: 'Alpha', amounts: amounts() }])
    const runtimes = [{ id: runtimeId('agent-a'), name: 'Runtime A', metered: true }]
    const record = (one: TeamOverviewSeat, agent: string | null, label: string): SeatRecord => ({ ...one.record, agent: agent ? { id: agent, name: agent, origin: 'project' } : null, seatLabel: label } as SeatRecord)
    const snapshot: ClientSnapshot = {
      teams: [{ goal: { id: 'team', createdAt: 110 }, members: [record(a, 'Agent A', 'Seat A'), record(b, null, 'Seat B')], board: { id: 'team' } } as unknown as GoalView],
      // The separately-held board has the latest nickname, claims and signals.
      boards: [{ id: 'team', intents: cards, nicknames: { [sessionKey('agent-a', 'Alpha')]: 'Nickname' }, channel: signals } as unknown as TeamState],
      runs: [execution({ id: 'older', startedAt: 120 }), execution({ goal: 'other', id: 'other', startedAt: 999 }), run],
      seats: [
        { goal: 'other', seat: 'agent-a:Alpha', role: 'builder', card: null, state: 'idle', doing: null },
        { goal: 'team', seat: 'agent-a:Alpha', role: 'builder', card: 1, state: 'working', doing: seatDoing(inFlightItem(a.session!)!), since: 250 },
      ],
      approvals: [
        { runtime: runtimeId('agent-b'), sessionId: sessionId('Alpha'), approval: approval('Alpha') },
        { runtime: runtimeId('agent-a'), sessionId: sessionId('Beta'), approval: approval('Beta') },
      ], reviews: [],
    }
    const equivalent = input({ seats: [{ ...a, name: 'Nickname', runtime: { capabilities: { metered: true } } }, { ...b, name: 'Seat B', runtime: { capabilities: { metered: true } } }], cards, signals, run: { execution: run, startedAt: 150 }, report: usage, runtimeCapabilities: new Map([['agent-a', { metered: true }]]) })
    assert.deepEqual(teamOverviewOf(snapshot, 'team', { report: usage, runtimes }), teamOverview(equivalent))
    const before = JSON.stringify(snapshot)
    teamOverviewOf(snapshot, 'team', { report: usage, runtimes })
    assert.equal(JSON.stringify(snapshot), before)
    delete (snapshot.boards[0] as { nicknames?: unknown }).nicknames
    assert.equal(teamOverviewOf(snapshot, 'team', { report: null, runtimes }).seats.find(row => row.seat === 'Alpha')?.name, 'Agent A')
    const recordWithoutName = { ...snapshot.teams[0]!.members[0]!, agent: null, seatLabel: undefined } as unknown as SeatRecord
    ;(snapshot.teams[0]!.members as SeatRecord[])[0] = recordWithoutName
    assert.equal(teamOverviewOf(snapshot, 'team', { report: null, runtimes }).seats.find(row => row.seat === 'Alpha')?.name, 'Agent')
  })
  it('keeps a legacy run’s unknown start time null', () => {
    const snapshot: ClientSnapshot = { teams: [{ goal: { id: 'team', createdAt: 110 }, members: [], board: { id: 'team', intents: [] } } as unknown as GoalView], runs: [execution()], boards: [], seats: [], approvals: [], reviews: [] }
    assert.equal(teamOverviewOf(snapshot, 'team', { report: null, runtimes: [] }).run?.startedAt, null)
    assert.deepEqual(teamOverviewOf(snapshot, 'missing', { report: null, runtimes: [] }), { run: null, needsYou: [], seats: [] })
  })
})


describe('completed Seat readings', () => {
  it('freezes working time from its first claim to its last completed turn', () => {
    const completed = session('Alpha', [], false)
    const model = teamOverview(input({ seats: [seat('Alpha', { session: completed })],
      cards: [card(1, { state: 'done' })],
      signals: [blockedSignal('Alpha', { signal: 'claimed', at: 220 }), blockedSignal('Alpha', { signal: 'completed', at: 310 })],
    }))
    assert.equal(model.seats[0]?.done, true)
    assert.partialDeepStrictEqual(model.seats[0], { durationMs: 80 })
  })
  it('keeps completed timing unknown without a recorded end', () => {
    const model = teamOverview(input({ seats: [seat('Alpha')], cards: [card(1, { state: 'done' })],
      signals: [blockedSignal('Alpha', { signal: 'completed' })] }))
    assert.partialDeepStrictEqual(model.seats[0], { durationMs: null })
  })
  for (const reason of ['Waiting for a passing check at this revision.', 'Waiting for CI to go green at this revision.', 'Waiting for the pull request to reach that state.', 'Waiting for a structured review at this revision.', 'Waiting for an observed diff at this revision.']) {
    it(`keeps the evidence wait neutral: ${reason}`, () => {
      const run = execution({ reason: `Rule after-review: ${reason}`, rounds: [{ n: 1, role: 'builder', cards: [1], seats: ['Alpha'], evidence: [], state: 'waiting-evidence', cause: 'seed' }] })
      const model = teamOverview(input({ seats: [seat('Alpha')], run: { execution: run, startedAt: 100 } }))
      assert.equal(model.run?.needsYou, false)
      assert.equal(model.run?.waitingEvidence, true)
      assert.equal(model.seats[0]?.state, 'idle')
    })
  }
})
