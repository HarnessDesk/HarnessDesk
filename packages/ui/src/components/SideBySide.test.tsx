import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import { sessionKey, type SessionKey } from '@harnessdesk/protocol'
import { PaneProvider, usePane } from '../state/context'
import { emptySideBySide, type SideBySideState } from '../lib/side-by-side'
import { SideBySide } from './SideBySide'

vi.mock('./Conversation', () => ({
  Conversation: ({ header }: { header?: boolean }) => {
    const pane = usePane()
    return <div data-testid="conversation-body" data-pane-id={pane?.paneId} data-session-key={pane?.sessionKey} data-header={String(header ?? true)}>
      <input aria-label="Message" />
    </div>
  },
}))

vi.mock('./Approvals', () => ({ Approvals: () => <div data-testid="approvals" /> }))
vi.mock('../state/context', async (load) => {
  const actual = await load<typeof import('../state/context')>()
  return { ...actual, useIsFocusedPane: () => true }
})

let measuredWidth = 1200
const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
  if (this.getAttribute('data-slot') === 'side-by-side-grid') {
    return { x: 0, y: 0, top: 0, left: 0, right: measuredWidth, bottom: 700, width: measuredWidth, height: 700, toJSON: () => ({}) } as DOMRect
  }
  return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect
})
let container: HTMLDivElement
let root: Root | null
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  rect.mockClear()
})

const keys = [sessionKey('codex', 'one'), sessionKey('claude', 'two'), sessionKey('cursor', 'three')] as SessionKey[]
const nicknames = ['Alpha', 'Beta', 'Gamma']
const members = new Map(keys.map((key, index) => [key, { nickname: nicknames[index]!, agent: `Agent ${index + 1}`, model: `Model ${index + 1}` }]))
const entries = new Map(keys.map((key, index) => [key, {
  key,
  peer: { nickname: nicknames[index], runtime: 'codex', inbound: 'accept' },
  brand: index === 0 ? 'codex' : null,
  tint: 'blue',
  busy: index === 0,
  waitingForYou: index === 1,
  here: true,
  canUseBoard: true,
  idleOnBoard: false,
  onTask: null,
  title: null,
  ceiling: null,
} as never]))

const baseState = (tileKeys = keys.slice(0, 2)): SideBySideState => ({
  ...emptySideBySide(),
  tiles: tileKeys,
  focused: tileKeys[0] ?? null,
  seen: tileKeys,
})

const mount = (initial = baseState(), opts: { width?: number; onOpenMember?: (key: SessionKey) => void } = {}) => {
  const opened = opts.onOpenMember ?? vi.fn()
  measuredWidth = opts.width ?? 1200
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Harness initial={initial} onOpenMember={opened} />))
  return { container, root: root!, opened }
}

const click = (element: Element): void => act(() => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const text = (target: ParentNode, content: string): HTMLElement => {
  const element = [...target.querySelectorAll<HTMLElement>('*')].find((node) => node.textContent?.trim() === content)
  if (!element) throw new Error(`Could not find text: ${content}`)
  return element
}

const Harness = ({ initial, onOpenMember }: {
  initial: SideBySideState
  onOpenMember: (key: SessionKey) => void
}) => {
  const [state, setState] = useState(initial)
  return <SideBySide
    state={state}
    onChange={setState}
    paneId="room-pane"
    memberOf={(key) => members.get(key)}
    entryOf={(key) => entries.get(key) ?? null}
    onOpenMember={onOpenMember}
    conversationProps={{ onChooseProject: vi.fn(), onSignIn: vi.fn(), onOpenUsage: vi.fn(), onOpenRuntimes: vi.fn() }}
  />
}

it('renders one tile per member in order and marks focus and hidden state', () => {
  mount({ ...baseState(), focused: keys[1]!, expanded: keys[1]! })
  const tiles = [...document.querySelectorAll<HTMLElement>('[data-slot="side-by-side-tile"]')]
  expect(tiles.map((tile) => tile.dataset.sessionKey)).toEqual(keys.slice(0, 2))
  expect(tiles[0]?.hasAttribute('data-focused')).toBe(false)
  expect(tiles[1]?.hasAttribute('data-focused')).toBe(true)
  expect(tiles[0]?.hasAttribute('data-hidden')).toBe(true)
  expect(tiles[1]?.hasAttribute('data-hidden')).toBe(false)
})

it('renders the member header, full nickname, state, expand control and grid menu', () => {
  const { opened } = mount()
  const first = document.querySelector<HTMLElement>('[data-slot="side-by-side-tile"]')!
  const header = first.querySelector('header')!
  expect(header.querySelector('[data-slot="icon-tile"] svg')).not.toBeNull()
  const name = text(header, 'Alpha')
  expect(name.dataset.role).toBe('row')
  expect(name.className).not.toMatch(/truncate|text-ellipsis/)
  expect(text(header, 'Agent 1 · Model 1').dataset.role).toBe('meta')
  expect(text(header, 'Working')).toBeTruthy()
  expect(header.querySelector('button[aria-label="Expand Alpha"]')?.getAttribute('aria-pressed')).toBe('false')
  click(header.querySelector('button[aria-label="Alpha actions"]')!)
  const menu = document.body.querySelector('[role="menu"]')!
  expect(text(menu, 'Open conversation')).toBeTruthy()
  expect(text(menu, 'Pin to the grid')).toBeTruthy()
  expect(text(menu, 'Take off the grid')).toBeTruthy()
  click(text(menu, 'Open conversation'))
  expect(opened).toHaveBeenCalledWith(keys[0])
  click(header.querySelector('button[aria-label="Alpha actions"]')!)
  click(text(document.body.querySelector('[role="menu"]')!, 'Pin to the grid'))
  click(header.querySelector('button[aria-label="Alpha actions"]')!)
  const pinned = document.body.querySelector('[role="menu"]')!
  expect(text(pinned, 'Unpin')).toBeTruthy()
  click(text(pinned, 'Unpin'))
  click(header.querySelector('button[aria-label="Alpha actions"]')!)
  click(text(document.body.querySelector('[role="menu"]')!, 'Take off the grid'))
  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(1)
  expect(text(container, 'Waiting for you')).toBeTruthy()
})

it('mounts the existing conversation and approvals in each tile scope', () => {
  mount()
  const bodies = [...document.querySelectorAll<HTMLElement>('[data-testid="conversation-body"]')]
  expect(bodies.map((body) => body.dataset.paneId)).toEqual(keys.slice(0, 2).map((key) => `room-pane:${key}`))
  expect(bodies.map((body) => body.dataset.sessionKey)).toEqual(keys.slice(0, 2))
  expect(document.querySelectorAll('[data-testid="approvals"]')).toHaveLength(2)
  // The tile's bar is its one header; the conversation's own is left out.
  expect(bodies.map((body) => body.dataset.header)).toEqual(['false', 'false'])
})

it('clicking a tile focuses it without taking focus from an input inside it', () => {
  mount()
  const tiles = [...document.querySelectorAll<HTMLElement>('[data-slot="side-by-side-tile"]')]
  click(tiles[1]!)
  expect(tiles[1]?.hasAttribute('data-focused')).toBe(true)
  const input = tiles[0]!.querySelector<HTMLInputElement>('input[aria-label="Message"]')!
  input.focus()
  click(input)
  expect(document.activeElement).toBe(input)
})

it('expands a tile, keeps the others mounted, and Escape returns to the grid', () => {
  mount()
  click(container.querySelector('button[aria-label="Expand Alpha"]')!)
  const tiles = [...document.querySelectorAll<HTMLElement>('[data-slot="side-by-side-tile"]')]
  expect(tiles).toHaveLength(2)
  expect(tiles[0]?.hasAttribute('data-focused')).toBe(true)
  expect(tiles[1]?.hasAttribute('data-hidden')).toBe(true)
  const consumeEscape = (event: KeyboardEvent): void => event.preventDefault()
  tiles[0]!.addEventListener('keydown', consumeEscape, { capture: true, once: true })
  act(() => { tiles[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(tiles[1]?.hasAttribute('data-hidden')).toBe(true)
  act(() => { tiles[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(tiles[1]?.hasAttribute('data-hidden')).toBe(false)
})

it('shows a nickname tab strip when narrow and uses it to focus a tile', () => {
  mount(baseState(), { width: 400 })
  const tabs = container.querySelector('[role="tablist"]')!
  expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(2)
  expect(tabs.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Alpha')
  click(text(tabs, 'Beta'))
  expect(tabs.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Beta')
  const shown = [...container.querySelectorAll<HTMLElement>('[data-slot="side-by-side-tile"]')].find((tile) => tile.dataset.sessionKey === keys[1])
  expect(shown?.hasAttribute('data-hidden')).toBe(false)
})

it('routes tile keys to focus and toggle expansion only while mounted', () => {
  const view = mount()
  act(() => { window.dispatchEvent(new CustomEvent('hd-side-by-side', { detail: 'tile-2' })) })
  expect(document.querySelectorAll('[data-slot="side-by-side-tile"]')[1]?.hasAttribute('data-focused')).toBe(true)
  act(() => { window.dispatchEvent(new CustomEvent('hd-side-by-side', { detail: 'tile-expand' })) })
  expect(document.querySelectorAll('[data-slot="side-by-side-tile"]')[1]?.hasAttribute('data-hidden')).toBe(false)
  act(() => { window.dispatchEvent(new CustomEvent('hd-side-by-side', { detail: 'tile-expand' })) })
  act(() => { window.dispatchEvent(new CustomEvent('hd-side-by-side', { detail: 'tile-1' })) })
  expect(document.querySelectorAll('[data-slot="side-by-side-tile"]')[0]?.hasAttribute('data-focused')).toBe(true)
  act(() => view.root.unmount())
  act(() => { window.dispatchEvent(new CustomEvent('hd-side-by-side', { detail: 'tile-1' })) })
  expect(document.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(0)
})
