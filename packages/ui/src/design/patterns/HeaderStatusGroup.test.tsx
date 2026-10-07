import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HeaderStatusGroup, HeaderStatusReading } from './HeaderStatusGroup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

it('names all readings in one card, including readings whose words fold away', () => {
  act(() => root.render(
    <HeaderStatusGroup open>
      <HeaderStatusReading label="Status" detail="Running"><span>●</span></HeaderStatusReading>
      <HeaderStatusReading label="Plan usage" detail="Agent A — Weekly, 78% left"><span>78%</span></HeaderStatusReading>
      <HeaderStatusReading label="Other agents" detail="1 other agent — 1 out of quota"><span>1 out</span></HeaderStatusReading>
    </HeaderStatusGroup>,
  ))
  const group = container.querySelector('[role="group"]')!
  expect(group.getAttribute('aria-label')).toBe('Conversation status')
  expect(group.querySelector('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('neutral')
  const cards = document.querySelectorAll('[data-slot="hover-card-content"]')
  expect(cards).toHaveLength(1)
  expect(cards[0]?.textContent).toContain('StatusRunning')
  expect(cards[0]?.textContent).toContain('Plan usageAgent A — Weekly, 78% left')
  expect(cards[0]?.textContent).toContain('Other agents1 other agent — 1 out of quota')
})

it('updates facts and removes ended readings without moving the remaining ones', () => {
  const render = (status: string, tasks: boolean) => act(() => root.render(
    <HeaderStatusGroup open>
      <HeaderStatusReading label="Status" detail={status}>●</HeaderStatusReading>
      {tasks && <HeaderStatusReading label="Background tasks" detail="1 running">1</HeaderStatusReading>}
      <HeaderStatusReading label="Branch" detail="main">main</HeaderStatusReading>
    </HeaderStatusGroup>,
  ))
  render('Running', true)
  render('Idle', false)
  const card = document.querySelector('[data-slot="hover-card-content"]')!
  expect(card.textContent).toBe('Conversation statusStatusIdleBranchmain')
})

it('opens from keyboard focus and keeps each reading action reachable', () => {
  const select = vi.fn()
  act(() => root.render(
    <HeaderStatusGroup>
      <HeaderStatusReading label="Branch" detail="main"><button onClick={select}>main</button></HeaderStatusReading>
    </HeaderStatusGroup>,
  ))
  act(() => container.querySelector<HTMLElement>('[role="group"]')!.focus())
  expect(document.querySelector('[data-slot="hover-card-content"]')?.textContent).toContain('Branchmain')
  act(() => container.querySelector('button')!.click())
  expect(select).toHaveBeenCalledOnce()
})

it('draws no empty chip when a draft has no readings', () => {
  act(() => root.render(<HeaderStatusGroup><HeaderStatusReading label="Branch" detail="main">main</HeaderStatusReading></HeaderStatusGroup>))
  act(() => root.render(<HeaderStatusGroup>{null}</HeaderStatusGroup>))
  expect(container.querySelector('[role="group"]')?.hasAttribute('hidden')).toBe(true)
})

it('keeps focus returned after a pointer action quiet', () => {
  act(() => root.render(<HeaderStatusGroup><HeaderStatusReading label="Branch" detail="main"><button>main</button></HeaderStatusReading></HeaderStatusGroup>))
  const button = container.querySelector('button')!
  const matches = button.matches.bind(button)
  vi.spyOn(button, 'matches').mockImplementation((selector) => selector === ':focus-visible' ? false : matches(selector))
  act(() => button.focus())
  expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()
})

it('orders late-mounted and moved readings by their chips', () => {
  const render = (labels: string[]) => act(() => root.render(
    <HeaderStatusGroup open>{labels.map((label) => <HeaderStatusReading key={label} label={label} detail={label}>{label}</HeaderStatusReading>)}</HeaderStatusGroup>,
  ))
  const labels = () => [...document.querySelectorAll('[data-slot="hover-card-content"] dt')].map((node) => node.textContent)
  render(['Status', 'Branch'])
  render(['Status', 'Background tasks', 'Branch'])
  expect(labels()).toEqual(['Status', 'Background tasks', 'Branch'])
  render(['Branch', 'Status', 'Background tasks'])
  expect(labels()).toEqual(['Branch', 'Status', 'Background tasks'])
})
