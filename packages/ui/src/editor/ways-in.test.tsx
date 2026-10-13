import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, sessionId, sessionKey, type Session } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { MountProvider } from '../panels/mount'
import { FilePane } from '../components/FilePane'
import { EditorMain } from './EditorMain'
import { editorConversation } from './state'
import { rebaseFileChange } from './rebase'
const wakes = vi.hoisted(() => ({ held: false, pending: new Set<() => void>() }))
vi.mock('../lib/coalesce', () => ({ coalesce: (fn: () => void) => () => { if (wakes.held) wakes.pending.add(fn); else fn() } }))
vi.mock('./head', () => ({ readHead: async () => ({ content: 'original', status: 'tracked' }) }))
vi.mock('./CodeView', () => ({ CodeView: ({ value, onChange }: any) => <textarea value={value} onChange={e => { const next = e.target.value; onChange(next, (latest: string) => rebaseFileChange(value, next, latest)) }} /> }))
vi.mock('./MergeView', () => ({ MergeView: ({ value, onChange }: any) => <textarea value={value} onChange={e => { const next = e.target.value; onChange(next, (latest: string) => rebaseFileChange(value, next, latest)) }} /> }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const runtime = runtimeId('fake'), key = sessionKey(runtime, sessionId('owner')), subject = `session:${key}`, path = '/work/owner/notes.ts'
let store: AppStore, host: HTMLDivElement, root: Root, disk: any, request: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  wakes.held = false; wakes.pending.clear()
  store = new AppStore('ws://localhost:0/'); disk = { kind: 'text', content: 'original', hash: 'read-hash', truncated: false }
  Object.assign(store.getSnapshot(), { sessions: new Map([[key, { id: sessionId('owner'), runtime, cwd: '/work/owner', title: 'Owner', status: { type: 'idle' }, turns: [] } as unknown as Session]]) })
  request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: any) => {
    if (method === 'workspace/readFile') return disk
    if (method === 'workspace/stat') return { modifiedAt: 1 }
    if (method === 'file/save') { disk = { ...disk, content: params.content, hash: 'saved-hash' }; return { saved: true, hash: 'saved-hash' } }
    return null
  }) as never)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
const draw = async (main = false) => act(async () => root.render(<StoreProvider store={store}><section data-panel><MountProvider scope={{ area: 'right', id: 'file-owner', view: { kind: 'file', path, runtime } }}><FilePane /></MountProvider></section>{main && <section data-main><EditorMain subject={subject} root="/work/owner" runtime={runtime} /></section>}</StoreProvider>))
const bind = () => { const s = store.getSnapshot(); Object.assign(s.workbench, { toolOwners: { ...s.workbench.toolOwners, 'file-owner': subject }, frameSubjects: { ...s.workbench.frameSubjects, [subject]: { paneId: 'owner', view: { kind: 'conversation', session: key } } } }) }
const edit = async (area: 'panel' | 'main', value: string) => act(async () => { const input = host.querySelector<HTMLTextAreaElement>(`[data-${area}] textarea`)!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
const save = async (area: 'panel' | 'main') => act(async () => [...host.querySelectorAll<HTMLButtonElement>(`[data-${area}] button`)].find(b => b.textContent === 'Unsaved · Save ⌘S')!.click())
for (const dirtyPeer of [false, true]) it.each(['main', 'panel'] as const)(`a stale %s Reload keeps the peer ${dirtyPeer ? 'draft' : 'save'} before notifications`, async reader => {
  const peer = reader === 'main' ? 'panel' : 'main'
  request.mockImplementation((async (method: string, params: any) => {
    if (method === 'workspace/readFile') return { ...disk }
    if (method === 'workspace/stat') return { modifiedAt: 1 }
    if (method === 'file/save') {
      if (params.expectedHash !== disk.hash) return { saved: false, conflict: { content: disk.content, hash: disk.hash } }
      disk = { ...disk, content: params.content, hash: 'saved-hash' }
      return { saved: true, hash: disk.hash }
    }
    return null
  }) as never)
  const action = async (area: 'main' | 'panel', label: string) => act(async () => {
    const button = [...host.querySelectorAll<HTMLButtonElement>(`[data-${area}] button`)].find(node => node.textContent === label)
    expect(button).toBeTruthy(); button!.click()
  })
  bind(); store.openEditorFile(subject, path, { keep: true }); await draw(true)
  await edit(reader, 'my saved draft')
  disk = { ...disk, content: 'older foreign bytes', hash: 'foreign-hash' }
  await save(reader); await save(peer); wakes.held = true
  await action(peer, 'Keep mine')
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'my saved draft', base: { hash: 'saved-hash' } })
  if (dirtyPeer) await edit(peer, 'newer peer draft')
  await action(reader, 'Reload')
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: dirtyPeer ? 'newer peer draft' : disk.content, base: { hash: disk.hash } })
})
it('popout keeps its exact owner, view and original draft baseline while entering Editor mode', async () => {
  bind(); await draw(); await edit('panel', 'panel draft')
  const popout = host.querySelector<HTMLButtonElement>('[aria-label="Pop out to Editor mode"]')
  expect(popout).not.toBeNull(); await act(async () => popout!.click())
  expect(store.getSnapshot().windowMode).toBe('editor')
  expect(store.getSnapshot().workbench.navigation.current).toMatchObject({ kind: 'work', view: { kind: 'conversation', session: key } })
  expect(editorConversation(store.getSnapshot().editorState, subject)).toMatchObject({ active: path, preview: null })
  expect(store.getSnapshot().editorDocuments.get(subject)?.get(path)).toMatchObject({ content: 'panel draft', base: { hash: 'read-hash' } })
  await draw(true); expect(host.querySelector<HTMLTextAreaElement>('[data-main] textarea')?.value).toBe('panel draft')
})
it('seeds a retained same-file draft and shares subsequent edits and save baselines both ways', async () => {
  bind(); store.openEditorFile(subject, path, { document: { base: { content: 'original', hash: 'read-hash', truncated: false }, content: 'retained draft', pendingCreation: false } })
  await draw(true)
  expect(host.querySelector<HTMLTextAreaElement>('[data-panel] textarea')?.value).toBe('retained draft')
  await edit('panel', 'panel edit'); expect(host.querySelector<HTMLTextAreaElement>('[data-main] textarea')?.value).toBe('panel edit')
  await save('main'); expect(host.querySelector<HTMLTextAreaElement>('[data-panel] textarea')?.value).toBe('panel edit')
  expect(store.getSnapshot().editorDocuments.get(subject)?.has(path)).toBeFalsy()
  expect(host.textContent).not.toContain('Unsaved')
  await edit('panel', 'after main save'); await save('panel')
  expect(request).toHaveBeenLastCalledWith('workspace/readFile', expect.objectContaining({ path }))
  expect(request.mock.calls.filter(([method]: [string]) => method === 'file/save').at(-1)?.[1]).toMatchObject({ expectedHash: 'saved-hash', content: 'after main save' })
  expect(host.querySelector<HTMLTextAreaElement>('[data-main] textarea')?.value).toBe('after main save')
  expect(host.textContent).not.toContain('Unsaved')
  await edit('main', 'main edit'); expect(host.querySelector<HTMLTextAreaElement>('[data-panel] textarea')?.value).toBe('main edit')
  await draw(false); await draw(true); expect(host.querySelector<HTMLTextAreaElement>('[data-main] textarea')?.value).toBe('main edit')
})

it('refuses a divergent transfer without navigating, hiding or discarding either draft', async () => {
  bind(); store.openEditorFile(subject, path, { document: { base: { content: 'original', hash: 'read-hash', truncated: false }, content: 'editor draft', pendingCreation: false } })
  await draw(true)
  const navigation = store.getSnapshot().workbench.navigation.current
  const incoming = { base: { content: 'original', hash: 'older-hash', truncated: false }, content: 'independent panel draft', pendingCreation: false, comparison: { content: 'foreign', hash: 'comparison-hash' } }
  const notice = vi.spyOn(store, 'notice')
  await act(async () => expect(store.popOutEditorFile({ path, runtime, root: '/work/owner', subject, view: 'source', document: incoming })).toBe(false))
  expect(store.getSnapshot().workbench.navigation.current).toEqual(navigation)
  expect(store.getSnapshot().windowMode).toBe('conversation')
  expect(store.getSnapshot().editorDocuments.get(subject)?.get(path)?.content).toBe('editor draft')
  expect(incoming).toMatchObject({ content: 'independent panel draft', base: { hash: 'older-hash' }, comparison: { hash: 'comparison-hash' } })
  expect(host.querySelector('[data-panel]')?.hasAttribute('hidden')).toBe(false)
  expect(notice).toHaveBeenCalledWith('warning', expect.stringContaining('Both drafts are kept'))
})
it('keeps a peer edit made during a save and applies the new baseline to both surfaces', async () => {
  bind(); store.openEditorFile(subject, path, { keep: true }); await draw(true); await edit('main', 'being saved')
  let finish!: (result: any) => void
  request.mockImplementationOnce((async () => new Promise(resolve => { finish = resolve })) as never)
  await save('main'); await edit('panel', 'typed during save')
  disk = { ...disk, content: 'being saved', hash: 'saved-hash' }
  await act(async () => finish({ saved: true, hash: 'saved-hash' }))
  expect(host.querySelector<HTMLTextAreaElement>('[data-main] textarea')?.value).toBe('typed during save')
  expect(host.querySelector<HTMLTextAreaElement>('[data-panel] textarea')?.value).toBe('typed during save')
  expect(store.getSnapshot().editorDocuments.get(subject)?.get(path)).toMatchObject({ content: 'typed during save', base: { content: 'being saved', hash: 'saved-hash' } })
})
it('Review selects its own worktree, Changed filter and existing tab Changes without agent calls', () => {
  const otherKey = sessionKey(runtimeId('other'), sessionId('owner'))
  Object.assign(store.getSnapshot().workbench.main, { root: { kind: 'pane', id: 'main', view: { kind: 'conversation', session: otherKey } }, focused: 'main' })
  store.openEditorFile(subject, path, { keep: true, view: 'source' })
  store.reviewEditorFiles(key, 'notes.ts')
  expect(editorConversation(store.getSnapshot().editorState, subject)).toMatchObject({ active: path, filter: 'changed', tabs: [{ path, view: 'changes' }] })
  expect(store.getSnapshot().workbench.navigation.current).toMatchObject({ kind: 'work', view: { session: key } })
  expect(request.mock.calls.some(([method]: [string]) => method === 'session/read' || method === 'session/resume')).toBe(false)
})
it('line entry chooses Source on an existing tab and keeps transient targets out of preferences', async () => {
  store.openEditorFile(subject, path, { keep: true, view: 'changes' })
  await store.loadPreferences()
  expect(store.enterEditorFile(key, path, { view: 'source', line: 12 })).toBe(true)
  expect(editorConversation(store.getSnapshot().editorState, subject).tabs[0]?.view).toBe('source')
  expect(store.getSnapshot().editorLineTargets.get(subject)?.get(path)?.line).toBe(12)
  for (const [method, params] of request.mock.calls as [string, any][]) if (method === 'app/state/set') expect(JSON.stringify(params)).not.toContain('lineTarget')
})

it('resolves a retained tool owner even before its frame-subject record arrives', async () => {
  bind(); Object.assign(store.getSnapshot().workbench, { frameSubjects: {} })
  const popout = vi.spyOn(store, 'popOutEditorFile')
  await draw(); await edit('panel', 'retained owner draft')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Pop out to Editor mode"]')!.click())
  expect(popout).toHaveBeenCalledWith(expect.objectContaining({ subject, runtime, root: '/work/owner', document: expect.objectContaining({ content: 'retained owner draft' }) }))
})

it.each(['main', 'panel'] as const)('preserves a peer edit while a %s save completes before store notifications', async saver => {
  const peer = saver === 'main' ? 'panel' : 'main'
  bind(); store.openEditorFile(subject, path, { keep: true }); await draw(true); await edit(saver, 'being saved')
  let finish!: (result: any) => void
  request.mockImplementationOnce((async () => new Promise(resolve => { finish = resolve })) as never)
  await save(saver); wakes.held = true
  await edit(peer, 'edit before notification')
  disk = { ...disk, content: 'being saved', hash: 'saved-hash' }
  await act(async () => finish({ saved: true, hash: 'saved-hash' }))
  expect(store.getSnapshot().editorDocuments.get(subject)?.get(path)).toMatchObject({ content: 'edit before notification', base: { hash: 'saved-hash' } })
  await save(peer)
  expect(request.mock.calls.filter(([method]: [string]) => method === 'file/save').at(-1)?.[1]).toMatchObject({ expectedHash: 'saved-hash', content: 'edit before notification' })
  await act(async () => { wakes.held = false; for (const wake of wakes.pending) wake(); wakes.pending.clear() })
  expect(host.querySelector<HTMLTextAreaElement>('[data-main] textarea')?.value).toBe('edit before notification')
})

it.each(['main', 'panel'] as const)('rebases stale %s typing against the other displayed document before notifications', async writer => {
  const peer = writer === 'main' ? 'panel' : 'main'
  bind(); store.openEditorFile(subject, path, { keep: true }); await draw(true); wakes.held = true
  await edit(peer, `original + ${peer}`)
  expect(host.querySelector<HTMLTextAreaElement>(`[data-${writer}] textarea`)?.value).toBe('original')
  await edit(writer, `original + ${writer}`)
  const retained = store.getSnapshot().editorDocuments.get(subject)?.get(path)?.content
  expect(retained).toContain(`+ ${peer}`); expect(retained).toContain(`+ ${writer}`)
  await act(async () => { wakes.held = false; for (const wake of wakes.pending) wake(); wakes.pending.clear() })
  expect(host.querySelector<HTMLTextAreaElement>('[data-main] textarea')?.value).toBe(retained)
  expect(host.querySelector<HTMLTextAreaElement>('[data-panel] textarea')?.value).toBe(retained)
})
it.each(['main', 'panel'] as const)('fences a held peer read begun before a %s save', async saver => {
  bind(); const readBeforeSave = { ...disk }, normal = request.getMockImplementation()!
  let finishRead!: (result: any) => void, reads = 0
  request.mockImplementation(((method: string, params: any) => {
    if (method === 'workspace/readFile' && ++reads === (saver === 'main' ? 1 : 2)) return new Promise(resolve => { finishRead = resolve })
    return normal(method as never, params)
  }) as never)
  store.openEditorFile(subject, path, { keep: true }); await draw(true); await edit(saver, `saved from ${saver}`); await save(saver)
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: `saved from ${saver}`, base: { hash: 'saved-hash' } })
  await act(async () => finishRead(readBeforeSave))
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: `saved from ${saver}`, base: { hash: 'saved-hash' } })
  expect(host.querySelector<HTMLTextAreaElement>('[data-main] textarea')?.value).toBe(`saved from ${saver}`)
  expect(host.querySelector<HTMLTextAreaElement>('[data-panel] textarea')?.value).toBe(`saved from ${saver}`)
})

it.each(['main', 'panel'] as const)('fences a held %s post-save verification read after a peer save', async saver => {
  const peer = saver === 'main' ? 'panel' : 'main'
  bind(); store.openEditorFile(subject, path, { keep: true }); await draw(true)
  const normal = request.getMockImplementation()!
  let hold = false, finishRead!: (result: any) => void, verification: any
  request.mockImplementation(((method: string, params: any) => {
    if (method === 'workspace/readFile' && hold) { hold = false; verification = { ...disk }; return new Promise(resolve => { finishRead = resolve }) }
    const result = normal(method as never, params)
    if (method === 'file/save' && params.content === 'first save') hold = true
    return result
  }) as never)
  await edit(saver, 'first save'); await save(saver)
  await edit(peer, 'second save'); await save(peer)
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)?.content).toBe('second save')
  await act(async () => finishRead(verification))
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'second save', base: { content: 'second save', hash: 'saved-hash' } })
})

const delayedReply = (outcome: 'success' | 'conflict' | 'binary' | 'tooLarge' | 'error') => {
  let finish!: () => void, finishRead!: (result: any) => void, holdRead = false
  request.mockImplementation((async (method: string, params: any) => {
    if (method === 'workspace/readFile') {
      if (holdRead) { holdRead = false; return new Promise(resolve => { finishRead = resolve }) }
      return { ...disk }
    }
    if (method === 'workspace/stat') return { modifiedAt: 1 }
    if (method === 'file/save') {
      if (params.expectedHash !== disk.hash) return { saved: false, conflict: { content: disk.content, hash: disk.hash } }
      if (params.content === 'first save') {
        disk = { ...disk, content: 'first save', hash: 'first-hash' }
        return new Promise((resolve, reject) => { finish = () => {
          if (outcome === 'error') reject(new Error('Obsolete save failure'))
          else if (outcome === 'success') resolve({ saved: true, hash: 'first-hash' })
          else if (outcome === 'conflict') resolve({ saved: false, conflict: { content: 'old foreign', hash: 'old-conflict-hash' } })
          else resolve({ saved: false, reason: outcome, size: 999_999 })
        } })
      }
      disk = { ...disk, content: params.content, hash: params.content === 'original' ? 'read-hash' : 'second-hash' }
      return { saved: true, hash: disk.hash }
    }
    return null
  }) as never)
  return { finish: () => finish(), holdRead: () => { holdRead = true }, finishRead: () => finishRead({ ...disk }) }
}
const keepMine = async (area: 'panel' | 'main') => act(async () => [...host.querySelectorAll<HTMLButtonElement>(`[data-${area}] button`)].find(b => b.textContent === 'Keep mine')!.click())
it.each(['main', 'panel'] as const)('a delayed successful %s reply cannot roll back a newer peer baseline or draft', async saver => {
  const peer = saver === 'main' ? 'panel' : 'main', reply = delayedReply('success')
  bind(); store.openEditorFile(subject, path, { keep: true }); await draw(true)
  await edit(saver, 'first save'); await save(saver)
  await edit(peer, 'second save'); await save(peer); await keepMine(peer)
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'second save', base: { hash: 'second-hash' } })
  reply.holdRead(); await act(async () => reply.finish())
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'second save', base: { hash: 'second-hash' } })
  await edit(peer, 'second save + third edit'); await act(async () => reply.finishRead())
  expect(store.getSnapshot().editorDocuments.get(subject)?.get(path)).toMatchObject({ content: 'second save + third edit', base: { content: 'second save', hash: 'second-hash' } })
})
it.each(['conflict', 'binary', 'tooLarge', 'error'] as const)('discards a superseded %s response rather than overwriting the current conflict surface', async outcome => {
  const reply = delayedReply(outcome), notice = vi.spyOn(store, 'notice')
  bind(); store.openEditorFile(subject, path, { keep: true }); await draw(true)
  await edit('main', 'first save'); await save('main')
  await edit('panel', 'second save'); await save('panel'); await keepMine('panel')
  await act(async () => reply.finish())
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'second save', base: { hash: 'second-hash' } })
  expect(host.textContent).not.toContain('changed on disk')
  expect(host.textContent).not.toContain('save was refused')
  expect(notice).not.toHaveBeenCalledWith('error', 'Obsolete save failure')
})
it('a superseded save-and-close cannot discard a peer draft typed while its reread is held', async () => {
  const reply = delayedReply('success')
  bind(); store.openEditorFile(subject, path, { keep: true }); await draw(true); await edit('main', 'first save')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close notes.ts"]')!.click())
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Save')!.click())
  await edit('panel', 'second save'); await save('panel'); await keepMine('panel')
  reply.holdRead(); await act(async () => reply.finish()); await edit('panel', 'second save + still dirty')
  await act(async () => reply.finishRead())
  expect(editorConversation(store.getSnapshot().editorState, subject).tabs.some(tab => tab.path === path)).toBe(true)
  expect(store.getSnapshot().editorDocuments.get(subject)?.get(path)).toMatchObject({ content: 'second save + still dirty', base: { hash: 'second-hash' } })
})

it('a delayed success stays superseded when a peer restores the original bytes and hash', async () => {
  const reply = delayedReply('success')
  bind(); store.openEditorFile(subject, path, { keep: true }); await draw(true)
  await edit('main', 'first save'); await save('main')
  await edit('panel', 'second save'); await save('panel'); await keepMine('panel')
  await edit('panel', 'original'); await save('panel')
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'original', base: { hash: 'read-hash' } })
  reply.holdRead(); await act(async () => reply.finish())
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'original', base: { hash: 'read-hash' } })
  await act(async () => reply.finishRead())
})

const abaHash = (content: string) => content === 'original' ? 'read-hash' : content === 'checkpoint' ? 'checkpoint-hash' : 'middle-hash'
const cleanAbaSeed = () => { bind(); store.openEditorFile(subject, path, { keep: true, document: { base: { content: 'original', hash: 'read-hash', truncated: false }, content: 'original', pendingCreation: false } }) }
it.each(['main', 'panel'] as const)('an initial read in %s rejects intermediate bytes after a peer restores the original baseline', async reader => {
  const peer = reader === 'main' ? 'panel' : 'main'
  let finishRead!: (result: any) => void, reads = 0
  request.mockImplementation((async (method: string, params: any) => {
    if (method === 'workspace/readFile') { if (++reads === (reader === 'panel' ? 1 : 2)) return new Promise(resolve => { finishRead = resolve }); return { ...disk } }
    if (method === 'workspace/stat') return { modifiedAt: 1 }
    if (method === 'file/save') { disk = { ...disk, content: params.content, hash: abaHash(params.content) }; return { saved: true, hash: disk.hash } }
    return null
  }) as never)
  cleanAbaSeed(); await draw(true)
  await edit(peer, 'middle write'); await save(peer); const intermediate = { ...disk }
  await edit(peer, 'original'); await save(peer)
  await act(async () => finishRead(intermediate))
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'original', base: { hash: 'read-hash' } })
  expect(host.querySelector<HTMLTextAreaElement>('[data-main] textarea')?.value).toBe('original')
  expect(host.querySelector<HTMLTextAreaElement>('[data-panel] textarea')?.value).toBe('original')
})
it.each(['main', 'panel'] as const)('a poll read in %s rejects an ABA result before installing disk bytes', async reader => {
  vi.useFakeTimers(); const peer = reader === 'main' ? 'panel' : 'main'
  let finishRead!: (result: any) => void, holdAt = 0, reads = 0, modified = 1
  request.mockImplementation((async (method: string, params: any) => {
    if (method === 'workspace/readFile') { if (holdAt && ++reads === holdAt) return new Promise(resolve => { finishRead = resolve }); return { ...disk } }
    if (method === 'workspace/stat') return { modifiedAt: modified }
    if (method === 'file/save') { disk = { ...disk, content: params.content, hash: abaHash(params.content) }; return { saved: true, hash: disk.hash } }
    return null
  }) as never)
  cleanAbaSeed(); await draw(true); holdAt = reader === 'panel' ? 1 : 2; ++modified
  await act(async () => vi.advanceTimersByTime(3000))
  await edit(peer, 'middle write'); await save(peer); const intermediate = { ...disk }
  await edit(peer, 'original'); await save(peer)
  await act(async () => finishRead(intermediate))
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'original', base: { hash: 'read-hash' } })
})
it.each(['main', 'panel'] as const)('a save verification in %s rejects an ABA intermediate result', async saver => {
  const peer = saver === 'main' ? 'panel' : 'main'
  let finishRead!: (result: any) => void, holdRead = false, saves = 0
  request.mockImplementation((async (method: string, params: any) => {
    if (method === 'workspace/readFile') { if (holdRead) { holdRead = false; return new Promise(resolve => { finishRead = resolve }) }; return { ...disk } }
    if (method === 'workspace/stat') return { modifiedAt: 1 }
    if (method === 'file/save') { disk = { ...disk, content: params.content, hash: abaHash(params.content) }; if (++saves === 1) holdRead = true; return { saved: true, hash: disk.hash } }
    return null
  }) as never)
  cleanAbaSeed(); await draw(true); await edit(saver, 'checkpoint'); await save(saver)
  await edit(peer, 'middle write'); await save(peer); const intermediate = { ...disk }
  await edit(peer, 'checkpoint'); await save(peer)
  await act(async () => finishRead(intermediate))
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: 'checkpoint', base: { hash: 'checkpoint-hash' } })
})
it.each(['main', 'panel'] as const)('an obsolete %s read error does not replace the restored document surface', async reader => {
  const peer = reader === 'main' ? 'panel' : 'main'
  let rejectRead!: (error: Error) => void, reads = 0
  request.mockImplementation((async (method: string, params: any) => {
    if (method === 'workspace/readFile') { if (++reads === (reader === 'panel' ? 1 : 2)) return new Promise((_resolve, reject) => { rejectRead = reject }); return { ...disk } }
    if (method === 'workspace/stat') return { modifiedAt: 1 }
    if (method === 'file/save') { disk = { ...disk, content: params.content, hash: abaHash(params.content) }; return { saved: true, hash: disk.hash } }
    return null
  }) as never)
  cleanAbaSeed(); await draw(true)
  await edit(peer, 'middle write'); await save(peer); await edit(peer, 'original'); await save(peer)
  await act(async () => rejectRead(new Error('Obsolete read error')))
  expect(host.textContent).not.toContain('Obsolete read error')
  expect(host.querySelector<HTMLTextAreaElement>(`[data-${reader}] textarea`)?.value).toBe('original')
})
