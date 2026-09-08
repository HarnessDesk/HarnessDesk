import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionKey, type BackgroundTask, type RuntimeId, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { BackgroundTasksView } from './BackgroundTasks'

/**
 * The background-task panel, through the DOM.
 *
 * What it has to hold: every task on screen as a card with the command it ran
 * and what it printed; the running work first and never behind a count; a
 * stop button on exactly the tasks that can be stopped; an honest empty state
 * for an agent that keeps no such list; and every control a request to the
 * host rather than a local edit, because the runtime owns the list and two
 * windows must not disagree about what is alive.
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

const KEY = sessionKey('alpha', 's1')

const session = (): Session =>
  ({
    id: 's1',
    runtime: 'alpha',
    cwd: '/w',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
  }) as unknown as Session

const runtime = (backgroundTasks: boolean): RuntimeInfo =>
  ({
    id: 'alpha',
    presentation: { name: 'Alpha' },
    capabilities: { backgroundTasks },
  }) as unknown as RuntimeInfo

const calls = {
  refreshTasks: vi.fn(),
  stopTask: vi.fn(),
  clearTasks: vi.fn(),
  notice: vi.fn(),
}

const mount = (tasks: readonly BackgroundTask[], { capable = true, open = true } = {}): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    runtimes: [runtime(capable)],
    activeRuntime: 'alpha' as RuntimeId,
    sessions: open ? new Map([[KEY, session()]]) : new Map(),
    activeSessionKey: open ? KEY : null,
    tasks: tasks.length > 0 ? new Map([[KEY, tasks]]) : new Map(),
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    ...calls,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <BackgroundTasksView />
      </StoreProvider>,
    )
  })
}

const running = (id: string, label: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id,
  label,
  kind: 'command',
  state: 'running',
  startedAt: Date.now() - 65_000,
  stoppable: true,
  ...extra,
})

const done = (id: string, label: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id,
  label,
  kind: 'command',
  state: 'completed',
  startedAt: Date.now() - 120_000,
  endedAt: Date.now() - 60_000,
  stoppable: false,
  ...extra,
})

const cards = (): HTMLElement[] => [...container.querySelectorAll('[data-slot="task-card"]')] as HTMLElement[]
const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === label || element.textContent?.includes(label),
  )
  if (!found) throw new Error(`no ${label} button; saw ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`)
  return found as HTMLButtonElement
}
const click = (element: HTMLButtonElement): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockReset()
})

describe('BackgroundTasksView', () => {
  it('asks the host for the list when it opens', () => {
    // The list arrives unasked only when it *changes*; a job that has been
    // running since before this window opened has nothing to announce.
    mount([])
    expect(calls.refreshTasks).toHaveBeenCalledWith(KEY)
  })

  it('says why it is empty, and the reason depends on the agent', () => {
    mount([], { capable: true })
    expect(container.textContent).toContain('Nothing in the background')
    expect(container.textContent).toContain('Alpha')

    // An agent without the concept: an empty list would suggest the work was
    // lost, and it was never kept.
    mount([], { capable: false })
    expect(container.textContent).toContain('keeps no list')

    mount([], { open: false })
    expect(container.textContent).toContain('No conversation')
  })

  it('draws every task as a card, running work first', () => {
    mount([done('t2', 'Ran the build'), running('t1', 'Watch the tests')])
    expect(cards().map((card) => card.dataset['state'])).toEqual(['running', 'completed'])
    expect(container.textContent).toContain('1 running · 1 finished')
  })

  it('shows the command and what it printed, where the task is', () => {
    // The whole reason the panel exists. The strip this replaced could say a
    // label and a clock; the output — the half a person opens it for — had
    // nowhere to go but a notice in the transcript.
    mount([done('t1', 'Run the test suite', { command: 'node --test test/', output: 'ℹ tests 1\nℹ pass 1\n' })])
    expect(container.textContent).toContain('node --test test/')
    expect(container.querySelector('[data-slot="task-output"]')?.textContent).toContain('ℹ pass 1')
  })

  it('says the kind and the state in words, with the duration', () => {
    mount([done('t1', 'Ran the build')])
    expect(container.textContent).toContain('Shell · Completed · 1m 00s')
  })

  it('does not pretend a running task printed nothing yet is silence', () => {
    mount([running('t1', 'Watch the tests', { command: 'pnpm test --watch' })])
    expect(container.textContent).toContain('Nothing printed yet')
    expect(container.querySelector('[data-slot="task-output"]')).toBeNull()
  })

  it('tells "still fetching" from "never found" on a finished task with no output', () => {
    // A race and a loss look the same on the wire — no `output` — unless the
    // runtime says it gave up. One sentence each, so a person can wait for
    // the first and stop waiting for the second.
    mount([done('t1', 'Ran the build', { command: 'pnpm build' })])
    expect(container.textContent).toContain('Fetching what it printed')
    mount([done('t1', 'Ran the build', { command: 'pnpm build', outputMissing: true })])
    expect(container.textContent).toContain('Its output was never found')
    expect(container.textContent).not.toContain('Fetching')
  })

  it('marks the end of a longer log', () => {
    mount([done('t1', 'Tail', { output: 'last lines', outputTruncated: true })])
    expect(container.textContent).toContain('Showing the end of a longer log')
  })

  it('offers stop on running work only, and asks the host to do it', () => {
    mount([running('t1', 'Still going'), done('t2', 'Over')])
    const stops = [...container.querySelectorAll('button')].filter((element) =>
      element.getAttribute('aria-label')?.startsWith('Stop '),
    )
    expect(stops).toHaveLength(1)
    click(button('Stop Still going'))
    expect(calls.stopTask).toHaveBeenCalledWith('t1', KEY)
  })

  it('clears the finished ones through the host, never locally', () => {
    mount([running('t1', 'Still going'), done('t2', 'Over')])
    click(button('Clear'))
    expect(calls.clearTasks).toHaveBeenCalledWith(KEY)
    // Nothing moved on screen: the rows redraw from the event that answers,
    // which is what keeps two windows agreeing.
    expect(cards()).toHaveLength(2)
  })

  it('has no Clear while nothing has finished', () => {
    mount([running('t1', 'Still going')])
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Clear')).toBe(false)
  })

  it('marks a task that failed or was stopped differently from one that finished', () => {
    mount([done('t1', 'Broke', { state: 'failed' }), done('t2', 'Killed', { state: 'stopped' })])
    expect(cards().map((card) => card.dataset['state'])).toEqual(['failed', 'stopped'])
    expect(container.textContent).toContain('Failed')
    expect(container.textContent).toContain('Stopped')
  })

  it('says nothing about elapsed time when the runtime never said when it started', () => {
    mount([running('t1', 'Since who knows when', { startedAt: undefined })])
    expect(container.textContent).toContain('Since who knows when')
    expect(container.textContent).not.toMatch(/\d+s/)
  })
})
