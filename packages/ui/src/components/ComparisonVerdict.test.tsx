import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { comparisonVerdictOf } from '../lib/comparison-verdict'
import { runTimeline } from '../lib/run-timeline'
import { shapeFixture } from '../preview/run-shapes-fixture'
import { ComparisonVerdict } from './ComparisonVerdict'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let box: HTMLDivElement
let root: Root
const picked = () => {
  const input = shapeFixture('comparison')
  return comparisonVerdictOf(runTimeline(input), input.execution, input.cards)
}
afterEach(() => { if (root) act(() => root.unmount()); box?.remove() })
const mount = () => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) }
const names = (seat: string | null) => seat === 'seat-5' ? 'Gamma' : seat === 'seat-1' ? 'Alpha' : 'Beta'
it('names the judge and picked attempt, gives the recorded reason and opens the next Run step', () => {
  mount()
  const onOpen = vi.fn()
  act(() => root.render(<ComparisonVerdict verdict={picked()} nameOfSeat={names} onOpenRun={onOpen} onPick={vi.fn()} />))
  expect(box.textContent).toContain('Gamma picked Attempt A')
  expect(box.textContent).toContain('Attempt A preserves the ordering and passes the checks.')
  const action = [...box.querySelectorAll('button')].find(one => one.textContent === 'Merge the picked change')!
  act(() => action.click())
  expect(onOpen).toHaveBeenCalledWith('person-4-6')
})
it('stays dismissed on a refresh and returns for a new verdict', () => {
  mount()
  const verdict = picked()!
  const draw = (id: string) => root.render(<ComparisonVerdict verdict={{ ...verdict, id }} nameOfSeat={names} onOpenRun={vi.fn()} onPick={vi.fn()} />)
  act(() => draw(verdict.id))
  act(() => box.querySelector<HTMLButtonElement>('button[aria-label="Dismiss verdict"]')!.click())
  expect(box.querySelector('[data-slot="comparison-notice"]')).toBeNull()
  act(() => draw(verdict.id))
  expect(box.querySelector('[data-slot="comparison-notice"]')).toBeNull()
  act(() => draw('new-pick'))
  expect(box.querySelector('[data-slot="comparison-notice"]')).not.toBeNull()
  act(() => draw(verdict.id))
  expect(box.querySelector('[data-slot="comparison-notice"]')).not.toBeNull()
})
it('reserves the same shelf before a pick without exposing a verdict or controls', () => {
  mount()
  act(() => root.render(<ComparisonVerdict verdict={null} nameOfSeat={names} onOpenRun={vi.fn()} onPick={vi.fn()} />))
  expect(box.querySelector('[data-slot="comparison-notice-slot"]')).not.toBeNull()
  expect(box.querySelector('[data-slot="comparison-notice"]')).toBeNull()
  expect(box.querySelector('button')).toBeNull()
  expect(box.textContent).toBe('')
})
it('keeps the recorded verdict without a Merge action when no person step needs an answer', () => {
  mount()
  const verdict = picked()!
  if (verdict.kind !== 'picked') throw new Error('No recorded pick')
  act(() => root.render(<ComparisonVerdict verdict={{ ...verdict, next: null }} nameOfSeat={names} onOpenRun={vi.fn()} onPick={vi.fn()} />))
  expect(box.textContent).toContain('Gamma picked Attempt A')
  expect([...box.querySelectorAll('button')].some(one => one.textContent === 'Merge the picked change')).toBe(false)
})
