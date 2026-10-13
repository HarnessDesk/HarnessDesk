import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type Session, type SessionKey } from '@harnessdesk/protocol'
import { StoreProvider, PaneProvider } from '../state/context'
import { AppStore } from '../state/store'
import { MountProvider } from '../panels/mount'
import { FilePane } from '../components/FilePane'
import { EditorMain } from './EditorMain'

vi.mock('../lib/coalesce', () => ({ coalesce: (fn: () => void) => fn }))
vi.mock('./head', () => ({ readHead: async () => ({ content: 'original', status: 'tracked' }) }))
vi.mock('./CodeView', () => ({ CodeView: ({ value, onChange, readOnly }: any) => <textarea value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} /> }))
vi.mock('./MergeView', () => ({ MergeView: ({ value, original, readOnly }: any) => <><pre>{original}</pre><textarea value={value} readOnly={readOnly} /></> }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const session = 'fake:one' as SessionKey, subject = `session:${session}`, path = '/work/file.ts'
let host: HTMLDivElement, root: Root, store: AppStore, disk: any
const settle = () => act(async () => {})
beforeEach(async () => {
  vi.useFakeTimers()
  disk = { kind: 'text', content: 'original', hash: 'read-hash', truncated: false }
  store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { sessions: new Map([[session, { cwd: '/work', runtime: runtimeId('fake') } as Session]]) })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'workspace/readFile') return disk
    if (method === 'workspace/stat') { if (disk.kind === 'missing') throw new Error('Missing file'); return { modifiedAt: 1 } }
    return null
  }) as never)
  store.openEditorFile(subject, path)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<StoreProvider store={store}>
    <div data-surface="main"><EditorMain subject={subject} runtime={runtimeId('fake')} root="/work" /></div>
    <div data-surface="panel"><PaneProvider scope={{ paneId: 'panel', sessionKey: session, view: { kind: 'conversation', session } }}>
      <MountProvider scope={{ area: 'right', id: 'file-panel', view: { kind: 'file', path, runtime: runtimeId('fake') } }}><FilePane /></MountProvider>
    </PaneProvider></div>
  </StoreProvider>))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks() })
const surface = (name: 'main' | 'panel') => host.querySelector<HTMLDivElement>(`[data-surface="${name}"]`)!
const click = async (name: 'main' | 'panel', label: string) => {
  const button = [...surface(name).querySelectorAll('button')].find(button => button.textContent === label)!
  expect(button).toBeTruthy(); await act(async () => button.click())
}
const poll = async () => { await act(async () => vi.advanceTimersByTime(3000)); await settle() }
const expectMissing = () => {
  for (const name of ['main', 'panel'] as const) {
    expect(surface(name).textContent).toContain('file.ts does not exist yet.')
    expect(surface(name).querySelector('textarea')).toBeNull()
    expect(surface(name).textContent).not.toContain('Unsaved')
  }
  expect(store.getSnapshot().editorDocuments.get(subject)?.has(path)).toBeFalsy()
}

it('shares a clean deletion with main and panel through subsequent HEAD refreshes and polls', async () => {
  expect(surface('main').querySelector('textarea')?.value).toBe('original')
  expect(surface('panel').querySelector('textarea')?.value).toBe('original')
  disk = { kind: 'missing' }; await poll(); expectMissing()
  await poll(); expectMissing()
  await click('main', 'Changes +0 −1')
  expect(surface('main').querySelector('textarea')?.readOnly).toBe(true)
  expect(surface('main').querySelector('textarea')?.value).toBe('')
})

it.each(['main', 'panel'] as const)('clears an edit reverted in %s when disk is deleted', async name => {
  const area = surface(name).querySelector('textarea')!
  for (const value of ['temporary edit', 'original']) await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(store.getSnapshot().editorDocuments.get(subject)?.has(path)).toBeFalsy()
  for (const peer of ['main', 'panel'] as const) expect(surface(peer).textContent).not.toContain('Unsaved')
  disk = { kind: 'missing' }; await poll(); expectMissing()
  await poll(); expectMissing()
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toEqual({ kind: 'missing' })
  for (const peer of ['main', 'panel'] as const) {
    await click(peer, 'Changes +0 −1')
    expect(surface(peer).querySelector('pre')?.textContent).toBe('original')
    expect(surface(peer).querySelector('textarea')?.value).toBe('')
    expect(surface(peer).querySelector('textarea')?.readOnly).toBe(true)
  }
})

it.each(['main', 'panel'] as const)('Reload in %s discards a deleted draft in both bound surfaces', async name => {
  const area = surface(name).querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'unsaved draft')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(store.getSnapshot().editorDocuments.get(subject)?.get(path)?.content).toBe('unsaved draft')
  disk = { kind: 'missing' }; await poll()
  await click(name, 'Reload'); expectMissing()
  await poll(); expectMissing()
})

it('still reloads disk in the retained panel after an explicit tab discard', async () => {
  const area = surface('main').querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'discard me')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => store.closeEditorFile(subject, path, true))
  expect(surface('panel').querySelector('textarea')?.value).toBe('original')
  expect(store.getSnapshot().editorDocuments.get(subject)?.has(path)).toBeFalsy()
})
