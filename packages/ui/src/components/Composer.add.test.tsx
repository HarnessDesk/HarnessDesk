import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'

/** Drive Add's actual handlers through its canonical menu boundary. */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  chooseProject.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const KEY = sessionKey('alpha', 's1')

const request = vi.fn(async () => [])
const chooseProject = vi.fn()

const mount = (): void => {
  const runtime = {
    id: 'alpha',
    name: 'Legacy Agent',
    capabilities: { steer: false, imageInput: false } as RuntimeInfo['capabilities'],
    presentation: { name: 'Alpha Agent' },
  } as RuntimeInfo
  const session = {
    id: 's1',
    runtime: 'alpha',
    cwd: '/w',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
  } as unknown as Session
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    runtimes: [runtime],
    activeRuntime: runtime.id as AppSnapshot['activeRuntime'],
    health: { state: 'ready' } as AppSnapshot['health'],
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
    sessions: new Map([[KEY, session]]),
    activeSessionKey: KEY,
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    queue: vi.fn(async () => true),
    steer: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(),
    notice: vi.fn(),
    runCommand: vi.fn(async () => true),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Composer onChooseProject={chooseProject} />
      </StoreProvider>,
    )
  })
}

const box = (): HTMLTextAreaElement => container.querySelector('textarea') as HTMLTextAreaElement
const openAdd = async (): Promise<void> => {
  mount()
  await act(async () => { container.querySelector<HTMLButtonElement>('button[title="Add"]')!.click() })
}
const item = (label: string): HTMLElement => {
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.querySelector('[data-menu-label]')?.textContent === label)
  expect(row, label).toBeTruthy()
  return row!
}
const select = async (label: string): Promise<void> => {
  await act(async () => { item(label).click() })
  expect(document.querySelector('[role="menu"]')).toBeNull()
}

it('Add uses one complete icon level and exposes the image refusal without invoking the picker', async () => {
  await openAdd()
  const surface = document.querySelector('[data-popup-kind="menu"]')!
  expect(surface.getAttribute('data-menu-icons')).toBe('all')
  const rows = [...surface.querySelectorAll('[data-menu-row]')]
  expect(rows).toHaveLength(4)
  for (const row of rows) expect(row.querySelector('[data-menu-icon] svg')?.getAttribute('width')).toBe('16')
  const image = item('Attach images…')
  expect(image.getAttribute('aria-disabled')).toBe('true')
  expect(image.querySelector('[data-menu-hint]')?.textContent).toBe('Alpha Agent does not accept images.')
  const picker = vi.spyOn(container.querySelector<HTMLInputElement>('input[type="file"]')!, 'click')
  await act(async () => { image.click() })
  expect(picker).not.toHaveBeenCalled()
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
})
it('Add a file closes Add and begins the existing mention flow', async () => {
  await openAdd()
  expect(item('Add a file').querySelector('[data-menu-trailing]')?.textContent).toBe('@')
  await select('Add a file')
  expect(box().value).toBe('@')
  expect(document.activeElement).toBe(box())
})
it('Slash commands closes Add and begins the existing slash flow', async () => {
  await openAdd()
  expect(item('Slash commands').querySelector('[data-menu-trailing]')?.textContent).toBe('/')
  await select('Slash commands')
  expect(box().value).toBe('/')
  expect(document.activeElement).toBe(box())
})
it('Change project keeps its callback and closes Add', async () => {
  await openAdd()
  await select('Change project folder…')
  expect(chooseProject).toHaveBeenCalledTimes(1)
})
