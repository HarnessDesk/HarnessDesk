import type { HostMethodName, HostParams } from '@harnessdesk/protocol'
import type { AppStore } from '../state/store'
import { installExplorerFixture } from './editor-explorer-fixture'

/** A file-reading main surface backed only by synthetic, in-memory bytes. */
export const installEditorMainFixture = (store: AppStore) => {
  const { session } = installExplorerFixture(store, 'git')
  const retained = store.getSnapshot().sessions.get(session)!, root = retained.cwd, runtime = retained.runtime
  const subject = `session:${session}`, path = `${root}/app/checkout.ts`, readme = `${root}/README.md`
  const original = "export const checkout = 'Ready';\n"
  const files = new Map([
    [path, { content: original, hash: 'editor-code' }],
    [readme, { content: '# Storefront\n\nRead the checkout notes before editing.\n', hash: 'editor-readme' }],
  ])
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: HostMethodName, params: HostParams<HostMethodName>) => {
    if (method === 'workspace/readFile') {
      const file = files.get((params as HostParams<'workspace/readFile'>).path)
      if (file) return { kind: 'text', ...file, truncated: false }
    }
    if (method === 'git/diff') return { diff: '', truncated: false }
    if (method === 'workspace/stat') return { kind: 'file', isSymlink: false, modifiedAt: 1 }
    if (method === 'file/save') {
      const saving = params as HostParams<'file/save'>, file = files.get(saving.path)
      if (file && file.hash !== saving.expectedHash) return { saved: false, conflict: file }
      const hash = `editor-saved-${saving.content.length}`
      files.set(saving.path, { content: saving.content, hash })
      return { saved: true, hash }
    }
    return request(method, params as never)
  }) as typeof store.transport.request
  store.openEditorFile(subject, path, { keep: true })
  store.setEditorDocument(subject, path, { base: { content: original, hash: 'editor-code', truncated: false }, content: "export const checkout = 'Checkout';\n", pendingCreation: false })
  store.openEditorFile(subject, readme)
  store.selectEditorFile(subject, path)
  store.setWindowMode('editor')
  return { subject, path, runtime }
}
