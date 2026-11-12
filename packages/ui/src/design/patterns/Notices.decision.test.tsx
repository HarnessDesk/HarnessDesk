import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DecisionNotice } from './Notices'

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

const CHOICES = [
  { id: 'wait', label: 'Wait until reset' },
  { id: 'switch', label: 'Switch to Alpha · personal', primary: true },
  { id: 'stop', label: 'Stop' },
]

const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('[data-slot="decision-choices"] button')]

it('offers each answer, the recommended one first and solid, and a box that makes the answer the rule', async () => {
  const onChoose = vi.fn()
  await act(async () => root.render(
    <DecisionNotice message="Alpha · work reached its usage limit." detail="Resets at 4:30 PM" choices={CHOICES} always={{ label: 'Always do this' }} onChoose={onChoose} />,
  ))
  const notice = container.querySelector('[data-slot="decision-notice"]')!
  // Not an overlay: the conversation under it stays usable.
  expect(notice.getAttribute('role')).toBe('group')
  expect(container.querySelector('[role="dialog"],[aria-modal]')).toBeNull()
  expect(notice.textContent).toContain('Alpha · work reached its usage limit. Resets at 4:30 PM')
  expect(buttons().map(button => button.textContent)).toEqual(['Switch to Alpha · personal', 'Wait until reset', 'Stop'])

  await act(async () => buttons()[2]!.click())
  expect(onChoose).toHaveBeenLastCalledWith('stop', false)

  const box = container.querySelector<HTMLElement>('[data-slot="checkbox"]')!
  expect(box.closest('label')?.textContent).toBe('Always do this')
  await act(async () => box.click())
  await act(async () => buttons()[0]!.click())
  expect(onChoose).toHaveBeenLastCalledWith('switch', true)
})

it('says why an answer cannot be taken on hover and to a screen reader, without a line of its own', async () => {
  const onChoose = vi.fn()
  await act(async () => root.render(
    <DecisionNotice message="Alpha reached its usage limit." detail="No reset time known"
      choices={[CHOICES[1]!, { id: 'wait', label: 'Wait until reset', disabled: true, hint: 'No reset time' }, CHOICES[2]!]} onChoose={onChoose} />,
  ))
  const wait = buttons().find(button => button.textContent === 'Wait until reset')!
  expect(wait.disabled).toBe(true)
  expect(wait.title).toBe('No reset time')
  const described = document.getElementById(wait.getAttribute('aria-describedby')!)
  expect(described?.textContent).toBe('No reset time')
  expect(described?.className).toContain('sr-only')
  expect(container.querySelector('[data-slot="checkbox"]')).toBeNull()
})

it('lists the other places behind its link, each with one chip, and answers with the box as it stands', async () => {
  const onPick = vi.fn()
  await act(async () => root.render(
    <DecisionNotice message="Alpha · work reached its usage limit." choices={CHOICES} always={{ label: 'Always do this' }} onChoose={() => {}}
      alternatives={{ label: 'Other account…', items: [{ id: 'beta', name: 'Beta', chip: 'Nearly out' }], onPick }} />,
  ))
  const link = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Other account…')!
  expect(link.getAttribute('aria-haspopup')).toBe('menu')
  await act(async () => link.click())
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Beta'))!
  expect(row.textContent).toContain('Nearly out')
  await act(async () => row.click())
  expect(onPick).toHaveBeenCalledWith('beta', false)
})

it('holds every control while an answer is on its way', async () => {
  await act(async () => root.render(
    <DecisionNotice message="Alpha reached its usage limit." choices={CHOICES} always={{ label: 'Always do this' }} busy onChoose={() => {}} />,
  ))
  expect(buttons().every(button => button.disabled)).toBe(true)
  expect(container.querySelector('[data-slot="decision-notice"]')!.getAttribute('aria-busy')).toBe('true')
})
