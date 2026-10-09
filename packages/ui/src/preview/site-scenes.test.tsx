import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SCENES } from '../../site-demo/scenes'
import { SiteScene } from '../../site-demo/scene'
import { dashboardData } from '../../site-demo/dashboard'
import { buildYearGrid, busiestDay, busiestWeekday, dayLabelLong, leadingAgent, streaksFor, WEEKDAY_NAMES } from '../lib/heat'
import { formatTokens } from '../lib/context-usage'
import { planRows } from '../lib/plans-table'
import { periodTotals, stackDaily } from '../lib/ledger'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const NOW = new Date('2026-10-08T13:30:00').getTime()
let root: Root
let host: HTMLDivElement
const message = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }))
const press = async (name: string, scope: ParentNode = host) => {
  const control = [...scope.querySelectorAll<HTMLElement>('[role="radio"], button')]
    .find(node => (node.textContent ?? '').trim() === name || node.getAttribute('aria-label') === name)
  expect(control, name).toBeDefined()
  await act(async () => control!.click())
  return control!
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.removeAttribute('data-hd-dark-theme')
})

it('registers the full Dashboard and three focused 672 × 432 views', () => {
  expect(Object.keys(SCENES)).toEqual(['dashboard', 'dashboard-spend', 'dashboard-limits', 'dashboard-activity'])
  expect(SCENES.dashboard).toMatchObject({ width: 960, height: 600 })
  for (const name of ['dashboard-spend', 'dashboard-limits', 'dashboard-activity'] as const) {
    expect(SCENES[name]).toEqual({ width: 672, height: 432 })
  }
})

it.each(['light', 'dark'] as const)('boots focused Spend in %s and changes the chart with Line', async theme => {
  await act(async () => root.render(<SiteScene name="dashboard-spend" theme={theme} />))
  expect([...host.querySelectorAll('section[aria-label]')].map(node => node.getAttribute('aria-label'))).toEqual(['What it cost'])
  expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'dark')
  const scene = host.querySelector<HTMLElement>('[data-site-scene]')!
  expect([scene.style.width, scene.style.height]).toEqual(['672px', '432px'])
  expect(host.textContent).not.toContain('Rescan')
  const before = host.innerHTML
  await press('Line')
  expect(host.innerHTML).not.toBe(before)
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Line')
  await press('7d')
  expect(host.textContent).toContain('Last 7 days')
  await act(async () => message({ type: 'theme', value: theme === 'light' ? 'dark' : 'light' }))
  expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'light')
})

it.each(['light', 'dark'] as const)('boots focused Limits in %s and opens and closes the first account', async theme => {
  await act(async () => root.render(<SiteScene name="dashboard-limits" theme={theme} />))
  expect([...host.querySelectorAll('section[aria-label]')].map(node => node.getAttribute('aria-label'))).toEqual(['What is left'])
  expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'dark')
  expect(host.textContent).toContain('Windows')
  expect(host.textContent).toContain('Allowances')
  expect(host.textContent).toContain('Balances')
  expect(host.querySelectorAll('tbody > tr')).toHaveLength(6)
  const account = host.querySelector<HTMLElement>('button[aria-expanded]')!
  const before = host.innerHTML
  await act(async () => account.click())
  expect(account.getAttribute('aria-expanded')).toBe('true')
  expect(host.innerHTML).not.toBe(before)
  expect(host.textContent).toContain('Value')
  await act(async () => account.click())
  expect(account.getAttribute('aria-expanded')).toBe('false')
})

it.each(['light', 'dark'] as const)('boots focused Activity in %s and changes to By agent with reduced motion', async theme => {
  await act(async () => root.render(<SiteScene name="dashboard-activity" theme={theme} motion="reduce" />))
  expect([...host.querySelectorAll('section[aria-label]')].map(node => node.getAttribute('aria-label'))).toEqual(['When it ran'])
  expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'dark')
  expect(host.textContent).toContain('141.6B')
  const before = host.innerHTML
  await press('By agent')
  expect(host.innerHTML).not.toBe(before)
  expect(host.querySelector('[aria-label="Tokens or cost per day, per agent, last 13 weeks"]')).not.toBeNull()
  await act(async () => { message({ type: 'visible', value: false }); vi.advanceTimersByTime(60_000) })
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('By agent')
  await press('Cost')
  expect(host.textContent).not.toContain('141.6B')
})

it.each(['light', 'dark'] as const)('boots the entire shipping Dashboard in %s at cost, and follows live theme messages', async theme => {
  await act(async () => root.render(<StrictMode><SiteScene name="dashboard" theme={theme} /></StrictMode>))
  expect([...host.querySelectorAll('section[aria-label]')].map(node => node.getAttribute('aria-label')))
    .toEqual(['What it cost', 'Where it went', 'What is left', 'When it ran'])
  expect(host.querySelector('[aria-label="Window navigation"]')).toBeNull()
  expect(host.querySelector('[data-scene-pointer]')).toBeNull()
  expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'dark')
  await act(async () => message({ type: 'theme', value: theme === 'light' ? 'dark' : 'light' }))
  expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'light')
})

it('changes the chart, breakdown, range, account detail and activity through real controls', async () => {
  await act(async () => root.render(<SiteScene name="dashboard" />))
  const before = host.innerHTML
  await press('Line')
  expect(host.innerHTML).not.toBe(before)
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Line')
  await press('by model')
  expect(host.textContent).toContain('claude-opus-5-5')
  const breakdown = host.querySelector('section[aria-label="Where it went"]')!
  expect([...breakdown.querySelectorAll('th')].map(node => node.textContent)).toEqual(['Name', 'Share'])
  expect(breakdown.textContent).toContain('Other · 34')
  await press('by project')
  expect(breakdown.textContent).toContain('storefront')
  expect(breakdown.textContent).not.toContain('claude-opus-5-5')
  await press('7d')
  expect(host.textContent).toContain('Last 7 days')
  const account = host.querySelector('section[aria-label="What is left"] button[aria-expanded]') as HTMLElement
  await act(async () => account.click())
  expect(account.getAttribute('aria-expanded')).toBe('true')
  expect(host.textContent).toMatch(/22%\s*left/)
  expect(host.textContent).toContain('Pro')
  expect(host.textContent).toContain('Value')
  expect(host.textContent).toContain('runs out')
  await press('By hour')
  expect(host.querySelector('[aria-label="Tokens or calls by local weekday and hour, this year"]')).not.toBeNull()
  await press('Calls')
  expect(host.textContent).toContain('calls this year')
  await press('By agent')
  expect(host.querySelector('[aria-label="Tokens or cost per day, per agent, last 13 weeks"]')).not.toBeNull()
})

it('omits the cost footer and every unscanned year hatch', async () => {
  await act(async () => root.render(<SiteScene name="dashboard" />))
  const cost = host.querySelector('section[aria-label="What it cost"]')!
  expect(cost.textContent).not.toContain('days scanned')
  expect(cost.textContent).not.toContain('Rescan')
  const year = host.querySelector('section[aria-label="When it ran"]')!
  expect(year.querySelector('[data-state="not-scanned"]')).toBeNull()
  expect(year.textContent).not.toContain('No record yet')
})

it.each([undefined, 'reduce'] as const)('stays interactive without auto-cycling, including motion=%s and hidden messages', async motion => {
  await act(async () => root.render(<SiteScene name="dashboard" motion={motion} />))
  await press('Line')
  await act(async () => { message({ type: 'visible', value: true }); vi.advanceTimersByTime(20_000) })
  await act(async () => { message({ type: 'visible', value: false }); vi.advanceTimersByTime(60_000) })
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Line')
  await press('Bars')
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Bars')
  expect(host.querySelector('[data-scene-pointer]')).toBeNull()
})

it('supplies a busy, consistent year and six correctly classified demo accounts', () => {
  const data = dashboardData(NOW)
  const snapshot = data.store.getSnapshot()
  expect(snapshot.runtimes.map(info => info.presentation.name)).toEqual([
    'Claude Code', 'Cursor', 'Codex', 'Gemini CLI', 'Cline', 'OpenCode', 'Antigravity CLI', 'DeepSeek',
  ])
  expect(snapshot.usage.map(report => report.account)).toEqual([
    'shane@harnessdesk.app', 'olivia@harnessdesk.app', 'review@example.com', 'studio@example.com', null, 'api@example.com',
  ])
  const rows = planRows(snapshot.usage, NOW)
  expect(rows.map(row => row.status)).toEqual(['low', 'ready', 'ready', 'ready', 'ready', 'ready'])
  expect(Object.fromEntries(rows.map(row => [row.report.account ?? 'signed-in', row.view.hero?.remainingPercent ?? null]))).toEqual({
    'shane@harnessdesk.app': 22, 'olivia@harnessdesk.app': 64, 'review@example.com': 93,
    'studio@example.com': 88, 'signed-in': 100, 'api@example.com': null,
  })
  const ledger = data.ledger(30, 'runtime')
  expect(ledger.totalCost).toBeCloseTo(27_418, 0)
  const week = periodTotals(stackDaily(ledger, NOW), [7])[0]!
  expect(week.cost).toBeCloseTo(6_925.4, 1)
  expect(week.change).toBeCloseTo(13.4, 1)
  expect(ledger.daily.filter(row => row.day === Math.max(...ledger.daily.map(day => day.day))).reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(138.4, 1)
  const year = data.ledger(365, 'runtime')
  expect(year.totalTokens).toBeCloseTo(141_600_000_000, -1)
  const cells = buildYearGrid(year, NOW).weeks.flat().filter(cell => cell !== null)
  expect(cells).toHaveLength(365)
  expect(cells.every(cell => cell.scanned)).toBe(true)
  expect(cells.filter(cell => cell.tokens > 0)).toHaveLength(354)
  expect(streaksFor(cells, 'tokens')).toEqual({ current: 61, best: 61 })
  const busiest = busiestDay(cells, 'tokens')!
  expect(new Date(busiest.day).getMonth()).toBe(8)
  expect(new Date(busiest.day).getDay()).toBe(0)
  expect(busiest.tokens).toBeCloseTo(10_300_000_000, -1)
  expect(new Set(cells.filter(cell => cell.tokens > 0).map(cell => new Date(cell.day).getMonth())).size).toBe(12)
  const roster = new Set(snapshot.runtimes.map(info => info.id))
  expect(year.daily.every(row => roster.has(row.runtime))).toBe(true)
  expect(year.hourly!.every(row => roster.has(row.runtime))).toBe(true)
  expect(year.hourly!.reduce((sum, row) => sum + row.tokens, 0)).toBeCloseTo(year.totalTokens!, -1)
  const next = dashboardData(NOW + 86_400_000).ledger(365, 'runtime')
  expect(Math.max(...next.daily.map(day => day.day))).toBe(Math.max(...year.daily.map(day => day.day)) + 86_400_000)
  expect(data.ledger(365, 'runtime')).toBe(year)
  const runtime = next.daily[0]!.runtime
  const dailyTuesday = next.daily.filter(row => row.runtime === runtime && new Date(row.day).getDay() === 2).reduce((sum, row) => sum + row.tokens, 0)
  const hourlyTuesday = next.hourly!.filter(row => row.runtime === runtime && row.weekday === 2).reduce((sum, row) => sum + row.tokens, 0)
  expect(hourlyTuesday).toBeCloseTo(dailyTuesday, -1)
})

it('gives every weekday work in every month, with lighter weekends and a gradual ramp', () => {
  const cells = buildYearGrid(dashboardData(NOW).ledger(365, 'runtime'), NOW).weeks.flat().filter(cell => cell !== null)
  const monthOf = (day: number) => `${new Date(day).getFullYear()}-${new Date(day).getMonth() + 1}`
  for (const month of new Set(cells.map(cell => monthOf(cell.day)))) for (let weekday = 0; weekday < 7; weekday++) {
    const days = cells.filter(cell => monthOf(cell.day) === month && new Date(cell.day).getDay() === weekday)
    expect(days.filter(cell => cell.tokens > 0).length, `month ${month}, weekday ${weekday}`).toBeGreaterThanOrEqual(Math.min(2, days.length))
  }
  const ordinary = cells.filter(cell => cell.tokens > 0 && cell.tokens < 10_000_000_000)
  const average = (days: typeof cells) => days.reduce((sum, day) => sum + day.tokens, 0) / days.length
  expect(average(ordinary.filter(cell => [0, 6].includes(new Date(cell.day).getDay()))))
    .toBeLessThan(average(ordinary.filter(cell => ![0, 6].includes(new Date(cell.day).getDay()))))
  const quarters = [0, 1, 2, 3].map(index => average(cells.slice(index * 91, (index + 1) * 91)))
  expect(quarters[1]).toBeGreaterThan(quarters[0]!)
  expect(quarters[2]).toBeGreaterThan(quarters[1]!)
  expect(quarters[3]).toBeGreaterThan(quarters[2]!)
  expect(cells.filter(cell => cell.tokens === 0).length).toBeGreaterThan(0)
  expect(cells.filter(cell => cell.tokens > 0).length).toBeGreaterThan(330)
})

it('renders Activity facts and its busiest weekday from the fictional year', async () => {
  const cells = buildYearGrid(dashboardData(NOW).ledger(365, 'runtime'), NOW).weeks.flat().filter(cell => cell !== null)
  await act(async () => root.render(<SiteScene name="dashboard-activity" />))
  const facts = host.querySelector('[data-slot="chart-card"]')!
  expect(facts.children[0]?.textContent).toBe(`${formatTokens(cells.reduce((sum, cell) => sum + cell.tokens, 0))}this year`)
  expect(facts.children[1]?.textContent).toBe(`${cells.filter(cell => cell.tokens > 0).length}active of 365 scanned`)
  const streak = streaksFor(cells, 'tokens')
  expect(facts.children[2]?.textContent).toBe(`${streak.current} daysstreak · best ${streak.best}`)
  expect(host.textContent).toContain(`Busiest on ${WEEKDAY_NAMES[busiestWeekday(cells, 'tokens')!]}s`)
  const peak = busiestDay(cells, 'tokens')!
  expect(facts.children[3]?.textContent).toBe(`${formatTokens(peak.tokens)}${dayLabelLong(peak.day)}`)
  expect(leadingAgent(cells, 'tokens')).toBe('claude')
  expect(facts.children[4]?.textContent).toBe('Claude Codedid the most')
})
