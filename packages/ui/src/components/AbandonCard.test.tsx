import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FlowExecution, FlowPolicyRule, Intent } from '@harnessdesk/protocol'
import { AbandonCard } from './AbandonCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let box: HTMLDivElement
let root: Root
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) })
afterEach(() => { act(() => root.unmount()); box.remove() })

const rule = (id: string, on: string, then: string, when?: FlowPolicyRule['when']): FlowPolicyRule => ({ id, on, ...(when ? { when } : {}), then: { role: then, title: 'Next' } })
const run = (rules: readonly FlowPolicyRule[]): FlowExecution => ({
  version: 2, id: 'run-1', goal: 'team-1', state: 'running', reason: null, legacyRun: null, operations: [],
  rounds: [{ n: 4, role: 'fixer', cards: [5], seats: [], evidence: [], state: 'running', cause: 'review-loop' }],
  document: { format: 'agents', flow: {
    version: 2, name: 'Build and review', inputs: [], messaging: 'board-only', wait: 240, seed: { role: 'fixer', title: 'Go' }, rules,
    roles: [
      { id: 'fixer', kind: 'agent', uses: ['fixer'], seats: [], isolate: false, grant: 'edit', independentOf: [] },
      { id: 'reviewer', kind: 'agent', uses: ['reviewer'], seats: [], isolate: false, grant: 'read', independentOf: [] },
    ],
  } },
})
const card = (patch: Partial<Intent> = {}): Intent => ({ id: 5, title: 'Answer round 3\'s review', state: 'open', files: [], dependsOn: [], createdAt: 1, updatedAt: 2, role: 'fixer', ...patch })
const draw = (props: Partial<Parameters<typeof AbandonCard>[0]> = {}, onAbandon = vi.fn().mockResolvedValue(undefined)) => {
  const execution = props.execution ?? run([rule('review', 'fixer', 'reviewer')])
  act(() => root.render(<AbandonCard execution={execution} cards={[props.card ?? card()]} card={card()} onAbandon={onAbandon} {...props} />))
  return { onAbandon }
}
const door = () => [...box.querySelectorAll('button')].find((one) => one.textContent === 'Abandon card…')
const dialog = () => document.body.querySelector('[role="alertdialog"]')
const inDialog = (label: string) => [...document.body.querySelectorAll('[role="alertdialog"] button')].find((one) => one.textContent === label) as HTMLButtonElement
const open = () => act(() => door()!.click())
const settle = () => act(async () => {})

it('offers abandoning a card that has not finished, and nothing for one that has', () => {
  draw()
  expect(door()).toBeDefined()
  draw({ card: card({ state: 'done' }) })
  expect(door()).toBeUndefined()
  draw({ card: card({ state: 'abandoned' }) })
  expect(door()).toBeUndefined()
})

it('opens a question that says first what the rule after the card\'s role will do', () => {
  draw()
  expect(dialog()).toBeNull()
  open()
  expect(dialog()?.textContent).toContain('Abandon card #5?')
  const body = document.body.querySelector('[data-slot="confirm-body"]')!
  expect(body.querySelector('p')?.textContent).toBe('The rule that follows the fixer role still fires, so abandoning this card opens a reviewer round.')
  expect([inDialog('Abandon card'), inDialog('Keep it')].every(Boolean)).toBe(true)
})

it('says the Run ends, rather than that a rule fires, when no rule accepts the card', () => {
  draw({ execution: run([rule('ship', 'fixer', 'reviewer', { every: ['published'] })]) })
  open()
  expect(document.body.querySelector('[data-slot="confirm-body"] p')?.textContent)
    .toBe('No rule that follows the fixer role accepts a card with no answer, so abandoning this card ends the Run without a next step.')
})

it('keeps the card when the person keeps it, and calls nothing', () => {
  const { onAbandon } = draw()
  open()
  act(() => inDialog('Keep it').click())
  expect(dialog()).toBeNull()
  expect(onAbandon).not.toHaveBeenCalled()
})

it('abandons the card, holds the question while it is on its way, and closes once the host has taken it', async () => {
  let release!: () => void
  const onAbandon = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
  draw({}, onAbandon)
  open()
  await act(async () => inDialog('Abandon card').click())
  expect(onAbandon).toHaveBeenCalledWith(5)
  expect(inDialog('Abandoning…').disabled).toBe(true)
  expect(inDialog('Keep it').disabled).toBe(true)
  await act(async () => release())
  expect(dialog()).toBeNull()
})

it('keeps the host\'s refusal on screen, with the act disabled, and lets the person keep the card', async () => {
  draw({}, vi.fn().mockRejectedValue(new Error('The board is being saved. Try again when it is ready.')))
  open()
  await act(async () => inDialog('Abandon card').click())
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('The board is being saved. Try again when it is ready.')
  expect(inDialog('Abandon card').disabled).toBe(true)
  act(() => inDialog('Keep it').click())
  expect(dialog()).toBeNull()
  // Asked again, it starts fresh.
  open()
  expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
  expect(inDialog('Abandon card').disabled).toBe(false)
})

it('says the card is as it was when the host gives no reason', async () => {
  draw({}, vi.fn().mockRejectedValue(new Error('')))
  open()
  await act(async () => inDialog('Abandon card').click())
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('The host did not abandon #5; the card is as it was.')
})

it('names the Seat that holds a claimed card, after the rule', () => {
  draw({ card: card({ state: 'claimed' }), holder: 'Alpha' })
  open()
  const paragraphs = [...document.body.querySelectorAll('[data-slot="confirm-body"] p')].map((one) => one.textContent)
  expect(paragraphs[0]).toContain('The rule that follows the fixer role still fires')
  expect(paragraphs[1]).toBe('Alpha holds this card now. Abandoning takes it back, and Alpha cannot finish it.')
  expect(paragraphs).toHaveLength(2)
  // An open card has no holder to name.
  draw({ card: card({ state: 'open' }), holder: 'Alpha' })
  expect(document.body.querySelectorAll('[data-slot="confirm-body"] p')).toHaveLength(1)
})

it('says a Seat holds a claimed card when it cannot name which', () => {
  draw({ card: card({ state: 'claimed' }), holder: null })
  open()
  expect([...document.body.querySelectorAll('[data-slot="confirm-body"] p')][1]?.textContent)
    .toBe('A Seat holds this card now. Abandoning takes it back, and it cannot finish it.')
})

it('draws the Flow\'s and the Seat\'s words as text, with terminal escapes dropped', () => {
  const execution = run([rule('review', 'fixer', '<img src=x onerror="alert(1)">\u001b[31m')])
  draw({ execution, card: card({ state: 'claimed' }), holder: '<b>Alpha</b>\u001b[0m' })
  open()
  const body = document.body.querySelector('[data-slot="confirm-body"]')!
  expect(body.querySelector('img, b')).toBeNull()
  expect(body.textContent).toContain('opens a <img src=x onerror="alert(1)"> round.')
  expect(body.textContent).toContain('<b>Alpha</b> holds this card now.')
  expect(body.textContent).not.toContain('\u001b')
})

it('replaces the stale question with the host explanation for a structured missing card', async () => {
  const message = 'This card was removed from the board.'
  const onAbandon = vi.fn().mockRejectedValue(Object.assign(new Error(message), { code: 'cardMissing' }))
  draw({ card: card({ state: 'claimed' }), holder: 'Alpha' }, onAbandon)
  open()
  await act(async () => inDialog('Abandon card').click())
  expect(document.body.textContent).toContain(message)
  expect(document.body.textContent).not.toContain('holds this card now')
  expect(document.body.textContent).not.toContain('opens a reviewer round')
  expect(document.body.textContent).not.toContain('Keep it')
  expect(door()).toBeUndefined()
  expect([...document.body.querySelectorAll('button')].some(one => one.textContent === 'Abandon card')).toBe(false)
  act(() => [...document.body.querySelectorAll('button')].find(one => one.textContent === 'Close')!.click())
  expect(document.body.textContent).toContain(message)
  expect(door()).toBeUndefined()
  expect(onAbandon).toHaveBeenCalledTimes(1)
})
