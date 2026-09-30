import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MoneyRow } from '../../lib/plans-table'
import { MoneyRowView } from './PlanFrame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = (money: MoneyRow): void => {
  act(() => root.render(<MoneyRowView money={money} />))
}

const row = (over: Partial<MoneyRow>): MoneyRow => ({
  value: 60,
  paid: 100,
  overageAside: null,
  overageAsideCurrency: null,
  ratio: 0.6,
  fee: { amount: 100, currency: 'USD', period: 'month' },
  feeIsUser: false,
  currency: 'USD',
  ...over,
})

describe('MoneyRowView', () => {
  it('uses a neutral paid chip at one times or above', () => {
    mount(row({ value: 100, paid: 100, ratio: 1 }))
    expect(host.querySelector('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('neutral')
    expect(host.textContent).toContain('1.0× paid')
  })

  it('uses a warning paid chip below one times', () => {
    mount(row({ ratio: 0.6 }))
    expect(host.querySelector('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('warning')
    expect(host.textContent).toContain('0.6× paid')
  })

  it('shows overage beside Paid', () => {
    mount(row({ overageAside: 4.5 }))
    expect(host.textContent).toContain('+ $4.50 overage this cycle')
  })

  it('formats overage aside in its own currency', () => {
    mount(row({ overageAside: 4.5, overageAsideCurrency: 'EUR' }))
    expect(host.textContent).toContain('+ €4.50 overage this cycle')
  })

  it('does not show Paid or a ratio chip when no fee is set', () => {
    mount(row({ fee: null, paid: null, overageAside: null, ratio: null }))
    expect(host.textContent).toContain('Fee not set')
    expect(host.textContent).not.toContain('Paid')
    expect(host.querySelector('[data-slot="chip"]')).toBeNull()
  })
})
