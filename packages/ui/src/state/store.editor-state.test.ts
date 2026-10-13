import { beforeEach, expect, it, vi } from 'vitest'
import type { HostMethodName } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { editorConversation, type FileDocumentState } from '../editor'

let store: AppStore
let saved: Record<string, unknown>
const doc: FileDocumentState = {
  base: { content: 'original', hash: 'read-hash', truncated: false }, content: 'unsaved', pendingCreation: false,
  comparison: { content: 'foreign disk', hash: 'comparison-hash' },
}
beforeEach(() => {
  saved = {}
  store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'app/state/get') return saved
    if (method === 'app/state/set') Object.assign(saved, (params as { patch: Record<string, unknown> }).patch)
    return null
  }) as never)
})

it('writes and restores mode and conversation tabs through app/state without document contents', async () => {
  await store.loadPreferences()
  store.setWindowMode('editor')
  store.openEditorFile('session:first', 'notes.md')
  store.setEditorDocument('session:first', 'notes.md', doc)
  store.setEditorFileView('session:first', 'notes.md', 'changes')
  store.setEditorExplorerFilter('session:first', 'all')
  store.setEditorExpandedFolders('session:first', ['src'])
  store.openEditorFile('session:second', 'two.ts')
  const encoded = JSON.stringify(saved)
  for (const privateValue of ['original', 'unsaved', 'read-hash', 'foreign disk', 'comparison-hash']) expect(encoded).not.toContain(privateValue)
  const fresh = new AppStore('ws://localhost:0/')
  vi.spyOn(fresh.transport, 'request').mockResolvedValue(saved as never)
  await fresh.loadPreferences()
  expect(fresh.getSnapshot().windowMode).toBe('editor')
  expect(editorConversation(fresh.getSnapshot().editorState, 'session:first')).toEqual(editorConversation(store.getSnapshot().editorState, 'session:first'))
  expect(fresh.getSnapshot().editorDocuments.size).toBe(0)
})

it('retains complete live documents and tabs beyond the persistence bound and across mode switches', async () => {
  await store.loadPreferences()
  store.openEditorFile('session:first', 'one.md')
  store.setEditorDocument('session:first', 'one.md', doc)
  store.setEditorFileView('session:first', 'one.md', 'changes')
  store.setWindowMode('conversation')
  for (let n = 0; n < 51; n++) store.openEditorFile(`session:${n}`, `${n}.ts`)
  expect(saved.editorState).toHaveLength(50)
  store.touchEditorConversation('session:first')
  store.setWindowMode('editor')
  expect(editorConversation(store.getSnapshot().editorState, 'session:first')).toMatchObject({
    tabs: [{ path: 'one.md', view: 'changes' }], active: 'one.md', preview: null,
  })
  expect(store.getSnapshot().editorDocuments.get('session:first')?.get('one.md')).toEqual(doc)
  expect((saved.editorState as { subject: string }[])[0]?.subject).toBe('session:first')
})

it('protects dirty tabs from preview replacement and close until explicitly discarded', () => {
  store.openEditorFile('session:first', 'one.md', { document: doc })
  store.openEditorFile('session:first', 'two.ts')
  expect(editorConversation(store.getSnapshot().editorState, 'session:first').tabs).toHaveLength(2)
  expect(store.closeEditorFile('session:first', 'one.md')).toBe(false)
  expect(store.closeEditorFile('session:first', 'one.md', true)).toBe(true)
  expect(store.getSnapshot().editorDocuments.get('session:first')?.has('one.md')).toBeFalsy()
  expect(editorConversation(store.getSnapshot().editorState, 'session:first').active).toBe('two.ts')
})

it('clears saved document state without turning its kept tab back into preview', () => {
  store.openEditorFile('session:first', 'one.md', { document: doc })
  store.setEditorDocument('session:first', 'one.md', null)
  expect(store.getSnapshot().editorDocuments.has('session:first')).toBe(false)
  expect(editorConversation(store.getSnapshot().editorState, 'session:first').preview).toBeNull()
})

it('merges preferences arriving late without replacing local mode or the changed subject', async () => {
  let answer!: (value: Record<string, unknown>) => void
  vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'app/state/get') return new Promise(resolve => { answer = resolve })
    if (method === 'app/state/set') Object.assign(saved, (params as { patch: Record<string, unknown> }).patch)
    return null
  }) as never)
  const loading = store.loadPreferences()
  store.setWindowMode('editor')
  store.openEditorFile('session:local', 'mine.md', { document: doc })
  answer({ windowMode: 'conversation', editorState: [
    { subject: 'session:local', state: { tabs: [{ path: 'old.ts', view: 'source' }] } },
    { subject: 'session:other', state: { tabs: [{ path: 'other.ts', view: 'source' }] } },
  ] })
  await loading
  expect(store.getSnapshot().windowMode).toBe('editor')
  expect(editorConversation(store.getSnapshot().editorState, 'session:local').active).toBe('mine.md')
  expect(editorConversation(store.getSnapshot().editorState, 'session:other').active).toBe('other.ts')
  expect(store.getSnapshot().editorDocuments.get('session:local')?.get('mine.md')).toEqual(doc)
  expect((saved.editorState as { subject: string }[]).map(one => one.subject)).toEqual(['session:local', 'session:other'])
})

it('restores saved tabs after a recency-only startup touch while keeping that subject most recent', async () => {
  let answer!: (value: Record<string, unknown>) => void
  vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName) =>
    method === 'app/state/get' ? new Promise(resolve => { answer = resolve }) : null) as never)
  const loading = store.loadPreferences()
  store.touchEditorConversation('session:startup')
  answer({ windowMode: 'editor', editorState: [
    { subject: 'session:other', state: { tabs: [{ path: 'other.ts', view: 'source' }] } },
    { subject: 'session:startup', state: { tabs: [{ path: 'restored.md', view: 'changes' }], active: 'restored.md', filter: 'all', expanded: ['src'] } },
  ] })
  await loading
  expect(store.getSnapshot().windowMode).toBe('editor')
  expect(store.getSnapshot().editorState[0]?.subject).toBe('session:startup')
  expect(editorConversation(store.getSnapshot().editorState, 'session:startup')).toMatchObject({
    tabs: [{ path: 'restored.md', view: 'changes' }], active: 'restored.md', filter: 'all', expanded: ['src'],
  })
})

it('does not write empty startup tabs before preferences have even begun loading', async () => {
  saved = { editorState: [{ subject: 'session:startup', state: { tabs: [{ path: 'saved.md', view: 'preview' }] } }] }
  store.touchEditorConversation('session:startup')
  await store.loadPreferences()
  expect(editorConversation(store.getSnapshot().editorState, 'session:startup').active).toBe('saved.md')
})

it.each(['before', 'during'] as const)('defers local metadata mutations %s initial hydration without replacing saved peers', async timing => {
  const original = [
    { subject: 'session:local', state: { tabs: [{ path: 'old.ts', view: 'source' }], active: 'old.ts' } },
    { subject: 'session:saved', state: { tabs: [{ path: 'saved.md', view: 'changes' }], active: 'saved.md', filter: 'all', expanded: ['src'] } },
  ]
  saved = { windowMode: 'conversation', editorState: original }
  let answer!: () => void
  vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'app/state/get') {
      const captured = structuredClone(saved)
      return timing === 'during' ? new Promise(resolve => { answer = () => resolve(captured) }) : captured
    }
    if (method === 'app/state/set') saved = { ...saved, ...(params as { patch: Record<string, unknown> }).patch }
    return null
  }) as never)
  const pending = timing === 'during' ? store.loadPreferences() : null
  store.setWindowMode('editor')
  store.openEditorFile('session:local', 'mine.md', { document: doc })
  store.setEditorFileView('session:local', 'mine.md', 'changes')
  store.setEditorExplorerFilter('session:local', 'all')
  store.setEditorExpandedFolders('session:local', ['mine'])
  expect(saved.editorState).toEqual(original)
  expect(editorConversation(store.getSnapshot().editorState, 'session:local').active).toBe('mine.md')
  expect(store.getSnapshot().editorDocuments.get('session:local')?.get('mine.md')).toEqual(doc)
  if (timing === 'during') answer()
  await (pending ?? store.loadPreferences())
  expect(store.getSnapshot().windowMode).toBe('editor')
  expect(editorConversation(store.getSnapshot().editorState, 'session:local')).toMatchObject({
    tabs: [{ path: 'mine.md', view: 'changes' }], active: 'mine.md', preview: null, filter: 'all', expanded: ['mine'],
  })
  expect(editorConversation(store.getSnapshot().editorState, 'session:saved')).toMatchObject(original[1]!.state)
  expect(store.getSnapshot().editorDocuments.get('session:local')?.get('mine.md')).toEqual(doc)
  expect(saved.editorState).toEqual(store.getSnapshot().editorState)
})

it('keeps metadata writes deferred after a failed initial read until a retry can merge saved peers', async () => {
  const original = [{ subject: 'session:saved', state: { tabs: [{ path: 'saved.md', view: 'preview' }] } }]
  saved = { editorState: original }
  let failRead = true
  vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'app/state/get') {
      if (failRead) throw new Error('read refused')
      return structuredClone(saved)
    }
    if (method === 'app/state/set') saved = { ...saved, ...(params as { patch: Record<string, unknown> }).patch }
    return null
  }) as never)
  await store.loadPreferences()
  expect(store.getSnapshot().preferencesLoaded).toBe(true)
  store.openEditorFile('session:local', 'mine.md', { document: doc })
  expect(saved.editorState).toEqual(original)
  failRead = false
  await store.loadPreferences()
  expect(editorConversation(store.getSnapshot().editorState, 'session:saved').active).toBe('saved.md')
  expect(store.getSnapshot().editorDocuments.get('session:local')?.get('mine.md')).toEqual(doc)
  expect(saved.editorState).toEqual(store.getSnapshot().editorState)
})

it('reports failed preference writes while preserving the local state', async () => {
  await store.loadPreferences()
  vi.mocked(store.transport.request).mockRejectedValue(new Error('write refused'))
  store.setWindowMode('editor')
  store.openEditorFile('session:first', 'one.md')
  await vi.waitFor(() => expect(store.getSnapshot().notices).toHaveLength(2))
  expect(store.getSnapshot().windowMode).toBe('editor')
  expect(editorConversation(store.getSnapshot().editorState, 'session:first').active).toBe('one.md')
})
