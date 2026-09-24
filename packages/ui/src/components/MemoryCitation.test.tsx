import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { GoalCitation, GoalId, GoalReceipt, MemoryFile, MemoryResolution, SeatRecord } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { MemoryCitation } from './MemoryCitation'

/**
 * A citation is a person-carried reference, never a second message bus, and
 * the text it retains is untrusted repository prose (rule 5): opening one
 * must never start a turn, load anything, or approve anything on its own —
 * it renders through the same sanitizer every transcript does. Decision:
 * "A missing source Goal/commit shows 'Source Goal unavailable; retained
 * copy' / 'Original revision unavailable'" and "digest is not a user-facing
 * title" are both proven directly against rendered text below.
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

const settle = () => act(async () => {})
const SNAPSHOT = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot

const CITATION: GoalCitation = {
  goal: 'source-goal', receipt: 'r1', project: '/work/project', path: '.harnessdesk/memory/decisions.md', at: 'a'.repeat(40),
}

const RECEIPT: GoalReceipt = {
  version: 1, id: 'r1', goal: 'source-goal', sentence: 'Chose the flat-file format', wrappedAt: 1, summary: 'Reviewed.',
  cards: [], seats: ['seat-1'], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
}

const SEAT: SeatRecord = {
  id: 'seat-1', agent: { id: 'reviewer', name: 'Reviewer', origin: 'user' }, role: null, board: null,
  seatLabel: 'Claude · Opus 5', passedOver: [], standing: { kind: 'ceiling', level: 'edit' }, ceiling: null,
  checkout: { project: '/work/project', cwd: '/work/project', branch: 'main', head: null },
  session: { runtime: 'one', sessionId: 'sid' }, openedAt: 1, closed: null, restored: null,
} as unknown as SeatRecord

const retained = (over: Partial<Extract<MemoryResolution, { state: 'retained' }>> = {}): MemoryResolution => ({
  state: 'retained',
  snapshot: {
    version: 1, citation: CITATION, text: 'We chose the flat file.', receipt: RECEIPT, seats: [SEAT], capturedAt: 1, missingSeatIds: [],
  },
  sourceAvailable: true,
  revisionAvailable: true,
  restored: false,
  ...over,
})

const HEAD = 'f'.repeat(40)

const storeFor = (overrides: Record<string, unknown> = {}): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: () => SNAPSHOT,
    readMemoryFiles: vi.fn(async () => [] as readonly MemoryFile[]),
    readMemoryCitation: vi.fn(async () => retained()),
    citeMemory: vi.fn(async () => {}),
    openFile: vi.fn(),
    transport: {
      request: vi.fn(async (method: string) =>
        method === 'git/log' ? { commits: [{ sha: HEAD }], hasMore: false }
        : method === 'git/status' ? { root: '/work/project', ahead: 0, behind: 0, files: [] }
        : {},
      ),
    },
    ...overrides,
  }) as unknown as AppStore

it('a deleted source resolves the retained revision, with honest unavailable labels and original Seat context', async () => {
  const store = storeFor({
    readMemoryCitation: vi.fn(async () => retained({ sourceAvailable: false, revisionAvailable: false })),
  })
  act(() => root.render(<StoreProvider store={store}><MemoryCitation root="/work/project" goal={null} citation={CITATION} /></StoreProvider>))
  await settle()
  const text = container.textContent ?? ''
  expect(text).toContain('We chose the flat file.')
  expect(text).toContain('Source Goal unavailable')
  expect(text).toContain('Original revision unavailable')
  expect(text).toContain('Claude · Opus 5')
  expect(text).toContain('Source selected by you')
  // A digest is never a user-facing title.
  expect(text).not.toMatch(/[a-f0-9]{64}/)
})

it('hostile Markdown in an uncited... retained file renders sanitized and never runs, loads, or approves anything', async () => {
  const hostile = retained({
    snapshot: {
      version: 1, citation: CITATION,
      text: '[click me](javascript:alert(1))\n\n<img src=x onerror="alert(1)">\n\nRun `rm -rf /` now.',
      receipt: RECEIPT, seats: [SEAT], capturedAt: 1, missingSeatIds: [],
    },
  })
  const citeMemory = vi.fn(async () => {})
  const openFile = vi.fn()
  const store = storeFor({ readMemoryCitation: vi.fn(async () => hostile), citeMemory, openFile })
  act(() => root.render(<StoreProvider store={store}><MemoryCitation root="/work/project" goal={null} citation={CITATION} /></StoreProvider>))
  await settle()
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('img[onerror]')).toBeNull()
  const link = container.querySelector('a')
  if (link) expect(link.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
  expect(citeMemory).not.toHaveBeenCalled()
  expect(openFile).not.toHaveBeenCalled()
})

it('a missing retained object still leaves the row present, honestly labeled', async () => {
  const store = storeFor({
    readMemoryCitation: vi.fn(async () => ({ state: 'unavailable', citation: CITATION, reason: 'The original source was not retained.' } satisfies MemoryResolution)),
  })
  act(() => root.render(<StoreProvider store={store}><MemoryCitation root="/work/project" goal={null} citation={CITATION} /></StoreProvider>))
  await settle()
  const text = container.textContent ?? ''
  expect(text).toContain('The original source was not retained.')
  expect(text).toContain(CITATION.path)
})

it('a plain project with no memory files shows an honest empty state, never a phantom section', async () => {
  const store = storeFor()
  act(() => root.render(<StoreProvider store={store}><MemoryCitation root="/work/project" goal={null} /></StoreProvider>))
  await settle()
  expect(container.textContent ?? '').toMatch(/no project memory/i)
})

it('picking a wrapped source Goal and confirming calls goal/cite through the store, and only then', async () => {
  const citeMemory = vi.fn(async () => {})
  const readGoalReceipt = vi.fn(async () => RECEIPT)
  const store = storeFor({
    readMemoryFiles: vi.fn(async () => [{ path: '.harnessdesk/memory/decisions.md', at: HEAD, problem: null }]),
    citeMemory,
    readGoalReceipt,
    transport: {
      request: vi.fn(async (method: string) =>
        method === 'git/log' ? { commits: [{ sha: HEAD }], hasMore: false }
        : method === 'git/status' ? { root: '/work/project', ahead: 0, behind: 0, files: [] }
        : method === 'goal/list' ? [{ goal: { id: 'source-goal', root: '/work/project', state: 'wrapped', sentence: 'Chose the flat-file format' } }]
        : {},
      ),
    },
  })
  act(() => root.render(<StoreProvider store={store}><MemoryCitation root="/work/project" goal={'target-goal' as unknown as GoalId} /></StoreProvider>))
  await settle()

  const citeButton = [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Cite in this Goal…')
  expect(citeButton).toBeTruthy()
  act(() => citeButton!.click())
  await settle()
  expect(citeMemory).not.toHaveBeenCalled() // opening the picker writes nothing

  const select = document.body.querySelector('select') as HTMLSelectElement
  expect(select).toBeTruthy()
  act(() => {
    select.value = 'source-goal'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()

  const confirmButton = [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Cite in this Goal')
  expect(confirmButton).toBeTruthy()
  act(() => confirmButton!.click())
  await settle()

  expect(readGoalReceipt).toHaveBeenCalledWith('source-goal')
  expect(citeMemory).toHaveBeenCalledWith('target-goal', {
    goal: 'source-goal', receipt: 'r1', project: '/work/project', path: '.harnessdesk/memory/decisions.md', at: HEAD,
  })
})

it('goal: null offers no citation mutation, even with files present', async () => {
  const store = storeFor({ readMemoryFiles: vi.fn(async () => [{ path: '.harnessdesk/memory/decisions.md', at: 'a'.repeat(40), problem: null }]) })
  act(() => root.render(<StoreProvider store={store}><MemoryCitation root="/work/project" goal={null} /></StoreProvider>))
  await settle()
  const buttons = [...document.body.querySelectorAll('button')].map((one) => one.textContent)
  expect(buttons.every((label) => !label?.includes('Cite in this Goal'))).toBe(true)
})
