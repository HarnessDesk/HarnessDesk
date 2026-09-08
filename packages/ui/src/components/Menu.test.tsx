import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextMenu, Menu, MenuItem, MenuToggle, Submenu, useContextMenu } from './Menu'

/**
 * The menu's contract, exercised through the DOM: a row closes the menu or
 * does not, a switch never does, a submenu opens beside its row and answers
 * the arrow keys, and a context menu goes away the ways a menu should.
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
  vi.useRealTimers()
})

const rows = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('button')]
const row = (label: string): HTMLButtonElement => {
  const match = rows().find((button) => button.textContent?.includes(label))
  if (!match) throw new Error(`no row labelled ${label}`)
  return match
}
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const key = (el: Element, name: string): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })
}

describe('Menu rows', () => {
  it('an action row runs and closes; a keepOpen row runs and stays', () => {
    const close = vi.fn()
    const act1 = vi.fn()
    const act2 = vi.fn()
    act(() => {
      root.render(
        <Menu close={close}>
          <MenuItem label="Go" onSelect={act1} />
          <MenuItem label="Stay" keepOpen onSelect={act2} />
        </Menu>,
      )
    })
    click(row('Stay'))
    expect(act2).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    click(row('Go'))
    expect(act1).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('a choice is a radio with its check, and a disabled choice shows its reason', () => {
    act(() => {
      root.render(
        <Menu close={() => {}}>
          <MenuItem label="Low" selected={false} onSelect={() => {}} />
          <MenuItem label="High" selected onSelect={() => {}} />
          <MenuItem label="Max" selected={false} disabled="Policy forbids it." onSelect={() => {}} />
        </Menu>,
      )
    })
    expect(row('High').getAttribute('role')).toBe('menuitemradio')
    expect(row('High').getAttribute('aria-checked')).toBe('true')
    expect(row('Low').getAttribute('aria-checked')).toBe('false')
    expect(row('Max').disabled).toBe(true)
    expect(row('Max').textContent).toContain('Policy forbids it.')
  })

  it('a switch flips without closing', () => {
    const close = vi.fn()
    const change = vi.fn()
    act(() => {
      root.render(
        <Menu close={close}>
          <MenuToggle label="Thinking" checked={false} onChange={change} />
        </Menu>,
      )
    })
    click(row('Thinking'))
    expect(change).toHaveBeenCalledWith(true)
    expect(close).not.toHaveBeenCalled()
    expect(row('Thinking').getAttribute('role')).toBe('switch')
  })

  it('↓ from outside the list — the trigger, say — steps into its first row', () => {
    act(() => {
      root.render(
        <>
          <button type="button" id="trigger">
            Open
          </button>
          <Menu close={() => {}}>
            <MenuItem label="One" onSelect={() => {}} />
            <MenuItem label="Two" onSelect={() => {}} />
          </Menu>
        </>,
      )
    })
    const trigger = document.getElementById('trigger') as HTMLButtonElement
    act(() => trigger.focus())
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })
    expect(document.activeElement).toBe(row('One'))
    act(() => trigger.focus())
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    })
    expect(document.activeElement).toBe(row('Two'))
  })

  it('arrow keys move between the rows of one level', () => {
    act(() => {
      root.render(
        <Menu close={() => {}}>
          <MenuItem label="One" onSelect={() => {}} />
          <MenuItem label="Two" onSelect={() => {}} />
          <MenuItem label="Three" onSelect={() => {}} />
        </Menu>,
      )
    })
    act(() => row('One').focus())
    key(row('One'), 'ArrowDown')
    expect(document.activeElement).toBe(row('Two'))
    key(row('Two'), 'ArrowUp')
    expect(document.activeElement).toBe(row('One'))
    key(row('One'), 'ArrowUp')
    expect(document.activeElement).toBe(row('Three'))
    key(row('Three'), 'Home')
    expect(document.activeElement).toBe(row('One'))
  })
})

describe('Submenu', () => {
  it('opens on click, lists its rows, and closes the whole menu when one is taken', () => {
    const close = vi.fn()
    const pick = vi.fn()
    act(() => {
      root.render(
        <Menu close={close}>
          <Submenu label="Effort" value="Medium">
            <MenuItem label="Low" selected={false} onSelect={pick} />
            <MenuItem label="Medium" selected onSelect={pick} />
          </Submenu>
        </Menu>,
      )
    })
    expect(rows().map((button) => button.textContent)).toEqual(['EffortMedium'])
    expect(row('Effort').getAttribute('aria-expanded')).toBe('false')
    click(row('Effort'))
    expect(row('Effort').getAttribute('aria-expanded')).toBe('true')
    expect(rows()).toHaveLength(3)
    click(row('Low'))
    expect(pick).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('→ opens it and ← closes it, returning focus to the row', () => {
    act(() => {
      root.render(
        <Menu close={() => {}}>
          <Submenu label="More models">
            <MenuItem label="Tiny" selected={false} onSelect={() => {}} />
          </Submenu>
        </Menu>,
      )
    })
    act(() => row('More models').focus())
    key(row('More models'), 'ArrowRight')
    expect(row('More models').getAttribute('aria-expanded')).toBe('true')
    const tiny = row('Tiny')
    act(() => tiny.focus())
    key(tiny, 'ArrowLeft')
    expect(row('More models').getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(row('More models'))
  })

  it('hovering a sibling row closes it', () => {
    act(() => {
      root.render(
        <Menu close={() => {}}>
          <MenuItem label="Plain" onSelect={() => {}} />
          <Submenu label="Effort">
            <MenuItem label="Low" selected={false} onSelect={() => {}} />
          </Submenu>
        </Menu>,
      )
    })
    click(row('Effort'))
    expect(row('Effort').getAttribute('aria-expanded')).toBe('true')
    act(() => {
      row('Plain').dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    expect(row('Effort').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('ContextMenu', () => {
  it('renders at the point it was asked for, and nothing when it was not', () => {
    const onClose = vi.fn()
    act(() => {
      root.render(
        <ContextMenu at={null} label="Actions" onClose={onClose}>
          <MenuItem label="Pin" onSelect={() => {}} />
        </ContextMenu>,
      )
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    act(() => {
      root.render(
        <ContextMenu at={{ x: 40, y: 50 }} label="Actions" onClose={onClose}>
          <MenuItem label="Pin" onSelect={() => {}} />
        </ContextMenu>,
      )
    })
    const panel = document.querySelector<HTMLElement>('[role="menu"]')
    expect(panel?.getAttribute('aria-label')).toBe('Actions')
    expect(panel?.style.left).toBe('40px')
    expect(panel?.style.top).toBe('50px')
    // The first row takes focus so the keyboard works at once.
    expect(document.activeElement).toBe(row('Pin'))
  })

  it('closes on Escape, on a click outside, and when a row is taken', () => {
    const onClose = vi.fn()
    const pin = vi.fn()
    const render = () =>
      act(() => {
        root.render(
          <ContextMenu at={{ x: 10, y: 10 }} label="Actions" onClose={onClose}>
            <MenuItem label="Pin" onSelect={pin} />
          </ContextMenu>,
        )
      })
    render()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)

    act(() => {
      row('Pin').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)

    click(row('Pin'))
    expect(pin).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('useContextMenu opens at the pointer and blocks the native menu', () => {
    const Harness = () => {
      const menu = useContextMenu()
      return (
        <div data-testid="target" onContextMenu={menu.open}>
          <ContextMenu at={menu.at} label="Session" onClose={menu.close}>
            <MenuItem label="Rename" onSelect={() => {}} />
            <MenuItem label="Archive" onSelect={() => {}} />
          </ContextMenu>
        </div>
      )
    }
    act(() => { root.render(<Harness />) })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    const target = document.querySelector('[data-testid="target"]')!
    const event = new MouseEvent('contextmenu', { clientX: 77, clientY: 88, bubbles: true, cancelable: true })
    act(() => { target.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    const panel = document.querySelector<HTMLElement>('[role="menu"]')
    expect(panel).not.toBeNull()
    expect(panel?.style.left).toBe('77px')
    expect(panel?.style.top).toBe('88px')
    expect(row('Rename')).toBeDefined()
    expect(row('Archive')).toBeDefined()
  })
})
