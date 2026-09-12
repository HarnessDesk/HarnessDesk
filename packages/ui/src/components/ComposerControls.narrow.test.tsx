import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ConfigOption, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ModelControl, PermissionControl } from './ComposerControls'

/**
 * The composer's controls as the toolbar narrows.
 *
 * Below 560px every control keeps its glyph and gives its words to the hover
 * text; below 320px — a phone — the chevron goes too. The model used to be the
 * exception to the first step, keeping its name as the one word a mark cannot
 * carry, and at a phone's width that name was then the one word clipped to its
 * first letters.
 *
 * jsdom lays nothing out, so the toolbar is as wide as this file says.
 */

vi.mock('../design', () => ({ Btn: () => null, Dialog: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let width = 1000
const watching = new Set<Measured>()

/* Reports the width when it starts watching, and again whenever `resize` says
   the toolbar moved — the two moments a real observer speaks. */
class Measured {
  constructor(private readonly report: ResizeObserverCallback) {}
  observe(): void {
    watching.add(this)
    this.tell()
  }
  tell(): void {
    this.report([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve(): void {}
  disconnect(): void {
    watching.delete(this)
  }
}

const resize = (to: number): void => {
  width = to
  act(() => {
    for (const observer of watching) observer.tell()
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Measured)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const agent: RuntimeInfo = {
  id: 'agent',
  name: 'Agent',
  capabilities: {},
  presentation: { name: 'Agent' },
} as unknown as RuntimeInfo

const options: readonly ConfigOption[] = [
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'small',
    choices: [
      { value: 'small', label: 'Small' },
      { value: 'large', label: 'Large' },
    ],
  },
  {
    id: 'effort',
    label: 'Reasoning',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    choices: [
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
    ],
  },
  {
    id: 'approval',
    label: 'Approval',
    category: '_permissions',
    type: 'select',
    currentValue: 'ask',
    choices: [
      { value: 'ask', label: 'Ask first' },
      { value: 'auto', label: 'Auto' },
    ],
  },
] as unknown as readonly ConfigOption[]

const draw = (at: number): void => {
  width = at
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [agent],
    activeRuntime: agent.id,
    draftOptions: options,
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setOption: vi.fn(async () => {}),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PermissionControl />
        <ModelControl />
      </StoreProvider>,
    )
  })
}

const triggers = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]'),
]
const model = (): HTMLButtonElement => {
  const found = triggers().find((trigger) => /model and reasoning/i.test(trigger.title))
  if (!found) throw new Error('no model control')
  return found
}

it('says the model, and how hard it thinks, when the toolbar has the room', () => {
  draw(700)
  expect(model().textContent).toContain('Small')
  expect(model().textContent).toContain('medium')
  expect(model().title).toBe('Model and reasoning')
})

it('folds the model’s name with every other word when the toolbar is narrow', () => {
  draw(500)
  // Both controls drew — an empty list would pass every assertion below.
  expect(triggers()).toHaveLength(2)
  // Every control down to its mark — the model no longer the one exception.
  for (const trigger of triggers()) expect(trigger.textContent?.trim()).toBe('')
  // The words go to the hover text, and with nothing else to name the trigger,
  // to its accessible name.
  expect(model().title).toBe('Small · medium — model and reasoning')
  expect(model().getAttribute('aria-label')).toBe('Small · medium — model and reasoning')
})

/**
 * The fold happens at the width the constant names, and nothing straddles it.
 *
 * #145 reported the model as the one control that kept its label when the rest
 * dropped to glyphs, and #192 settled it the way this file's other tests
 * describe — the name folds with the words. What nothing held was the *edge*:
 * both existing tests sit well clear of it (500 and 700), so the exception
 * could come back anywhere between them, or the threshold could move, without
 * a red. A boundary is the only place this rule can break quietly.
 */
it('folds at the width the constant names, and not a pixel earlier', () => {
  // 560 is the constant: narrow is `width < NARROW_TOOLBAR`, so the width
  // itself still has the room.
  draw(560)
  expect(triggers()).toHaveLength(2)
  expect(model().textContent).toContain('Small')
  expect(model().title).toBe('Model and reasoning')

  resize(559)
  // One pixel under, and the words are gone — the model's with them.
  for (const trigger of triggers()) expect(trigger.textContent?.trim()).toBe('')
  expect(model().title).toBe('Small · medium — model and reasoning')

  // And it is a threshold, not a one-way trip.
  resize(560)
  expect(model().textContent).toContain('Small')
})

/**
 * Above the fold nobody is the exception either — in the other direction.
 *
 * The narrow test asserts every control is down to its mark. This is the same
 * question asked of the wide side: the model says its name *and so does its
 * neighbour*, so a change that folded the model alone to buy room would be as
 * visible as the one that kept it alone.
 */
it('keeps every control’s words, the model’s among them, while there is room', () => {
  draw(700)
  expect(triggers()).toHaveLength(2)
  for (const trigger of triggers()) expect(trigger.textContent?.trim()).not.toBe('')
  // The permission control is the neighbour, saying its own current choice.
  const permission = triggers().find((trigger) => /what the agent may do/i.test(trigger.title))
  expect(permission?.textContent).toContain('Ask first')
  expect(model().textContent).toContain('Small')
})

it('keeps the chevrons while there is room for them, and folds them at a phone’s width', () => {
  draw(500)
  expect(triggers()).toHaveLength(2)
  const glyphs = (): number[] => triggers().map((trigger) => trigger.querySelectorAll('svg').length)
  // A mark and a chevron each.
  expect(glyphs()).toEqual([2, 2])

  resize(300)
  expect(glyphs()).toEqual([1, 1])
  expect(model().title).toBe('Small · medium — model and reasoning')

  // And back, as the window widens again.
  resize(700)
  expect(glyphs()).toEqual([2, 2])
  expect(model().textContent).toContain('Small')
})
