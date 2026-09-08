import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Board, BoardAddCard, BoardCard, BoardColumn } from './board'

/**
 * Both of the board's layouts, pinned — because the default is a decision and
 * the opt-out is a different decision, and a later edit that quietly makes one
 * behave like the other loses an argument nobody would notice losing.
 *
 * Scrolling is the default: with user-defined columns there is no order to
 * recover, so a column that moved is a column you have to hunt for. Wrapping is
 * for a fixed, short set of states in a pane whose width is not the board's to
 * choose — where scrolling does not shorten the board, it hides a state, and
 * the state that goes first is the one someone opened the board to find.
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

const columns = (
  <>
    <BoardColumn title="Waiting" />
    <BoardColumn title="Blocked" />
  </>
)

const draw = (node: React.ReactNode) => {
  act(() => root.render(node))
  const board = container.querySelector<HTMLElement>('[data-slot="board"]')
  if (!board) throw new Error('no board rendered')
  return board
}

describe('Board', () => {
  it('scrolls sideways by default', () => {
    const board = draw(<Board>{columns}</Board>)
    expect(board.className).toContain('overflow-x-auto')
    expect(board.className).not.toContain('grid-cols-')
    expect(board.hasAttribute('data-wrap')).toBe(false)
  })

  it('wraps onto a second row when asked, and then never scrolls sideways', () => {
    const board = draw(<Board wrap>{columns}</Board>)
    expect(board.hasAttribute('data-wrap')).toBe(true)
    expect(board.className).toContain('grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]')
    // A wrapped board that could still scroll would hide a state anyway.
    expect(board.className).not.toContain('overflow-x-auto')
  })

  it('makes the columns fluid from the parent, leaving the column itself alone', () => {
    const wrapped = draw(<Board wrap>{columns}</Board>)
    expect(wrapped.className).toContain('[&>[data-slot=board-column]]:w-auto')

    // The column keeps its own fixed width; only the parent's rule overrides it,
    // so every other board in the app is untouched by this prop existing.
    const column = container.querySelector<HTMLElement>('[data-slot="board-column"]')
    expect(column?.className).toContain('w-[280px]')

    const plain = draw(<Board>{columns}</Board>)
    expect(plain.className).not.toContain('[&>[data-slot=board-column]]:w-auto')
  })

  it('keeps every column mounted in both layouts — wrapping may not drop one', () => {
    expect(draw(<Board>{columns}</Board>).querySelectorAll('[data-slot="board-column"]')).toHaveLength(2)
    expect(
      draw(<Board wrap>{columns}</Board>).querySelectorAll('[data-slot="board-column"]'),
    ).toHaveLength(2)
  })
})

/*
 * The tag is one line, however long its label.
 *
 * A card's tag is a fixed-height chip, and a label that wrapped — three
 * owned paths joined with commas, on every card of a 138-page audit —
 * spilled over the note above and the foot below until the card read as
 * three overlapping paragraphs. Found on camera; nothing in a test had ever
 * given a chip a label longer than a word.
 */
describe('BoardCard', () => {
  it('keeps a long tag on one line and carries the whole label as its title', () => {
    const label = 'reports/account-deletion.md, reports/account-deletion, reports/account-deletion/**'
    act(() => {
      root.render(
        <BoardCard
          title="Audit /account-deletion"
          note="7/10 — Fast load and clean outline but report clipping on the phone"
          tag={{ label, tint: 'teal' }}
          meta={<span>1m</span>}
        />,
      )
    })
    /* By its own label rather than by "the first thing with a title": the
       clamped note carries one too now, so it can be read in full on hover,
       and it comes first in the DOM. */
    const chip = [...container.querySelectorAll<HTMLElement>('[title]')].find(
      (one) => one.getAttribute('title') === label,
    )
    expect(chip).not.toBeUndefined()
    expect(chip?.className).toContain('truncate')
    expect(chip?.className).toContain('max-w-full')
    // The clamped note is still its own paragraph, not the chip's neighbour in one line.
    expect(container.querySelector('p')?.className).toContain('line-clamp-2')
  })
})

/**
 * What a card does with content it was not sized for.
 *
 * Every case below came off one screenshot of a real room, and every one of
 * them is invisible until the column is narrow: a board that only ever gets
 * looked at at 280px passes on all three. They are pinned as classes rather
 * than as measurements because jsdom lays nothing out — what is being
 * defended is the *decision*, and the decision is a word in a class list that
 * a later edit can delete without noticing.
 */
describe('a card under content that does not fit', () => {
  it('breaks a title with no spaces in it rather than pushing it through the card', () => {
    draw(
      <Board>
        <BoardColumn title="Claimed">
          <BoardCard title="packages/server/src/methods/conversation.ts::resumeAfterCompaction" />
        </BoardColumn>
      </Board>,
    )
    const heading = container.querySelector('h4')
    /* Both halves, and neither is enough alone: a flex child's minimum size is
       its content, so without `min-w-0` the card simply widens, and a token
       with no break opportunity does not wrap without `break-words`. */
    expect(heading?.className).toContain('break-words')
    expect(heading?.parentElement?.className).toContain('min-w-0')
    expect(container.querySelector('[data-slot="board-card"]')?.className).toContain('min-w-0')
  })

  it('keeps the judgement chip on one line, and lets the tag take one of its own', () => {
    draw(
      <Board>
        <BoardColumn title="Claimed">
          <BoardCard
            title="Migrate"
            tag={{ label: 'packages/server/src/methods/conversation.ts', tint: 'teal' }}
            priority={{ label: 'stranded 40m', tone: 'warning' }}
          />
        </BoardColumn>
      </Board>,
    )
    const chips = container.querySelector('[data-slot="board-card"] > div:last-of-type')
    // The chip is a fixed height, so a label allowed to wrap spills out of it.
    const priority = [...container.querySelectorAll('span')].find((one) =>
      one.textContent === 'stranded 40m',
    )
    expect(priority?.className).toContain('whitespace-nowrap')
    expect(priority?.className).toContain('shrink-0')
    // …which is only safe because the row can give the tag a line of its own.
    expect(chips?.className).toContain('flex-wrap')
  })

  it('an empty column is still a column: it keeps an edge and a floor', () => {
    draw(
      <Board>
        <BoardColumn title="Blocked" count={0} />
      </Board>,
    )
    const column = container.querySelector<HTMLElement>('[data-slot="board-column"]')
    expect(column?.className).toContain('border')
    expect(column?.className).toContain('min-h-40')
  })
})

/**
 * The slot at the foot of a column, which is the board's quick path.
 *
 * It opens from one click, so it has to close from one key — and it clears on
 * hand-over rather than on a promise, because the caller may be talking to a
 * host over a socket and a field that waits eats the next card typed into it.
 */
describe('BoardAddCard', () => {
  const open = (onAdd: (title: string) => void) => {
    act(() => root.render(<BoardAddCard onAdd={onAdd} label="Add work" />))
    const slot = container.querySelector<HTMLButtonElement>('button[data-slot="board-add"]')
    if (!slot) throw new Error('no slot')
    act(() => slot.click())
    const field = container.querySelector<HTMLInputElement>('[data-slot="board-add"] input')
    if (!field) throw new Error('the slot did not open')
    return field
  }

  const type = (field: HTMLInputElement, text: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('is a slot until it is pressed', () => {
    act(() => root.render(<BoardAddCard onAdd={() => {}} label="Add work" />))
    expect(container.querySelector('[data-slot="board-add"]')?.tagName).toBe('BUTTON')
    expect(container.querySelector('input')).toBeNull()
  })

  it('hands over the title on Enter, clears, and stays open for the next one', () => {
    const added: string[] = []
    const field = open((title) => added.push(title))
    type(field, '  Ship the docs  ')
    act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(added).toEqual(['Ship the docs'])
    const still = container.querySelector<HTMLInputElement>('[data-slot="board-add"] input')
    expect(still?.value).toBe('')
  })

  it('adds nothing for a title that is only spaces', () => {
    const added: string[] = []
    const field = open((title) => added.push(title))
    type(field, '   ')
    act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(added).toEqual([])
  })

  it('Escape closes it and takes the half-typed title with it', () => {
    const added: string[] = []
    const field = open((title) => added.push(title))
    type(field, 'Half a thought')
    act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    expect(container.querySelector('[data-slot="board-add"][data-open]')).toBeNull()
    expect(added).toEqual([])
  })

  /* `focusout`, not `blur`: React attaches one listener at the root and
     `blur` does not bubble to it, so a dispatched `blur` runs no handler at
     all and the test would pass on a component that had none. */
  const leave = (field: HTMLInputElement) =>
    act(() => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))

  it('a blur with nothing typed closes it', () => {
    leave(open(() => {}))
    expect(container.querySelector('[data-slot="board-add"][data-open]')).toBeNull()
  })

  it('a blur with something typed keeps both the field and the words', () => {
    const field = open(() => {})
    type(field, 'Keep me')
    leave(field)
    expect(container.querySelector<HTMLInputElement>('[data-slot="board-add"] input')?.value).toBe(
      'Keep me',
    )
  })
})
