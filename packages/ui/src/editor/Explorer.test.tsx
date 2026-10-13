import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, sessionId, sessionKey, type Session } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import * as editor from './index'
import { shortcutFor } from '../lib/shortcuts'
import { CodeView } from './CodeView'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const onShortcut = (event: KeyboardEvent) => {
  if (shortcutFor(event)?.action === 'go-to-file') { event.preventDefault(); window.dispatchEvent(new CustomEvent('harnessdesk:go-to-file')) }
}
let container: HTMLDivElement, mount: Root
beforeEach(() => { document.addEventListener('keydown', onShortcut); container = document.createElement('div'); document.body.appendChild(container); mount = createRoot(container) })
afterEach(() => { document.removeEventListener('keydown', onShortcut); act(() => mount.unmount()); container.remove(); vi.useRealTimers() })
const a = sessionKey(runtimeId('agent-a'), sessionId('a')), b = sessionKey(runtimeId('agent-b'), sessionId('b'))
const entry = (path: string, kind: 'file' | 'directory' = 'file') => ({ name: path.split('/').pop()!, path, kind })
const rig = () => {
  let snapshot = { ...emptySnapshot(), activeRuntime: runtimeId('unrelated'), workspace: { path: '/main', name: 'Main', lastOpenedAt: 1 },
    sessions: new Map([[a, { runtime: runtimeId('agent-a'), cwd: '/worktree/src' } as Session], [b, { runtime: runtimeId('agent-b'), cwd: '/other' } as Session]]),
  } as AppSnapshot
  const listeners = new Set<() => void>()
  const patch = (next: Partial<AppSnapshot>) => { snapshot = { ...snapshot, ...next }; listeners.forEach(run => run()) }
  const mutate = (subject: string, change: (state: editor.EditorConversation) => editor.EditorConversation) => patch({ editorState: editor.updateEditorConversation(snapshot.editorState, subject, change(editor.editorConversation(snapshot.editorState, subject))) })
  const request = vi.fn(async (method: string, params: unknown) => {
    const p = params as { root: string; path: string }
    if (method === 'git/status') return { root: '/worktree', ahead: 0, behind: 0, files: [{ path: 'src/a.ts', status: 'modified', staged: false }] }
    if (method === 'workspace/browse') return { path: p.path, parent: p.path === p.root ? null : p.root,
      entries: p.path.endsWith('/folder') ? [entry(`${p.path}/child.ts`)] : [entry(`${p.root}/folder`, 'directory'), entry(`${p.root}/a.ts`), entry(`${p.root}/b.md`)] }
    if (method === 'workspace/files') return [entry(`${p.root}/picked.md`), entry(`${p.root}/folder`, 'directory')]
    return null
  })
  const store = { subscribe: (run: () => void) => { listeners.add(run); return () => listeners.delete(run) }, getSnapshot: () => snapshot,
    transport: { request }, openEditorFile: vi.fn((subject, path, options) => mutate(subject, state => editor.openEditorTab(state, path, options))),
    setEditorExpandedFolders: vi.fn((subject, expanded) => mutate(subject, state => ({ ...state, expanded }))),
    setEditorExplorerFilter: vi.fn((subject, filter) => mutate(subject, state => ({ ...state, filter }))),
  } as unknown as AppStore
  const render = async (session = a, withCode = false) => { expect(editor.Explorer).toBeTypeOf('function'); await act(async () => mount.render(<StoreProvider store={store}><editor.Explorer session={session} />{withCode && <CodeView dark={false} look={editor.editorLook(snapshot.editorPrefs)} value={'first line\nsecond line'} path="test.ts" onChange={() => {}} />}</StoreProvider>)) }
  const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === name || node.textContent === name)!
  return { request, store, render, button, patch, snapshot: () => snapshot }
}
it('uses retained session cwd/runtime, defaults Changed, single previews and double keeps', async () => {
  const r = rig(); await r.render()
  expect(r.request).toHaveBeenCalledWith('workspace/browse', { mode: 'entries', root: '/worktree/src', path: '/worktree/src', runtime: 'agent-a' })
  expect(r.request).toHaveBeenCalledWith('git/status', { root: '/worktree/src' })
  expect(r.button('a.ts')).toBeDefined(); expect(r.button('b.md')).toBeUndefined()
  await act(async () => r.button('a.ts').click())
  expect(editor.editorConversation(r.snapshot().editorState, `session:${a}`).preview).toBe('/worktree/src/a.ts')
  await act(async () => r.button('a.ts').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  expect(editor.editorConversation(r.snapshot().editorState, `session:${a}`).preview).toBeNull()
})
it('All lazily expands folders and the explicit choice stays All as Git changes refresh', async () => {
  const r = rig(); await r.render()
  await act(async () => r.button('All').click())
  expect(r.request.mock.calls.filter(([m, p]) => m === 'workspace/browse' && (p as { path: string }).path.endsWith('/folder'))).toHaveLength(0)
  await act(async () => r.button('folder').click())
  expect(r.button('child.ts')).toBeDefined()
  expect(editor.editorConversation(r.snapshot().editorState, `session:${a}`).filter).toBe('all')
})
it('missing session metadata never falls back to main checkout; stale reads cannot contaminate another conversation', async () => {
  const r = rig(); const answers: { method: string; resolve: (value: unknown) => void }[] = []
  r.request.mockImplementation((async (method: string) => new Promise(resolve => { answers.push({ method, resolve }) })) as never)
  await r.render()
  r.request.mockImplementation((async (method: string) => method === 'git/status' ? null : { path: '/other', parent: null, entries: [entry('/other/other.md')] }) as never)
  await r.render(b)
  await act(async () => {
    answers.find(one => one.method === 'workspace/browse')!.resolve({ path: '/worktree/src', parent: null, entries: [entry('/worktree/src/stale.ts')] })
    answers.find(one => one.method === 'git/status')!.resolve({ root: '/worktree', ahead: 0, behind: 0, files: [{ path: 'src/stale.ts', status: 'modified', staged: false }] })
  })
  expect(r.button('other.md')).toBeDefined(); expect(r.button('stale.ts')).toBeUndefined()
  expect(container.querySelector('[aria-label="Explorer filter"]')).toBeNull()
  await act(async () => r.patch({ sessions: new Map() }))
  r.request.mockClear(); await r.render(a)
  expect(r.request).not.toHaveBeenCalled()
  expect(container.textContent).toContain('folder')
})
it('Cmd P searches the conversation folder and runtime; choosing a file keeps it and directories are excluded', async () => {
  vi.useFakeTimers()
  const r = rig(); await r.render()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true })))
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Find a file"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'pick')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => vi.advanceTimersByTime(100))
  expect(r.request).toHaveBeenCalledWith('workspace/files', { root: '/worktree/src', runtime: 'agent-a', query: 'pick', limit: 40 })
  const choose = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('picked.md'))!
  await act(async () => choose.click())
  expect(r.store.openEditorFile).toHaveBeenCalledWith(`session:${a}`, '/worktree/src/picked.md', { keep: true })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
it('an unset filter follows changes arriving later, while explicit All remains All', async () => {
  vi.useFakeTimers()
  const r = rig(), request = r.request.getMockImplementation()!
  let changes = false
  r.request.mockImplementation((async (method: string, params: unknown) => method === 'git/status'
    ? { root: '/worktree', ahead: 0, behind: 0, files: changes ? [{ path: 'src/a.ts', status: 'modified', staged: false }] : [] }
    : request(method, params)) as never)
  await r.render()
  expect(r.button('b.md')).toBeDefined()
  expect(editor.editorConversation(r.snapshot().editorState, `session:${a}`).filter).toBeNull()
  changes = true
  await act(async () => vi.advanceTimersByTime(2_000))
  expect(r.button('b.md')).toBeUndefined()
  await act(async () => r.button('All').click())
  await act(async () => vi.advanceTimersByTime(2_000))
  expect(r.button('b.md')).toBeDefined()
})
it('search replies from an older query or conversation cannot appear or open tabs', async () => {
  vi.useFakeTimers()
  const r = rig(), request = r.request.getMockImplementation()!
  const pending: ((value: unknown) => void)[] = []
  r.request.mockImplementation((async (method: string, params: unknown) => method === 'workspace/files'
    ? new Promise(resolve => pending.push(resolve)) : request(method, params)) as never)
  await r.render()
  await act(async () => r.button('Go to file').click())
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Find a file"]')!
  const type = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => vi.advanceTimersByTime(100))
  }
  await type('old'); await type('new')
  await act(async () => pending[0]!([{ path: '/worktree/src/old.ts', relativePath: 'old.ts', score: 1 }]))
  expect(document.body.textContent).not.toContain('old.ts')
  await r.render(b)
  await act(async () => pending[1]!([{ path: '/worktree/src/new.ts', relativePath: 'new.ts', score: 1 }]))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(r.store.openEditorFile).not.toHaveBeenCalled()
})

for (const modifier of ['metaKey', 'ctrlKey'] as const) it(`Go to file opens from the actual CodeView with ${modifier}`, async () => {
  const r = rig(); await r.render(a, true)
  const content = container.querySelector<HTMLElement>('.cm-content')!
  await act(async () => content.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', [modifier]: true, bubbles: true, cancelable: true })))
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Go to file')
})
