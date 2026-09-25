import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SortableAnnouncer, SortableHandle, sortableItemClass, useSortable } from './sortable-list'

/**
 * The sortable list, through the DOM: order shown by position; a move is a
 * request the owner answers (nothing reorders locally); ⌥↑/⌥↓ from anywhere in
 * a row moves it one place; a drag starts only from the handle; every move is
 * announced when it lands; and focus stays with the row that moved.
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

/** An owner that answers every request, or (`answer: false`) never does. */
const List = ({ onMove, answer = true, refuse = false, withField = false, busy = false, locked = [] }: { onMove: (id: string, to: number) => void; answer?: boolean; refuse?: boolean; withField?: boolean; busy?: boolean; locked?: string[] }) => {
  const [ids, setIds] = useState(['alpha', 'beta', 'gamma'])
  const sortable = useSortable({
    ids,
    name: (id) => id,
    movable: (id) => !locked.includes(id),
    busy,
    onMove: (id, to) => {
      onMove(id, to)
      if (!answer) return
      // A refusal is an answer too: the order changes, but not as asked.
      if (refuse) return setIds(['beta', 'alpha', 'gamma'])
      setIds((was) => {
        const rest = was.filter((one) => one !== id)
        return [...rest.slice(0, to), id, ...rest.slice(to)]
      })
    },
  })
  return (
    <>
      <ol>
        {ids.map((id, index) => (
          <li key={id} data-slot="sortable-row" className={sortableItemClass()} {...sortable.row(id, index)}>
            <SortableHandle {...sortable.handle(id)} />
            <span>{id}</span>
            {withField ? <input aria-label={`Note on ${id}`} /> : null}
            <button type="button" onKeyDown={(event) => { if (event.key === 'ArrowDown') opened.push(id) }}>Remove {id}</button>
          </li>
        ))}
      </ol>
      <SortableAnnouncer message={sortable.announcement} />
    </>
  )
}

/** What the rows' own buttons did with a key that reached them — a menu trigger opening, say. */
let opened: string[] = []
beforeEach(() => { opened = [] })

const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-slot="sortable-row"]')]
const order = (): string[] => rows().map((row) => row.querySelector('span')?.textContent ?? '')
const handle = (id: string): HTMLButtonElement => container.querySelector(`[aria-label="Move ${id}"]`) as HTMLButtonElement
const said = (): string => container.querySelector('[data-slot="sortable-announcer"]')?.textContent ?? ''
const press = (target: HTMLElement, key: string, alt = true): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, altKey: alt, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('SortableList', () => {
  it('owns the reveal of an item’s actions: hidden at rest, up with the pointer or the focus', () => {
    const drawn = sortableItemClass()
    expect(drawn).toContain('[&_[data-slot=sortable-actions]]:opacity-0')
    expect(drawn).toContain('hover:[&_[data-slot=sortable-actions]]:opacity-100')
    expect(drawn).toContain('focus-within:[&_[data-slot=sortable-actions]]:opacity-100')
    expect(sortableItemClass('horizontal')).toContain('focus-within:[&_[data-slot=sortable-actions]]:opacity-100')
  })

  it('moves a row one place with ⌥↑ and ⌥↓, from its handle or anything else in it', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} />))
    expect(press(handle('beta'), 'ArrowUp').defaultPrevented).toBe(true)
    expect(onMove).toHaveBeenLastCalledWith('beta', 0)
    expect(order()).toEqual(['beta', 'alpha', 'gamma'])

    const remove = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Remove alpha') as HTMLButtonElement
    press(remove, 'ArrowDown')
    expect(onMove).toHaveBeenLastCalledWith('alpha', 2)
    expect(order()).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('leaves a plain arrow to the row, and says so at either end rather than asking — every time', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} />))
    const remove = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Remove beta') as HTMLButtonElement
    expect(press(remove, 'ArrowUp', false).defaultPrevented).toBe(false)
    press(handle('alpha'), 'ArrowUp')
    press(handle('gamma'), 'ArrowDown')
    expect(onMove).not.toHaveBeenCalled()
    expect(said()).toBe('gamma is already last')
    // The same sentence again is still a change a live region speaks.
    press(handle('gamma'), 'ArrowDown')
    expect(said()).not.toBe('gamma is already last')
    expect(said().trim()).toBe('gamma is already last')
  })

  it('takes no Alt+arrow with another modifier, and none typed in a text field', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} withField />))
    for (const modifier of ['shiftKey', 'metaKey', 'ctrlKey'] as const) {
      const event = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, [modifier]: true, bubbles: true, cancelable: true })
      act(() => { handle('beta').dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
    }
    const field = container.querySelector('input') as HTMLInputElement
    expect(press(field, 'ArrowUp').defaultPrevented).toBe(false)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('does not announce a move the owner refused', () => {
    act(() => root.render(<List onMove={() => {}} refuse />))
    press(handle('gamma'), 'ArrowUp')
    // The owner answered with a new order that leaves gamma where it was.
    expect(order()).toEqual(['beta', 'alpha', 'gamma'])
    expect(said()).toBe('')
  })

  it('makes the handles one tab stop, walked with the arrows', () => {
    act(() => root.render(<List onMove={() => {}} />))
    expect([handle('alpha'), handle('beta'), handle('gamma')].map((one) => one.tabIndex)).toEqual([0, -1, -1])
    handle('alpha').focus()
    press(handle('alpha'), 'ArrowDown', false)
    expect(document.activeElement).toBe(handle('beta'))
    expect([handle('alpha'), handle('beta'), handle('gamma')].map((one) => one.tabIndex)).toEqual([-1, 0, -1])
  })

  it('picks a row up with Space, carries it with the arrows, and Escape puts it back', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} />))
    handle('alpha').focus()
    press(handle('alpha'), ' ', false)
    expect(handle('alpha').getAttribute('aria-pressed')).toBe('true')
    expect(said()).toContain('Picked up alpha')
    press(handle('alpha'), 'ArrowDown', false)
    press(document.activeElement as HTMLElement, 'ArrowDown', false)
    expect(order()).toEqual(['beta', 'gamma', 'alpha'])
    const escape = press(document.activeElement as HTMLElement, 'Escape', false)
    expect(escape.defaultPrevented).toBe(true)
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    expect(onMove).toHaveBeenLastCalledWith('alpha', 0)
    expect(handle('alpha').getAttribute('aria-pressed')).toBe('false')
  })

  it('takes Alt+arrows before a control in the row does: Alt+↓ on a menu button moves the row', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} />))
    const remove = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Remove alpha') as HTMLButtonElement
    press(remove, 'ArrowDown')
    expect(onMove).toHaveBeenLastCalledWith('alpha', 1)
    expect(opened).toEqual([])
    // A plain ↓ is still the control's own.
    press(remove, 'ArrowDown', false)
    expect(opened).toEqual(['alpha'])
  })

  it('puts a lifted row back where it was when focus leaves it for somewhere else', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} />))
    handle('alpha').focus()
    press(handle('alpha'), ' ', false)
    press(handle('alpha'), 'ArrowDown', false)
    expect(order()).toEqual(['beta', 'alpha', 'gamma'])
    const elsewhere = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Remove gamma') as HTMLButtonElement
    act(() => elsewhere.focus())
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    expect(onMove).toHaveBeenLastCalledWith('alpha', 0)
    expect(handle('alpha').getAttribute('aria-pressed')).toBe('false')
  })

  it('waits while the owner is busy: handles stay focusable, and no key or drag moves anything', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} busy />))
    expect(handle('beta').disabled).toBe(false)
    expect(handle('beta').getAttribute('aria-disabled')).toBe('true')
    handle('beta').focus()
    expect(press(handle('beta'), ' ', false).defaultPrevented).toBe(true)
    expect(handle('beta').getAttribute('aria-pressed')).toBe('false')
    press(handle('beta'), 'ArrowUp')
    expect(rows()[1]?.getAttribute('draggable')).toBe('false')
    expect(onMove).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(handle('beta'))
  })

  it('puts a lifted row down where it is with Enter', () => {
    act(() => root.render(<List onMove={() => {}} />))
    handle('beta').focus()
    press(handle('beta'), 'Enter', false)
    press(handle('beta'), 'ArrowUp', false)
    press(document.activeElement as HTMLElement, 'Enter', false)
    expect(order()).toEqual(['beta', 'alpha', 'gamma'])
    expect(said()).toBe('Dropped beta at position 1 of 3')
    expect(handle('beta').getAttribute('aria-pressed')).toBe('false')
  })

  it('announces a move when the owner answers, in the one sentence every reorder uses', () => {
    act(() => root.render(<List onMove={() => {}} />))
    press(handle('gamma'), 'ArrowUp')
    expect(said()).toBe('Moved gamma to position 2 of 3')
    const region = container.querySelector('[data-slot="sortable-announcer"]') as HTMLElement
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
  })

  it('says nothing until the owner answers, and never reorders on its own', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} answer={false} />))
    press(handle('gamma'), 'ArrowUp')
    expect(onMove).toHaveBeenCalledWith('gamma', 1)
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    expect(said()).toBe('')
  })

  it('keeps focus on the row that moved', () => {
    act(() => root.render(<List onMove={() => {}} />))
    handle('gamma').focus()
    press(handle('gamma'), 'ArrowUp')
    press(document.activeElement as HTMLElement, 'ArrowUp')
    expect(order()).toEqual(['gamma', 'alpha', 'beta'])
    expect(document.activeElement).toBe(handle('gamma'))
  })

  it('names the keys on a handle a keyboard can reach, and none on a row that cannot move', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} locked={['alpha']} />))
    expect(handle('beta').tagName).toBe('BUTTON')
    expect(handle('beta').getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
    expect(handle('alpha').disabled).toBe(true)
    press(handle('alpha'), 'ArrowDown')
    expect(onMove).not.toHaveBeenCalled()
    expect(rows()[0]?.getAttribute('draggable')).toBe('false')
  })
})

describe('dragging a sortable row', () => {
  const transfer = (): DataTransfer =>
    ({ effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => '' }) as unknown as DataTransfer
  /** A drag event over a row's upper or lower half (jsdom's rows have no size, so the sign says which). */
  const dragEvent = (type: string, dataTransfer: DataTransfer, half: 'upper' | 'lower' = 'lower'): Event => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    const at = half === 'upper' ? -1 : 1
    Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientX: { value: at }, clientY: { value: at } })
    return event
  }

  it('marks the true landing place: above a row for its upper half, below it for its lower, nothing where nothing would change', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} answer={false} />))
    const data = transfer()
    act(() => {
      handle('alpha').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      rows()[0]?.dispatchEvent(dragEvent('dragstart', data))
    })
    const marks = (): (string | null)[] => rows().map((row) => row.getAttribute('data-drop'))
    // Over beta's upper half: straight back where alpha is — no mark.
    act(() => { rows()[1]?.dispatchEvent(dragEvent('dragover', data, 'upper')) })
    expect(marks()).toEqual([null, null, null])
    // Over beta's lower half: between beta and gamma, drawn above gamma.
    act(() => { rows()[1]?.dispatchEvent(dragEvent('dragover', data, 'lower')) })
    expect(marks()).toEqual([null, null, 'before'])
    act(() => { rows()[1]?.dispatchEvent(dragEvent('drop', data, 'lower')) })
    expect(onMove).toHaveBeenLastCalledWith('alpha', 1)

    // Up: gamma over beta's upper half lands at index 1.
    act(() => {
      handle('gamma').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      rows()[2]?.dispatchEvent(dragEvent('dragstart', data))
    })
    act(() => { rows()[1]?.dispatchEvent(dragEvent('dragover', data, 'upper')) })
    expect(marks()).toEqual([null, 'before', null])
    act(() => { rows()[1]?.dispatchEvent(dragEvent('drop', data, 'upper')) })
    expect(onMove).toHaveBeenLastCalledWith('gamma', 1)
  })

  it('drops onto the index of the row it lands on, and marks where it will land', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} answer={false} />))
    const data = transfer()
    act(() => {
      handle('alpha').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      rows()[0]?.dispatchEvent(dragEvent('dragstart', data))
    })
    act(() => {
      rows()[2]?.dispatchEvent(dragEvent('dragover', data))
    })
    expect(rows()[0]?.hasAttribute('data-dragging')).toBe(true)
    expect(rows()[2]?.getAttribute('data-drop')).toBe('after')
    act(() => {
      rows()[2]?.dispatchEvent(dragEvent('drop', data))
    })
    expect(onMove).toHaveBeenCalledWith('alpha', 2)
    expect(rows().some((row) => row.hasAttribute('data-drop') || row.hasAttribute('data-dragging'))).toBe(false)
  })

  it('does not begin a drag that did not start on the handle', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} />))
    const data = transfer()
    const start = dragEvent('dragstart', data)
    act(() => {
      rows()[1]?.dispatchEvent(start)
      rows()[0]?.dispatchEvent(dragEvent('dragover', data))
      rows()[0]?.dispatchEvent(dragEvent('drop', data))
    })
    expect(start.defaultPrevented).toBe(true)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('forgets a press on the handle that never became a drag', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} />))
    const data = transfer()
    act(() => {
      handle('beta').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      handle('beta').dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    const start = dragEvent('dragstart', data)
    act(() => {
      rows()[1]?.dispatchEvent(start)
    })
    expect(start.defaultPrevented).toBe(true)
  })
})

/** A strip of tabs: each tab is its own grip, and the keys run along it. */
const Strip = ({ onMove }: { onMove: (id: string, to: number) => void }) => {
  const [ids, setIds] = useState(['one', 'two', 'three'])
  const sortable = useSortable({
    ids,
    name: (id) => `tab ${id}`,
    orientation: 'horizontal',
    grip: 'item',
    left: (id) => `tab ${id} closed`,
    onMove: (id, to) => {
      onMove(id, to)
      setIds((was) => {
        const rest = was.filter((one) => one !== id)
        return to >= was.length ? rest : [...rest.slice(0, to), id, ...rest.slice(to)]
      })
    },
  })
  return (
    <>
      <div role="tablist">
        {ids.map((id, index) => {
          return (
            <span key={id} role="tab" tabIndex={0} aria-keyshortcuts={sortable.keys} {...sortable.row(id, index)}>
              {id}
            </span>
          )
        })}
      </div>
      <button type="button" onClick={() => sortable.move('one', 9)}>Close one</button>
      <SortableAnnouncer message={sortable.announcement} />
    </>
  )
}

describe('a horizontal strip whose items are their own grip', () => {
  const tabs = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="tab"]')]

  it('moves along the strip with ⌥← and ⌥→, not ⌥↑ and ⌥↓, and keeps focus on the tab', () => {
    const onMove = vi.fn()
    act(() => root.render(<Strip onMove={onMove} />))
    expect(tabs()[0]?.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowLeft Alt+ArrowRight')
    const first = tabs()[0] as HTMLElement
    first.focus()
    expect(press(first, 'ArrowDown').defaultPrevented).toBe(false)
    press(first, 'ArrowRight')
    expect(onMove).toHaveBeenLastCalledWith('one', 1)
    expect(tabs().map((tab) => tab.textContent)).toEqual(['two', 'one', 'three'])
    expect(said()).toBe('Moved tab one to position 2 of 3')
    expect(document.activeElement?.textContent).toBe('one')
  })

  it('starts a drag from anywhere on the item', () => {
    const onMove = vi.fn()
    act(() => root.render(<Strip onMove={onMove} />))
    const data = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => '' } as unknown as DataTransfer
    const fire = (node: Element, type: string, x = 1): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, { dataTransfer: { value: data }, clientX: { value: x }, clientY: { value: 1 } })
      act(() => { node.dispatchEvent(event) })
      return event
    }
    expect(fire(tabs()[2]!, 'dragstart').defaultPrevented).toBe(false)
    fire(tabs()[0]!, 'dragover', -1)
    expect(tabs()[0]?.getAttribute('data-drop')).toBe('before')
    fire(tabs()[0]!, 'drop', -1)
    expect(onMove).toHaveBeenCalledWith('three', 0)
  })

  it('says what the owner calls a move that takes an item out of the order', () => {
    act(() => root.render(<Strip onMove={() => {}} />))
    const close = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Close one') as HTMLButtonElement
    act(() => close.click())
    expect(tabs().map((tab) => tab.textContent)).toEqual(['two', 'three'])
    expect(said()).toBe('tab one closed')
  })
})
