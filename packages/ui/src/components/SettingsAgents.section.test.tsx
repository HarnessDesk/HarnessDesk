import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { RateLimits } from '@harnessdesk/protocol'

import { UsageSection } from './SettingsAgents'

/**
 * An account's Usage section: its windows, and the prepaid balance
 * `describeLimits` works out, a zero included, which was shown nowhere but the
 * Usage window (#182). What each account row reads is pinned in
 * `SettingsAgents.usage.test.tsx`.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const limits = (over: Partial<RateLimits>): RateLimits =>
  ({ hasCredits: true, unlimited: false, balance: null, planType: 'team', windows: [], reached: null, ...over }) as RateLimits

const shown = (value: RateLimits | null): string => {
  act(() => root.render(<UsageSection limits={value} name="Codex" />))
  return container.textContent ?? ''
}

/** The toned value a row shows, by its words: not the control's wrapper, which holds the same words. */
const value = (words: string): Element | undefined =>
  [...container.querySelectorAll('[data-tone]')].find((node) => node.textContent === words)

it('shows a zero balance as a balance, in the danger tone', () => {
  const text = shown(limits({ balance: 0 }))
  expect(text).toContain('Credits')
  expect(text).toContain('0 credits')
  expect(text).not.toContain('Nothing to read yet')
  expect(value('0 credits')?.getAttribute('data-tone')).toBe('danger')
})

it('shows a balance with something in it, untoned', () => {
  shown(limits({ balance: 5 }))
  const credits = [...container.querySelectorAll('[data-slot="text"]')].find(
    (node) => node.textContent === '5 credits',
  )
  expect(credits).toBeDefined()
  expect(credits?.getAttribute('data-tone')).toBeNull()
})

it('shows an unlimited account as unlimited', () => {
  expect(shown(limits({ unlimited: true }))).toContain('unlimited')
})

it('says there is nothing to read when there is neither a window nor a balance', () => {
  const text = shown(null)
  expect(text).toContain('Nothing to read yet')
  expect(text).not.toContain('Credits')
  /* An account with no credits and a zero balance has no balance to show. With `balance: null` this line passed
     whichever way `hasCredits` went (review of #216). */
  expect(shown(limits({ hasCredits: false, balance: 0 }))).toContain('Nothing to read yet')
})

it('draws the windows and the balance as one card', () => {
  // Review of #216: two cards under one heading read as a second section that forgot its name.
  shown(limits({ balance: 5, windows: [{ label: 'Weekly', usedPercent: 40, resetsAt: null }] as never }))
  const cards = [...container.children].filter((node) => /Weekly|Credits/.test(node.textContent ?? ''))
  expect(cards).toHaveLength(1)
  expect(cards[0]?.textContent).toContain('Weekly')
  expect(cards[0]?.textContent).toContain('Credits')
})

it('draws each usage window as a row of the card, before Credits', () => {
  // The windows used to be one padded block drawing its own divider; each is
  // now a row of the card, so the card's own rule separates them.
  shown(
    limits({
      balance: 5,
      windows: [
        { label: '5-hour', usedPercent: 10, resetsAt: null },
        { label: 'Weekly', usedPercent: 40, resetsAt: null },
      ] as never,
    }),
  )
  const card = [...container.children].find((node) => node.textContent?.includes('Credits'))
  const rows = [...(card?.children ?? [])]
  const meters = rows.filter((row) => row.querySelector('[role="progressbar"]'))
  const credits = rows.find((row) => row.textContent?.includes('Credits'))
  expect(meters.map((row) => row.textContent)).toEqual([expect.stringContaining('5-hour'), expect.stringContaining('Weekly')])
  expect(meters.every((row) => row.querySelectorAll('[role="progressbar"]').length === 1)).toBe(true)
  expect(rows.indexOf(credits as Element)).toBe(rows.length - 1)
})

it('grades a window meter the way every remaining meter is graded', () => {
  // Neutral while there is room — green made "nothing is wrong" the loudest
  // thing on the page — amber under a fifth, red when spent.
  shown(
    limits({
      windows: [
        { label: '5-hour', usedPercent: 52, resetsAt: null },
        { label: 'Weekly', usedPercent: 88, resetsAt: null },
        { label: 'Monthly', usedPercent: 100, resetsAt: null },
      ] as never,
    }),
  )
  const meters = [...container.querySelectorAll('[role="progressbar"]')]
  expect(meters.map((meter) => meter.getAttribute('aria-label'))).toEqual([
    '5-hour remaining',
    'Weekly remaining',
    'Monthly remaining',
  ])
  expect(meters.map((meter) => meter.getAttribute('aria-valuenow'))).toEqual(['48', '12', '0'])
  expect(meters.map((meter) => meter.getAttribute('data-tone'))).toEqual(['neutral', 'warning', 'danger'])
  expect(meters.every((meter) => meter.getAttribute('data-measure') === 'remaining')).toBe(true)
  expect(container.textContent).toContain('48% left')
})

it('says when a window refills on the line under its name', () => {
  const resetsAt = new Date(2030, 0, 2, 16, 0).getTime()
  shown(limits({ windows: [{ label: 'Weekly', usedPercent: 40, resetsAt }] as never }))
  const meter = container.querySelector('[role="progressbar"]')
  const row = [...container.querySelectorAll('*')].find(
    (node) => node.parentElement?.children.length && node.contains(meter) && node.textContent?.startsWith('Weekly'),
  )
  expect(row?.textContent).toMatch(/^WeeklyResets .+60% left$/)
})
