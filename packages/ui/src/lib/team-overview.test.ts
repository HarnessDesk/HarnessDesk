import { describe, expect, it } from 'vitest'

import { approvalId, itemId, runtimeId, sessionId, turnId } from '@harnessdesk/protocol'

import type { AgentItem, Approval, FlowExecution, InsightAmounts, InsightMetric, InsightReport, Intent, Session, TeamSignal } from '@harnessdesk/protocol'

import { doingLine, teamOverview, type TeamOverviewInput, type TeamOverviewSeat } from './team-overview'

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
  it('orders needs-you, unread, working, idle before card number', () => {
    const data = input({
      seats: [seat('Idle'), seat('Working', { session: session('Working') }), seat('Unread', { unreadSince: 260, session: session('Unread') }), seat('Waiting', { approvals: [approval('Waiting')] })],
      cards: [card(1, { claim: claim('Idle'), state: 'blocked', blockedBy: 'graph' }), card(2, { claim: claim('Working'), state: 'claimed' }), card(3, { claim: claim('Unread'), state: 'claimed' }), card(4, { claim: claim('Waiting'), state: 'claimed' })],
    })
    expect(teamOverview(data).seats.map((row) => [row.name, row.state])).toEqual([
      ['Waiting', 'needs-you'], ['Unread', 'unread'], ['Working', 'working'], ['Idle', 'idle'],
    ])
  })

  it('breaks ties by card number and puts a seat without a card last', () => {
    const result = teamOverview(input({ seats: [seat('None'), seat('Later'), seat('First')], cards: [
      card(8, { claim: claim('Later'), state: 'blocked', blockedBy: 'graph' }), card(2, { claim: claim('First'), state: 'blocked', blockedBy: 'graph' }),
    ] }))
    expect(result.seats.map((row) => row.name)).toEqual(['First', 'Later', 'None'])
  })

  it('uses only the window unread mark, including its timestamp', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [], false) }), seat('Beta', { unreadSince: 280 })] }))
    expect(result.seats[0]).toMatchObject({ name: 'Beta', state: 'unread', since: 280 })
    expect(result.seats[1]?.state).toBe('idle')
  })

  it('counts a claim as working without a running conversation', () => {
    expect(teamOverview(input({ seats: [seat('Alpha')], cards: [card(1, { state: 'claimed', claim: claim('Alpha') })] })).seats[0]).toMatchObject({ state: 'working', since: 220, card: { id: 1, title: 'Task 1' } })
  })

  it('does not match a different runtime with the same session id', () => {
    const result = teamOverview(input({ seats: [seat('Alpha')], cards: [card(1, { state: 'claimed', claim: { ...claim('Alpha'), runtime: runtimeId('agent-b') } })] }))
    expect(result.seats[0]).toMatchObject({ state: 'idle', card: null })
  })

  it('keeps a hand block reason on the original seat after its claim is cleared', () => {
    const run = execution({ operations: [{ key: 'seat:1:0', kind: 'seat', state: 'finished', card: 1, seat: 'Alpha' }] })
    const result = teamOverview(input({ seats: [seat('Alpha', { unreadSince: 260 })], cards: [card(1, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target' })], run: { execution: run, startedAt: 150 } }))
    expect(result.seats[0]).toMatchObject({ state: 'needs-you', reason: 'Choose a target', since: 200, round: 1 })
  })

  it('attributes a hand block from its channel signal without a Run', () => {
    const result = teamOverview(input({
      seats: [seat('Alpha', { unreadSince: 260 }), seat('Beta')],
      cards: [card(1, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target' })],
      signals: [blockedSignal('Alpha')],
    }))
    expect(result.seats[0]).toMatchObject({ seat: 'Alpha', state: 'needs-you', reason: 'Choose a target', since: 200, card: { id: 1 }, round: null })
    expect(result.seats[1]).toMatchObject({ seat: 'Beta', state: 'idle', card: null })
  })

  it('retains a hand block after asynchronous stop capture updates the card', () => {
    const result = teamOverview(input({
      seats: [seat('Alpha')],
      cards: [card(1, { state: 'blocked', claim: null, blockedBy: 'hand', blockedReason: 'Choose a target', updatedAt: 201, until: 'a'.repeat(40) })],
      signals: [blockedSignal('Alpha')],
    }))
    expect(result.seats[0]).toMatchObject({ seat: 'Alpha', state: 'needs-you', reason: 'Choose a target', card: { id: 1 }, round: null })
  })

  it.each(['added', 'claimed', 'released', 'unblocked', 'completed', 'abandoned', 'reopened'] as const)(
    'does not revive a hand block superseded by a %s signal', (signal) => {
      const result = teamOverview(input({
        seats: [seat('Alpha')],
        cards: [card(1, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target' })],
        // Lifecycle order is authoritative even when timestamps share a millisecond.
        signals: [blockedSignal('Alpha'), blockedSignal('Alpha', { id: 'later', signal })],
      }))
      expect(result.seats[0]).toMatchObject({ state: 'idle', card: null, reason: null })
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
    expect(result.seats[0]).toMatchObject({ seat: 'Beta', state: 'needs-you', card: { id: 1 }, reason: 'Choose a target' })
    expect(result.seats[1]).toMatchObject({ seat: 'Alpha', state: 'idle', card: null })
  })

  it('does not attribute another runtime\'s block or a later person block to a seat', () => {
    for (const by of [{ kind: 'agent', runtime: runtimeId('agent-b'), sessionId: 'Alpha', title: 'Alpha' }, { kind: 'user' }] as const) {
      const result = teamOverview(input({
        seats: [seat('Alpha')],
        cards: [card(1, { state: 'blocked', blockedBy: 'hand', blockedReason: 'Choose a target' })],
        signals: [blockedSignal('Alpha'), blockedSignal('Alpha', { id: 'new-block', by })],
      }))
      expect(result.seats[0]).toMatchObject({ state: 'idle', card: null })
    }
  })

  it('does not ask for a person when a hand block supplies no reason', () => {
    expect(teamOverview(input({ seats: [seat('Alpha')], cards: [card(1, { claim: claim('Alpha'), state: 'blocked', blockedBy: 'hand', blockedReason: '' })] })).seats[0]?.state).toBe('idle')
  })

  it('shows unfinished graph dependencies in the card and leaves the seat idle', () => {
    const result = teamOverview(input({ seats: [seat('Alpha')], cards: [card(1, { state: 'done' }), card(2), card(3, { state: 'blocked', blockedBy: 'graph', dependsOn: [1, 2], claim: claim('Alpha') })] }))
    expect(result.seats[0]).toMatchObject({ state: 'idle', reason: null, card: { id: 3, title: 'Task 3 · after #2' } })
  })

  it('keeps an abandoned dependency waiting, while a trimmed dependency is settled', () => {
    const result = teamOverview(input({ seats: [seat('Alpha')], cards: [card(2, { state: 'abandoned' }), card(3, { state: 'blocked', blockedBy: 'graph', dependsOn: [1, 2], claim: claim('Alpha') })] }))
    expect(result.seats[0]?.card?.title).toBe('Task 3 · after #2')
  })

  it('gathers waiting person cards without assigning them to unrelated seats', () => {
    const run = execution({ rounds: [{ n: 2, role: 'person', cards: [2, 3, 4], seats: [], evidence: [], state: 'running', cause: 'answer' }] })
    const result = teamOverview(input({ seats: [seat('Alpha')], cards: [card(2, { role: 'person' }), card(3, { role: 'person', state: 'done' }), card(4, { role: 'person', state: 'blocked', blockedBy: 'graph', dependsOn: [1] })], run: { execution: run, startedAt: 150 } }))
    expect(result.needsYou).toEqual([{ kind: 'card', seat: null, card: 2, summary: 'Task 2', since: 200 }])
    expect(result.seats[0]?.state).toBe('idle')
  })

  it.each(['settled', 'stopped'] as const)('does not ask for an unanswered person card from a %s Run', (state) => {
    const run = execution({ state, rounds: [{ n: 2, role: 'person', cards: [2], seats: [], evidence: [], state: 'running', cause: 'answer' }] })
    expect(teamOverview(input({ cards: [card(2, { role: 'person' })], run: { execution: run, startedAt: 150 } })).needsYou).toEqual([])
  })

  it('ignores person role names on unrelated cards and cards in closed rounds', () => {
    const run = execution({ rounds: [{ n: 2, role: 'person', cards: [2], seats: [], evidence: [], state: 'closed', cause: 'answer' }] })
    expect(teamOverview(input({ cards: [card(2, { role: 'person' }), card(3, { role: 'person' })], run: { execution: run, startedAt: 150 } })).needsYou).toEqual([])
  })

  it('keeps a stalled Run\'s own open person step waiting', () => {
    const run = execution({ state: 'stalled', rounds: [{ n: 2, role: 'person', cards: [2], seats: [], evidence: [], state: 'running', cause: 'answer' }] })
    expect(teamOverview(input({ cards: [card(2, { role: 'person' })], run: { execution: run, startedAt: 150 } })).needsYou).toEqual([
      { kind: 'card', seat: null, card: 2, summary: 'Task 2', since: 200 },
    ])
  })

  it('classifies structured questions and tool approvals with their own times', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha'), approvals: [approval('Alpha'), { id: approvalId('question'), type: 'userInput', tool: 'ask', sessionId: sessionId('Alpha'), requestedAt: 260, questions: [{ id: 'target', question: 'Which target?', multiSelect: false, options: [] }] }] })] }))
    expect(result.needsYou).toEqual([
      { kind: 'question', seat: 'Alpha', card: null, summary: 'Which target?', since: 260 },
      { kind: 'approval', seat: 'Alpha', card: null, summary: 'Use a tool', since: 275 },
    ])
    expect(result.seats[0]).toMatchObject({ state: 'needs-you', since: 260, reason: 'Which target?' })
  })

  it('does not copy command text into an approval summary', () => {
    const request: Approval = { id: approvalId('command'), sessionId: sessionId('Alpha'), requestedAt: 260, type: 'command', command: 'TOKEN=private-value curl https://example.com', cwd: '/project', actions: [], options: [] }
    expect(teamOverview(input({ seats: [seat('Alpha', { approvals: [request] })] })).needsYou[0]?.summary).toBe('Approve a command')
  })

  it('keeps no-run and empty teams useful', () => {
    expect(teamOverview(input())).toEqual({ run: null, needsYou: [], seats: [] })
    expect(teamOverview(input({ seats: [seat('Alpha')] })).seats[0]).toMatchObject({ state: 'idle', round: null, card: null, doing: null, cost: null })
  })

  it.each(['stalled', 'settled', 'stopped'] as const)('keeps %s run attention out of seat state', (state) => {
    const result = teamOverview(input({ seats: [seat('Alpha')], run: { execution: execution({ state, reason: 'No rule continues' }), startedAt: 150 } }))
    expect(result.run).toMatchObject({ run: 'run', state, startedAt: 150, round: 1, role: 'builder' })
    expect(result.seats[0]?.state).toBe('idle')
    expect(result.needsYou).toEqual([])
  })

  it('reads the frozen review budget and its used rounds', () => {
    const run = execution({ findings: { version: 1, budget: { rounds: 6, withoutProgress: 2 }, closedRounds: [1, 2], idleRounds: 0, progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null } })
    expect(teamOverview(input({ run: { execution: run, startedAt: 150 } })).run?.reviewRounds).toEqual({ used: 2, of: 6 })
  })

  it('includes further rounds the person has already authorized in the budget', () => {
    const run = execution({ findings: { version: 1, budget: { rounds: 3, withoutProgress: 2 }, closedRounds: [1, 2, 3], idleRounds: 0, progress: [], series: [], stopped: null, extraRound: { after: 3, count: 2, reason: 'Continue' }, overrides: [], lastDecision: null } })
    expect(teamOverview(input({ run: { execution: run, startedAt: 150 } })).run?.reviewRounds).toEqual({ used: 3, of: 5 })
  })

  it('uses money only for a metered runtime with known rate provenance', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { runtime: { capabilities: { metered: true } } })], report: report([{ seat: 'Alpha', amounts: amounts() }]) }))
    expect(result.seats[0]?.cost).toEqual({ unit: 'money', value: 1.5, estimated: true })
  })

  it('uses supplied runtime capability facts consistently for a seat and the Run', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { runtime: null })], runtimeCapabilities: new Map([['agent-a', { metered: true }]]), report: report([{ seat: 'Alpha', amounts: amounts() }]), run: { execution: execution(), startedAt: 150 } }))
    expect(result.seats[0]?.cost).toEqual({ unit: 'money', value: 1.5, estimated: true })
    expect(result.run?.total.money).toBe(1.5)
  })

  it('uses turns for an unmetered runtime even when list-price money exists', () => {
    expect(teamOverview(input({ seats: [seat('Alpha')], report: report([{ seat: 'Alpha', amounts: amounts() }]) })).seats[0]?.cost).toEqual({ unit: 'turns', value: 4, estimated: false })
  })

  it('falls back to turns when money has no known rate', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { runtime: { capabilities: { metered: true } } })], report: report([{ seat: 'Alpha', amounts: amounts(metric(1.5, { unit: 'usd', basis: 'unknown' }), metric(4, { quality: 'floor', coverage: 'partial' })) }]) }))
    expect(result.seats[0]?.cost).toEqual({ unit: 'turns', value: 4, estimated: true })
  })

  it('distinguishes unavailable cost, unknown metrics and observed zero', () => {
    expect(teamOverview(input({ seats: [seat('Alpha')] })).seats[0]?.cost).toBeNull()
    expect(teamOverview(input({ seats: [seat('Alpha')], report: report([{ seat: 'Alpha', amounts: amounts(metric(null), metric(null)) }]) })).seats[0]?.cost).toBeNull()
    expect(teamOverview(input({ seats: [seat('Alpha')], report: report([{ seat: 'Alpha', amounts: amounts(metric(null), metric(0)) }]) })).seats[0]?.cost).toEqual({ unit: 'turns', value: 0, estimated: false })
  })

  it('never substitutes another team, partition or total for a missing seat cost', () => {
    expect(teamOverview(input({ seats: [seat('Alpha')], report: report([{ seat: 'Alpha', goal: 'other', amounts: amounts() }]) })).seats[0]?.cost).toBeNull()
  })

  it('keeps total turns but leaves money unknown without eligible seat partitions', () => {
    const result = teamOverview(input({ seats: [seat('Alpha')], report: report([]), run: { execution: execution(), startedAt: 150 } }))
    expect(result.run?.total).toEqual({ money: null, turns: 4 })
    expect(teamOverview(input({ report: report([], { goal: 'other' }), run: { execution: execution(), startedAt: 150 } })).run?.total).toEqual({ money: null, turns: null })
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
    expect(result.run?.total).toEqual({ money: 1.5, turns: 16 })
    expect(teamOverview(input({ seats: [seat('Unmetered')], report: report([{ seat: 'Unmetered', amounts: amounts() }]), run: { execution: execution(), startedAt: 150 } })).run?.total.money).toBeNull()
  })

  it('includes historical metered seats once through their recorded runtime identity', () => {
    const usage = report([{ seat: 'Earlier', runtime: 'earlier-agent', amounts: amounts(metric(3, { basis: 'vendorMetered', unit: 'usd' })) }, { seat: 'Subscription', runtime: 'subscription-agent', amounts: amounts() }])
    // Alternate partitions must not be counted as additional contributions.
    const result = teamOverview(input({ report: { ...usage, breakdowns: [...usage.breakdowns, { ...usage.breakdowns[0]!, dimension: 'agent' }] }, runtimeCapabilities: new Map([['earlier-agent', { metered: true }], ['subscription-agent', { metered: false }]]), run: { execution: execution(), startedAt: 150 } }))
    expect(result.run?.total).toEqual({ money: 3, turns: 4 })
    expect(result.seats).toEqual([])
  })

  it('distinguishes unavailable Run money from an observed metered zero', () => {
    for (const value of [null, 0]) {
      const result = teamOverview(input({ seats: [seat('Alpha', { runtime: { capabilities: { metered: true } } })], report: report([{ seat: 'Alpha', amounts: amounts(metric(value, { basis: 'vendorMetered', unit: 'usd' })) }]), run: { execution: execution(), startedAt: 150 } }))
      expect(result.run?.total.money).toBe(value)
    }
  })

  it('takes the latest in-flight tool, ignoring finished calls and prose', () => {
    const result = teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [tool('Read', { path: 'src/first.ts' }, { startedAt: 260 }), tool('Edit', { path: 'src/next.ts', old_string: 'old', new_string: 'new' }, { startedAt: 270 }), tool('Read', { path: 'src/finished.ts' }, { status: 'completed' }), { id: itemId('prose'), type: 'assistantMessage', text: 'https://example.com SECRET=value' }]) })] }))
    expect(result.seats[0]).toMatchObject({ doing: 'Edited src/next.ts', since: 250 })
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
      expect(line).not.toBeNull()
      expect(line).not.toMatch(/TOKEN|private-value|https:|curl|\$|`/)
    }
    expect(teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [calls[0]!]) })] })).seats[0]?.doing).toBe('Running a command')
  })

  it('does not revive in-flight items from completed turns', () => {
    expect(teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [tool('Read', { path: 'src/stale.ts' })], false) })] })).seats[0]?.doing).toBeNull()
  })

  it('rejects protocol-relative URLs and prose masquerading as a path', () => {
    for (const path of ['//example.com/private', 'src/file.ts echo private-value', 'TOKEN private-value']) {
      expect(teamOverview(input({ seats: [seat('Alpha', { session: session('Alpha', [tool('Read', { path })]) })] })).seats[0]?.doing).toBe('Reading a file')
    }
  })

  it('does not mutate the snapshot', () => {
    const data = input({ seats: [seat('Beta'), seat('Alpha', { session: session('Alpha') })], cards: [card(1)], run: { execution: execution(), startedAt: 150 } })
    const before = JSON.stringify(data)
    teamOverview(data)
    expect(JSON.stringify(data)).toBe(before)
  })
})

describe('doingLine', () => {
  it('shows the first line immediately and holds changes for 2.5 seconds', () => {
    const first = doingLine(null, 'Reading a file', 100)
    expect(first).toEqual({ line: 'Reading a file', at: 100 })
    expect(doingLine(first, 'Editing a file', 2599)).toEqual(first)
    expect(doingLine(first, 'Editing a file', 2600)).toEqual({ line: 'Editing a file', at: 2600 })
  })

  it('does not postpone a pending update by refreshing an unchanged line', () => {
    const first = { line: 'Reading a file', at: 100 }
    expect(doingLine(first, first.line, 5000)).toEqual(first)
    expect(doingLine(first, null, 2599)).toEqual(first)
    expect(doingLine(first, null, 2600)).toEqual({ line: null, at: 2600 })
  })
})
