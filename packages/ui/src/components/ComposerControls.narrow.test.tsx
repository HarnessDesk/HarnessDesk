import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionId, sessionKey, type ConfigOption, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import foundationTokens from '../design/foundation/tokens.css?raw'
import { PaneProvider, StoreProvider } from '../state/context'
import { ComposerGap, ComposerTools } from '../design'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ModeControl, ModelControl, PermissionControl } from './ComposerControls'

/**
 * The composer's controls as the toolbar narrows.
 *
 * Controls fold one at a time in the shared order. The fake observer gives
 * the toolbar its measured width; token values and the toolbar gap model the
 * foundation styles that jsdom does not load.
 *
 * jsdom lays nothing out, so the toolbar is as wide as this file says.
 */

vi.mock('../design', async (importOriginal) => ({ ...(await importOriginal<typeof import('../design')>()), Button: () => null, Dialog: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let width = 1000
const watching = new Set<Measured>()
const tokenValue = (name: string): number => {
  const matches = [...foundationTokens.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))]
  const match = /-wide$|-folded$/.test(name) ? matches.at(-1) : matches[0]
  if (!match) throw new Error(`Missing token ${name}`)
  const value = match[1]!.trim()
  const reference = value.match(/^var\((--[\w-]+)\)$/)
  return reference ? tokenValue(reference[1]!) : Number.parseFloat(value)
}
const wideTracks = ['add', 'work-in', 'agent', 'permissions', 'mode', 'extension', 'more', 'context', 'model', 'send']
const foldOrder = ['agent', 'more', 'context', 'mode', 'permissions', 'model']
const toolbarGap = tokenValue('--hd-space-1-5')
const wideToken = (track: string): string =>
  `--hd-composer-track-${track}${['permissions', 'mode', 'context'].includes(track) ? '-wide' : ''}`
const foldThreshold = (target: string): number => {
  const widths = new Map(wideTracks.map((track) => [
    track,
    tokenValue(wideToken(track)),
  ]))
  widths.set('extension', tokenValue('--hd-composer-track-extension-empty'))
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
  const trackTokens = new Set([...foundationTokens.matchAll(/(--hd-composer-track-[\w-]+):/g)].map(([, token]) => token!))
  for (const token of trackTokens) {
    document.body.style.setProperty(token, `${tokenValue(token)}px`)
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
  {
    id: 'mode',
    label: 'Mode',
    description: 'How the agent works',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    choices: [{ value: 'default', label: 'Default' }],
  },
] as unknown as readonly ConfigOption[]

const draw = (at: number, layout: 'draft' | 'live' = 'draft', populatedExtension = false, declaredOptions = options): void => {
  width = at
  const key = sessionKey(agent.id, sessionId('narrow-test'))
  const liveSession = {
    id: sessionId('narrow-test'), runtime: agent.id, cwd: '/repo', status: { type: 'idle' },
    createdAt: 1, updatedAt: 1, turns: [], itemsLoaded: true, options: declaredOptions,
  } as unknown as Session
  let snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [agent],
    activeRuntime: agent.id,
    draftOptions: declaredOptions,
    ...(layout === 'live' ? { activeSessionKey: key, sessions: new Map([[key, liveSession]]) } : {}),
  }
  const listeners = new Set<() => void>()
  testStore = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    setOption: vi.fn(async (id: string, value: string) => {
      snapshot = { ...snapshot, draftOptions: snapshot.draftOptions!.map((option) => option.id === id ? { ...option, currentValue: value } as ConfigOption : option) }
      for (const listener of listeners) listener()
    }),
  } as unknown as AppStore
  const toolbar = (
    <ComposerTools data-composer-layout={layout} style={{ gap: `${toolbarGap}px` }}>
      <PermissionControl />
      <ModeControl />
      <span data-composer-track="extension">{populatedExtension ? '◇' : null}</span>
      <ComposerGap />
      <ModelControl />
    </ComposerTools>
  )
  act(() => {
    root.render(
      <StoreProvider store={testStore}>
        <PaneProvider scope={{ paneId: 'narrow-test', view: { kind: 'conversation', session: key }, sessionKey: layout === 'live' ? key : null }}>
          {toolbar}
        </PaneProvider>
      </StoreProvider>,
    )
  })
  const toolbarNode = container.querySelector<HTMLElement>('[data-slot="composer-tools"]')
  if (!toolbarNode) throw new Error('no composer toolbar')
  toolbarNode.getBoundingClientRect = () => ({ width } as DOMRect)
  resize(at)
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

  resize(permissionsAt)
  expect(model().textContent).toContain('Small')
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

it('keeps a chosen permission mode label in a draft when the redundant permission slot is absent', async () => {
  const mode: ConfigOption = {
    id: 'mode', label: 'Mode', description: 'Session permission mode', category: 'mode', type: 'select',
    currentValue: 'default', choices: [{ value: 'default', label: 'Manual' }, { value: 'acceptEdits', label: 'Accept edits' }],
  }
  // A draft has one more control than a live conversation. The permission
  // mode must not pay for a second permission control that has nothing to say.
  draw(foldThreshold('mode') - 1, 'draft', false, [...options.filter((option) => option.category !== '_permissions' && option.category !== 'mode'), mode])
  const track = () => container.querySelector<HTMLElement>('[data-composer-track="mode"]')!
  click(track().querySelector('button')!)
  const acceptEdits = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((row) => row.textContent?.includes('Accept edits'))!
  await act(async () => { acceptEdits.click() })
  expect(testStore.setOption).toHaveBeenCalledWith('mode', 'acceptEdits')
  expect(track().querySelector('button')?.textContent).toContain('Accept edits')
  expect(track().hasAttribute('data-folded')).toBe(false)

  // Folding past the absent Permissions slot must not count it again.
  const modelAt = foldThreshold('model') - tokenValue('--hd-composer-track-permissions-folded') - toolbarGap
  resize(modelAt)
  expect(model().textContent).toContain('Small')
  resize(modelAt - 1)
  expect(model().textContent?.trim()).toBe('')
  const allFoldedAt = modelAt - tokenValue('--hd-composer-track-model') + tokenValue('--hd-composer-track-model-folded')
  resize(allFoldedAt)
  expect(container.querySelector('[data-composer-track="model"]')?.hasAttribute('data-tight')).toBe(false)
  resize(allFoldedAt - 1)
  expect(container.querySelector('[data-composer-track="model"]')?.hasAttribute('data-tight')).toBe(true)
})

it('keeps the selected Mode fact whole at a 560px live toolbar width', () => {
  draw(560, 'live')
  const track = container.querySelector<HTMLElement>('[data-composer-track="mode"]')
  expect(track?.querySelector('[data-slot="chip-words"] > span:not(.sr-only)')?.textContent).toBe('Default')
})

it('uses the Mode mark instead of a clipped initial after the fact folds', () => {
  draw(300)
  const track = container.querySelector<HTMLElement>('[data-composer-track="mode"]')
  const chip = track?.querySelector<HTMLElement>('[data-slot="chip"]')
  expect(track?.hasAttribute('data-folded')).toBe(true)
  if (chip) {
    expect(chip.title).toBe('Default')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(chip.querySelector('.sr-only')?.textContent).toBe('Default')
  }
})

it('reserves the populated Extension track width even when the track is empty', () => {
  // Draft Model folds at 588px with the reserved Extension track, but at
  // 556px if the empty track is incorrectly counted as zero.
  const at = 570
  draw(at, 'draft', false)
  const emptyFolded = container.querySelector('[data-composer-track="model"]')?.hasAttribute('data-folded')
  draw(at, 'draft', true)
  const populatedFolded = container.querySelector('[data-composer-track="model"]')?.hasAttribute('data-folded')
  expect(emptyFolded).toBe(true)
  expect(populatedFolded).toBe(true)
})

/**
 * Above the fold nobody is the exception either — in the other direction.
 * The model says its name and so does its neighbour; they fold together only
 * after the selected choice values have had their room.
 */
it('keeps every control’s words, the model’s among them, while there is room', () => {
  draw(720)
  expect(triggers()).toHaveLength(2)
  for (const trigger of triggers()) expect(trigger.textContent?.trim()).not.toBe('')
  const permission = triggers().find((trigger) => /what the agent may do/i.test(trigger.title))
  expect(permission?.textContent).toContain('Ask first')
  expect(model().textContent).toContain('Small')
})

it('puts boolean auto-approval in the permission control', () => {
  draw(700, 'live')
  const permission = triggers().find((trigger) => /what the agent may do/i.test(trigger.title))
  expect(permission).toBeDefined()
  click(permission!)

  const toggle = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((button) =>
    button.textContent?.includes('Auto-approve tools'),
  )
  expect(toggle).toBeDefined()
  click(toggle!)
  expect(testStore.setOption).toHaveBeenCalledWith('auto_approve', true, sessionKey(agent.id, sessionId('narrow-test')))
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

it('declares selected-value aliases where their target token is defined', () => {
  const blocks = [...foundationTokens.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
  for (const name of ['--hd-composer-track-context-wide', '--hd-composer-track-context-folded', '--hd-composer-track-context-tight']) {
    const block = blocks.filter(([, , content]) => content!.includes(name + ':')).at(-1)!
    const selector = block[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    expect(selector).toBe('body')
  }
})
