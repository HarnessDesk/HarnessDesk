import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionId, sessionKey, type ConfigOption, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import foundationTokens from '../design/foundation/tokens.css?raw'
import { PaneProvider, StoreProvider } from '../state/context'
import { ComposerGap, ComposerTools } from '../design'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ModelControl, PermissionControl } from './ComposerControls'

/**
 * The composer's controls as the toolbar narrows.
 *
 * Controls fold one at a time in a token-sized order. The fake observer gives
 * the toolbar its measured width; token values and the 6px toolbar gap model
 * the foundation styles that jsdom does not load.
 *
 * jsdom lays nothing out, so the toolbar is as wide as this file says.
 */

vi.mock('../design', async (importOriginal) => ({ ...(await importOriginal<typeof import('../design')>()), Button: () => null, Dialog: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let width = 1000
const watching = new Set<Measured>()
const tokenValue = (name: string): number => {
  const match = foundationTokens.match(new RegExp(`${name}:\\s*([\\d.]+)px`))
  if (!match) throw new Error(`Missing token ${name}`)
  return Number(match[1])
}
const wideTracks = ['add', 'work-in', 'agent', 'permissions', 'mode', 'extension', 'more', 'context', 'model', 'send']
const foldOrder = ['agent', 'work-in', 'more', 'mode', 'permissions', 'model']
const toolbarGap = tokenValue('--hd-space-1-5')
const foldThreshold = (target: string): number => {
  const widths = new Map(wideTracks.map((track) => [
    track,
    tokenValue(`--hd-composer-track-${track}`),
  ]))
  const gaps = wideTracks.length * toolbarGap
  for (const track of foldOrder) {
    const threshold = [...widths.values()].reduce((sum, one) => sum + one, gaps)
    if (track === target) return threshold
    widths.set(track, tokenValue(`--hd-composer-track-${track}-folded`))
  }
  throw new Error(`No fold step for ${target}`)
}

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
let testStore: AppStore

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Measured)
  for (const [, token, value] of foundationTokens.matchAll(/(--hd-composer-track-[\w-]+):\s*([\d.]+px)/g)) {
    document.body.style.setProperty(token!, value!)
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.removeAttribute('style')
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
  {
    id: 'auto_approve',
    label: 'Auto-approve tools',
    category: '_permissions',
    type: 'boolean',
    currentValue: false,
  },
] as unknown as readonly ConfigOption[]

const draw = (at: number, layout: 'draft' | 'live' = 'draft', populatedExtension = false): void => {
  width = at
  const key = sessionKey(agent.id, sessionId('narrow-test'))
  const liveSession = {
    id: sessionId('narrow-test'), runtime: agent.id, cwd: '/repo', status: { type: 'idle' },
    createdAt: 1, updatedAt: 1, turns: [], itemsLoaded: true, options,
  } as unknown as Session
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [agent],
    activeRuntime: agent.id,
    draftOptions: options,
    ...(layout === 'live' ? { activeSessionKey: key, sessions: new Map([[key, liveSession]]) } : {}),
  }
  testStore = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setOption: vi.fn(async () => {}),
  } as unknown as AppStore
  const toolbar = (
    <ComposerTools data-composer-layout={layout} style={{ gap: `${toolbarGap}px` }}>
      <PermissionControl />
      <span data-composer-track="extension">{populatedExtension ? '◇' : null}</span>
      <ComposerGap />
      <ModelControl />
    </ComposerTools>
  )
  act(() => {
    root.render(
      <StoreProvider store={testStore}>
        <PaneProvider scope={{ paneId: 'narrow-test', view: { kind: 'conversation', session: key }, sessionKey: key }}>
          {toolbar}
        </PaneProvider>
      </StoreProvider>,
    )
  })
}

const triggers = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]'),
]
const model = (): HTMLButtonElement => {
  const found = triggers().find((trigger) => /model and reasoning/i.test(trigger.title))
  if (!found) throw new Error('no model control')
  return found
}

const click = (element: Element): void => {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
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

/** The computed track sums are boundaries, so cover both sides of each one. */
it('folds Permissions and then Model at the sums of their preceding tracks', () => {
  const permissionsAt = foldThreshold('permissions')
  const modelAt = foldThreshold('model')
  draw(permissionsAt + 1)
  expect(triggers()).toHaveLength(2)
  expect(model().textContent).toContain('Small')
  expect(triggers().find((trigger) => /what the agent may do/i.test(trigger.title))?.textContent).toContain('Ask first')

  resize(permissionsAt - 1)
  expect(model().textContent).toContain('Small')
  expect(triggers().find((trigger) => /what the agent may do/i.test(trigger.title))?.textContent?.trim()).toBe('')

  resize(modelAt)
  expect(model().textContent).toContain('Small')
  resize(modelAt - 1)
  expect(model().textContent?.trim()).toBe('')
  expect(model().title).toBe('Small · medium — model and reasoning')

  // The step moves back when the toolbar widens again.
  resize(modelAt)
  expect(model().textContent).toContain('Small')
})

it('recomputes fold steps when one toolbar switches between draft and live at a fixed width', () => {
  draw(560, 'draft')
  expect(model().textContent?.trim()).toBe('')

  draw(560, 'live')
  expect(model().textContent).toContain('Small')

  draw(560, 'draft')
  expect(model().textContent?.trim()).toBe('')
})

it('reserves the populated Extension track width even when the track is empty', () => {
  const at = 560
  draw(at, 'draft', false)
  const emptyFolded = triggers().map((trigger) => trigger.textContent?.trim())
  draw(at, 'draft', true)
  const populatedFolded = triggers().map((trigger) => trigger.textContent?.trim())
  expect(populatedFolded).toEqual(emptyFolded)
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

it('puts boolean auto-approval in the permission control', () => {
  draw(700)
  const permission = triggers().find((trigger) => /what the agent may do/i.test(trigger.title))
  expect(permission).toBeDefined()
  click(permission!)

  const toggle = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((button) =>
    button.textContent?.includes('Auto-approve tools'),
  )
  expect(toggle).toBeDefined()
  click(toggle!)
  expect(testStore.setOption).toHaveBeenCalledWith('auto_approve', true)
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

  // A 360px box leaves 342px inside the toolbar after its padding. All folded
  // tracks still need the tight token there, so chevrons disappear as well.
  resize(342)
  expect(glyphs()).toEqual([1, 1])

  // And back, as the window widens again.
  resize(700)
  expect(glyphs()).toEqual([2, 2])
  expect(model().textContent).toContain('Small')
})

it('centres tight controls without letting their glyphs shrink', () => {
  draw(342)

  for (const trigger of triggers()) {
    expect(trigger.className).toContain('px-0')
    expect(trigger.className).toContain('justify-center')
    expect(trigger.className).toContain('[&_svg]:shrink-0')
  }
})
