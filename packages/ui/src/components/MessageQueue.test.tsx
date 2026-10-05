import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, wrapContext, type GoalView, type Session, type SessionQueue } from '@harnessdesk/protocol'

import { createQueueBoardStore } from '../design/explorer/boards'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { MessageQueue } from './MessageQueue'

/**
 * The queue strip, through the DOM.
 *
 * What it has to hold: nothing on screen when nothing is waiting; the order
 * the host gave, not one the component invented; every control a request to
 * the host rather than a local edit; and a paused queue that says *why* and
 * offers the way out.
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
const OTHER_KEY = sessionKey('alpha', 's2')

const session = (id: string): Session =>
  ({
    id,
    runtime: 'alpha',
    cwd: '/w',
    status: { type: 'active' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
  }) as unknown as Session

const calls = {
  unqueue: vi.fn(),
  moveQueued: vi.fn(),
  updateQueued: vi.fn(),
  flushQueue: vi.fn(),
  clearQueue: vi.fn(),
  notice: vi.fn(),
  addRecoverableDraft: vi.fn(),
}

const mount = (queue: SessionQueue | null, key = KEY, overrides: Partial<AppSnapshot> = {}): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    sessions: new Map([[key, session(key.split(':').slice(1).join(':'))]]),
    activeSessionKey: key,
    queues: queue ? new Map([[key, queue]]) : new Map(),
    ...overrides,
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    ...calls,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <MessageQueue />
      </StoreProvider>,
    )
  })
}

const waiting = (...lines: string[]): SessionQueue => ({
  status: 'waiting',
  reason: null,
  messages: lines.map((line, index) => ({
    id: `q${index}`,
    input: [{ type: 'text', text: line }],
    queuedAt: 0,
    state: 'queued',
  })),
})

it('keeps queued text but disables Send now in a wrapped conversation', () => {
  mount({ ...waiting('Keep this draft'), status: 'paused', reason: 'Held for later' }, KEY, { goals: new Map([['record', {
    goal: { state: 'wrapped' }, members: [], receipt: { members: [{ session: { runtime: 'alpha', sessionId: 's1' } }] },
  } as unknown as GoalView]]) })
  const send = [...container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Send now')!
  expect(send.disabled).toBe(true)
  expect(send.title).toBe('This Team is wrapped')
  expect(container.textContent).toContain('Keep this draft')
  calls.flushQueue.mockClear()
  act(() => send.click())
  expect(calls.flushQueue).not.toHaveBeenCalled()
})

const rows = (): HTMLLIElement[] => [...container.querySelectorAll('li')]
const button = (label: string, index = 0): HTMLButtonElement => {
  const accessibleLabel = label === 'Edit' ? 'Edit queued message' : label
  const found = [...container.querySelectorAll('button')].filter(
    (element) => element.getAttribute('aria-label') === accessibleLabel || element.textContent === label,
  )
  const element = found[index]
  if (!element) throw new Error(`no ${label} button`)
  return element as HTMLButtonElement
}
const click = (element: HTMLButtonElement): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const editor = (): HTMLTextAreaElement => {
  const field = container.querySelector('textarea[aria-label="Edit queued message"]') as HTMLTextAreaElement | null
  if (!field) throw new Error('no queued-message editor')
  return field
}
const typeIntoEditor = (value: string): void => {
  act(() => {
    const field = editor()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockReset()
})

describe('MessageQueue', () => {
  it('shows nothing at all when nothing is waiting', () => {
    mount(null)
    expect(container.textContent).toBe('')
    mount({ status: 'waiting', reason: null, messages: [] })
    expect(container.textContent).toBe('')
  })

  it('lists what is waiting, in the host’s order, and says when it goes', () => {
    mount(waiting('run the tests', 'then commit it'))
    expect(container.textContent).toContain('2 messages waiting — sent when this turn ends')
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('run the tests'),
      expect.stringContaining('then commit it'),
    ])
  })

  it('says when each one goes, and that none of them go while the queue is held', () => {
    mount(waiting('first', 'second', 'third'))
    expect(rows()[0]?.textContent).toContain('next')
    expect(rows()[1]?.textContent).toContain('then')
    // Beyond the second the position number already carries the order.
    expect(rows()[2]?.textContent).not.toContain('then')

    mount({ ...waiting('first', 'second'), status: 'paused', reason: 'The turn failed.' })
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('held'),
      expect.stringContaining('held'),
    ])
    expect(rows()[0]?.textContent).not.toContain('next')
  })

  it('shows the first line only, however long the message', () => {
    mount(waiting('the first line\nand a second one nobody needs in a row'))
    expect(rows()[0]?.textContent).toContain('the first line')
    expect(rows()[0]?.textContent).not.toContain('nobody needs')
  })

  it('counts what rides along rather than listing it', () => {
    mount({
      status: 'waiting',
      reason: null,
      messages: [
        {
          id: 'q0',
          queuedAt: 0,
          state: 'queued',
          input: [
            { type: 'text', text: 'look at this' },
            { type: 'image', url: 'data:image/png;base64,AA', name: 'shot.png' },
            { type: 'mention', name: 'a.ts', path: '/w/a.ts' },
          ],
        },
      ],
    })
    expect(rows()[0]?.textContent).toContain('1 image · 1 file')
  })

  it('reorders from the keyboard with ⌥↑ and ⌥↓, asking the host, with no move buttons', () => {
    mount(waiting('first', 'second'))
    expect(container.querySelector('[aria-label="Move up"], [aria-label="Move down"]')).toBeNull()
    const press = (target: Element, key: string): void => {
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }))
      })
    }
    press(button('Remove', 0), 'ArrowDown')
    expect(calls.moveQueued).toHaveBeenCalledWith('q0', 1, KEY)
    press(button('Move “second”'), 'ArrowUp')
    expect(calls.moveQueued).toHaveBeenCalledWith('q1', 0, KEY)
    // The ends stay put: nothing is asked of the host.
    calls.moveQueued.mockReset()
    press(button('Move “first”'), 'ArrowUp')
    expect(calls.moveQueued).not.toHaveBeenCalled()
  })

  it('announces a move once the host has answered with the new order', () => {
    mount(waiting('first', 'second'))
    act(() => {
      button('Move “second”').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
    })
    const said = (): string => container.querySelector('[role="status"]')?.textContent ?? ''
    expect(said()).toBe('')
    const answered = waiting('second', 'first')
    mount({ ...answered, messages: [answered.messages[0]!, answered.messages[1]!].map((message, index) => ({ ...message, id: index === 0 ? 'q1' : 'q0' })) })
    expect(said()).toBe('Moved “second” to position 1 of 2')
  })

  it('drops one message, and throws the whole queue away', () => {
    mount(waiting('first', 'second'))
    click(button('Remove', 1))
    expect(calls.unqueue).toHaveBeenCalledWith('q1', KEY)
    click(button('Discard all'))
    expect(calls.clearQueue).toHaveBeenCalledWith(KEY)
  })

  it('edits one row in place without touching the composer or changing its carried file', async () => {
    const compose = vi.fn()
    window.addEventListener('harnessdesk:compose', compose)
    mount({
      status: 'waiting',
      reason: null,
      messages: [
        {
          id: 'q0',
          queuedAt: 0,
          state: 'queued',
          input: [
            { type: 'text', text: 'revise this' },
            { type: 'mention', name: 'a.ts', path: '/w/a.ts' },
          ],
        },
        { id: 'q1', queuedAt: 0, state: 'queued', input: [{ type: 'text', text: 'next item' }] },
      ],
    })
    click(button('Edit'))
    expect(editor().value).toBe('revise this')
    expect(container.textContent).toContain('a.ts')
    expect(button('Edit').disabled).toBe(true)
    typeIntoEditor('revised text')
    await act(async () => {
      click(button('Save'))
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
    window.removeEventListener('harnessdesk:compose', compose)

    expect(calls.updateQueued).toHaveBeenCalledWith('q0', [
      { type: 'text', text: 'revised text', deskContext: { prefix: '' } },
      { type: 'mention', name: 'a.ts', path: '/w/a.ts' },
    ], KEY)
    expect(calls.unqueue).not.toHaveBeenCalled()
    expect(compose).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)))
    const edit = button('Edit')
    expect(edit.ownerDocument.activeElement).toBe(edit)
  })

  it('keeps an unresolved save visible and leaves the queued row in place until the host answers', async () => {
    let resolve!: () => void
    calls.updateQueued.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done }))
    mount(waiting('original'))
    click(button('Edit'))
    typeIntoEditor('pending revision')
    await act(async () => click(button('Save')))
    expect(editor().value).toBe('pending revision')
    expect(button('Saving…').disabled).toBe(true)
    expect(rows()).toHaveLength(1)
    expect(calls.unqueue).not.toHaveBeenCalled()
    await act(async () => resolve())
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('recovers a local edit when another window changes the same queued row', () => {
    mount(waiting('original'))
    click(button('Edit'))
    typeIntoEditor('my local revision')

    mount(waiting('revision from the other window'))

    expect(calls.addRecoverableDraft).toHaveBeenCalledWith(KEY, expect.objectContaining({
      text: 'my local revision',
      detail: 'The queued message changed in another window. Your edit was not saved. Restore it to the composer.',
    }))
    expect(container.querySelector('textarea')).toBeNull()
    expect(rows()[0]?.textContent).toContain('revision from the other window')
  })

  it('recovers a revised head row when delivery removes it before Save', () => {
    mount(waiting('original'))
    click(button('Edit'))
    typeIntoEditor('my revised instruction')
    mount({ status: 'waiting', reason: null, messages: [] })
    expect(calls.addRecoverableDraft).toHaveBeenCalledWith(KEY, expect.objectContaining({
      text: 'my revised instruction',
      detail: 'Your edit wasn’t saved because its message is no longer waiting. Restore it to the composer.',
    }))
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('does not recover or discard an edit when the same queue view switches conversations', () => {
    mount(waiting('original'))
    click(button('Edit'))
    typeIntoEditor('revision for the first conversation')

    mount({ ...waiting('another conversation'), messages: [{
      id: 'other-row', queuedAt: 0, state: 'queued', input: [{ type: 'text', text: 'another conversation' }],
    }] }, OTHER_KEY)
    expect(calls.addRecoverableDraft).not.toHaveBeenCalled()

    mount(waiting('original'))
    expect(rows()[0]?.textContent).toContain('original')
    expect(button('Edit')).toBeDefined()
    expect(calls.addRecoverableDraft).not.toHaveBeenCalled()
  })

  it('keeps an unsaved revision recoverable when Discard all removes its queued row', () => {
    mount(waiting('original', 'another row'))
    click(button('Edit'))
    typeIntoEditor('keep this revision')
    click(button('Discard all'))

    mount({ status: 'waiting', reason: null, messages: [] })
    expect(calls.addRecoverableDraft).toHaveBeenCalledWith(KEY, expect.objectContaining({
      text: 'keep this revision',
      detail: 'Your edit wasn’t saved because its message is no longer waiting. Restore it to the composer.',
    }))
  })

  it('disables Save for an empty text-only edit and points to Remove', () => {
    mount(waiting('original'))
    click(button('Edit'))
    typeIntoEditor('   ')
    expect(button('Save').disabled).toBe(true)
    expect(button('Save').title).toContain('Remove')
    expect(calls.updateQueued).not.toHaveBeenCalled()
  })

  it('keeps resolved context attached when edited words are saved', async () => {
    mount({
      status: 'waiting',
      reason: null,
      messages: [{
        id: 'q0', queuedAt: 0, state: 'queued',
        input: [{ type: 'text', text: '<context source="Issue 12">\nbody\n</context>\nfix it' }],
      }],
    })
    click(button('Edit'))
    expect(container.querySelector('[aria-label="Carried with this message"]')?.textContent).toContain('Issue 12')
    typeIntoEditor('fix it carefully')
    await act(async () => click(button('Save')))
    expect(calls.updateQueued).toHaveBeenCalledWith('q0', [
      { type: 'text', text: `${wrapContext('Issue 12', 'body')}\n\nfix it carefully`, deskContext: { prefix: wrapContext('Issue 12', 'body') } },
    ], KEY)
  })

  it('keeps a carried context chip intact while editing the queued row', async () => {
    const compose = vi.fn()
    window.addEventListener('harnessdesk:compose', compose)
    mount({
      status: 'waiting',
      reason: null,
      messages: [{
        id: 'q0', queuedAt: 0, state: 'queued',
        input: [{ type: 'text', text: `${wrapContext('Issue 12', 'body')}\nfix it` }],
      }],
    })
    click(button('Edit'))
    expect(editor().value).toBe('fix it')
    expect(container.querySelector('[aria-label="Carried with this message"]')?.textContent).toContain('Issue 12')
    typeIntoEditor('fix it carefully')
    await act(async () => click(button('Save')))
    window.removeEventListener('harnessdesk:compose', compose)

    expect(calls.updateQueued).toHaveBeenCalledWith('q0', [
      { type: 'text', text: `${wrapContext('Issue 12', 'body')}\n\nfix it carefully`, deskContext: { prefix: wrapContext('Issue 12', 'body') } },
    ], KEY)
    expect(calls.unqueue).not.toHaveBeenCalled()
    expect(compose).not.toHaveBeenCalled()
  })

  it('editing a recorded lookalike keeps it in the typed words', async () => {
    const raw = `${wrapContext('Other', 'typed words')}\n\nExplain it`
    mount({ ...waiting(raw), messages: [{ ...waiting(raw).messages[0]!,
      input: [{ type: 'text', text: raw, deskContext: { prefix: '' } }],
    }] })
    click(button('Edit'))
    expect(editor().value).toBe(raw)
    expect(container.querySelector('[aria-label="Carried with this message"]')).toBeNull()
    typeIntoEditor(`${raw} carefully`)
    await act(async () => click(button('Save')))
    expect(calls.updateQueued).toHaveBeenCalledWith('q0', [{
      type: 'text', text: `${raw} carefully`, deskContext: { prefix: '' },
    }], KEY)
  })

  it('cancel restores the original row and leaves its chips and composer alone', async () => {
    mount({
      status: 'waiting',
      reason: null,
      messages: [
        {
          id: 'q0',
          queuedAt: 0,
          state: 'queued',
          input: [{ type: 'text', text: '<context source="Issue 12">\nbody\n</context>\nfix it' }],
        },
      ],
    })
    click(button('Edit'))
    typeIntoEditor('discard this change')
    click(button('Cancel'))
    expect(container.querySelector('textarea')).toBeNull()
    expect(rows()[0]?.textContent).toContain('fix it')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)))
    const edit = button('Edit')
    expect(edit.ownerDocument.activeElement).toBe(edit)
    expect(calls.updateQueued).not.toHaveBeenCalled()
    expect(calls.unqueue).not.toHaveBeenCalled()
  })

  it('keeps a refused edit recoverable and explains why it could not be saved', async () => {
    calls.updateQueued.mockRejectedValueOnce(new Error('This message is being delivered.'))
    mount(waiting('original'))
    click(button('Edit'))
    typeIntoEditor('save this text for me')
    await act(async () => click(button('Save')))
    expect(calls.addRecoverableDraft).toHaveBeenCalledTimes(1)
    expect(calls.addRecoverableDraft.mock.calls[0]).toMatchObject([KEY, {
      text: 'save this text for me',
      detail: expect.stringContaining('This message is being delivered.'),
    }])
  })

  it('keeps two refused edits of the same row as separate recoveries in order', async () => {
    calls.updateQueued.mockRejectedValueOnce(new Error('delivering')).mockRejectedValueOnce(new Error('delivering'))
    mount(waiting('original'))
    click(button('Edit'))
    typeIntoEditor('first refused revision')
    await act(async () => click(button('Save')))
    click(button('Edit'))
    typeIntoEditor('second refused revision')
    await act(async () => click(button('Save')))

    const recoveries = calls.addRecoverableDraft.mock.calls.map(([, draft]) => draft)
    expect(recoveries.map((draft) => draft.text)).toEqual(['first refused revision', 'second refused revision'])
    expect(recoveries.map((draft) => draft.sourceId)).toEqual(['q0', 'q0'])
  })

  it('Escape cancels and Enter or Meta+Enter saves', async () => {
    mount(waiting('one', 'two'))
    click(button('Edit'))
    typeIntoEditor('first revision')
    act(() => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(container.querySelector('textarea')).toBeNull()
    expect(calls.updateQueued).not.toHaveBeenCalled()

    click(button('Edit'))
    typeIntoEditor('second revision')
    await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(calls.updateQueued).toHaveBeenCalledTimes(1)

    click(button('Edit'))
    typeIntoEditor('third revision')
    await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })))
    expect(calls.updateQueued).toHaveBeenCalledTimes(2)
  })

  /** The state the whole pause rule exists for. */
  it('a paused queue says why, and offers the way out', () => {
    mount({ ...waiting('the follow-up'), status: 'paused', reason: 'You have hit your usage limit.' })
    expect(container.textContent).toContain('You have hit your usage limit.')
    expect(container.textContent).toContain('1 message waiting')
    click(button('Send now'))
    expect(calls.flushQueue).toHaveBeenCalledWith(KEY)
  })

  /**
   * The queue is a notice standing beside the composer, so it is the soft
   * alert — muted ground, strong hairline — and the warning alert while it is
   * held. Its head is a toolbar, its list the sortable list's rows, and a row
   * takes no hover ground: pressing one does nothing.
   */
  it('is drawn by the alert, the toolbar and the sortable list — nothing of its own', () => {
    mount(waiting('run the tests', 'then commit it'))
    const frame = container.firstElementChild as HTMLElement
    expect(frame.getAttribute('data-slot')).toBe('alert')
    expect(frame.getAttribute('data-variant')).toBe('soft')
    expect(frame.getAttribute('data-tone')).toBe('neutral')
    expect(frame.querySelector(':scope > [data-slot="toolbar"]')?.textContent).toContain('2 messages waiting')
    const list = frame.querySelector('ol[aria-label="Waiting messages"]')
    expect(list?.querySelectorAll(':scope > li[data-slot="sortable-row"]')).toHaveLength(2)
    for (const row of rows()) {
      expect(row.className).not.toMatch(/hover:bg-/)
      // Its actions are the sortable item's to reveal, with the pointer or the keyboard's focus.
      expect(row.className).toContain('focus-within:[&_[data-slot=sortable-actions]]:opacity-100')
      const actions = row.querySelector('[data-slot="sortable-actions"]')
      expect(actions?.querySelector('[aria-label="Remove"]')).not.toBeNull()
      expect(actions?.className).not.toMatch(/opacity|group-hover|focus-within/)
    }
    expect(frame.querySelector('[data-slot="sortable-announcer"]')).not.toBeNull()

    mount({ ...waiting('the follow-up'), status: 'paused', reason: 'Stopped.' })
    expect((container.firstElementChild as HTMLElement).getAttribute('data-tone')).toBe('warning')
  })

  it('a message on its way out has no controls to fight over', () => {
    mount({
      status: 'waiting',
      reason: null,
      messages: [{ id: 'q0', queuedAt: 0, state: 'sending', input: [{ type: 'text', text: 'going' }] }],
    })
    expect(container.querySelector('[aria-label="Remove"]')).toBeNull()
    expect((container.querySelector('[data-slot="sortable-handle"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

/**
 * Dragging a message to a new place in the line.
 *
 * The order belongs to the host, so a drop must be the same request the
 * keys make. If these ever reordered locally, two windows on one
 * conversation would disagree about what runs next.
 */
describe('dragging a queued message', () => {
  const grip = (index: number): HTMLElement => {
    const found = rows()[index]?.querySelector('[data-slot="sortable-handle"]')
    if (!found) throw new Error(`no grip on row ${index}`)
    return found as HTMLElement
  }

  const transfer = (): DataTransfer =>
    ({ effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => '' }) as unknown as DataTransfer

  /** A drag event over a row's upper or lower half (jsdom's rows have no size, so the sign says which). */
  const dragEvent = (type: string, dataTransfer: DataTransfer, half: 'upper' | 'lower' = 'lower'): Event => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    const at = half === 'upper' ? -1 : 1
    Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientX: { value: at }, clientY: { value: at } })
    return event
  }

  it('asks the host to move it, and never reorders on its own', () => {
    mount(waiting('first', 'second', 'third'))
    const data = transfer()
    act(() => {
      grip(2).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      rows()[2]?.dispatchEvent(dragEvent('dragstart', data))
    })
    act(() => {
      rows()[0]?.dispatchEvent(dragEvent('dragover', data, 'upper'))
      rows()[0]?.dispatchEvent(dragEvent('drop', data, 'upper'))
    })
    expect(calls.moveQueued).toHaveBeenCalledWith('q2', 0, KEY)
    // The rows are still in the order the host last gave.
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
      expect.stringContaining('third'),
    ])
  })

  /** A drag that began on the text, not the handle, must not start one. */
  it('does not begin a drag that did not start on the handle', () => {
    mount(waiting('first', 'second'))
    const data = transfer()
    act(() => {
      rows()[1]?.dispatchEvent(dragEvent('dragstart', data))
      rows()[0]?.dispatchEvent(dragEvent('dragover', data))
      rows()[0]?.dispatchEvent(dragEvent('drop', data))
    })
    expect(calls.moveQueued).not.toHaveBeenCalled()
  })

  /**
   * A whole gesture inside one task.
   *
   * Reading the dragged id from state failed exactly here: every handler still
   * saw the render from before the drag began, so the drop asked the host to
   * move nothing. The id lives in a ref for this reason.
   */
  it('still knows what is moving when every event lands in one task', () => {
    mount(waiting('first', 'second', 'third'))
    const data = transfer()
    act(() => {
      grip(2).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      rows()[2]?.dispatchEvent(dragEvent('dragstart', data))
      rows()[0]?.dispatchEvent(dragEvent('dragover', data, 'upper'))
      rows()[0]?.dispatchEvent(dragEvent('drop', data, 'upper'))
    })
    expect(calls.moveQueued).toHaveBeenCalledWith('q2', 0, KEY)
  })

  /**
   * Downward, which the keys never exercise: they move by one, so a drop
   * several places away is the first caller ever to ask the host for an
   * arbitrary index. This pins the request, not the host's reading of it.
   */
  it('asks for the index of the row it was dropped on', () => {
    mount(waiting('first', 'second', 'third'))
    const data = transfer()
    act(() => {
      grip(0).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      rows()[0]?.dispatchEvent(dragEvent('dragstart', data))
      rows()[2]?.dispatchEvent(dragEvent('dragover', data))
      rows()[2]?.dispatchEvent(dragEvent('drop', data))
    })
    expect(calls.moveQueued).toHaveBeenCalledWith('q0', 2, KEY)
  })

  it('backs the explorer queue with an isolated, complete local store', async () => {
    const boardKey = sessionKey(runtimeId('codex'), sessionId('catalogue-queue'))
    const store = createQueueBoardStore()
    const listener = vi.fn()
    store.subscribe(listener)

    expect(store.getSnapshot().queues.get(boardKey)?.messages.map(({ id }) => id)).toEqual([
      'queue-board-1', 'queue-board-2', 'queue-board-3',
    ])
    await store.moveQueued('queue-board-3', 0, boardKey)
    await store.updateQueued('queue-board-1', [{ type: 'text', text: 'Edited message' }], boardKey)
    expect(store.getSnapshot().queues.get(boardKey)?.messages.map(({ id }) => id)).toEqual([
      'queue-board-3', 'queue-board-1', 'queue-board-2',
    ])
    expect(store.getSnapshot().queues.get(boardKey)?.messages[1]?.input).toEqual([
      { type: 'text', text: 'Edited message' },
    ])
    await store.unqueue('queue-board-1', boardKey)
    expect(store.getSnapshot().queues.get(boardKey)?.messages.map(({ id }) => id)).toEqual([
      'queue-board-3', 'queue-board-2',
    ])
    await store.clearQueue(boardKey)
    expect(store.getSnapshot().queues.get(boardKey)?.messages).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)

    const untouched = createQueueBoardStore()
    const untouchedSnapshot = untouched.getSnapshot()
    const untouchedListener = vi.fn()
    untouched.subscribe(untouchedListener)
    await untouched.updateQueued('missing', [{ type: 'text', text: 'ignored' }], boardKey)
    await untouched.unqueue('missing', boardKey)
    await untouched.moveQueued('missing', 0, boardKey)
    await untouched.moveQueued('queue-board-1', 3, boardKey)
    await untouched.updateQueued('queue-board-1', [], sessionKey(runtimeId('codex'), sessionId('other')))
    expect(untouched.getSnapshot()).toBe(untouchedSnapshot)
    expect(untouchedListener).not.toHaveBeenCalled()

    const remounted = createQueueBoardStore()
    expect(remounted.getSnapshot().queues.get(boardKey)?.messages.map(({ id }) => id)).toEqual([
      'queue-board-1', 'queue-board-2', 'queue-board-3',
    ])
  })
})
