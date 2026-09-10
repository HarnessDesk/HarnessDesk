import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommandPalette } from './CommandPalette'

/**
 * "Start with <agent>" promises a conversation.
 *
 * Choosing the agent is a preference that leaves the screen alone, so the
 * palette has to open the draft itself — for the agent it just chose, and
 * for the one that was already chosen. Pinned because the old switch opened
 * the draft as a side effect, and a row that only set a preference would
 * read as a dead row.
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

const CODEX = runtimeId('codex')
const CLAUDE = runtimeId('claude-code')

const runtime = (id: string, name: string): RuntimeInfo =>
  ({ id, name, capabilities: {}, presentation: { name } }) as unknown as RuntimeInfo

const mount = async (): Promise<{ selectRuntime: ReturnType<typeof vi.fn>; newDraft: ReturnType<typeof vi.fn> }> => {
  const selectRuntime = vi.fn(async () => {})
  const newDraft = vi.fn()
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [runtime(CODEX, 'OpenAI Codex'), runtime(CLAUDE, 'Claude Code')],
    activeRuntime: CODEX,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async () => ({ data: [], nextCursor: null })) },
    selectRuntime,
    newDraft,
  } as unknown as AppStore
  const host = { close: () => {}, chooseFolder: () => {}, openSettings: () => {}, openUsage: () => {} }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={host} />
      </StoreProvider>,
    )
  })
  return { selectRuntime, newDraft }
}

const type = (value: string): void => {
  const field = container.querySelector('input')
  if (!field) throw new Error('no palette input')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const row = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) =>
    node.textContent?.includes(label),
  )
  if (!found) throw new Error(`no row reading “${label}”`)
  return found
}

it('starting with another agent chooses it and opens a draft', async () => {
  const { selectRuntime, newDraft } = await mount()
  type('start with claude')
  act(() => row('Start with Claude Code').click())
  expect(selectRuntime).toHaveBeenCalledWith(CLAUDE)
  expect(newDraft).toHaveBeenCalledOnce()
})

it('starting with the agent already chosen opens the draft and chooses nothing', async () => {
  const { selectRuntime, newDraft } = await mount()
  type('start with codex')
  const current = row('Start with OpenAI Codex')
  expect(current.textContent).toContain('current')
  act(() => current.click())
  expect(selectRuntime).not.toHaveBeenCalled()
  expect(newDraft).toHaveBeenCalledOnce()
})
