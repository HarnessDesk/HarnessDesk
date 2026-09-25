import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { cardEvidence, checkView, ciView, factView, prView } from '../preview/evidence-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { EvidenceChips, ObservedDialog } from './EvidenceChips'

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
  vi.restoreAllMocks()
})

/* One snapshot object: a store that answers every read with a new one never
   settles, now that the chips read the board they belong to. */
const SNAPSHOT = { ...emptySnapshot(), status: 'open' } as AppSnapshot
const store = {
  subscribe: () => () => {},
  getSnapshot: () => SNAPSHOT,
} as unknown as AppStore

const mount = async (node: React.ReactNode): Promise<void> => {
  await act(async () => {
    root.render(<StoreProvider store={store}>{node}</StoreProvider>)
  })
}

it('a card the desk observed nothing about draws nothing', async () => {
  await mount(<EvidenceChips id={1} title="Retry on a 502" card={undefined} />)
  expect(container.innerHTML).toBe('')
  await mount(<EvidenceChips id={1} title="Retry on a 502" card={cardEvidence(1, [])} />)
  expect(container.innerHTML).toBe('')
})

it('every fact whole: what a failed check printed, the forge’s checks, and the pull request, which opens', async () => {
  const opened = vi.spyOn(window, 'open').mockReturnValue(null)
  const card = cardEvidence(1, [
    checkView({ exit: 1, tail: 'FAIL retry.test.ts > retries a 502\n1 failed' }),
    ciView(['passed', 'failed']),
    prView('open'),
  ])
  await mount(<ObservedDialog id={1} title="Retry on a 502" card={card} onClose={() => {}} />)

  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('verify ✗ @a1b2c3d')
  expect(dialog?.textContent).toContain('It exited 1.')
  expect(dialog?.querySelector('pre')?.textContent).toBe('FAIL retry.test.ts > retries a 502\n1 failed')
  expect(dialog?.textContent).toContain('build: passed · lint: failed')
  const open = [...(dialog?.querySelectorAll('button') ?? [])].find(
    (one) => one.textContent === 'Open pull request #12',
  )
  act(() => open?.click())
  expect(opened).toHaveBeenCalledWith(
    'https://example.com/storefront/pull/12',
    '_blank',
    'noopener,noreferrer',
  )
})

it('a check still running is said, and a card with nothing observed yet says what would be', async () => {
  await mount(
    <ObservedDialog
      id={3}
      title="Cover both"
      card={cardEvidence(3, [], [{ name: 'verify', since: 1 }])}
      onClose={() => {}}
    />,
  )
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('verify is running')
  expect(dialog?.textContent).toContain('Nothing observed yet')
  expect(dialog?.textContent).toContain('Nothing an agent says is recorded here.')
})

it("each chip's tone is the one the state map gives its outcome, and stale and unknown are the Chip's own", async () => {
  const card = cardEvidence(
    1,
    [
      checkView(),
      checkView({ name: 'lint', freshness: { state: 'behind', commits: 2 } }),
      ciView(['passed', 'cancelled']),
      prView('merged', { freshness: { state: 'unknown', why: 'its checkout is gone' } }),
    ],
    [{ name: 'e2e', since: 1 }],
  )
  await mount(<EvidenceChips id={1} title="Retry on a 502" card={card} />)
  const chips = [...container.querySelectorAll<HTMLElement>('[data-slot="chip-words"]')].map((words) => {
    const chip = words.parentElement as HTMLElement
    return [words.textContent, chip.dataset['tone'], 'stale' in chip.dataset, 'unknown' in chip.dataset]
  })
  expect(chips).toEqual([
    ['e2e running', 'info', false, false],
    ['verify ✓ @a1b2c3d', 'success', false, false],
    ['lint ✓ @a1b2c3d', 'neutral', true, false],
    ['CI cancelled', 'neutral', false, false],
    ['PR #12 merged', 'neutral', false, true],
  ])
  // The distance a stale fact is behind rides in its title, not on the chip.
  const stale = container.querySelector<HTMLElement>('[data-stale]')
  expect(stale?.getAttribute('title')).toBe('lint ✓ @a1b2c3d — 2 commits since')
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
    'What the desk observed on #1: e2e running, verify ✓ @a1b2c3d, lint ✓ @a1b2c3d — 2 commits since (stale), CI cancelled, PR #12 merged (unknown)',
  )
})

it('draws a zero diff alone only when the caller says the card is finished', async () => {
  const none = factView({ kind: 'diff', files: 0, added: 0, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) })
  await mount(
    <>
      <div data-card="1"><EvidenceChips id={1} title="Finished" card={cardEvidence(1, [none])} finished /></div>
      <div data-card="2"><EvidenceChips id={2} title="Working" card={cardEvidence(2, [none])} finished={false} /></div>
      <div data-card="3"><EvidenceChips id={3} title="Unsaid" card={cardEvidence(3, [none])} /></div>
    </>,
  )
  expect(container.querySelector('[data-card="1"]')?.textContent).toBe('no changes')
  expect(container.querySelector('[data-card="2"]')?.innerHTML).toBe('')
  expect(container.querySelector('[data-card="3"]')?.innerHTML).toBe('')
})
