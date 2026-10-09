import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type SessionSummary, type TranscriptHit } from '@harnessdesk/protocol'

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
  localStorage.clear()
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

const LISTED_ACP: SessionSummary = {
  id: sessionId('cline-older'),
  runtime: runtimeId('acp-cline'),
  title: 'Older listed ACP conversation',
  preview: 'last week',
  cwd: '/repo',
  status: { type: 'notLoaded' },
  createdAt: 1,
  updatedAt: 2,
}

const mount = async (runtimes: AppSnapshot['runtimes'] = []): Promise<{ request: ReturnType<typeof vi.fn> }> => {
  const request = vi.fn(async (method: string) => {
    if (method === 'transcripts/search') return [HIT]
    if (method === 'session/search') return { data: [LISTED_ACP], nextCursor: null }
    return { data: [], nextCursor: null }
  })
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes,
    history: [],
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: async () => {},
    transport: { request },
    openSession: vi.fn(async () => {}),
  } as unknown as AppStore
  const host = {
    close: () => {},
    chooseFolder: () => {},
    openSettings: () => {},
    openUsage: () => {},
    openAgents: () => {},
    openFrontDoor: () => {},
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
  // The matched words are lifted to full ink and the semibold weight inside
  // the match line — the text role's own ink step, not a ground of their own,
  // so they still read on a highlighted row whose line is already full ink.
  const mark = container.querySelector('b[data-slot="text"]')
  expect(mark?.textContent).toBe('treasure')
  expect(mark?.getAttribute('data-role')).toBe('meta')
  expect(mark?.getAttribute('data-ink')).toBe('primary')
  expect(mark?.getAttribute('data-weight')).toBe('semibold')
  expect(mark?.className).toContain('font-semibold')
  expect(mark?.className).not.toContain('font-normal')
})

it('nothing is asked for a single character', async () => {
  const { request } = await mount()
  type('t')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160))
  })
  expect(request).not.toHaveBeenCalledWith('transcripts/search', expect.anything())
})

it('tool output is requested only when the viewer enables it and is rendered as text', async () => {
  const { request } = await mount()
  request.mockImplementation(async (method: string, params: { includeTools?: boolean }) => {
    if (method === 'transcripts/search') return params.includeTools ? [{ ...HIT, source: 'tool', line: '<img src=x onerror=alert(1)> treasure output', start: 27, end: 35 }] : []
    return { data: [], nextCursor: null }
  })
  type('treasure')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
  const control = container.querySelector('[role="switch"][aria-label="Include tool output"]') as HTMLElement
  expect(control).not.toBeNull()
  expect(control.getAttribute('aria-checked')).toBe('false')
  act(() => control.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
  expect(request).toHaveBeenLastCalledWith('transcripts/search', { query: 'treasure', includeTools: true })
  expect(container.textContent).toContain('<img src=x onerror=alert(1)> treasure output')
  expect(container.textContent).toContain('Tool output')
  expect(container.querySelector('img[src="x"]')).toBeNull()
  act(() => control.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
  expect(request).toHaveBeenLastCalledWith('transcripts/search', { query: 'treasure' })
  expect(container.textContent).not.toContain('treasure output')
})

it('searches listed ACP history through the runtime capability', async () => {
  const { request } = await mount([{
    id: 'acp-cline',
    name: 'Agent',
    capabilities: { searchHistory: true, listHistory: true },
    presentation: { name: 'Agent' },
  } as AppSnapshot['runtimes'][number]])
  type('Older listed')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160))
  })

  expect(request).toHaveBeenCalledWith('session/search', { runtime: 'acp-cline', query: 'Older listed' })
  expect(container.textContent).toContain('Older listed ACP conversation')
})
