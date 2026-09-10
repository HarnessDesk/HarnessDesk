import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type FileMatch, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'

/**
 * A file picked from `@` on a line of its own.
 *
 * The strip behind the pick kept a space and nothing else, so `@rea` typed on
 * a second line took the line break with it when `read.ts` was picked, and the
 * two lines ran together (#87). The helper has its own tests; this drives the
 * pick the way a person does — type, wait for the search, Enter — and reads
 * the draft back out of the box.
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

const KEY = sessionKey('alpha', 's1')
const READ: FileMatch = { path: '/w/src/read.ts', relativePath: 'src/read.ts', score: 1 }

const request = vi.fn(async (method: string) => (method === 'workspace/files' ? [READ] : {}))

const mount = (): void => {
  const runtime = {
    id: 'alpha',
    name: 'Alpha Agent',
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
        <Composer onChooseProject={() => {}} />
      </StoreProvider>,
    )
  })
}

const box = (): HTMLTextAreaElement => container.querySelector('textarea') as HTMLTextAreaElement

/* Through the prototype's setter, which is what a keystroke does — assigning
   `.value` directly is a change React never hears. */
const type = (text: string): void => {
  const node = box()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('no value setter on HTMLTextAreaElement — typing would be a no-op')
  setter.call(node, text)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

const press = (key: string): void => {
  box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

/** The file search is debounced by 90ms and then answered by the host. */
const settled = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
}

it('a file picked from @ on its own line keeps the line break', async () => {
  mount()
  act(() => type('first line\n@rea'))
  await settled()
  expect(request).toHaveBeenCalledWith('workspace/files', expect.objectContaining({ query: 'rea' }))
  expect(container.querySelector('[role="option"]')?.textContent).toContain('read.ts')

  act(() => press('Enter'))
  // The pick is a chip, and the draft is the words minus the token — with the
  // line break the token stood on still in it.
  expect(container.querySelector('button[aria-label="Remove read.ts"]')).not.toBeNull()
  expect(box().value).toBe('first line\n')
})
