import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import type { TerminalView } from '../state/layout'
import { dock } from '../state/workbench'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { TerminalToggle } from './Conversation'

/**
 * The terminal button in the conversation header is an on/off switch.
 *
 * The press that matters is the second one: whether it lands after the bottom
 * panel has a shell or while the first is still opening, it has to close it —
 * never ask the runtime for a shell nobody wanted. That is what a double
 * click on this button is, and it used to leave a stray terminal behind.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let opened: number
let closed: number
/** Held so a press can land while the shell is still opening. */
let settle: () => void

const docked = (): TerminalView => ({
  kind: 'terminal',
  terminalId: 't1',
  runtime: runtimeId('claude'),
  cwd: '/repo',
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  opened = 0
  closed = 0
  settle = () => {}
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const mount = (terminals: readonly TerminalView[]): void => {
  const base = emptySnapshot()
  // The shells live in the bottom panel now, docked the way anything is.
  const workbench = terminals.reduce((acc, view) => dock(acc, 'bottom', view), base.workbench)
  const snapshot: AppSnapshot = { ...base, workbench, layout: workbench.main }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    openTerminal: () => {
      opened += 1
      return new Promise<void>((resolve) => {
        settle = resolve
      })
    },
    closeTerminalDock: () => {
      closed += 1
    },
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TerminalToggle />
      </StoreProvider>,
    )
  })
}

const button = (): HTMLButtonElement => {
  const found = container.querySelector('button')
  if (!found) throw new Error('no terminal button')
  return found
}

const press = (): void => {
  act(() => {
    button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

it('opens a terminal when the dock is empty', () => {
  mount([])
  expect(button().getAttribute('aria-label')).toBe('Open terminal')
  press()
  expect([opened, closed]).toEqual([1, 0])
})

it('closes the dock instead of opening a second shell', () => {
  mount([docked()])
  expect(button().getAttribute('aria-label')).toBe('Close terminal')
  press()
  expect([opened, closed]).toEqual([0, 1])
})

it('reads a still-opening shell as on, so a double click closes it', async () => {
  mount([])
  press()
  // The runtime has not answered yet — the snapshot's dock is still empty.
  expect(button().getAttribute('aria-label')).toBe('Close terminal')
  press()
  expect([opened, closed]).toEqual([1, 1])
  // Let the cancelled open settle, so the state it drops lands inside act.
  await act(async () => {
    settle()
  })
})
