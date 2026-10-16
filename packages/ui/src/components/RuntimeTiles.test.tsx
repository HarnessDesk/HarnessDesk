import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { LedgerReport, LibraryEntry } from '@harnessdesk/protocol'
import { previewStore, runtime } from '../preview/harness'
import { StoreProvider } from '../state/context'
import { AddAgentsTestPage } from '../test-support/settings-page'
import { RuntimeFace } from './RuntimeFace'
import { SkillRow, SkillList } from './SkillRow'
import { PlansTable } from './usage/PlansTable'
import { Ranked, tintsForRoster } from './usage/shared'
import { planRows } from '../lib/plans-table'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(['windows', 'allowance', 'balance', 'metered', 'free'] as const)('keeps each brand tint across Add, roster, Loaded by and Usage (%s), independent of account tint and runtime id', async (kind) => {
  const brands = ['codex', 'claudecode', 'cursor'] as const
  const infos = brands.map((brand, index) => ({ ...runtime(`installed-${index}`, `Runtime ${index}`), presentation: { name: `Runtime ${index}`, brand } }))
  const store = previewStore({ runtimes: infos, accountPrefs: Object.fromEntries(infos.map(info => [`${info.id}:oauth:dev@example.com`, { tint: 'rose' as const }])), accountsByRuntime: Object.fromEntries(infos.map(info => [info.id, { accounts: [{ kind: 'oauth', label: 'dev@example.com' }], signInMethods: [] }])) })
  store.agentCatalog = async () => brands.map((brand, index) => ({ key: `template-${index}`, name: `Runtime ${index}`, brand, available: true, registered: false }))
  const entry = { kind: 'skill', name: 'shared', copies: [], reach: infos.map(info => ({ runtime: info.id, state: 'reaches', basis: 'reported' })) } as LibraryEntry
  const now = Date.UTC(2026, 9, 16)
  const byId = new Map(infos.map(info => [info.id, info]))
  const reports = infos.map(info => ({ ...store.getSnapshot().usage[0]!, runtime: info.id, account: 'dev@example.com', billing: { kinds: [kind] } }))
  const rows = planRows(reports, now)
  const ledger: LedgerReport = { days: 30, currency: 'USD', totalCost: 3, totalTokens: 300,
    rows: infos.map(info => ({ key: info.id, label: info.presentation.name, runtime: null, cost: 1, tokens: 100, hasUnpriced: false })),
    provenance: 'listPrice', coverage: { priced: 3, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 30, daysRequested: 30 }, daily: [], scannedAt: now }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<StoreProvider store={store}>
      <section data-surface="add"><AddAgentsTestPage onBack={() => {}} onDone={() => {}} /></section>
      <section data-surface="roster">{infos.map(info => <RuntimeFace key={info.id} runtime={info} />)}</section>
      <section data-surface="library"><SkillList><SkillRow entry={entry} columns={infos.map(info => ({ id: info.id, label: info.presentation.name, info }))} onOpen={() => {}} /></SkillList></section>
      <section data-surface="plans"><PlansTable rows={rows} byId={byId} now={now} snapshot={store.getSnapshot()} filter="all" preferenceFor={() => ({})} onRefreshAccount={() => {}} onStopTracking={() => {}} onOpenPlanSettings={() => {}} /></section>
      {[false, true].map(compact => <section key={String(compact)} data-surface={`ranked-${compact}`}><Ranked ledger={ledger} wideLedger={null} pivot="runtime" range={30} now={now} byId={byId} tintOf={tintsForRoster(infos)} compact={compact} /></section>)}
    </StoreProvider>))
    const tints = (surface: string, selector: string) => [...host.querySelectorAll(`[data-surface="${surface}"] ${selector}`)].map(tile => tile.getAttribute('data-tint'))
    const add = tints('add', '[data-slot="icon-tile"]')
    expect(tints('roster', '[data-slot="icon-tile"]')).toEqual(add)
    expect(tints('library', '[data-slot="avatar"]')).toEqual(add)
    expect(rows.map(row => row.shape)).toEqual(infos.map(() => kind))
    // Plan sorting is independent of the roster order; compare each named runtime.
    for (const [index, info] of infos.entries()) {
      const row = [...host.querySelectorAll('[data-surface="plans"] tbody tr')].find(row => row.textContent?.includes(info.presentation.name))!
      expect.soft(row.querySelector('[data-slot="icon-tile"]')?.getAttribute('data-tint')).toBe(add[index])
    }
    for (const compact of [false, true]) expect.soft(tints(`ranked-${compact}`, '[data-slot="icon-tile"]')).toEqual(add)
    expect(new Set(add).size).toBe(3)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
