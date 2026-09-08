import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Popover, dismissOverlays } from './Popover'

/**
 * The popover's contract, exercised through the DOM. Chiefly: a menu is not a
 * handle for moving the window. Popovers sit in the conversation header and in
 * pane strips, which are `-webkit-app-region: drag`, and a drag region eats the
 * press — the window slides and the button fires only when the pointer stayed
 * still, which is a control that works about half the time.
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

const render = (): void => {
  act(() => {
    root.render(
      <Popover label="Menu" title="Conversation">
        {(close) => (
          <button type="button" onClick={close}>
            Compact now
          </button>
        )}
      </Popover>,
    )
  })
}

const trigger = (): HTMLButtonElement => {
  const button = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
  if (!button) throw new Error('no trigger')
  return button
}

const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('Popover', () => {
  it('opts its box out of the window drag region, so the press reaches the trigger', () => {
    render()
    const anchor = trigger().parentElement as HTMLElement
    expect(anchor.className.split(/\s+/)).toContain('hd-no-drag')
  })

  it('the trigger opens the menu and closes it again', () => {
    render()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    click(trigger())
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('a row closes the menu, and Escape returns focus to the trigger', () => {
    render()
    click(trigger())
    const row = document.querySelector('[role="menu"] button') as HTMLButtonElement
    click(row)
    expect(document.querySelector('[role="menu"]')).toBeNull()

    click(trigger())
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('a dialog taking the window closes it', () => {
    // Floating panels outrank the modal layer on purpose — one opened
    // inside Settings has to sit above it — so a panel still open when a
    // dialog appears paints over the dialog and cannot be clicked through.
    // A dialog opened from the keyboard is neither a press nor an Escape.
    render()
    click(trigger())
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    act(dismissOverlays)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  /**
   * The room is the window's, not a number. A fixed 400px ceiling scrolled
   * the browser pane's fourteen-row settings menu with half the window empty
   * beneath it, and the rows past the fold were found only by people who
   * noticed the scrollbar.
   */
  it('a menu takes the room below its trigger, and scrolls only when the window is too short', () => {
    const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    const originalInner = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    // jsdom lays nothing out: the panel claims to be 600px tall, the window 900.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    try {
      render()
      trigger().getBoundingClientRect = () => ({ top: 20, bottom: 46, left: 0, right: 40, width: 40, height: 26, x: 0, y: 20, toJSON: () => ({}) })
      click(trigger())
      const panel = document.querySelector<HTMLElement>('[role="menu"]')!
      // 900 - 8 margin - (46 + 6) top: everything under the trigger.
      expect(panel.style.maxHeight).toBe('840px')
      expect(panel.style.top).toBe('52px')
    } finally {
      if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight)
      if (originalInner) Object.defineProperty(window, 'innerHeight', originalInner)
    }
  })

  it('a press outside closes it; one on the trigger or the panel does not', () => {
    render()
    click(trigger())
    act(() => {
      document
        .querySelector('[role="menu"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

/**
 * What the trigger is called, and the one rule that decides it.
 *
 * WCAG 2.5.3, Label in Name: whatever a person can *see* on a control has to
 * appear in what a screen reader announces, or speech control cannot address
 * it. The trigger's `title` becomes the accessible name only when the trigger
 * shows no words of its own — and the condition used to be spelled
 * `typeof label === 'string'`, which is false for every fragment however much
 * text it holds. The conversation header's branch chip is an icon plus a span,
 * so it was announced as its worktree *path* with its visible label discarded.
 */
describe('the trigger’s accessible name', () => {
  const nameOf = (label: ReactNode) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        <Popover label={label} title="/Users/me/code/app/.claude/worktrees/wt">
          {() => <span />}
        </Popover>,
      )
    })
    const button = host.querySelector('button')
    const answer = { aria: button?.getAttribute('aria-label') ?? null, text: button?.textContent ?? '' }
    act(() => root.unmount())
    host.remove()
    return answer
  }

  it('is the hover text when the trigger is a glyph, which has no name of its own', () => {
    const { aria, text } = nameOf(<svg aria-hidden />)
    expect(text.trim()).toBe('')
    expect(aria).toBe('/Users/me/code/app/.claude/worktrees/wt')
  })

  it('is left to the visible words when the trigger has any — even inside a fragment', () => {
    const { aria, text } = nameOf(
      <>
        <svg aria-hidden />
        <span>feat/worktrees</span>
      </>,
    )
    expect(text).toContain('feat/worktrees')
    /* Not the path. A label that replaces the visible one is the failure, and
       a fragment is the shape it hid in. */
    expect(aria).toBeNull()
  })

  it('is left alone for a plain string label too', () => {
    expect(nameOf('Menu').aria).toBeNull()
  })
})
