import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { TranscriptHit } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommandPalette } from './CommandPalette'

/**
 * The palette's content search reaches the host's transcript store — the one
 * search that covers every agent — not only the runtimes that can search
 * their own history. Pinned here: a conversation that is in nobody's list but
 * whose stored transcript matches still becomes a row, and the row shows the
 * transcript's own matching line with the match marked.
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

const HIT: TranscriptHit = {
  summary: {
    id: 'ghost',
    runtime: 'codex',
    title: 'The forgotten thread',
    preview: 'about the flaky suite',
    cwd: '/repo/app',
    status: { type: 'notLoaded' },
    createdAt: 1,
    updatedAt: 2,
  },
  line: 'the treasure is buried under the websocket test',
  start: 4,
  end: 12,
} as unknown as TranscriptHit

const mount = async (): Promise<{ request: ReturnType<typeof vi.fn> }> => {
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
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    openSession: vi.fn(async () => {}),
  } as unknown as AppStore
  const host = {
    close: () => {},
    chooseFolder: () => {},
    openSettings: () => {},
    openUsage: () => {},
  }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={host} />
      </StoreProvider>,
    )
  })
  return { request }
}

const type = (value: string): void => {
  const field = container.querySelector('input')
  if (!field) throw new Error('no palette input')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('a transcript-only conversation surfaces with the store’s matching line marked', async () => {
  const { request } = await mount()
  type('treasure')
  // Past the 120ms debounce, then let the promise land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160))
  })

  expect(request).toHaveBeenCalledWith('transcripts/search', { query: 'treasure' })
  expect(container.textContent).toContain('The forgotten thread')
  const mark = container.querySelector('mark')
  expect(mark?.textContent).toBe('treasure')
})

it('nothing is asked for a single character', async () => {
  const { request } = await mount()
  type('t')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160))
  })
  expect(request).not.toHaveBeenCalledWith('transcripts/search', expect.anything())
})
