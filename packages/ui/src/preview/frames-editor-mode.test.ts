import { expect, it } from 'vitest'
import { editorConversation, readHead } from '../editor'
import { frameDestinationStore } from './frame-destination-store'
import { previewStore } from './harness'
import { installEditorModeFixture } from './frames-editor-mode'

it('provides four changed files, two tabs, one dirty document and real HEAD provenance', async () => {
  const store = frameDestinationStore(previewStore())
  const fixture = installEditorModeFixture(store, 'source')
  const { subject, root, path, readme, runtime } = fixture
  expect(editorConversation(store.getSnapshot().editorState, subject).tabs).toHaveLength(2)
  expect(store.getSnapshot().editorDocuments.get(subject)?.size).toBe(1)
  expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: expect.stringContaining('retryPayment') })
  expect((await store.transport.request('git/status', { root }))?.files).toHaveLength(4)
  for (const file of [path, readme, `${root}/src/checkout.ts`, `${root}/docs/retry.md`, `${root}/unchanged.ts`]) {
    const head = await readHead((method, params) => store.transport.request(method, params), { root, path: file, runtime })
    if (file.endsWith('docs/retry.md')) expect(head).toMatchObject({ content: null, status: 'added' })
    else expect(head.content).toContain(file === path ? 'token.length > 8' : file === readme ? '# Storefront' : file.endsWith('checkout.ts') ? '3000' : 'USD')
  }
})

it('conflicts and saves are confined to synthetic in-memory bytes with current hashes', async () => {
  const store = frameDestinationStore(previewStore())
  const { path, runtime, changeOnDisk } = installEditorModeFixture(store, 'source')
  changeOnDisk()
  expect(await store.transport.request('workspace/stat', { path, runtime })).toMatchObject({ modifiedAt: 2 })
  expect(await store.transport.request('file/save', { path, runtime, content: 'My draft', expectedHash: 'fixture-auth' })).toMatchObject({ saved: false, conflict: { hash: 'fixture-disk-change' } })
  const saved = await store.transport.request('file/save', { path, runtime, content: 'My draft', expectedHash: 'fixture-disk-change' })
  expect(saved.saved).toBe(true)
  expect(await store.transport.request('workspace/readFile', { path, runtime })).toMatchObject({ content: 'My draft' })
})
it('supplies a tracked deletion and its HEAD without an unsaved creation draft', async () => {
  const store = frameDestinationStore(previewStore())
  const { subject, path, root, runtime } = installEditorModeFixture(store, 'deleted')
  expect(await store.transport.request('workspace/readFile', { path, runtime })).toEqual({ kind: 'missing' })
  expect(store.getSnapshot().editorDocuments.get(subject)?.size ?? 0).toBe(0)
  expect(editorConversation(store.getSnapshot().editorState, subject).tabs.find(tab => tab.path === path)?.view).toBe('changes')
  expect(await readHead((method, params) => store.transport.request(method, params), { root, path, runtime })).toMatchObject({ content: expect.stringContaining('token.length > 8'), status: 'tracked' })
})
it('reads Git paths for a conversation alias below the canonical repository root', async () => {
  const store = frameDestinationStore(previewStore())
  const { path, root, runtime } = installEditorModeFixture(store, 'alias')
  expect(await store.transport.request('git/status', { root })).toMatchObject({ root: '/canonical/storefront', resolvedRoot: '/canonical/storefront/subfolder' })
  expect(await readHead((method, params) => store.transport.request(method, params), { root, path, runtime })).toMatchObject({ content: expect.stringContaining('token.length > 8'), status: 'tracked' })
})
