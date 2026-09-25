import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionKey, type Session, type SessionQueue } from '@harnessdesk/protocol'

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

const session = (): Session =>
  ({
    id: 's1',
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
  flushQueue: vi.fn(),
  clearQueue: vi.fn(),
  notice: vi.fn(),
}

const mount = (queue: SessionQueue | null): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    sessions: new Map([[KEY, session()]]),
    activeSessionKey: KEY,
    queues: queue ? new Map([[KEY, queue]]) : new Map(),
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

const rows = (): HTMLLIElement[] => [...container.querySelectorAll('li')]
const button = (label: string, index = 0): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].filter(
    (element) => element.getAttribute('aria-label') === label || element.textContent === label,
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

  it('puts an edited message back in the composer, whole, and takes it off the queue', () => {
    const heard: unknown[] = []
    const listener = (event: Event): void => {
      heard.push((event as CustomEvent).detail)
    }
    window.addEventListener('harnessdesk:compose', listener)
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
      ],
    })
    click(button('Edit'))
    window.removeEventListener('harnessdesk:compose', listener)

    expect(calls.unqueue).toHaveBeenCalledWith('q0', KEY)
    expect(heard[0]).toEqual({
      text: 'revise this',
      replace: true,
      attachments: [{ name: 'a.ts', path: '/w/a.ts', kind: 'file' }],
    })
  })

  it('gives back the context it carried as a chip, rather than dropping it', () => {
    // Editing a message must not quietly lose what it promised to carry. The
    // provider cannot resolve again — the chip became this text when the
    // message was queued — so the text itself comes back as a chip.
    const heard: unknown[] = []
    const listener = (event: Event): void => {
      heard.push((event as CustomEvent).detail)
    }
    window.addEventListener('harnessdesk:compose', listener)
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
    window.removeEventListener('harnessdesk:compose', listener)

    const detail = heard[0] as { text: string; attachments: { name: string; kind: string; text: string }[] }
    expect(detail.text).toBe('fix it')
    expect(detail.attachments[0]?.kind).toBe('note')
    expect(detail.attachments[0]?.name).toBe('Issue 12')
    expect(detail.attachments[0]?.text).toBe('<context source="Issue 12">\nbody\n</context>')
    expect(calls.notice).not.toHaveBeenCalled()
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
})
