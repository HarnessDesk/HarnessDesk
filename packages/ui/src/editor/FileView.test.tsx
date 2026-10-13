import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FileView, type FileDocumentState, type FileSaveHandle } from './FileView'

const head = vi.hoisted(() => vi.fn(async () => ({ content: 'original', status: 'tracked' })))
vi.mock('./head', () => ({ readHead: head }))
vi.mock('./CodeView', () => ({
  CodeView: ({ value, onChange, onSave, readOnly }: any) => <textarea aria-label="file editor" value={value} readOnly={readOnly} onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.metaKey && e.key === 's') onSave() }} />,
}))
vi.mock('./MergeView', () => ({
  MergeView: ({ value, original, onChange, onSave, readOnly }: any) => <><pre data-original>{original}</pre><textarea aria-label="merge editor" value={value} readOnly={readOnly} onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.metaKey && e.key === 's') onSave() }} /></>,
}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
let disk: any, modified: number, request: ReturnType<typeof vi.fn>, store: AppStore
const snapshot = emptySnapshot()
const text = (content = 'original', hash = 'old-hash') => ({ kind: 'text', content, hash, truncated: false })
const settle = () => act(async () => {})
beforeEach(() => {
  disk = text(); modified = 1; head.mockResolvedValue({ content: 'original', status: 'tracked' })
  request = vi.fn(async (method: string, params?: any) => {
    if (method === 'workspace/readFile') return disk
    if (method === 'workspace/stat') { if (disk.kind === 'missing') throw new Error('No such file'); return { kind: 'file', modifiedAt: modified } }
    if (method === 'file/save') { disk = text(params.content, 'saved-hash'); return { saved: true, hash: 'saved-hash' } }
    if (method === 'preview/ticket') return { ticket: 'placeholder-ticket' }
    throw Error(method)
  })
  store = { subscribe: () => () => {}, getSnapshot: () => snapshot, transport: { request }, reportEditor: vi.fn(), notice: vi.fn() } as unknown as AppStore
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })
const render = async (path = '/work/notes.txt', props: any = {}) => {
  act(() => root.render(<StoreProvider store={store}><FileView path={path} root="/work" runtime={runtimeId('claude')} {...props} /></StoreProvider>)); await settle()
}
const button = (name: string) => [...container.querySelectorAll('button')].find(b => b.textContent === name || b.getAttribute('aria-label') === name)!
const click = async (name: string) => { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()) }
const edit = async (value: string) => {
  const area = container.querySelector('textarea')!
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value); area.dispatchEvent(new Event('input', { bubbles: true })) }); await settle()
}
const poll = async () => { await act(async () => vi.advanceTimersByTime(3000)); await settle() }

it('opens Markdown in Preview with Edit and hides unchanged Changes; text opens editable Source', async () => {
  await render('/work/notes.md'); expect(button('Preview')).toBeTruthy(); expect(button('Source')).toBeTruthy(); expect(button('Edit')).toBeTruthy(); expect(container.querySelector('textarea')).toBeNull(); expect(container.textContent).not.toContain('Changes')
  await click('Edit'); expect(container.querySelector('textarea')?.readOnly).toBe(false)
  await render('/work/code.ts'); expect(button('Preview')).toBeUndefined(); expect(container.querySelector('textarea')?.readOnly).toBe(false)
})
it('shows Changes counts against HEAD and transfers the exact current view and draft', async () => {
  disk = text('new line'); const onPopOut = vi.fn(), onViewChange = vi.fn(); await render('/work/notes.txt', { onPopOut, onViewChange })
  await click('Changes +1 −1'); expect(container.querySelector('[data-original]')?.textContent).toBe('original'); expect(onViewChange).toHaveBeenCalledWith('changes')
  await edit('draft'); await click('Pop out to Editor mode'); expect(onPopOut).toHaveBeenCalledWith(expect.objectContaining({ path: '/work/notes.txt', root: '/work', runtime: runtimeId('claude'), view: 'changes', document: expect.objectContaining({ content: 'draft', base: expect.objectContaining({ hash: 'old-hash' }) }) }))
})
it('saves explicitly with the read hash and reports a clean document', async () => {
  const onDocumentChange = vi.fn(); await render('/work/notes.txt', { onDocumentChange }); await edit('draft'); expect(request.mock.calls.some(([method]) => method === 'file/save')).toBe(false)
  await click('Unsaved · Save ⌘S'); expect(request).toHaveBeenCalledWith('file/save', { path: '/work/notes.txt', runtime: runtimeId('claude'), content: 'draft', expectedHash: 'old-hash' }); expect(onDocumentChange).toHaveBeenLastCalledWith(null)
})
it('retains new edits typed while an earlier save is in flight', async () => {
  let finish!: (value: any) => void
  request.mockImplementation(async (method: string) => method === 'file/save' ? await new Promise(resolve => { finish = resolve }) : method === 'workspace/readFile' ? disk : { modifiedAt: modified })
  await render(); await edit('saved text'); await click('Unsaved · Save ⌘S'); await edit('newer text'); disk = text('saved text', 'saved-hash'); await act(async () => finish({ saved: true, hash: 'saved-hash' }))
  expect(container.querySelector('textarea')?.value).toBe('newer text'); expect(button('Unsaved · Save ⌘S')).toBeTruthy(); await click('Unsaved · Save ⌘S'); expect(request).toHaveBeenLastCalledWith('file/save', expect.objectContaining({ content: 'newer text', expectedHash: 'saved-hash' }))
})
it.each(['Compare', 'Reload', 'Keep mine'])('offers %s on a hashed save conflict', async choice => {
  request.mockImplementation(async (method: string) => method === 'workspace/readFile' ? disk : method === 'file/save' ? { saved: false, conflict: { content: 'disk text', hash: 'disk-hash' } } : { modifiedAt: modified })
  await render(); await edit('draft'); await click('Unsaved · Save ⌘S'); await click(choice)
  if (choice === 'Compare') { expect(container.querySelector('[data-original]')?.textContent).toBe('disk text'); expect(container.querySelector('textarea')?.value).toBe('draft') }
  if (choice === 'Reload') { expect(container.querySelector('textarea')?.value).toBe('disk text'); expect(button('Unsaved · Save ⌘S')).toBeUndefined() }
  if (choice === 'Keep mine') expect(request).toHaveBeenLastCalledWith('file/save', expect.objectContaining({ content: 'draft', expectedHash: 'disk-hash' }))
})
it('reloads clean disk changes quietly, and protects dirty edits with the three banner actions', async () => {
  vi.useFakeTimers(); await render(); disk = text('agent edit', 'agent-hash'); modified = 2; await poll(); expect(container.querySelector('textarea')?.value).toBe('agent edit'); expect(container.textContent).not.toContain('changed on disk')
  await edit('my draft'); disk = text('later agent edit', 'later-hash'); modified = 3; await poll(); expect(container.querySelector('textarea')?.value).toBe('my draft'); expect(container.textContent).toContain('notes.txt changed on disk while you had unsaved edits.'); expect(button('Compare')).toBeTruthy(); expect(button('Reload')).toBeTruthy(); expect(button('Keep mine')).toBeTruthy()
})
it('suppresses its own saves and ignores a polling response started before the save', async () => {
  vi.useFakeTimers(); await render(); let finish!: (value: any) => void
  request.mockImplementationOnce(async () => await new Promise(resolve => { finish = resolve })); await poll(); await edit('saved'); modified = 2; await click('Unsaved · Save ⌘S'); await edit('new draft'); await act(async () => finish({ modifiedAt: 99 })); await poll(); expect(container.textContent).not.toContain('changed on disk'); expect(container.querySelector('textarea')?.value).toBe('new draft')
})
it('keeps original base/hash on restored stale drafts rather than silently rebasing', async () => {
  disk = text('disk changed', 'new-hash'); const document: FileDocumentState = { base: { content: 'original', hash: 'old-hash', truncated: false }, content: 'restored draft', pendingCreation: false }
  await render('/work/notes.txt', { document }); expect(container.querySelector('textarea')?.value).toBe('restored draft'); expect(button('Compare')).toBeTruthy(); await click('Unsaved · Save ⌘S'); expect(request).toHaveBeenCalledWith('file/save', expect.objectContaining({ expectedHash: 'old-hash' }))
})
it('ignores an old load when switching paths', async () => {
  let finish!: (value: any) => void
  request.mockImplementationOnce(async () => await new Promise(resolve => { finish = resolve })); await render('/work/old.txt'); disk = text('new file'); await render('/work/new.txt'); await act(async () => finish(text('old response'))); expect(container.querySelector('textarea')?.value).toBe('new file')
})
it('allows explicit creation and saving an empty missing file', async () => {
  disk = { kind: 'missing' }; await render(); await click('Create this file'); await click('Unsaved · Save ⌘S'); expect(request).toHaveBeenCalledWith('file/save', expect.objectContaining({ content: '', expectedHash: '' }))
})
it.each(['binary', 'tooLarge'])('preserves a draft and blocks overwriting a %s refusal', async reason => {
  request.mockImplementation(async (method: string) => method === 'workspace/readFile' ? disk : method === 'file/save' ? { saved: false, reason, size: 3 * 1024 * 1024 } : { modifiedAt: 1 })
  await render(); await edit('draft'); await click('Unsaved · Save ⌘S'); expect(container.querySelector('textarea')?.value).toBe('draft'); expect(button('Unsaved · Save ⌘S')?.disabled).toBe(true); expect(button('Keep mine')).toBeUndefined()
})
it('preserves bounded image reads and native HTML/PDF tickets and sandbox policy', async () => {
  disk = { kind: 'binary', content: 'aGVsbG8=', size: 3 * 1024 * 1024, hash: 'image-hash' }; await render('/work/tiny.png'); expect(container.querySelector('img')?.src).toBe('data:image/png;base64,aGVsbG8='); expect(request).toHaveBeenCalledWith('workspace/readFile', expect.objectContaining({ maxBytes: 10 * 1024 * 1024, encoding: 'base64' }))
  disk = text('<h1>hi</h1>'); await render('/work/page.html'); expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups'); expect(container.querySelector('iframe')?.src).toContain('/preview-frame?ticket=placeholder-ticket')
  await render('/work/doc.pdf'); expect(container.querySelector('iframe')?.hasAttribute('sandbox')).toBe(false)
})

it('retains requested Changes while HEAD is loading and transfers that requested view', async () => {
  let finish!: (value: any) => void
  head.mockImplementationOnce(async () => await new Promise(resolve => { finish = resolve }))
  const onViewChange = vi.fn(), onPopOut = vi.fn()
  disk = text('changed'); await render('/work/notes.txt', { view: 'changes', onViewChange, onPopOut })
  await click('Pop out to Editor mode'); expect(onPopOut).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'changes' })); expect(onViewChange).not.toHaveBeenCalled()
  await act(async () => finish({ content: 'original', status: 'tracked' })); expect(container.querySelector('[data-original]')?.textContent).toBe('original'); expect(onViewChange).not.toHaveBeenCalled()
})
it('saves a dirty Markdown draft explicitly with the shortcut from Preview', async () => {
  await render('/work/notes.md'); await click('Edit'); await edit('draft'); await click('Preview')
  act(() => container.querySelector('[data-slot="tool-pane"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }))); await settle()
  expect(request).toHaveBeenCalledWith('file/save', expect.objectContaining({ content: 'draft', expectedHash: 'old-hash' }))
})
it('retains a disk comparison across a pop-out/remount', async () => {
  vi.useFakeTimers(); const onPopOut = vi.fn(); await render('/work/notes.txt', { onPopOut }); await edit('draft'); disk = text('disk edit', 'disk-hash'); modified = 2; await poll(); await click('Compare'); await click('Pop out to Editor mode')
  const transferred = onPopOut.mock.calls[0]![0]
  expect(transferred.document.comparison).toEqual({ content: 'disk edit', hash: 'disk-hash' })
  act(() => root.unmount()); root = createRoot(container); await render('/work/notes.txt', { view: transferred.view, document: transferred.document }); expect(container.querySelector('[data-original]')?.textContent).toBe('disk edit'); expect(container.querySelector('textarea')?.value).toBe('draft')
})

it('leaves handled and modified save chords alone, and saves once from Preview', async () => {
  await render('/work/notes.md'); await click('Edit'); await edit('draft'); await click('Preview')
  const pane = container.querySelector('[data-slot="tool-pane"]')!
  for (const extra of [{ shiftKey: true }, { altKey: true }, { handled: true }]) {
    const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true, ...extra })
    if ('handled' in extra) event.preventDefault()
    act(() => pane.dispatchEvent(event)); await settle()
  }
  expect(request.mock.calls.filter(([method]) => method === 'file/save')).toHaveLength(0)
  act(() => pane.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }))); await settle()
  expect(request.mock.calls.filter(([method]) => method === 'file/save')).toHaveLength(1)
})

it.each(['Compare', 'Reload', 'Keep mine'])('protects a draft when disk is deleted and offers %s', async choice => {
  vi.useFakeTimers(); await render(); await edit('my draft'); disk = { kind: 'missing' }; modified = 2; await poll()
  expect(container.querySelector('textarea')?.value).toBe('my draft'); expect(container.textContent).toContain('notes.txt changed on disk while you had unsaved edits.')
  await click(choice)
  if (choice === 'Compare') { expect(container.querySelector('[data-original]')?.textContent).toBe(''); expect(container.querySelector('textarea')?.value).toBe('my draft') }
  if (choice === 'Reload') { expect(container.textContent).toContain('notes.txt does not exist yet.'); expect(button('Create this file')).toBeTruthy(); expect(container.querySelector('textarea')).toBeNull() }
  if (choice === 'Keep mine') expect(request).toHaveBeenCalledWith('file/save', expect.objectContaining({ content: 'my draft', expectedHash: '' }))
})

it.each([false, true])('detects a foreign write between save and baseline stat (newer draft: %s)', async newerDraft => {
  let finish!: (value: any) => void, stats = 0
  request.mockImplementation(async (method: string) => {
    if (method === 'workspace/readFile') return disk
    if (method === 'workspace/stat') {
      if (++stats === 2) { disk = text('foreign bytes', 'foreign-hash'); modified = 2 }
      return { kind: 'file', modifiedAt: modified }
    }
    if (method === 'file/save') return await new Promise(resolve => { finish = resolve })
    throw Error(method)
  })
  await render(); await edit('saved bytes'); await click('Unsaved · Save ⌘S')
  if (newerDraft) await edit('newer draft')
  disk = text('saved bytes', 'saved-hash'); await act(async () => finish({ saved: true, hash: 'saved-hash' }))
  if (newerDraft) { expect(container.querySelector('textarea')?.value).toBe('newer draft'); expect(button('Compare')).toBeTruthy(); await click('Compare'); expect(container.querySelector('[data-original]')?.textContent).toBe('foreign bytes') }
  else { expect(container.querySelector('textarea')?.value).toBe('foreign bytes'); expect(container.textContent).not.toContain('changed on disk') }
})

it('preserves a same-file dirty draft and original hash when root metadata arrives', async () => {
  const onDocumentChange = vi.fn()
  await render('/work/notes.txt', { root: null, onDocumentChange }); await edit('unsaved draft')
  const reads = request.mock.calls.filter(([method]) => method === 'workspace/readFile').length
  await render('/work/notes.txt', { root: '/work', onDocumentChange })
  expect(container.querySelector('textarea')?.value).toBe('unsaved draft'); expect(onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'unsaved draft', base: expect.objectContaining({ hash: 'old-hash' }) }))
  expect(request.mock.calls.filter(([method]) => method === 'workspace/readFile')).toHaveLength(reads)
})
it('preserves an in-flight save and newer edits through root-only arrival', async () => {
  let finish!: (value: any) => void
  request.mockImplementation(async (method: string) => method === 'file/save' ? await new Promise(resolve => { finish = resolve }) : method === 'workspace/readFile' ? disk : { modifiedAt: modified })
  await render('/work/notes.txt', { root: null }); await edit('submitted'); await click('Unsaved · Save ⌘S'); await edit('newer draft')
  await render('/work/notes.txt', { root: '/work' }); disk = text('submitted', 'saved-hash'); await act(async () => finish({ saved: true, hash: 'saved-hash' }))
  expect(container.querySelector('textarea')?.value).toBe('newer draft'); expect(button('Unsaved · Save ⌘S')?.disabled).toBe(false)
  await click('Unsaved · Save ⌘S'); expect(request).toHaveBeenLastCalledWith('file/save', expect.objectContaining({ content: 'newer draft', expectedHash: 'saved-hash' }))
})
it('keeps a pending native ticket live through root-only arrival', async () => {
  let finish!: (value: any) => void
  request.mockImplementation(async (method: string) => method === 'preview/ticket' ? await new Promise(resolve => { finish = resolve }) : { modifiedAt: modified })
  await render('/work/doc.pdf', { root: null }); await render('/work/doc.pdf', { root: '/work' }); await act(async () => finish({ ticket: 'placeholder-ticket' }))
  expect(container.querySelector('iframe')?.src).toContain('placeholder-ticket')
})
it('clears a reverted disk conflict and comparison without exposing an obsolete Reload target', async () => {
  vi.useFakeTimers(); await render(); await edit('my draft'); disk = text('temporary foreign version', 'foreign-hash'); modified = 2; await poll(); await click('Compare')
  disk = text(); modified = 3; await poll(); expect(button('Compare')).toBeUndefined(); expect(button('Reload')).toBeUndefined(); expect(button('Keep mine')).toBeUndefined(); expect(container.querySelector('[data-original]')?.textContent).not.toBe('temporary foreign version'); expect(container.querySelector('textarea')?.value).toBe('my draft')
  await poll(); expect(button('Reload')).toBeUndefined(); expect(container.querySelector('textarea')?.value).toBe('my draft')
})
it('refreshes HEAD after a commit without a disk write and hides unchanged Changes', async () => {
  vi.useFakeTimers(); disk = text('committed bytes', 'disk-hash'); await render(); expect(button('Changes +1 −1')).toBeTruthy()
  head.mockResolvedValue({ content: 'committed bytes', status: 'tracked' }); await poll(); expect(button('Changes +1 −1')).toBeUndefined()
  expect(request.mock.calls.filter(([method]) => method === 'workspace/readFile')).toHaveLength(1)
})
it('refreshes HEAD movement without rebasing an unchanged disk or dirty draft', async () => {
  vi.useFakeTimers(); await render(); expect(button('Changes +1 −1')).toBeUndefined(); head.mockResolvedValue({ content: 'other commit', status: 'tracked' }); await poll(); expect(button('Changes +1 −1')).toBeTruthy()
  await edit('my draft'); head.mockResolvedValue({ content: 'my draft', status: 'tracked' }); await poll(); expect(button('Changes +1 −1')).toBeUndefined(); expect(container.querySelector('textarea')?.value).toBe('my draft')
  await click('Unsaved · Save ⌘S'); expect(request).toHaveBeenCalledWith('file/save', expect.objectContaining({ expectedHash: 'old-hash' }))
})
it('bounds HEAD requests to one in flight and fences an obsolete root response', async () => {
  vi.useFakeTimers(); let finish!: (value: any) => void
  head.mockImplementationOnce(async () => await new Promise(resolve => { finish = resolve })); const initialCalls = head.mock.calls.length
  await render('/work/notes.txt', { root: '/work/old-root' }); await render('/work/notes.txt', { root: '/work/new-root' }); await poll(); await poll(); await poll()
  expect(head.mock.calls.length - initialCalls).toBe(1)
  head.mockResolvedValue({ content: 'original', status: 'tracked' }); await act(async () => finish({ content: 'obsolete baseline', status: 'tracked' })); expect(button('Changes +1 −1')).toBeUndefined(); expect(head.mock.calls.length - initialCalls).toBe(2)
})
it.each([false, true])('recovers a dirty editor after unreadable disk becomes text (foreign hash: %s)', async foreign => {
  vi.useFakeTimers(); await render(); await edit('my draft'); disk = { kind: 'unreadable', message: 'Temporary refusal' }; modified = 2; await poll(); expect(container.textContent).toContain('Temporary refusal')
  disk = foreign ? text('foreign bytes', 'foreign-hash') : text(); modified = 3; await poll(); expect(container.textContent).not.toContain('Temporary refusal'); expect(container.querySelector('textarea')?.value).toBe('my draft')
  if (foreign) { await click('Compare'); expect(container.querySelector('[data-original]')?.textContent).toBe('foreign bytes'); expect(container.querySelector('textarea')?.value).toBe('my draft') } else expect(button('Compare')).toBeUndefined()
})

it('fences a HEAD response from before a save until the queued current snapshot resolves', async () => {
  let earlier!: (value: any) => void, latest!: (value: any) => void
  head.mockImplementationOnce(async () => await new Promise(resolve => { earlier = resolve }))
  head.mockImplementationOnce(async () => await new Promise(resolve => { latest = resolve }))
  await render(); await edit('saved bytes'); await click('Unsaved · Save ⌘S')
  await act(async () => earlier({ content: 'obsolete HEAD', status: 'tracked' }))
  expect(button('Changes +1 −1')).toBeUndefined(); expect(container.querySelector('textarea')?.value).toBe('saved bytes')
  await act(async () => latest({ content: 'saved bytes', status: 'tracked' })); expect(button('Changes +1 −1')).toBeUndefined()
})
it('clears a reverted creation conflict when a pending new file is missing again', async () => {
  vi.useFakeTimers(); disk = { kind: 'missing' }; await render(); await click('Create this file'); await edit('new draft')
  disk = text('foreign creation', 'foreign-hash'); modified = 2; await poll(); await click('Compare')
  disk = { kind: 'missing' }; modified = 3; await poll(); expect(button('Reload')).toBeUndefined(); expect(container.querySelector('[data-original]')?.textContent).not.toBe('foreign creation'); expect(container.querySelector('textarea')?.value).toBe('new draft')
})

it('drops a queued HEAD refresh when the file unmounts', async () => {
  vi.useFakeTimers(); let finish!: (value: any) => void
  head.mockImplementationOnce(async () => await new Promise(resolve => { finish = resolve })); const initialCalls = head.mock.calls.length
  await render(); await poll(); act(() => root.unmount()); root = createRoot(container)
  await act(async () => finish({ content: 'obsolete', status: 'tracked' })); expect(head.mock.calls.length - initialCalls).toBe(1)
})


it('refuses parent Save on a truncated read without writing a partial file', async () => {
  const saveRef = createRef<FileSaveHandle>()
  disk = { ...text('partial disk'), truncated: true }
  await render('/work/notes.txt', { saveRef, document: { base: disk, content: 'partial draft', pendingCreation: false } })
  let saved: boolean | undefined
  await act(async () => { saved = await saveRef.current?.save() })
  expect(saved).toBe(false)
  expect(request.mock.calls.filter(([method]) => method === 'file/save')).toHaveLength(0)
})
