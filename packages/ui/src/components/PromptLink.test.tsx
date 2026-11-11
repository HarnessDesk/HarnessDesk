import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NO_CAPABILITIES, runtimeId, type RuntimeInfo, type WorkspaceEntry } from '@harnessdesk/protocol'

import { matchPromptLinkProject, promptLinkContext } from '../lib/prompt-link'
import { PaneProvider, StoreProvider, useSnapshot } from '../state/context'
import { panes, sessionOf } from '../state/layout'
import { AppStore } from '../state/store'
import { Composer } from './Composer'

/**
 * A prompt link (`harnessdesk://new`) fills a new chat's draft in a project
 * the desk already has, marks it as from a link, and does nothing else: no
 * message is sent, no session or run is started, no setting is written.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runtime = { id: runtimeId('demo'), name: 'Demo', presentation: { name: 'Demo' }, capabilities: NO_CAPABILITIES } as unknown as RuntimeInfo

const widgets: WorkspaceEntry = {
  path: '/work/widgets',
  name: 'widgets',
  lastOpenedAt: 2,
  repo: { root: '/work/widgets', worktree: false, origin: 'acme.dev/jane/widgets' },
}
const other: WorkspaceEntry = { path: '/work/other', name: 'other', lastOpenedAt: 3 }

describe('matching a link to an open project', () => {
  const worktree: WorkspaceEntry = { ...widgets, path: '/work/widgets-wt', lastOpenedAt: 9, repo: { ...widgets.repo!, worktree: true } }
  it.each([
    ['jane/widgets', widgets],
    ['Jane/Widgets', widgets],
    ['acme.dev/jane/widgets', widgets],
    ['jane/widgets.git', widgets],
    ['/work/widgets', widgets],
    ['/work/widgets/', widgets],
    ['/work/other', other],
    ['jane/gadgets', null],
    ['acme.dev/widgets', null],
    ['other.dev/jane/widgets', null],
    ['/work', null],
  ] as const)('%s', (repo, expected) => {
    expect(matchPromptLinkProject(repo, [other, worktree, widgets])).toBe(expected)
  })

  it('says a pull request and a Flow as plain words, and nothing when there are none', () => {
    expect(promptLinkContext({ pr: 42, flow: 'review' })).toBe('Pull request #42 · Flow review.')
    expect(promptLinkContext({ pr: null, flow: null })).toBeNull()
  })
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  sessionStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Every request the store makes, so the test can say what was never asked. */
const mountDesk = async () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { runtimes: [runtime], activeRuntime: runtime.id, health: { state: 'ready' } })
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params?: { path?: string }) => {
    if (method === 'workspace/recent') return [other, widgets]
    if (method === 'workspace/open') return [other, widgets].find((entry) => entry.path === params?.path) ?? other
    if (method === 'runtime/health') return { state: 'ready' }
    if (method === 'session/list') return { data: [], cursor: null }
    return []
  }) as never)
  await store.loadWorkspaces()
  const LiveComposer = () => {
    const state = useSnapshot()
    const pane = panes(state.layout.root).find((one) => one.view.kind === 'conversation')
    return pane ? (
      <PaneProvider scope={{ paneId: pane.id, view: pane.view, sessionKey: sessionOf(pane) }}>
        <Composer onChooseProject={() => {}} />
      </PaneProvider>
    ) : null
  }
  act(() => root.render(<StoreProvider store={store}><LiveComposer /></StoreProvider>))
  return { store, request }
}

const textarea = (): HTMLTextAreaElement | null => container.querySelector('textarea')
const marker = (): Element | null =>
  [...container.querySelectorAll('[data-slot="composer-notice"]')].find((one) => one.textContent?.includes('From a link')) ?? null

/**
 * Nothing a link may cause: a message, a session, a run, a Flow, or a
 * setting. Opening a project remembers the window's layout for it, as any
 * click on a project does; that is the one preference written.
 */
const neverSent = (request: ReturnType<typeof vi.spyOn>): void => {
  const forbidden = (request.mock.calls as unknown[][]).filter(([method, params]) =>
    /^(turn|flow|goal|team|lead|permission)\//.test(String(method)) || method === 'session/create' ||
    (method === 'app/state/set' && Object.keys((params as { patch: object }).patch).some((key) => key !== 'layouts')))
  expect(forbidden).toEqual([])
}

const type = (value: string): void => {
  const element = textarea()!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('a prompt link on the desk', () => {
  it('fills a new chat in the matching project, marks it, and sends nothing', async () => {
    const { store, request } = await mountDesk()
    const prompt = 'Fix the flaky test\n<b>not markup</b>'
    let outcome: string | undefined
    await act(async () => {
      outcome = await store.fillFromPromptLink({ repo: 'jane/widgets', prompt, pr: 42, flow: 'review' })
    })
    expect(outcome).toBe('filled')
    expect(store.getSnapshot().workspace?.path).toBe('/work/widgets')
    expect(textarea()?.value).toBe(prompt)
    expect(marker()?.textContent).toContain('From a link — review before sending.')
    expect(marker()?.textContent).toContain('Pull request #42 · Flow review.')
    // The link's words are composer text only, never markup anywhere.
    expect(container.querySelector('b')).toBeNull()
    neverSent(request)

    type(`${prompt} please`)
    expect(marker()).toBeNull()
    expect(store.getSnapshot().promptLinkDraft).toBeNull()
    type(prompt)
    expect(marker()).toBeNull()
    neverSent(request)
  })

  it('says to open the repository first when no project matches, and opens nothing', async () => {
    const { store, request } = await mountDesk()
    const before = store.getSnapshot().workspace?.path
    let outcome: string | undefined
    await act(async () => {
      outcome = await store.fillFromPromptLink({ repo: 'jane/gadgets', prompt: 'Hello', pr: null, flow: null })
    })
    expect(outcome).toBe('unmatched')
    expect(store.getSnapshot().notices.map((notice) => notice.message)).toContain('Open this repository first: jane/gadgets')
    expect(store.getSnapshot().workspace?.path).toBe(before)
    expect(store.getSnapshot().promptLinkDraft).toBeNull()
    expect(marker()).toBeNull()
    expect(request.mock.calls.some(([method]) => method === 'workspace/open')).toBe(false)
    neverSent(request)
  })

  it('sets a draft already being typed aside to restore, rather than overwriting it', async () => {
    const { store, request } = await mountDesk()
    await act(async () => { await store.fillFromPromptLink({ repo: '/work/widgets', prompt: 'First', pr: null, flow: null }) })
    type('My own words')
    await act(async () => { await store.fillFromPromptLink({ repo: '/work/widgets', prompt: 'Second', pr: null, flow: null }) })
    expect(textarea()?.value).toBe('Second')
    const kept = [...store.getSnapshot().recoverableDrafts.values()].flat().map((item) => item.text)
    expect(kept).toContain('My own words')
    neverSent(request)
  })
})
