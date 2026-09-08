import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionKey, type RuntimeId, type Session } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { TaskPanel } from './TaskPanel'

/**
 * The sidebar's Tasks panel, through the DOM.
 *
 * The three things it exists to fix, each of which was a real defect:
 *
 *   - it shows the *focused* conversation's plan, where a plugin-owned list
 *     was one object for the whole app and left the previous agent's tasks
 *     under the next agent's session;
 *   - the newest plan replaces the older one, whichever tool wrote it;
 *   - the title folds it away, and the fold is a stored preference rather
 *     than component state, because the panel is re-rendered from the
 *     transcript every time the agent ticks something off.
 *
 * The scrolling half is CSS (`.sectionBody`), asserted where the stylesheet
 * is, not here.
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

const setListPrefs = vi.fn()
const editPlanTask = vi.fn()
const retirePlanEdits = vi.fn()

const session = (turns: unknown[]): Session =>
  ({
    id: 's1',
    runtime: 'alpha',
    cwd: '/w',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    itemsLoaded: true,
    turns,
  }) as unknown as Session

const planning = (todos: { content: string; status: string }[], id = 's1'): Session =>
  ({
    ...session([
      {
        id: 't1',
        status: 'completed',
        items: [
          {
            id: 'c1',
            type: 'toolCall',
            tool: 'TodoWrite',
            source: { kind: 'builtin' },
            status: 'completed',
            args: { todos },
          },
        ],
      },
    ]),
    id,
  }) as unknown as Session

const mount = (
  sessions: Record<string, Session>,
  active: string | null,
  collapsed: string[] = [],
  edits: Record<string, { from: string; to: string; at?: number }[]> = {},
): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    sessions: new Map(
      Object.entries(sessions).map(([id, value]) => [sessionKey('alpha' as RuntimeId, id), value]),
    ),
    activeSessionKey: active ? sessionKey('alpha' as RuntimeId, active) : null,
    listPrefs: { ...emptySnapshot().listPrefs, panelsCollapsed: collapsed },
    planEdits: Object.fromEntries(
      Object.entries(edits).map(([id, value]) => [sessionKey('alpha' as RuntimeId, id), value]),
    ),
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setListPrefs,
    editPlanTask,
    retirePlanEdits,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TaskPanel />
      </StoreProvider>,
    )
  })
}

const text = (): string => container.textContent ?? ''

describe('TaskPanel', () => {
  beforeEach(() => {
    setListPrefs.mockReset()
    editPlanTask.mockReset()
  })

  it('shows the focused conversation’s plan, counted', () => {
    mount(
      {
        s1: planning([
          { content: 'explore the repo', status: 'completed' },
          { content: 'write the spec', status: 'in_progress' },
          { content: 'ship it', status: 'pending' },
        ]),
      },
      's1',
    )
    expect(text()).toContain('Tasks · 1/3')
    expect(text()).toContain('write the spec')
    expect(text()).toContain('in progress')
  })

  it('is the *other* session’s plan when the other session is the one on screen', () => {
    // One list per conversation. A single shared list is what put the
    // previous agent's nine tasks under the next agent's session.
    const sessions = {
      s1: planning([{ content: 'the old plan', status: 'pending' }], 's1'),
      s2: planning([{ content: 'the new plan', status: 'pending' }], 's2'),
    }
    mount(sessions, 's1')
    expect(text()).toContain('the old plan')
    mount(sessions, 's2')
    expect(text()).toContain('the new plan')
    expect(text()).not.toContain('the old plan')
  })

  it('draws nothing at all for a conversation that never planned, or none at all', () => {
    mount({ s1: session([{ id: 't1', status: 'completed', items: [] }]) }, 's1')
    expect(container.querySelector('section')).toBeNull()
    mount({}, null)
    expect(container.querySelector('section')).toBeNull()
  })

  it('folds from the title, and remembers it as a preference rather than in state', () => {
    mount({ s1: planning([{ content: 'a task', status: 'pending' }]) }, 's1')
    const title = container.querySelector('button')
    expect(title?.getAttribute('aria-expanded')).toBe('true')
    act(() => {
      title?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // The panel is re-registered from the transcript on every tick, so a
    // fold held in component state would spring open again. It goes to the
    // store.
    expect(setListPrefs).toHaveBeenCalledWith({ panelsCollapsed: ['hd.tasks'] })
  })

  it('shows only the title once folded, and offers the way back', () => {
    mount({ s1: planning([{ content: 'a task', status: 'pending' }]) }, 's1', ['hd.tasks'])
    expect(text()).toContain('Tasks · 0/1')
    expect(text()).not.toContain('a task')
    const title = container.querySelector('button')
    expect(title?.getAttribute('aria-expanded')).toBe('false')
    act(() => {
      title?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(setListPrefs).toHaveBeenCalledWith({ panelsCollapsed: [] })
  })
})

describe('editing a task', () => {
  beforeEach(() => editPlanTask.mockReset())

  const KEY = sessionKey('alpha' as RuntimeId, 's1')
  const rows = (): HTMLElement[] => [...container.querySelectorAll('li button')] as HTMLElement[]
  const open = (index = 0): HTMLTextAreaElement => {
    act(() => {
      rows()[index]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = container.querySelector('textarea')
    if (!input) throw new Error('no field opened')
    return input as HTMLTextAreaElement
  }
  const type = (input: HTMLTextAreaElement, value: string): void => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = (input: HTMLTextAreaElement, key: string): void => {
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }

  it('opens a field on the task you click, carrying its text', () => {
    mount({ s1: planning([{ content: 'Buffer the request body', status: 'pending' }]) }, 's1')
    expect(open().value).toBe('Buffer the request body')
  })

  it('commits on Enter, against the label the transcript carries', () => {
    mount({ s1: planning([{ content: 'Buffer the request body', status: 'pending' }]) }, 's1')
    const input = open()
    type(input, 'Buffer the body, re-arm per attempt')
    press(input, 'Enter')
    expect(editPlanTask).toHaveBeenCalledWith(
      'Buffer the request body',
      'Buffer the body, re-arm per attempt',
      0,
      KEY,
    )
    // Enter closes the field, closing it blurs it, and the blur handler used
    // to commit again — two writes and two `app/state/set` requests per edit.
    expect(editPlanTask).toHaveBeenCalledTimes(1)
  })

  it('abandons on Escape rather than committing', () => {
    mount({ s1: planning([{ content: 'Buffer the request body', status: 'pending' }]) }, 's1')
    const input = open()
    type(input, 'something I changed my mind about')
    press(input, 'Escape')
    expect(editPlanTask).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('keys a second edit on the agent’s wording, not on the first edit', () => {
    // The whole reason `source` exists: an edit keyed on the displayed text
    // would have a `from` that nothing in the transcript ever matches.
    mount(
      { s1: planning([{ content: 'Buffer the request body', status: 'pending' }]) },
      's1',
      [],
      { s1: [{ from: 'Buffer the request body', to: 'Buffer the body' }] },
    )
    expect(text()).toContain('Buffer the body')
    const input = open()
    expect(input.value).toBe('Buffer the body')
    type(input, 'Buffer it once')
    press(input, 'Enter')
    expect(editPlanTask).toHaveBeenCalledWith('Buffer the request body', 'Buffer it once', 0, KEY)
  })

  it('says where it is showing something the conversation does not say', () => {
    mount(
      { s1: planning([{ content: 'Buffer the request body', status: 'pending' }]) },
      's1',
      [],
      { s1: [{ from: 'Buffer the request body', to: 'Buffer the body' }] },
    )
    expect(text()).toContain('edited')
    expect(rows()[0]?.getAttribute('title')).toContain('Buffer the request body')
  })

  it('leaves an untouched task saying exactly what the agent wrote', () => {
    mount({ s1: planning([{ content: 'Re-run the suite', status: 'completed' }]) }, 's1')
    expect(text()).toContain('Re-run the suite')
    expect(text()).not.toContain('edited')
  })
})

describe('a plan that repeats a label', () => {
  const KEY = sessionKey('alpha' as RuntimeId, 's1')
  beforeEach(() => editPlanTask.mockReset())
  const twice = (): Session =>
    planning([
      { content: 'Run the tests', status: 'pending' },
      { content: 'Run the tests', status: 'pending' },
    ])

  it('gives the two rows their own edits', () => {
    mount({ s1: twice() }, 's1')
    const rows = [...container.querySelectorAll('li button')] as HTMLElement[]
    expect(rows).toHaveLength(2)
    act(() => rows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const field = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(field, 'Run the whole suite')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    // The second occurrence, not the first — and not both.
    expect(editPlanTask).toHaveBeenCalledWith('Run the tests', 'Run the whole suite', 1, KEY)
  })

  it('shows the edit on only the row it was made on', () => {
    mount({ s1: twice() }, 's1', [], { s1: [{ from: 'Run the tests', to: 'Run the whole suite', at: 1 }] })
    const rows = [...container.querySelectorAll('li button')].map((b) => b.textContent)
    expect(rows[0]).toContain('Run the tests')
    expect(rows[0]).not.toContain('whole suite')
    expect(rows[1]).toContain('Run the whole suite')
  })
})
