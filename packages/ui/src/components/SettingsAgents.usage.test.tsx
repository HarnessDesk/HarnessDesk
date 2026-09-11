import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { RateLimits } from '@harnessdesk/protocol'

import { UsageSection } from './SettingsAgents'

/**
 * An account's Usage section shows the prepaid balance `describeLimits` works
 * out, a zero included: it was shown nowhere but the Usage window (#182).
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

it('shows a zero balance as a balance', () => {
  const text = shown(limits({ balance: 0 }))
  expect(text).toContain('Credits')
  expect(text).toContain('0 credits')
  expect(text).not.toContain('Nothing to read yet')
})

it('shows an unlimited account as unlimited', () => {
  expect(shown(limits({ unlimited: true }))).toContain('unlimited')
})

it('says there is nothing to read when there is neither a window nor a balance', () => {
  const text = shown(null)
  expect(text).toContain('Nothing to read yet')
  expect(text).not.toContain('Credits')
  expect(shown(limits({ hasCredits: false }))).toContain('Nothing to read yet')
})
