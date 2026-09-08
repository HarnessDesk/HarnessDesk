import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionKey, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { noteKey, wrapContext } from '../lib/context-envelope'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'

/**
 * A block the desk composed for this message — the marks made on a page, on
 * their way over from the browser pane.
 *
 * The rule under test is whose the text box is: a person's. Context arrives
 * as a chip beside the box, travels in the same `<context source=…>`
 * envelope every other injection uses, and never appears as characters
 * someone has to scroll past or delete around.
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
const BLOCK = wrapContext('Page annotations', '# Page annotations:\n\n## Comment 1\nmake this wider')

const queue = vi.fn(async (_content: unknown, _key?: unknown) => true)

const mount = (): void => {
  const runtime = {
    id: 'alpha',
    name: 'Alpha Agent',
    capabilities: { steer: false, imageInput: true } as RuntimeInfo['capabilities'],
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
    activeRuntime: runtime.id,
    health: { state: 'ready' } as AppSnapshot['health'],
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
    sessions: new Map([[KEY, session]]),
    activeSessionKey: KEY,
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn() },
    queue,
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

/** What the browser pane hands over when the marks are added to a message. */
const handOver = (withImage = true): void => {
  act(() => {
    window.dispatchEvent(
      new CustomEvent('harnessdesk:compose', {
        detail: {
          text: '',
          attachments: [
            {
              name: 'Page annotations — 1 comment',
              path: noteKey('Page annotations', BLOCK),
              kind: 'note',
              text: BLOCK,
            },
            ...(withImage
              ? [{ name: 'Example — annotated', path: 'data:image/png;base64,AAAA', kind: 'image' }]
              : []),
          ],
        },
      }),
    )
  })
}

const type = (words: string): void => {
  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('no textarea')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, words)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const send = async (): Promise<void> => {
  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('no textarea')
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => queue.mockClear())

describe('a block the desk composed', () => {
  it('becomes a chip, and leaves the text box empty', () => {
    mount()
    handOver()
    const textarea = container.querySelector('textarea')
    expect(textarea?.value).toBe('')
    const chip = [...container.querySelectorAll('span')].find((node) =>
      node.textContent?.includes('Page annotations'),
    )
    expect(chip).toBeTruthy()
    // The block is a few thousand characters of envelope; the chip shows its
    // name and offers the first lines on hover, not the whole thing.
    expect(chip?.getAttribute('title')).toContain('Sent with your message')
    expect(chip?.getAttribute('title')).toContain('make this wider')
  })

  it('travels in the context envelope, ahead of its picture and the words', async () => {
    mount()
    handOver()
    type('have a look at this')
    await send()
    expect(queue).toHaveBeenCalledTimes(1)
    const content = queue.mock.calls[0]?.[0] as unknown as { type: string; text?: string; url?: string }[]
    expect(content.map((part) => part.type)).toEqual(['text', 'image', 'text'])
    expect(content[0]?.text).toBe(BLOCK)
    expect(content[1]?.url).toBe('data:image/png;base64,AAAA')
    expect(content[2]?.text).toBe('have a look at this')
  })

  it('is enough to send on its own — a page can be the whole message', async () => {
    mount()
    handOver(false)
    await send()
    expect(queue).toHaveBeenCalledTimes(1)
    const content = queue.mock.calls[0]?.[0] as unknown as { type: string; text?: string }[]
    expect(content.map((part) => part.type)).toEqual(['text'])
    expect(content[0]?.text).toBe(BLOCK)
  })

  it('can be taken back off the message, like anything else riding along', async () => {
    mount()
    handOver(false)
    type('never mind')
    const remove = [...container.querySelectorAll('button')].find((node) =>
      node.getAttribute('aria-label')?.startsWith('Remove Page annotations'),
    )
    act(() => remove?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await send()
    const content = queue.mock.calls[0]?.[0] as unknown as { type: string; text?: string }[]
    expect(content).toEqual([{ type: 'text', text: 'never mind' }])
  })

  it('acknowledges a hand-over, so the sender knows the chip landed', () => {
    mount()
    let received = 0
    act(() => {
      window.dispatchEvent(
        new CustomEvent('harnessdesk:compose', {
          detail: {
            text: '',
            attachments: [{ name: 'Page annotations — 1 comment', path: noteKey('Page annotations', BLOCK), kind: 'note', text: BLOCK }],
            onReceived: () => {
              received += 1
            },
          },
        }),
      )
    })
    expect(received).toBe(1)
    expect(container.textContent).toContain('Page annotations')
  })

})
