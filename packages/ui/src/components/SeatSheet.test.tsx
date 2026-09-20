import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore, type SeatRefusal } from '../state/store'
import { SeatSheet } from './SeatSheet'

/**
 * The refusal sheet: a list with a fix on every line, and "Nothing was
 * opened" said only when it is true.
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

const REFUSAL: SeatRefusal = {
  agent: 'code-reviewer',
  name: 'Code reviewer',
  blocked: null,
  opened: false,
  candidates: [
    {
      seat: { runtime: 'cursor', model: 'gemini-3.8-flash' },
      label: 'Cursor · Gemini 3.8 Flash',
      runtimeName: 'Cursor',
      state: 'passed',
      reason: { kind: 'signedOut' },
      fix: { kind: 'signIn', runtime: 'cursor' },
    },
    {
      seat: { runtime: 'codex' },
      label: 'Codex',
      runtimeName: 'Codex',
      state: 'passed',
      reason: { kind: 'notInstalled', added: false },
      fix: { kind: 'add', runtime: 'codex' },
    },
  ],
}

// One object, so every read of the store is the same snapshot.
const SNAPSHOT = { ...emptySnapshot(), status: 'open', home: '/home/u' } as unknown as AppSnapshot

const mount = (refusal: SeatRefusal) => {
  const onFix = vi.fn()
  const onClose = vi.fn()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => SNAPSHOT,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SeatSheet refusal={refusal} onClose={onClose} onFix={onFix} />
      </StoreProvider>,
    )
  })
  return { onFix, onClose }
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)

it('says nothing was opened, and lists every candidate with its reason and its fix', () => {
  mount(REFUSAL)
  const text = document.body.textContent ?? ''
  expect(text).toContain('Code reviewer can’t be seated here')
  expect(text).toContain('Nothing was opened.')
  expect(text).toContain('Cursor · Gemini 3.8 Flash')
  expect(text).toContain('Cursor is signed out')
  expect(text).toContain('Codex is not added to HarnessDesk')
  expect(button('Sign in to Cursor')).toBeDefined()
  expect(button('Add Codex')).toBeDefined()
  // Words, never wire.
  expect(text).not.toContain('cursor=')
  expect(text).not.toContain('gemini-3.8-flash')
})

it('each fix, and Edit seats for this Mac beneath, says where to go', () => {
  const { onFix } = mount(REFUSAL)
  act(() => button('Sign in to Cursor')?.click())
  expect(onFix).toHaveBeenLastCalledWith({ kind: 'signIn', runtime: 'cursor' })
  act(() => button('Edit seats for this Mac')?.click())
  expect(onFix).toHaveBeenLastCalledWith({ kind: 'seats' })
})

it('says what a passed-over seat may have left behind', () => {
  mount({
    ...REFUSAL,
    candidates: [
      {
        seat: { runtime: 'gemini' },
        label: 'Gemini CLI',
        runtimeName: 'Gemini CLI',
        state: 'passed',
        reason: { kind: 'openedOtherwise', differences: [{ field: 'effort', asked: 'high', running: 'low' }] },
        fix: { kind: 'seats' },
        left: { kind: 'kept', archived: 'here' },
      },
    ],
  })
  expect(document.body.textContent).toContain('Gemini CLI may keep the empty conversation it opened')
})

it('says it was not started, never that nothing was opened, once a seat actually tried', () => {
  const text = () =>
    mount({
      ...REFUSAL,
      opened: true,
      candidates: [
        {
          seat: { runtime: 'gemini' },
          label: 'Gemini CLI',
          runtimeName: 'Gemini CLI',
          state: 'passed',
          reason: { kind: 'openedOtherwise', differences: [{ field: 'effort', asked: 'high', running: 'low' }] },
          fix: { kind: 'seats' },
          left: { kind: 'kept', archived: 'here' },
        },
      ],
    }) && (document.body.textContent ?? '')
  const shown = text()
  expect(shown).toContain('It was not started')
  expect(shown).not.toContain('Nothing was opened.')
})

it('an Agent that could not be weighed at all says why, worded from its own entry, never the host’s path', () => {
  mount({
    ...REFUSAL,
    candidates: [],
    blocked: 'HarnessDesk › agents/code-reviewer/AGENT.md: prefer[1] — cannot parse "cursor=" with no seat name after the equals sign',
  })
  const text = document.body.textContent ?? ''
  expect(text).toContain('Nothing was opened. It could not be weighed at all')
  expect(text).toContain('HarnessDesk › agents/code-reviewer/AGENT.md')
  expect(text).not.toContain('/home/u/')
})
