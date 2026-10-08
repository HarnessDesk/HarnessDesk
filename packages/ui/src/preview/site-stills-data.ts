/** Website camera data: fictional accounts and one reproducible year of local history. */
import { type FlowAgentRole, type FlowPolicy, type FlowPreview, type Intent, type LedgerDay, type LedgerHour, type LedgerQuery, type LedgerReport, type UsageReport } from '@harnessdesk/protocol'
import type { RunTimelineInput } from '../lib/run-timeline'
import { shapeFixture } from './run-shapes-fixture'
import { runFixture } from './run-view-fixture'
import { previewUsage } from './sidebar-fixture'

export const SITE_NOW = Date.parse('2026-09-30T17:00:00Z')
export const SITE_BROWSER_URL = 'https://acme.dev/storefront'
const DAY = 86_400_000
const accounts = [0, 1, 2, 3, 6].map((index, n) => ({ template: previewUsage[index]!, account: ['dev', 'work', 'review', 'studio', 'api'][n] + '@example.com' }))
const runtimes = [...new Set(accounts.map(row => row.template.runtime))]

export const siteHistory = () => {
  const rows: { day: number; runtime: typeof runtimes[number]; account: string; hour: number; requests: number; tokens: number; cost: number }[] = []
  for (let index = 364; index >= 0; index--) {
    const date = new Date(SITE_NOW)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - index)
    const weekday = date.getDay()
    // A holiday week, most weekends and occasional days off really have no work.
    const off = (index >= 72 && index <= 78) || weekday === 0 || (weekday === 6 && index % 5 !== 0) || index % 19 === 0
    for (const [n, { template, account }] of accounts.entries()) {
      for (let hour = 0; hour < 24; hour++) {
        const weight = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 4, 5, 2, 5, 7, 8, 6, 4, 2, 1, 0, 0, 0, 0][hour]!
        const requests = off ? 0 : Math.floor(weight * (0.7 + ((index * 17 + n * 11) % 23) / 20) * (n === 4 ? 0.6 : 1))
        rows.push({ day: date.getTime(), runtime: template.runtime, account, hour, requests, tokens: requests * (4600 + n * 800), cost: requests * (0.09 + n * 0.035) })
      }
    }
  }
  return rows
}

export const siteLedger = ({ days, groupBy, runtime }: LedgerQuery): LedgerReport => {
  const history = siteHistory()
  const dates = [...new Set(history.map(row => row.day))].slice(-days)
  const selected = history.filter(row => row.day >= dates[0]! && (!runtime || row.runtime === runtime))
  const daily: LedgerDay[] = dates.flatMap(day => runtimes.filter(id => !runtime || runtime === id).map(id => {
    const rows = selected.filter(row => row.day === day && row.runtime === id)
    const tokens = rows.reduce((sum, row) => sum + row.tokens, 0)
    return { day, runtime: id, cost: rows.reduce((sum, row) => sum + row.cost, 0), tokens,
      input: tokens * 0.3, output: tokens * 0.2, cacheRead: tokens * 0.45, cacheWrite: tokens * 0.05,
      requests: rows.reduce((sum, row) => sum + row.requests, 0), ...(id === runtimes[2] ? {} : { turns: Math.ceil(rows.reduce((sum, row) => sum + row.requests, 0) / 5) }) }
  }))
  const hourly: LedgerHour[] = runtimes.filter(id => !runtime || id === runtime).flatMap(id => Array.from({ length: 168 }, (_, index) => {
    const weekday = Math.floor(index / 24), hour = index % 24
    const rows = selected.filter(row => row.runtime === id && new Date(row.day).getDay() === weekday && row.hour === hour)
    return { runtime: id, weekday, hour, tokens: rows.reduce((sum, row) => sum + row.tokens, 0), requests: rows.reduce((sum, row) => sum + row.requests, 0) }
  }))
  const rows = runtimes.filter(id => !runtime || id === runtime).map(id => {
    const entries = daily.filter(row => row.runtime === id)
    return { key: groupBy === 'model' ? `model-${id}` : String(id), label: String(id), runtime: id,
      cost: entries.reduce((sum, row) => sum + row.cost, 0), tokens: entries.reduce((sum, row) => sum + row.tokens, 0), hasUnpriced: false }
  })
  return { days, currency: 'USD', provenance: 'listPrice', daily, hourly, rows, scannedAt: SITE_NOW - 120_000,
    totalCost: daily.reduce((sum, row) => sum + row.cost, 0), totalTokens: daily.reduce((sum, row) => sum + row.tokens, 0),
    coverage: { priced: selected.reduce((sum, row) => sum + row.requests, 0), unpriced: 0, unmetered: 0, estimated: 0,
      daysCovered: dates.length, daysRequested: days, earliestDay: dates[0]!, turnsKnownFor: runtimes.slice(0, 2), hoursKnownFor: runtimes },
    totals: { input: daily.reduce((sum, row) => sum + row.input!, 0), output: daily.reduce((sum, row) => sum + row.output!, 0),
      cacheRead: daily.reduce((sum, row) => sum + row.cacheRead!, 0), cacheWrite: daily.reduce((sum, row) => sum + row.cacheWrite!, 0),
      reasoning: 0, requests: selected.reduce((sum, row) => sum + row.requests, 0) } }
}

export const siteUsage = (): UsageReport[] => accounts.map(({ template, account }, n) => {
  const recent = siteHistory().filter(row => row.account === account && row.day >= SITE_NOW - 30 * DAY)
  const cost = recent.reduce((sum, row) => sum + row.cost, 0)
  return { ...template, account, fetchedAt: SITE_NOW - 60_000, source: { kind: 'runtime', label: 'from its own API' },
    lanes: template.lanes.filter(lane => !lane.scope && lane.usageKnown !== false).map((lane, index) => ({ ...lane,
      usedPercent: n === 0 ? index === 0 ? 94 : 89 : 28 + n * 11, resetsAt: SITE_NOW + (index === 0 ? 70 : 26 * 60) * 60_000 })),
    ...(template.spend ? { spend: { ...template.spend, windowCost: cost, windowTokens: recent.reduce((sum, row) => sum + row.tokens, 0) } } : {}),
    billing: { ...template.billing, kinds: template.billing?.kinds ?? [],
      ...(template.billing?.budget ? { budget: { ...template.billing.budget, amount: 1500 } } : {}),
      fee: template.billing?.kinds.includes('windows') ? { amount: n === 0 ? 200 : 20, currency: 'USD', period: 'month', source: 'user' } : undefined },
  }
})

const agent = (id: string, grant: 'read' | 'edit' = 'edit'): FlowAgentRole => ({ id, kind: 'agent', uses: [id], seats: [], isolate: true, grant, independentOf: [] })
const person: FlowPolicy['roles'][number] = { id: 'person', kind: 'person', outcomes: ['approved'] }
export const siteRun = (kind: 'review' | 'race'): RunTimelineInput => {
  const base = shapeFixture(kind === 'race' ? 'comparison' : 'independent-review', 1)
  const start = SITE_NOW - 22 * 60_000
  const race = kind === 'race'
  const roles = race ? [{ ...agent('competitor'), count: 2 }, agent('judge', 'read'), person] : [agent('write'), agent('review', 'read'), agent('fix'), person]
  const steps = race ? [['competitor', [1, 2]], ['judge', [5]], ['person', [6]]] as const
    : [['write', [1]], ['review', [2]], ['fix', [3]], ['review', [4]], ['person', [5]]] as const
  const titles = race ? ['Retry inside the client', 'Retry at the call site', '', '', 'Pick the better attempt', 'Decide whether the change ships']
    : ['Retry the checkout call on a 502', 'Review the retry change', 'Cap the retry attempts', 'Review the repair', 'Decide whether the change ships']
  const flow: FlowPolicy = { version: 2, name: race ? 'Compare two attempts' : 'Write and review',
    inputs: [{ id: 'brief', label: 'Brief' }, { id: 'task', label: 'Task' }], roles, messaging: 'board-only', wait: 240,
    seed: { role: roles[0]!.id, title: titles[0]! }, rules: race ? [
      { id: 'attempts', on: 'competitor', then: { role: 'judge', title: titles[4]! } },
      { id: 'picked', on: 'judge', when: { every: ['picked'] }, then: { role: 'person', title: titles[5]! } },
    ] : [
      { id: 'written', on: 'write', then: { role: 'review', title: titles[1]! } },
      { id: 'changes', on: 'review', when: { any: ['request-changes'] }, then: { role: 'fix', title: titles[2]! } },
      { id: 'fixed', on: 'fix', then: { role: 'review', title: titles[3]! } },
      { id: 'approved', on: 'review', when: { every: ['approve'] }, then: { role: 'person', title: titles[4]! } },
    ] }
  const rounds = steps.map(([role, cards], index) => ({ n: index + 1, role, cards: [...cards], seats: role === 'person' ? [] : cards.map(id => `seat-${id}`),
    evidence: [], state: role === 'person' ? 'running' as const : 'closed' as const, cause: index === 0 ? 'seed' : race ? ['attempts', 'picked'][index - 1]! : ['written', 'changes', 'fixed', 'approved'][index - 1]! }))
  const execution = { ...base.execution, id: `site-${kind}`, goal: 'site-team', startedAt: start, brief: null, rounds,
    document: { format: 'agents' as const, flow }, operations: rounds.flatMap(round => round.seats.map((seat, i) => ({ key: seat, kind: 'seat' as const, card: round.cards[i]!, seat, state: 'finished' as const }))) }
  const cards: Intent[] = rounds.flatMap(round => round.cards.map(id => ({ id, role: round.role, title: titles[id - 1]!, files: [], dependsOn: [],
    createdAt: start + (round.n - 1) * 4 * 60_000, updatedAt: start + round.n * 4 * 60_000,
    state: round.role === 'person' ? 'open' : 'done', outcome: round.role === 'person' ? null : race ? round.role === 'judge' ? 'picked' : 'delivered' : id === 2 ? 'request-changes' : id === 4 ? 'approve' : 'published',
    note: race && round.role === 'judge' ? 'Attempt A keeps retries inside the client.' : null })))
  const evidence = { ...base.evidence!, room: execution.goal, cards: race ? base.evidence!.cards.filter(card => [1, 2, 5].includes(card.card)).map(card => ({ ...card,
    facts: card.facts.map(view => ({ ...view, record: { ...view.record, round: card.card === 5 ? 2 : 1, card: { board: execution.goal, id: card.card } } })) })) : [] }
  const findings = race ? [] : runFixture().findings.map(finding => ({ ...finding, ownerGoal: execution.goal,
    origin: { ...finding.origin, goal: execution.goal, run: execution.id, round: 2, card: 2, seat: 'seat-2' },
    lifecycle: { state: 'repaired' as const, confirmed: true, repairs: ['b'.repeat(40)] } }))
  return { execution, cards, evidence, findings }
}

/** The top excerpt keeps every Seat; the frozen Flow owns its roles and ceilings. */
export const siteStartPreview = (): FlowPreview => {
  const saved = siteRun('review').execution.document
  if (saved.format !== 'agents') throw new Error('Expected the website’s agent Flow')
  const document = { ...saved, flow: { ...saved.flow, roles: saved.flow.roles.map(role => role.kind === 'agent'
    ? { ...role, uses: [role.grant === 'read' ? 'code-reviewer' : 'implementer'] } : role) } }
  return { token: 'site-start-token', compiled: { document, bindings: [], problems: [] }, commands: [], guards: [], messaging: 'board-only', problems: [],
    seats: document.flow.roles.flatMap((role, index) => role.kind === 'agent' ? [{ role: role.id, index: 0, agent: role.uses[0]!, isolate: role.isolate, reviews: role.grant === 'read',
      plan: { id: role.uses[0]!, from: 'prefer' as const, winner: 0, blocked: null, ceiling: { level: role.grant ?? 'edit', hold: 'held' as const },
        candidates: [{ seat: { runtime: index === 1 ? 'claude' : 'codex' }, label: index === 1 ? 'Beta' : 'Alpha', runtimeName: index === 1 ? 'Beta' : 'Alpha', state: 'taken' as const, reason: null, fix: null }] } }] : []) }
}
