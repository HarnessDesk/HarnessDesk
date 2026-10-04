import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { approvalId, sessionId, sessionKey, type Approval } from '@harnessdesk/protocol'
import { approvalDoor, type NeedsYouAnswers, type StepDoor } from '../lib/needs-you'
import type { NeedsYouItem, SeatRow } from '../lib/team-overview'
import { TeamOverview } from './TeamOverview'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let box: HTMLDivElement
let root: Root
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) })
afterEach(() => { act(() => root.unmount()); box.remove() })

const KEY = sessionKey('codex', 'beta')
const seat = (id: string, name: string): SeatRow => ({ seat: id, name, role: 'reviewer', card: null, round: null, state: 'needs-you', done: false, reason: null, doing: null, since: null, cost: null })
const options = [
  { id: 'always', label: 'Allow for this session', intent: 'approveAlways' as const },
  { id: 'no', label: 'Deny', intent: 'deny' as const },
  { id: 'yes', label: 'Allow once', intent: 'approve' as const },
]
const command = (id: string, text = 'pnpm verify', patch: Partial<Approval> = {}): Approval =>
  ({ id: approvalId(id), sessionId: sessionId('beta'), requestedAt: 10, type: 'command', command: text, cwd: '/work', actions: [], options, ...patch }) as Approval
const item = (patch: Partial<NeedsYouItem> = {}): NeedsYouItem => ({ kind: 'approval', seat: 'seat-beta', card: null, summary: 'Approve a command', since: 10, approval: approvalId('a1'), sessionKey: KEY, ...patch })
const fake = (approvals: readonly Approval[] = [], over: Partial<NeedsYouAnswers> = {}): NeedsYouAnswers => ({
  stepDoor: () => null,
  approvalDoor: (id, key) => {
    const found = approvals.find((one) => one.id === id)
    return found ? { key, ...approvalDoor(found) } : null
  },
  answerStep: vi.fn().mockResolvedValue(undefined),
  approvalRefusals: () => [],
  respond: vi.fn().mockResolvedValue(undefined),
  openBoard: vi.fn(),
  ...over,
})
const draw = (needsYou: NeedsYouItem[], answers?: NeedsYouAnswers, onOpen = vi.fn()) => {
  act(() => root.render(<TeamOverview model={{ run: null, needsYou, seats: [seat('seat-beta', 'Beta')] }} answers={answers} onOpen={onOpen} />))
  return { onOpen }
}
const rows = () => [...box.querySelectorAll<HTMLElement>('[aria-label="Needs you"] [data-slot="list-row"]')]
const buttonsIn = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>('button')]

it('lets an approval be answered from the Overview with the agent\'s own choices, the plain yes filled', () => {
  const answers = fake([command('a1')])
  draw([item()], answers)
  const [row] = rows()
  expect(row?.textContent).toContain('Beta')
  expect(row?.textContent).toContain('Approve a command')
  expect(buttonsIn(row!).map((one) => one.textContent)).toEqual(['Deny', 'Allow for this session', 'Allow once'])
  expect(buttonsIn(row!).map((one) => one.hasAttribute('data-filled'))).toEqual([false, false, true])
  act(() => buttonsIn(row!)[2]!.click())
  expect(answers.respond).toHaveBeenCalledWith(KEY, 'a1', { type: 'option', optionId: 'yes' }, 'yes')
  act(() => buttonsIn(row!)[0]!.click())
  expect(answers.respond).toHaveBeenLastCalledWith(KEY, 'a1', { type: 'option', optionId: 'no' }, 'no')
})

it('shows what is being approved whole, so a yes is not given blind', () => {
  const long = `pnpm verify && ${'echo checking the retry budget and the last failure '.repeat(8)}&& rm -rf ./tmp`
  draw([item()], fake([command('a1', long, { reason: 'The check needs a clean checkout.' })]))
  const code = box.querySelector('[data-slot="approval-code"]')
  expect(code?.textContent).toBe(long)
  expect(code?.className).not.toContain('truncate')
  expect(box.textContent).toContain('The check needs a clean checkout.')
})

it('shows a refused approval beside its row and disables only that choice', () => {
  const answers = Object.assign(fake([command('a1')]), {
    approvalRefusals: (key: string, id: string) => key === KEY && id === 'a1'
      ? [{ choiceId: 'yes', message: 'This approval was already answered.' }]
      : [],
  })
  draw([item()], answers)
  const row = rows()[0]!
  expect(row.querySelector('[role="alert"]')?.textContent).toBe('This approval was already answered.')
  expect(buttonsIn(row).map(button => button.disabled)).toEqual([false, false, true])
})

it('names the running command and folder that will receive stdin', () => {
  const stdin = command('a1', 'npm login', { kind: 'stdin', input: 'y\n', cwd: '/work/storefront' })
  draw([item()], fake([stdin]))
  const row = rows()[0]!
  expect(row.textContent).toContain('stdin')
  expect(row.textContent).toContain('y\n')
  expect(row.textContent).toContain('To')
  expect(row.textContent).toContain('npm login')
  expect(row.textContent).toContain('/work/storefront')
})

it('names the files a change touches and the folders and hosts an access would open', () => {
  const change = (path: string) => ({ path, kind: { type: 'update' as const, movePath: null }, diff: '' })
  const files = { id: approvalId('a1'), sessionId: sessionId('beta'), requestedAt: 10, type: 'fileChange', changes: [change('src/a.ts'), change('src/b.ts')], options } as Approval
  draw([item({ summary: 'Approve file changes' })], fake([files]))
  expect(rows()[0]?.textContent).toMatch(/Files\s*src\/a\.ts, src\/b\.ts/)
  const access = { id: approvalId('a1'), sessionId: sessionId('beta'), requestedAt: 10, type: 'permission', summary: 'Reach the package registry', filesystem: ['/work/cache'], network: ['registry.example.com'], options } as Approval
  draw([item({ summary: 'Reach the package registry' })], fake([access]))
  expect(rows()[0]?.textContent).toMatch(/Folders\s*\/work\/cache/)
  expect(rows()[0]?.textContent).toMatch(/Network\s*registry\.example\.com/)
})

it('answers each of two approvals asked in the same instant with its own id', () => {
  const answers = fake([command('a1', 'pnpm build'), command('a2', 'pnpm test')])
  draw([item({ approval: approvalId('a1') }), item({ approval: approvalId('a2'), summary: 'Approve a command' })], answers)
  const [first, second] = rows()
  act(() => buttonsIn(second!).at(-1)!.click())
  expect(answers.respond).toHaveBeenLastCalledWith(KEY, 'a2', { type: 'option', optionId: 'yes' }, 'yes')
  act(() => buttonsIn(first!).at(-1)!.click())
  expect(answers.respond).toHaveBeenLastCalledWith(KEY, 'a1', { type: 'option', optionId: 'yes' }, 'yes')
})

it('keys approval rows by their conversation when requests reuse an id', () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    draw([
      item({ seat: 'seat-alpha', approval: approvalId('shared') }),
      item({ seat: 'seat-beta', approval: approvalId('shared'), sessionKey: sessionKey('other', 'beta') }),
    ], fake([command('shared'), command('shared')]))
    expect(report.mock.calls.flat().join(' ')).not.toContain('same key')
  } finally {
    report.mockRestore()
  }
})

it('answers a single question with the option picked, and can cancel it', () => {
  const question = { id: approvalId('q1'), sessionId: sessionId('beta'), requestedAt: 10, type: 'userInput', tool: 'ask', questions: [{ id: 'target', question: 'Which target?', multiSelect: false, options: [{ id: 'web', label: 'Web' }, { id: 'api', label: 'API' }] }] } as Approval
  const answers = fake([question])
  draw([item({ kind: 'question', approval: approvalId('q1'), summary: 'Which target?' })], answers)
  const [row] = rows()
  expect(buttonsIn(row!).map((one) => one.textContent)).toEqual(['Web', 'API', 'Cancel'])
  act(() => buttonsIn(row!)[1]!.click())
  expect(answers.respond).toHaveBeenCalledWith(KEY, 'q1', { type: 'answers', answers: { target: ['api'] } }, 'answer-api')
  act(() => buttonsIn(row!)[2]!.click())
  expect(answers.respond).toHaveBeenLastCalledWith(KEY, 'q1', { type: 'cancel' }, 'cancel')
})

it('leaves a question that needs a form to its conversation', () => {
  const form = { id: approvalId('q1'), sessionId: sessionId('beta'), requestedAt: 10, type: 'userInput', tool: 'ask', questions: [{ id: 'a', question: 'Which?', multiSelect: true, options: [{ id: 'x', label: 'X' }] }] } as Approval
  const answers = fake([form])
  const { onOpen } = draw([item({ kind: 'question', approval: approvalId('q1'), summary: 'Which?' })], answers)
  const [row] = rows()
  expect(buttonsIn(row!).map((one) => one.textContent)).toEqual(['Cancel', 'Answer in the conversation'])
  act(() => buttonsIn(row!)[1]!.click())
  expect(onOpen).toHaveBeenCalledWith('seat-beta')
  expect(answers.respond).not.toHaveBeenCalled()
})

it('answers a person\'s card with the step\'s own controls, through the same request as the board', async () => {
  const door: StepDoor = { kind: 'answer', card: 7, answers: [{ outcome: 'approved', effect: 'Approved finishes the Run.' }] }
  const answers = fake([], { stepDoor: (card) => card === 7 ? door : null })
  draw([{ kind: 'card', seat: null, card: 7, summary: 'Review the change', since: 5 }], answers)
  const [row] = rows()
  expect(row?.textContent).toContain('#7')
  expect(row?.textContent).toContain('Review the change')
  expect(row?.textContent).toContain('Approved finishes the Run.')
  await act(async () => buttonsIn(row!).find((one) => one.textContent === 'Approved')!.click())
  expect(answers.answerStep).toHaveBeenCalledWith(7, 'approved', '')
})

it('sends a review step to the board', () => {
  const answers = fake([], { stepDoor: () => ({ kind: 'review', card: 7 }) })
  draw([{ kind: 'card', seat: null, card: 7, summary: 'Pick the best attempt', since: 5 }], answers)
  act(() => buttonsIn(rows()[0]!)[0]!.click())
  expect(answers.openBoard).toHaveBeenCalledTimes(1)
})

it('draws the same rows with no controls when nothing can answer them, or the door is gone', () => {
  const rowsOf = (answers?: NeedsYouAnswers) => { draw([item()], answers); return rows().map((one) => one.textContent) }
  const without = rowsOf()
  expect(buttonsIn(rows()[0]!)).toHaveLength(0)
  expect(rowsOf(fake([]))).toEqual(without)
  // An answered request leaves its row with it; one the door does not know keeps its sentence and no button.
  expect(without[0]).toContain('Approve a command')
})

it('draws an agent\'s words as text, with terminal escapes dropped', () => {
  draw([item({ summary: 'Approve a command' })], fake([command('a1', '<img src=x onerror="alert(1)">\u001b[31m echo hi\u001b[0m', { reason: '<b>why</b>' })]))
  expect(box.querySelector('[aria-label="Needs you"] img, [aria-label="Needs you"] b')).toBeNull()
  expect(box.querySelector('[data-slot="approval-code"]')?.textContent).toBe('<img src=x onerror="alert(1)"> echo hi')
})

it('keeps the attention sentence whole in its own slot beside the controls', () => {
  const summary = 'Choose whether the checkout retry should keep the original payment method before this review can continue.'
  draw([item({ kind: 'question', summary })], fake([]))
  const sentence = box.querySelector('[aria-label="Needs you"] [data-slot="list-row-subtitle"]')
  expect(sentence?.textContent).toBe(summary)
  expect(sentence?.hasAttribute('data-wrap-subtitle')).toBe(true)
})

it('keeps the note being written when another request arrives above the step', () => {
  const door: StepDoor = { kind: 'answer', card: 7, answers: [{ outcome: 'approved', effect: null }] }
  const answers = fake([command('a1')], { stepDoor: () => door })
  const step: NeedsYouItem = { kind: 'card', seat: null, card: 7, summary: 'Review the change', since: 50 }
  draw([step], answers)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const note = () => box.querySelector<HTMLInputElement>('[aria-label="Needs you"] input[aria-label="Note"]')!
  act(() => { setter.call(note(), 'Not before the retry has a ceiling.'); note().dispatchEvent(new Event('input', { bubbles: true })) })
  // An older request sorts above it, moving the step down a place.
  draw([item({ since: 10 }), step], answers)
  expect(rows()).toHaveLength(2)
  expect(note().value).toBe('Not before the retry has a ceiling.')
})
