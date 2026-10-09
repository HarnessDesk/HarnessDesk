import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { SCENES } from '../../site-demo/scenes'
import { SiteScene } from '../../site-demo/scene'
import { dashboardData } from '../../site-demo/dashboard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let frames: Map<number, FrameRequestCallback>
let frameId: number
const message = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }))
const step = async (ms: number) => act(async () => {
  vi.advanceTimersByTime(ms)
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(frame => frame(performance.now()))
})

let websiteData: ReturnType<typeof dashboardData>
let yearReferences: Set<string>
let yearRowKeys: Set<string>

beforeAll(() => {
  websiteData = dashboardData()
  const ledger = websiteData.ledger(365, 'runtime')
  yearReferences = new Set([
    ...ledger.daily.map(row => row.runtime),
    ...ledger.hourly!.map(row => row.runtime),
    ...ledger.rows.map(row => row.runtime!),
    ...ledger.coverage.hoursKnownFor!,
  ])
  yearRowKeys = new Set(ledger.rows.map(row => row.key))
  // Building the synthetic year took about 8 s on CI's runner, close to the 10 s hook default.
}, 30_000)

beforeEach(() => {
  vi.useFakeTimers()
  frames = new Map()
  frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
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

it('registers only the approved dashboard with its fixed logical size', () => {
  expect(Object.keys(SCENES)).toEqual(['dashboard'])
  expect(SCENES.dashboard).toMatchObject({ width: 960, height: 600, duration: 16_000 })
})

it('uses website runtime presentations and keeps every ledger reference on that roster', () => {
  const snapshot = websiteData.store.getSnapshot()
  expect(snapshot.runtimes.map(info => info.presentation)).toEqual([
    expect.objectContaining({ name: 'Codex', brand: 'codex' }),
    expect.objectContaining({ name: 'Claude Code', brand: 'claudecode' }),
    expect.objectContaining({ name: 'Gemini', brand: 'geminicli' }),
  ])
  const roster = new Set(snapshot.runtimes.map(info => info.id))
  const accounts = new Set(snapshot.usage.map(report => report.account))
  expect(accounts).toEqual(new Set(['shane@harnessdesk.app', 'olivia@harnessdesk.app', 'review@example.com', 'studio@example.com', 'api@example.com']))
  expect(yearReferences).toEqual(roster)
  expect(yearRowKeys).toEqual(roster)
})

it.each(['light', 'dark'] as const)('boots the shipping dashboard in %s, paused, and follows live theme messages', async theme => {
  await act(async () => root.render(<StrictMode><SiteScene name="dashboard" theme={theme} /></StrictMode>))
  expect(host.textContent).toContain('What is left')
  expect(host.querySelector('table')).not.toBeNull()
  expect(host.textContent).toContain('Claude Code')
  expect(host.textContent).toContain('Codex')
  expect(host.textContent).toContain('Gemini')
  expect(host.querySelector('.brand-codex')).not.toBeNull()
  expect(host.querySelector('.brand-claudecode')).not.toBeNull()
  expect(host.querySelector('.brand-geminicli')).not.toBeNull()
  expect(host.textContent).not.toMatch(/Alpha|Beta|Gamma/)
  expect(host.querySelector('[aria-label="Window navigation"]')).toBeNull()
  await step(5000)
  expect(host.querySelector('[data-scene-stage]')?.getAttribute('data-scene-stage')).toBe('limits')
  expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'dark')
  await act(async () => message({ type: 'theme', value: theme === 'light' ? 'dark' : 'light' }))
  expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'light')
})

it('plays real controls, pauses without losing its position and loops back to Limits', async () => {
  await act(async () => root.render(<SiteScene name="dashboard" theme="light" />))
  await act(async () => message({ type: 'visible', value: 'true' }))
  await step(4500)
  expect(host.textContent).toContain('What is left')
  await act(async () => message({ type: 'visible', value: true }))
  await step(4500)
  expect(host.querySelector('[data-scene-stage]')?.getAttribute('data-scene-stage')).toBe('spend')
  await act(async () => message({ type: 'visible', value: false }))
  await step(20_000)
  expect(host.querySelector('[data-scene-stage]')?.getAttribute('data-scene-stage')).toBe('spend')
  await act(async () => message({ type: 'visible', value: true }))
  await step(4500)
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('By agent')
  await step(4000)
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('Year')
  await step(4000)
  expect(host.querySelector('[data-scene-stage]')?.getAttribute('data-scene-stage')).toBe('limits')
})

it('holds a representative year still when motion is reduced', async () => {
  await act(async () => root.render(<SiteScene name="dashboard" theme="dark" motion="reduce" />))
  expect(host.textContent).toContain('When it ran')
  const before = host.innerHTML
  await act(async () => message({ type: 'visible', value: true }))
  await step(60_000)
  expect(host.innerHTML).toBe(before)
  expect(host.querySelector('[data-scene-pointer]')).toBeNull()
})

it('recalibrates the synthetic year and quota reset times together', () => {
  const now = Date.parse('2026-10-08T17:00:00Z')
  const data = dashboardData(now)
  const year = data.ledger(365, 'runtime')
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  expect(Math.max(...year.daily.map(day => day.day))).toBe(today.getTime())
  expect(new Set(year.daily.map(day => day.day)).size).toBe(365)
  expect(data.store.getSnapshot().usage.every(report => report.fetchedAt === now - 60_000)).toBe(true)
  expect(data.store.getSnapshot().usage[0]!.lanes[0]!.resetsAt).toBe(now + 70 * 60_000)
  expect(data.ledger(365, 'runtime')).toBe(year)
  const next = dashboardData(now + 86_400_000).ledger(365, 'runtime')
  expect(Math.max(...next.daily.map(day => day.day))).toBe(today.getTime() + 86_400_000)
  expect(Math.max(...year.daily.map(day => day.day))).toBe(today.getTime())
})

it('switches to the Year still when the system reduces motion during By agent', async () => {
  let matches = false
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (media: string) => ({ media, get matches() { return media.includes('reduced-motion') && matches },
    addEventListener: (_type: string, fn: () => void) => { if (media.includes('reduced-motion')) listeners.add(fn) },
    removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
  }))
  await act(async () => root.render(<SiteScene name="dashboard" />))
  await act(async () => message({ type: 'visible', value: true }))
  await step(9000)
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('By agent')
  await act(async () => { matches = true; listeners.forEach(listener => listener()) })
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('Year')
  expect(host.querySelector('[data-scene-pointer]')).toBeNull()
  const before = host.innerHTML
  await step(60_000)
  expect(host.innerHTML).toBe(before)
})
