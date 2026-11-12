import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NO_CAPABILITIES, runtimeId, sessionId, sessionKey, type RuntimeInfo, type WorkspaceEntry } from '@harnessdesk/protocol'

import { handOverToComposer } from '../lib/compose'
import { previewStore, PREVIEW_SESSION_KEY } from '../preview/harness'
import { matchPromptLinkProject, promptLinkContext } from '../lib/prompt-link'
import { PaneProvider, StoreProvider, useSnapshot } from '../state/context'
import { draftsOf, NEW_SESSION_DRAFT_KEY } from '../state/drafts'
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
/** Answers to `workspace/recent` a test holds back, in the order they are asked for; the rest come at once. */
let heldRecent: Promise<WorkspaceEntry[]>[] = []
const mountDesk = async () => {
  heldRecent = []
  const recent = (): Promise<WorkspaceEntry[]> => heldRecent.shift() ?? Promise.resolve([other, widgets])
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { runtimes: [runtime], activeRuntime: runtime.id, health: { state: 'ready' } })
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params?: { path?: string }) => {
    if (method === 'workspace/recent') return recent()
    if (method === 'workspace/open') return [other, widgets].find((entry) => entry.path === params?.path) ?? other
    if (method === 'runtime/health') return { state: 'ready' }
    if (method === 'session/list') return { data: [], cursor: null }
    if (method === 'evidence/seat') return null
    return []
  }) as never)
  await act(async () => { await store.loadWorkspaces() })
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

/** Frames run only when the test says so: React and the store then disagree for as long as it takes. */
const holdFrames = () => {
  const queued: FrameRequestCallback[] = []
  const spy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => queued.push(callback))
  return {
    /** Runs every frame asked for so far, and the renders they cause. */
    run: async (): Promise<void> => {
      const due = queued.splice(0)
      await act(async () => {
        for (const callback of due) callback(performance.now())
        // And the time a frame takes, for what waits on a timer instead.
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
    },
    release: () => spy.mockRestore(),
  }
}

const settle = async <T,>(pending: Promise<T>, run: () => Promise<void>): Promise<T> => {
  let done = false
  let value: T | undefined
  void pending.then((result) => { done = true; value = result })
  for (let frame = 0; frame < 60 && !done; frame += 1) await run()
  expect(done).toBe(true)
  return value as T
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const liveDraft = (store: AppStore) => draftsOf(store).live(NEW_SESSION_DRAFT_KEY)
const setAside = (store: AppStore) => [...store.getSnapshot().recoverableDrafts.values()].flat()

describe('a prompt link meets a desk already in use', () => {
  it('lands in the new draft, not in the conversation the pane is leaving', async () => {
    const { store, request } = await mountDesk()
    const earlier = sessionKey(runtime.id, 'earlier')
    const source = previewStore().getSnapshot().sessions.get(PREVIEW_SESSION_KEY)!
    await act(async () => { await store.openWorkspace('/work/widgets') })
    Object.assign(store.getSnapshot(), { sessions: new Map(store.getSnapshot().sessions)
      .set(earlier, { ...source, id: sessionId('earlier'), runtime: runtime.id, cwd: '/work/widgets', turns: [] }) })
    act(() => store.showViewIn('main', { kind: 'conversation', session: earlier }))
    expect(store.getSnapshot().activeSessionKey).toBe(earlier)
    type('Words for the earlier conversation')
    // Let the store's last wake land on a real frame, so every wake from here is held.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    const frames = holdFrames()
    try {
      // The store moves to the draft at once; React draws it a frame later,
      // and until then the earlier conversation's composer is the one listening.
      let pending!: Promise<string>
      await act(async () => { pending = store.fillFromPromptLink({ repo: 'jane/widgets', prompt: 'Fix the build', pr: null, flow: null }) })
      const outcome = await settle(pending, frames.run)
      expect(outcome).toBe('filled')
    } finally {
      frames.release()
    }
    expect(store.getSnapshot().activeSessionKey).toBeNull()
    expect(textarea()?.value).toBe('Fix the build')
    expect(marker()).not.toBeNull()
    neverSent(request)
  })

  it.each([
    ['other words', 'Notes for later'],
    ['the same words', 'Fix the build'],
    ['no words', ''],
  ])('replaces the chips a new chat already held, with %s, and sets them aside', async (_, typed) => {
    const { store, request } = await mountDesk()
    await act(async () => {
      await handOverToComposer({ text: typed, attachments: [
        { name: 'notes.md', path: '/work/widgets/notes.md', kind: 'note', text: 'A file the chat carried' },
        { name: 'screen.png', path: 'data:image/png;base64,AAAA', kind: 'image' },
      ] })
    })
    expect(liveDraft(store)?.attachments.map((attachment) => attachment.name)).toEqual(['notes.md', 'screen.png'])
    await act(async () => { await store.fillFromPromptLink({ repo: 'jane/widgets', prompt: 'Fix the build', pr: null, flow: null }) })
    expect(textarea()?.value).toBe('Fix the build')
    expect(liveDraft(store)).toMatchObject({ text: 'Fix the build', attachments: [] })
    expect(container.textContent).not.toContain('notes.md')
    const kept = setAside(store)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.text).toBe(typed)
    expect(kept[0]!.attachments.map((attachment) => attachment.name)).toEqual(['notes.md', 'screen.png'])
    neverSent(request)
  })

  it('lets the newest link win when an older one answers last', async () => {
    const { store, request } = await mountDesk()
    const answers = [deferred<WorkspaceEntry[]>(), deferred<WorkspaceEntry[]>()]
    heldRecent = answers.map((answer) => answer.promise)
    let older!: Promise<string>
    let newer!: Promise<string>
    await act(async () => {
      older = store.fillFromPromptLink({ repo: '/work/other', prompt: 'Older link', pr: null, flow: null })
      newer = store.fillFromPromptLink({ repo: 'jane/widgets', prompt: 'Newer link', pr: 42, flow: null })
    })
    await act(async () => { answers[1]!.resolve([other, widgets]); expect(await newer).toBe('filled') })
    await act(async () => { answers[0]!.resolve([other, widgets]); expect(await older).toBe('superseded') })
    expect(store.getSnapshot().workspace?.path).toBe('/work/widgets')
    expect(textarea()?.value).toBe('Newer link')
    expect(store.getSnapshot().promptLinkDraft?.text).toBe('Newer link')
    expect(marker()?.textContent).toContain('Pull request #42')
    neverSent(request)
  })

  it('does not let an older link land its folder after a newer one filled the open folder', async () => {
    const { store, request } = await mountDesk()
    await act(async () => { await store.openWorkspace('/work/widgets') })
    const opening = deferred<void>()
    const answer = request.getMockImplementation()!
    request.mockImplementation((async (method: string, params?: { path?: string }) => {
      if (method === 'workspace/open' && params?.path === '/work/other') await opening.promise
      return answer(method as never, params as never)
    }) as never)
    let older!: Promise<string>
    await act(async () => { older = store.fillFromPromptLink({ repo: '/work/other', prompt: 'Older link', pr: null, flow: null }) })
    await act(async () => {
      expect(await store.fillFromPromptLink({ repo: 'jane/widgets', prompt: 'Newer link', pr: 42, flow: null })).toBe('filled')
    })
    await act(async () => { opening.resolve(); expect(await older).toBe('superseded') })
    // Let the store's wake reach the screen before reading it.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(store.getSnapshot().workspace?.path).toBe('/work/widgets')
    expect(store.getSnapshot().promptLinkDraft?.text).toBe('Newer link')
    expect(textarea()?.value).toBe('Newer link')
    expect(marker()?.textContent).toContain('Pull request #42')
    neverSent(request)
  })

  it('leaves the desk where the person took it when an overtaken link answers', async () => {
    const { store, request } = await mountDesk()
    const answers = [deferred<WorkspaceEntry[]>(), deferred<WorkspaceEntry[]>()]
    heldRecent = answers.map((answer) => answer.promise)
    let older!: Promise<string>
    let newer!: Promise<string>
    await act(async () => { older = store.fillFromPromptLink({ repo: 'jane/widgets', prompt: 'Older link', pr: null, flow: null }) })
    await act(async () => { newer = store.fillFromPromptLink({ repo: 'jane/widgets', prompt: 'Newer link', pr: null, flow: null }) })
    await act(async () => { answers[1]!.resolve([other, widgets]); expect(await newer).toBe('filled') })
    // The person moves on before the older link's answer comes back.
    await act(async () => { await store.openWorkspace('/work/other') })
    type('My own words')
    await act(async () => { answers[0]!.resolve([other, widgets]); expect(await older).toBe('superseded') })
    expect(store.getSnapshot().workspace?.path).toBe('/work/other')
    expect(textarea()?.value).toBe('My own words')
    neverSent(request)
  })
})
