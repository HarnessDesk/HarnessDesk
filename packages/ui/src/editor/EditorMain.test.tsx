import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { editorConversation } from './state'
import { EditorMain } from './EditorMain'

vi.mock('../lib/coalesce', () => ({ coalesce: (fn: () => void) => fn }))
vi.mock('./head', () => ({ readHead: async () => ({ content: 'original', status: 'tracked' }) }))
vi.mock('./CodeView', () => ({ CodeView: ({ value, onChange }: any) => <textarea aria-label="file editor" value={value} onChange={e => onChange(e.target.value)} /> }))
vi.mock('./MergeView', () => ({ MergeView: ({ value, onChange }: any) => <textarea value={value} onChange={e => onChange(e.target.value)} /> }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root, store: AppStore, request: ReturnType<typeof vi.spyOn>
let disks: Map<string, any>
const first = 'session:first', second = 'session:second', path = '/work/one.ts', other = '/work/two.ts'
const text = (content = 'original', hash = 'read-hash') => ({ kind: 'text', content, hash, truncated: false })
beforeEach(() => {
  store = new AppStore('ws://localhost:0/'); disks = new Map([[path, text()], [other, text()]])
  request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: any) => {
    if (method === 'workspace/readFile') return disks.get(params.path) ?? text()
    if (method === 'workspace/stat') return { kind: 'file', modifiedAt: 1 }
    if (method === 'file/save') { disks.set(params.path, text(params.content, 'saved-hash')); return { saved: true, hash: 'saved-hash' } }
    return null
  }) as never)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })
const draw = async (subject = first) => { await act(async () => root.render(<StoreProvider store={store}><EditorMain subject={subject} runtime={runtimeId('codex')} root="/work" /></StoreProvider>)) }
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)!
const click = async (label: string) => { expect(button(label), label).toBeTruthy(); await act(async () => button(label).click()) }
const edit = async (value: string) => { const area = host.querySelector('textarea')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value); area.dispatchEvent(new Event('input', { bubbles: true })) }) }
const tabs = (subject = first) => editorConversation(store.getSnapshot().editorState, subject).tabs
const draft = () => store.getSnapshot().editorDocuments.get(first)?.get(path)
const open = async () => { store.openEditorFile(first, path); await draw(); await edit('draft') }
it('shows the exact empty state, then the selected file', async () => {
  await draw(); expect(host.textContent).toBe('No file open. Pick one in the Explorer, or press ⌘P.')
  await act(async () => store.openEditorFile(first, path)); expect(host.querySelector('textarea')?.value).toBe('original')
})
it('preserves drafts across tabs, conversations, and unmounting for Conversation mode', async () => {
  await open(); await act(async () => store.openEditorFile(first, other)); expect(host.querySelector('textarea')?.value).toBe('original')
  await click('one.ts, unsaved'); expect(host.querySelector('textarea')?.value).toBe('draft')
  await act(async () => store.openEditorFile(second, other)); await draw(second); expect(host.querySelector('textarea')?.value).toBe('original'); await draw(); expect(host.querySelector('textarea')?.value).toBe('draft')
  await act(async () => root.render(<div>Conversation</div>)); await draw(); expect(host.querySelector('textarea')?.value).toBe('draft')
})
it('closes clean tabs immediately and leaves dirty tabs untouched on Cancel', async () => {
  await open(); await act(async () => store.openEditorFile(first, other)); await click('Close two.ts'); expect(tabs()).toHaveLength(1)
  await click('Close one.ts'); expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(); await click('Cancel'); expect(tabs()).toHaveLength(1); expect(draft()?.content).toBe('draft')
})
it("discards only after Don't save", async () => {
  await open(); await click('Close one.ts'); await click("Don't save"); expect(tabs()).toHaveLength(0); expect(draft()).toBeUndefined()
})
it('waits for successful save before closing an inactive dirty tab', async () => {
  await open(); await act(async () => store.openEditorFile(first, other)); await click('Close one.ts')
  let finish!: (value: any) => void
  request.mockImplementationOnce((async () => await new Promise(resolve => { finish = resolve })) as never)
  await click('Save'); expect(tabs()).toHaveLength(2); expect(button('Saving…')?.disabled).toBe(true)
  disks.set(path, text('draft', 'saved-hash')); await act(async () => finish({ saved: true, hash: 'saved-hash' }))
  expect(tabs().map(tab => tab.path)).toEqual([other]); expect(draft()).toBeUndefined()
  expect(request).toHaveBeenCalledWith('file/save', expect.objectContaining({ path, content: 'draft', expectedHash: 'read-hash' }))
})
it.each(['conflict', 'error'])('keeps tab and draft after a %s save', async outcome => {
  await open(); await click('Close one.ts')
  if (outcome === 'conflict') request.mockResolvedValueOnce({ saved: false, conflict: { content: 'foreign', hash: 'foreign-hash' } } as never)
  else request.mockRejectedValueOnce(new Error('Save refused'))
  await click('Save'); expect(tabs()).toHaveLength(1); expect(draft()?.content).toBe('draft'); expect(host.querySelector('textarea')?.value).toBe('draft')
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})
it('dismisses a dirty-close question on subject changes without acting on either conversation', async () => {
  await open(); await click('Close one.ts'); await act(async () => store.openEditorFile(second, path)); await draw(second)
  expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(tabs()).toHaveLength(1); expect(tabs(second)).toHaveLength(1); expect(draft()?.content).toBe('draft')
  expect(request.mock.calls.filter(([method]: [string]) => method === 'file/save')).toHaveLength(0)
})

it('dismisses the close question when another file becomes active in the same conversation', async () => {
  await open(); await click('Close one.ts')
  await act(async () => store.openEditorFile(first, other))
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(tabs()).toHaveLength(2); expect(draft()?.content).toBe('draft')
  expect(request.mock.calls.filter(([method]: [string]) => method === 'file/save')).toHaveLength(0)
})
