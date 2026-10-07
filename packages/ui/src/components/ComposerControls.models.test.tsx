import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ConfigOption, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ModelControl } from './ComposerControls'

// ModelControl does not render either primitive, but ComposerControls imports
// them through the full design barrel. Keep this focused test from loading
// unrelated design-preview dependencies.
vi.mock('../design', async (importOriginal) => ({ ...(await importOriginal<typeof import('../design')>()), Button: () => null, Dialog: () => null }))
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

const cursor: RuntimeInfo = {
  id: 'cursor',
  name: 'Cursor',
  capabilities: {},
  presentation: { name: 'Cursor', tagline: 'The Cursor agent.' },
} as unknown as RuntimeInfo

/** The runtime's whole catalogue, as its draft option declares it. */
const model: ConfigOption = {
  id: 'model',
  label: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'spark-3',
  choices: [
    { value: 'brain-9', label: 'Brain 9' },
    { value: 'orb-2', label: 'Orb 2' },
    { value: 'spark-3', label: 'Spark 3' },
    { value: 'quill-1', label: 'Quill 1' },
  ],
}

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * The picker offers what Settings › Models left in it. A hidden model is a
 * setting, not a catalogue change: the agent still serves it to anything that
 * names it, and the one the draft is already on is never hidden from its own
 * control — a row you cannot see is a setting you cannot read back.
 *
 * Pinned because a recording claims it: three request-billed Cursor families
 * in a picker of thirty-four, exactly as the person left them.
 */
it('offers only the models Settings left visible, and always the one the draft is on', () => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [cursor],
    activeRuntime: cursor.id,
    draftOptions: [model],
    // Two hidden, one of which is the current pick.
    hiddenModels: { cursor: ['brain-9', 'spark-3'] },
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setOption: vi.fn(async () => {}),
    askSettings: vi.fn(),
    refreshCatalog: vi.fn(async () => null),
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ModelControl />
      </StoreProvider>,
    )
  })

  /* Found by the role it plays, not by an `aria-label` — because the control
     shows the model's name and a trigger with visible words keeps them as its
     accessible name (WCAG 2.5.3). `title` becomes the accessible *description*
     in that case, which is where "Model and reasoning" belongs. */
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  expect(trigger).not.toBeNull()
  expect(trigger!.getAttribute('title')).toBe('Model and reasoning')
  expect(trigger!.textContent?.trim()).not.toBe('')
  click(trigger!)

  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].map((row) =>
    (row.textContent ?? '').trim(),
  )
  expect(rows).toEqual(['Orb 2', 'Spark 3', 'Quill 1'])
  expect(rows.join(' ')).not.toContain('Brain 9')
})

it('keeps a long model name on the trigger and reports its status in the title and menu', () => {
  const longModel: ConfigOption = { ...model, choices: [{ value: 'spark-3', label: 'Spark Research 3' }] }
  let snapshot: AppSnapshot = {
    ...emptySnapshot(), status: 'open', runtimes: [cursor], activeRuntime: cursor.id,
    draftOptions: [longModel, { id: 'wide-window', type: 'boolean', label: 'Wide window',
      currentValue: true, modelStatus: 'Auto window' }],
  }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  const render = () => act(() => root.render(<StoreProvider store={store}><ModelControl /></StoreProvider>))
  render()
  const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  expect(trigger().textContent).toContain('Spark Research 3')
  expect(trigger().textContent).not.toContain('Auto window')
  expect(trigger().title).toContain('Auto window')
  click(trigger())
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Auto window')
  click(trigger())
  snapshot = { ...snapshot, draftOptions: [longModel] }
  render()
  expect(trigger().textContent).not.toContain('Auto window')
  expect(trigger().title).not.toContain('Auto window')
  click(trigger())
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Auto window')
})

it.each(['claude-code', 'codex', 'other-agent'])('renders effort without an undeclared model status for %s', (id) => {
  const runtime = { ...cursor, id, name: 'Test agent', presentation: { name: 'Test agent', tagline: 'Test agent.' } } as RuntimeInfo
  const effort: ConfigOption = { id: 'effort', label: 'Effort', category: 'thought_level', type: 'select',
    currentValue: 'max', choices: [{ value: 'max', label: 'Max' }] }
  const snapshot: AppSnapshot = { ...emptySnapshot(), status: 'open', runtimes: [runtime], activeRuntime: runtime.id,
    draftOptions: [model, effort] }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><ModelControl /></StoreProvider>))
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  expect(trigger.textContent).toContain('Max')
  expect(trigger.title).toBe('Model and reasoning')
  click(trigger)
  expect(document.querySelector('[role="menu"]')?.querySelector('[data-slot="chip"]')).toBeNull()
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Auto window')
})
