import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  contributionId,
  pluginInstanceId,
  sessionKey,
  type CapabilityContribution,
  type RuntimeInfo,
  type Session,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'

/**
 * A context chip that resolves to an image — the screenshot chip. The
 * contract: the picture reaches an agent that accepts images as an `image`
 * part beside the provider's text, and an agent that cannot look gets the
 * text with the omission named — never a message silently missing what its
 * chip promised.
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

const SHOT: CapabilityContribution = {
  kind: 'context',
  id: contributionId('ctx-shot'),
  owner: pluginInstanceId('browser#1'),
  revision: 0,
  scope: { kind: 'global' },
  label: 'Current page screenshot',
  form: 'resource',
  chip: { description: 'What the browser shows right now, as an image.' },
}

const RESOLVED = {
  label: 'Current page screenshot',
  text: 'The browser is on Example — https://example.test.',
  image: { dataUrl: 'data:image/png;base64,AAAA', name: 'Example' },
}

const queue = vi.fn(async (_content: unknown, _key?: unknown) => true)
const notice = vi.fn()
const request = vi.fn(async () => RESOLVED)

const mount = (imageInput: boolean, activeRuntime?: string): void => {
  const runtime = {
    id: 'alpha',
    name: 'Alpha Agent',
    capabilities: { steer: false, imageInput } as RuntimeInfo['capabilities'],
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
    activeRuntime: (activeRuntime ?? runtime.id) as AppSnapshot['activeRuntime'],
    health: { state: 'ready' } as AppSnapshot['health'],
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
    sessions: new Map([[KEY, session]]),
    activeSessionKey: KEY,
    contributions: [SHOT],
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    queue,
    steer: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(),
    notice,
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

const click = (element: Element | null | undefined): void => {
  if (!element) throw new Error('nothing to click')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const attachShot = (): void => {
  click(container.querySelector('button[title="Add"]'))
  // The popover portals to document.body, so the search must too.
  const item = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Current page screenshot'),
  )
  click(item)
}

const send = async (): Promise<void> => {
  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('no textarea')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, 'why does it look like this')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  queue.mockClear()
  notice.mockClear()
  request.mockClear()
})

describe('a chip that resolves to an image', () => {
  it('sends the picture beside the text to an agent that accepts images', async () => {
    mount(true)
    attachShot()
    await send()
    expect(request).toHaveBeenCalledWith('context/resolve', expect.objectContaining({ id: 'ctx-shot' }))
    expect(queue).toHaveBeenCalledTimes(1)
    const content = queue.mock.calls[0]?.[0] as unknown as { type: string; text?: string; url?: string; name?: string }[]
    expect(content.map((part) => part.type)).toEqual(['text', 'image', 'text'])
    expect(content[0]?.text).toContain('The browser is on Example')
    expect(content[1]?.url).toBe('data:image/png;base64,AAAA')
    expect(content[1]?.name).toBe('Example')
  })

  it('names the omission for an agent that cannot look, instead of dropping it silently', async () => {
    mount(false)
    attachShot()
    await send()
    expect(queue).toHaveBeenCalledTimes(1)
    const content = queue.mock.calls[0]?.[0] as unknown as { type: string; text?: string }[]
    expect(content.map((part) => part.type)).toEqual(['text', 'text'])
    // `brandOf` shortens "Alpha Agent" to its brand name in composer copy.
    expect(content[0]?.text).toContain('A screenshot was taken, but Alpha does not accept images')
  })
})

describe('which conversation a chip is resolved for', () => {
  it('pairs the runtime and the session id from the same conversation', async () => {
    mount(true)
    attachShot()
    await send()
    expect(request).toHaveBeenCalledWith(
      'context/resolve',
      expect.objectContaining({ id: 'ctx-shot', runtime: 'alpha', sessionId: 's1' }),
    )
  })

  it("does not pair the app's active runtime with another agent's conversation", async () => {
    // Opening a conversation from the sidebar does not change the app's active
    // runtime, so the two genuinely disagree — `Sidebar.tsx` derives the agent
    // from the focused key for exactly this reason. A provider that keys its
    // state by runtime and session would be asked about a conversation that
    // never existed: `beta\0s1` where the work was recorded under `alpha\0s1`.
    mount(true, 'beta')
    attachShot()
    await send()
    expect(request).toHaveBeenCalledWith(
      'context/resolve',
      expect.objectContaining({ runtime: 'alpha', sessionId: 's1' }),
    )
  })
})

