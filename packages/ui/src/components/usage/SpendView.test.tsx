import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type LedgerReport, type RuntimeInfo } from '@harnessdesk/protocol'

import { dotTint, tintsFor } from '../../design'
import { runtimeTint } from '../../lib/accounts'
import { SpendView } from './SpendView'
import { tintsForRoster } from './shared'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const runtime = (id: string, name: string, brand?: string): RuntimeInfo => ({
  id: runtimeId(id), capabilities: NO_CAPABILITIES, presentation: { name, ...(brand ? { brand } : {}) },
}) as RuntimeInfo
const roster = [runtime('alpha', 'Alpha', 'codex'), runtime('beta', 'Beta', 'claudecode'), runtime('gamma', 'Gamma', 'cursor')]
const now = new Date(2026, 9, 16, 12).getTime()
const day = new Date(2026, 9, 16).getTime()

const draw = (infos: RuntimeInfo[]) => {
  const ledger: LedgerReport = {
    days: 7, currency: 'USD', totalCost: infos.length, totalTokens: infos.length * 100, provenance: 'listPrice',
    coverage: { priced: infos.length, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 1, daysRequested: 7, earliestDay: day, coveredDays: [day] },
    rows: infos.map(info => ({ key: info.id, label: info.presentation.name, runtime: info.id, tokens: 100, cost: 1, hasUnpriced: false })),
    daily: infos.map(info => ({ day, runtime: info.id, cost: 1, tokens: 100 })), scannedAt: now,
  }
  act(() => root.render(<SpendView ledger={ledger} wideLedger={null} byId={new Map(infos.map(info => [info.id, info]))}
    agentTints={tintsForRoster(infos)} scan={null} now={now} range={7} onRangeChange={() => {}}
    mode="bars" onModeChange={() => {}} onScan={() => {}} pivot="runtime" onPivotChange={() => {}} />))
}

const assertSeries = (infos: RuntimeInfo[], expected: string[]) => {
  const segments = host.querySelectorAll('[aria-label="Where it went, by share"] > span')
  const bars = host.querySelectorAll('[data-slot="day-columns"] span[style*="height"]')
  expect(segments).toHaveLength(infos.length)
  expect(bars).toHaveLength(infos.length)
  for (const [index, info] of infos.entries()) {
    const row = [...host.querySelectorAll('tbody tr')].find(node => node.textContent?.includes(info.presentation.name))!
    const face = row.querySelector('[data-slot="icon-tile"]')!
    const key = [...host.querySelectorAll('[data-slot="chart-key"]')].find(node => node.textContent === info.presentation.name)!
    const tint = expected[index]!
    expect(face.getAttribute('data-tint')).toBe(tint)
    expect(key.querySelector('[data-slot="series-dot"]')?.getAttribute('data-tint')).toBe(tint)
    for (const node of [segments[index], bars[index]]) expect(node?.className).toContain(dotTint({ tint: tint as ReturnType<typeof runtimeTint> }))
  }
}

it('matches each branded runtime tile to its legend dot, meter segment and bar series', () => {
  draw(roster)
  assertSeries(roster, roster.map(runtimeTint))
})

it('keeps the first brand tint and gives a duplicate the next unused roster tint across its tile and series', () => {
  const infos = [roster[0]!, runtime('alpha-copy', 'Alpha copy', 'codex'), ...roster.slice(1)]
  const reserved = new Set(infos.map(runtimeTint))
  const alternate = tintsFor(infos.map(info => String(info.id))).find(tint => !reserved.has(tint))!
  draw(infos)
  assertSeries(infos, [runtimeTint(infos[0]), alternate, ...roster.slice(1).map(runtimeTint)])
})
