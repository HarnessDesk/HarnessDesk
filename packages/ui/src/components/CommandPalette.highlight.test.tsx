import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { TranscriptHit } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommandPalette } from './CommandPalette'

/**
 * Enter runs the row the user is looking at.
 *
 * Content and file results land a debounce late and re-sort the list. The
 * highlight used to be an index into that list, so a reshuffle between the
 * render the user read and the Enter they pressed ran whatever slid under
 * the index — the walkthrough's "Enter on an action landed /name in the
 * composer". The highlight is now the entry itself: locked to the first row
 * of a query's first paint, moved only by arrows and hover, and followed by
 * id through every reshuffle.
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

/** A late-arriving content hit whose +20 boost takes the top of the list. */
const HIT: TranscriptHit = {
  summary: {
    id: 'expedition',
    runtime: 'codex',
    title: 'Settings expedition',
    preview: 'about settings',
    cwd: '/repo/app',
    status: { type: 'notLoaded' },
    createdAt: 1,
    updatedAt: 2,
  },
  line: 'digging through settings all afternoon',
  start: 16,
  end: 24,
} as unknown as TranscriptHit

const mount = async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'transcripts/search') return [HIT]
    return { data: [], nextCursor: null }
  })
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [],
    history: [],
  } as AppSnapshot
  const openSession = vi.fn(async () => {})
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    openSession,
  } as unknown as AppStore
  const openSettings = vi.fn()
  const host = {
    close: () => {},
    chooseFolder: () => {},
    openSettings,
    openUsage: () => {},
  }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={host} />
      </StoreProvider>,
    )
  })
  return { openSettings, openSession }
}

const field = (): HTMLInputElement => {
  const input = container.querySelector('input')
  if (!input) throw new Error('no palette input')
  return input
}

const type = (value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const press = (key: string): void => {
  act(() => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const activeLabel = (): string =>
  container.querySelector('[data-active]')?.textContent ?? ''

const settle = async (): Promise<void> => {
  // Past the 120ms search debounce, then let the promises land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160))
  })
}

it('a reshuffle cannot move the highlight off the row the user saw', async () => {
  const { openSettings, openSession } = await mount()
  type('settings')

  // First paint of the query: an action leads and holds the highlight.
  expect(activeLabel()).toContain('Settings › Agents')

  await settle()

  // The boosted content hit has taken the top of the list…
  const first = container.querySelector('[role="option"]')
  expect(first?.textContent).toContain('Settings expedition')
  // …but the highlight stayed where the user left it.
  expect(activeLabel()).toContain('Settings › Agents')

  press('Enter')
  expect(openSettings).toHaveBeenCalledWith('agents')
  expect(openSession).not.toHaveBeenCalled()
})

it('an arrowed-to row keeps the highlight through a reshuffle', async () => {
  const { openSession } = await mount()
  type('settings')
  press('ArrowDown')
  const arrowed = activeLabel()
  expect(arrowed).not.toBe('')

  await settle()

  expect(activeLabel()).toBe(arrowed)
  press('Enter')
  // Whatever was arrowed to, it was not the session that later leapt to the
  // top — Enter did not open it.
  expect(openSession).not.toHaveBeenCalled()
})
