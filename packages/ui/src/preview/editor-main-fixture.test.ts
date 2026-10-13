import { expect, it } from 'vitest'
import { editorConversation, readHead } from '../editor'
import { frameDestinationStore } from './frame-destination-store'
import { previewStore } from './harness'
import { installEditorMainFixture } from './editor-main-fixture'

it('uses synthetic editable files and keeps document writes inside the preview fixture', async () => {
  const store = frameDestinationStore(previewStore())
  const { subject, path, runtime } = installEditorMainFixture(store)
  expect(store.getSnapshot().windowMode).toBe('editor')
  expect(editorConversation(store.getSnapshot().editorState, subject).tabs).toHaveLength(2)
  expect(store.getSnapshot().editorDocuments.get(subject)?.get(path)?.content).toContain('Checkout')
  const read = await store.transport.request('workspace/readFile', { path, runtime })
  expect(read.kind).toBe('text')
  expect(await readHead((method, params) => store.transport.request(method, params), { root: '/work/storefront-branch/src', path, runtime, disk: read })).toMatchObject({ content: "export const checkout = 'Ready';\n" })
  const saved = await store.transport.request('file/save', { path, runtime, content: 'Synthetic edit', expectedHash: 'editor-code' })
  expect(saved.saved).toBe(true)
  expect(await store.transport.request('workspace/readFile', { path, runtime })).toMatchObject({ content: 'Synthetic edit' })
})
