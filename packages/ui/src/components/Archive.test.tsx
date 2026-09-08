import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo, SessionSummary } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ArchiveSection } from './Archive'

/**
 * The archive page, and the two honesties it owes the user.
 *
 * It must ask for the archive rather than for everything and filter — a list
 * that quietly asked for the open sessions and looked for a flag nobody sets
 * is empty forever, and looks exactly like an empty archive. And it must say
 * *whose* archive it is showing, because a Codex thread archived here is
 * archived in Codex Desktop too, while a Claude Code conversation archived
 * here is still sitting in Claude Code's own list. Grouping by agent is what
 * lets it say that without being asked: the rail this page used to hang off
 * showed the sentence only after you scoped to one agent, so the view most
 * people saw never said it at all.
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

const runtime = (id: string, name: string, over: Record<string, boolean> = {}): RuntimeInfo =>
  ({
    id,
    name,
    capabilities: { archiveHistory: false, deleteHistory: false, ...over },
    presentation: { name },
  }) as unknown as RuntimeInfo

const summary = (id: string, runtimeId: string, cwd = '/repo/app'): SessionSummary =>
  ({
    id,
    runtime: runtimeId,
    title: `Conversation ${id}`,
    preview: null,
    cwd,
    status: { type: 'notLoaded' },
    createdAt: 1,
    updatedAt: 2,
    archived: true,
  }) as unknown as SessionSummary

const mount = async (
  runtimes: readonly RuntimeInfo[],
  rows: Readonly<Record<string, readonly SessionSummary[]>>,
): Promise<{ request: ReturnType<typeof vi.fn>; store: AppStore }> => {
  const request = vi.fn(async (_method: string, params: { runtime: string }) => ({
    data: rows[params.runtime] ?? [],
    nextCursor: null,
  }))
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtimes[0]?.id ?? null,
    runtimes: [...runtimes],
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    unarchiveSession: vi.fn(async () => {}),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <ArchiveSection />
      </StoreProvider>,
    )
  })
  return { request, store }
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label))

const type = (value: string): void => {
  const field = container.querySelector('input')
  if (!field) throw new Error('no search field')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('asks each agent for the archive itself, not for everything', async () => {
  const codex = runtime('codex', 'OpenAI Codex', { archiveHistory: true, deleteHistory: true })
  const { request } = await mount([codex], { codex: [summary('a', 'codex')] })

  expect(request).toHaveBeenCalledWith('session/list', { runtime: 'codex', archived: 'only' })
  expect(container.textContent).toContain('Conversation a')
})

it('names where the archive lives, agent by agent, without being asked', async () => {
  const codex = runtime('codex', 'OpenAI Codex', { archiveHistory: true })
  const claude = runtime('claude-code', 'Claude Code')
  await mount([codex, claude], {
    codex: [summary('a', 'codex')],
    'claude-code': [summary('b', 'claude-code')],
  })

  // The page's own promise, that nothing here has been lost.
  expect(container.textContent).toContain('Nothing here has been deleted')
  // And both differences at once — no scoping, no clicking to find out.
  expect(container.textContent).toContain('keeps this archive itself')
  expect(container.textContent).toContain('has no archive of its own')
  expect(container.textContent).toContain('still listed in Claude Code’s own window')
})

it('gives an agent a heading only when it has something', async () => {
  const codex = runtime('codex', 'OpenAI Codex', { archiveHistory: true })
  const claude = runtime('claude-code', 'Claude Code')
  await mount([codex, claude], { codex: [summary('a', 'codex')] })

  // A heading over an empty card is a question the reader has to answer.
  expect(container.textContent).toContain('OpenAI Codex · 1')
  expect(container.textContent).not.toContain('Claude Code')
})

it('offers Restore to everyone and Delete only where it is real', async () => {
  const codex = runtime('codex', 'OpenAI Codex', { archiveHistory: true, deleteHistory: true })
  const dsh = runtime('dsh', 'DeepSeek Harness')
  await mount([codex, dsh], {
    codex: [summary('a', 'codex')],
    dsh: [summary('b', 'dsh', '/repo/other')],
  })

  const rows = [...container.querySelectorAll('button')].filter((node) =>
    node.textContent?.includes('Delete'),
  )
  expect(rows).toHaveLength(2)
  // One agent can, one cannot, and the one that cannot says so rather than
  // offering a button that throws after the confirmation promised otherwise.
  expect(rows.filter((node) => node.disabled)).toHaveLength(1)
  expect(rows.find((node) => node.disabled)?.title).toContain('keeps no way to delete one')
  expect(
    [...container.querySelectorAll('button')].filter((n) => n.textContent?.includes('Restore')),
  ).toHaveLength(2)
})

it('does not offer "Archive instead" for something already archived', async () => {
  const codex = runtime('codex', 'OpenAI Codex', { archiveHistory: true, deleteHistory: true })
  await mount([codex], { codex: [summary('a', 'codex')] })

  act(() => button('Delete…')?.click())
  expect(container.textContent).toContain('Delete conversation')
  // A button that would do nothing reads as one that failed.
  expect(button('Archive instead')).toBeUndefined()
  expect(container.textContent).not.toContain('archive it instead')
})

it('says the archive is empty in words that explain how to fill it', async () => {
  await mount([runtime('codex', 'OpenAI Codex', { archiveHistory: true })], {})
  expect(container.textContent).toContain('Nothing is archived')
  expect(container.textContent).toContain('⋯ menu in the sidebar')
  // Nothing to narrow, so nothing to narrow it with.
  expect(container.querySelector('input')).toBeNull()
})

it('blames the search only when there was one', async () => {
  const codex = runtime('codex', 'OpenAI Codex', { archiveHistory: true })
  await mount([codex], { codex: [summary('a', 'codex')] })

  type('nothing like this')
  expect(container.textContent).toContain('Nothing here matches')
  expect(container.textContent).not.toContain('Nothing is archived')

  type('')
  expect(container.textContent).toContain('Conversation a')
})

it('names an agent that could not be asked instead of counting it as empty', async () => {
  const codex = runtime('codex', 'OpenAI Codex', { archiveHistory: true })
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [codex],
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: {
      request: vi.fn(async () => {
        throw new Error('not started')
      }),
    },
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <ArchiveSection />
      </StoreProvider>,
    )
  })
  expect(container.textContent).toContain('could not be asked')
})
