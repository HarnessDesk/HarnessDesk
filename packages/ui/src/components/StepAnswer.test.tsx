import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StepDoor } from '../lib/needs-you'
import { StepAnswer } from './StepAnswer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let box: HTMLDivElement
let root: Root
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) })
afterEach(() => { act(() => root.unmount()); box.remove() })

const door: StepDoor = { kind: 'answer', card: 7, answers: [
  { outcome: 'approved', effect: 'Approved opens the verify check.' },
  { outcome: 'request-changes', effect: 'Request changes opens a fixer round.' },
] }
const draw = (door_: StepDoor, onAnswer = vi.fn().mockResolvedValue(undefined), onOpenBoard = vi.fn()) => {
  act(() => root.render(<StepAnswer door={door_} onAnswer={onAnswer} onOpenBoard={onOpenBoard} />))
  return { onAnswer, onOpenBoard }
}
const buttons = () => [...box.querySelectorAll<HTMLButtonElement>('[role="group"] button')]
const button = (label: string) => buttons().find((one) => one.textContent === label)!
const note = () => box.querySelector<HTMLInputElement>('input')!
const typeNote = (text: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no value setter — typing would be a no-op')
  act(() => { setter.call(note(), text); note().dispatchEvent(new Event('input', { bubbles: true })) })
}

it('offers each word the role declares and says what each will do, before any is given', () => {
  draw(door)
  expect(buttons().map((one) => one.textContent)).toEqual(['Approved', 'Request changes'])
  expect(box.querySelector('[data-slot="step-effect"]')?.textContent)
    .toBe('Approved opens the verify check. Request changes opens a fixer round.')
  expect(buttons().map((one) => one.title)).toEqual(['Approved opens the verify check.', 'Request changes opens a fixer round.'])
  expect(box.querySelector('[role="group"]')?.getAttribute('aria-describedby')).toBe(box.querySelector('[data-slot="step-effect"]')?.id)
})

it('answers with the word picked, and no note unless one was written', async () => {
  const { onAnswer } = draw(door)
  await act(async () => button('Request changes').click())
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(onAnswer).toHaveBeenCalledWith(7, 'request-changes', '')
})

it('sends the note the person wrote, trimmed, with the answer', async () => {
  const { onAnswer } = draw(door)
  typeNote('  Ship it once the retry has a ceiling.  ')
  await act(async () => button('Approved').click())
  expect(onAnswer).toHaveBeenCalledWith(7, 'approved', 'Ship it once the retry has a ceiling.')
})

it('holds every button while the answer is on its way', async () => {
  let release!: () => void
  const onAnswer = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
  draw(door, onAnswer)
  await act(async () => button('Approved').click())
  expect(buttons().map((one) => one.disabled)).toEqual([true, true])
  expect(note().disabled).toBe(true)
  await act(async () => release())
  expect(buttons().map((one) => one.disabled)).toEqual([false, false])
})

it('keeps the host\'s refusal on screen and disables the answer it refused, leaving the others', async () => {
  const onAnswer = vi.fn().mockRejectedValueOnce(new Error('Refused: "approved" is not an answer this step accepts.')).mockResolvedValue(undefined)
  draw(door, onAnswer)
  await act(async () => button('Approved').click())
  expect(box.querySelector('[role="alert"]')?.textContent).toBe('Refused: "approved" is not an answer this step accepts.')
  expect(buttons().map((one) => one.disabled)).toEqual([true, false])
  // Answering another way clears it.
  await act(async () => button('Request changes').click())
  expect(box.querySelector('[role="alert"]')).toBeNull()
})

it('says the card is as it was when the host gives no reason', async () => {
  draw(door, vi.fn().mockRejectedValue(new Error('')))
  await act(async () => button('Approved').click())
  expect(box.querySelector('[role="alert"]')?.textContent).toBe('The host did not take that answer on #7; the card is as it was.')
})

it('lets a step that declares no words be marked done, as the board does', async () => {
  const { onAnswer } = draw({ kind: 'answer', card: 7, answers: [{ outcome: null, effect: 'Marking it done ends the Run without a next step.' }] })
  expect(buttons().map((one) => one.textContent)).toEqual(['Mark done'])
  await act(async () => button('Mark done').click())
  expect(onAnswer).toHaveBeenCalledWith(7, null, '')
})

it('says nothing about what an answer does when the Flow cannot be read that way', () => {
  draw({ kind: 'answer', card: 7, answers: [{ outcome: 'approved', effect: null }] })
  expect(box.querySelector('[data-slot="step-effect"]')).toBeNull()
  expect(box.querySelector('[role="group"]')?.hasAttribute('aria-describedby')).toBe(false)
  expect(buttons()[0]?.hasAttribute('title')).toBe(false)
})

it('sends a review step to the board, where its attempt is chosen, and offers no word to answer with', async () => {
  const { onAnswer, onOpenBoard } = draw({ kind: 'review', card: 7 })
  expect(box.querySelector('input')).toBeNull()
  expect(box.textContent).toBe('Pick an attempt on the board')
  await act(async () => box.querySelector('button')!.click())
  expect(onOpenBoard).toHaveBeenCalledTimes(1)
  expect(onAnswer).not.toHaveBeenCalled()
})

it('renders the Flow\'s words as text, never markup, and drops terminal escapes from them', () => {
  draw({ kind: 'answer', card: 7, answers: [{ outcome: '<img src=x onerror="alert(1)">\x1b[31m', effect: '<b>opens</b>\x1b[31m a <script>x()</script> round.\x1b[0m' }] })
  expect(box.querySelector('img, b, script')).toBeNull()
  expect(buttons()[0]?.textContent).toBe('<img src=x onerror="alert(1)">')
  expect(buttons()[0]?.title).toBe('<b>opens</b> a <script>x()</script> round.')
  expect(box.querySelector('[data-slot="step-effect"]')?.textContent).toBe('<b>opens</b> a <script>x()</script> round.')
})
