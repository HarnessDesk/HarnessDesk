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

it('shows a zero balance as a balance, in the tone of an empty one', () => {
  const text = shown(limits({ balance: 0 }))
  expect(text).toContain('Credits')
  expect(text).toContain('0 credits')
  expect(text).not.toContain('Nothing to read yet')
  expect(value('0 credits')?.getAttribute('data-tone')).toBe('bad')
})

it('shows a balance with something in it in the tone of a good one', () => {
  shown(limits({ balance: 5 }))
  expect(value('5 credits')?.getAttribute('data-tone')).toBe('good')
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
