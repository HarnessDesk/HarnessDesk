import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SortableHandle, SortableList, SortableRow, sortableMoveMessage, useSortable } from './sortable-list'

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
const List = ({ onMove, answer = true, locked = [] }: { onMove: (id: string, to: number) => void; answer?: boolean; locked?: string[] }) => {
  const [ids, setIds] = useState(['alpha', 'beta', 'gamma'])
  const sortable = useSortable({
    ids,
    name: (id) => id,
    movable: (id) => !locked.includes(id),
    onMove: (id, to) => {
      onMove(id, to)
      if (!answer) return
      setIds((was) => {
        const rest = was.filter((one) => one !== id)
        return [...rest.slice(0, to), id, ...rest.slice(to)]
      })
    },
  })
  return (
    <SortableList announcement={sortable.announcement}>
      {ids.map((id, index) => (
        <SortableRow key={id} {...sortable.row(id, index)}>
          <SortableHandle {...sortable.handle(id)} />
          <span>{id}</span>
          <button type="button">Remove {id}</button>
        </SortableRow>
      ))}
    </SortableList>
  )
}

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

  it('leaves a plain arrow alone, and says so at either end rather than asking', () => {
    const onMove = vi.fn()
    act(() => root.render(<List onMove={onMove} />))
    expect(press(handle('beta'), 'ArrowUp', false).defaultPrevented).toBe(false)
    press(handle('alpha'), 'ArrowUp')
    press(handle('gamma'), 'ArrowDown')
    expect(onMove).not.toHaveBeenCalled()
    expect(said()).toBe('gamma is already last')
  })

  it('announces a move when the owner answers, in the one sentence every reorder uses', () => {
    act(() => root.render(<List onMove={() => {}} />))
    press(handle('gamma'), 'ArrowUp')
    expect(said()).toBe(sortableMoveMessage('gamma', 2, 3))
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
  const dragEvent = (type: string, dataTransfer: DataTransfer): Event => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    return event
  }

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
    expect(rows()[2]?.hasAttribute('data-drop')).toBe(true)
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
