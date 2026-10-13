import { useEffect } from 'react'
import { itemId, turnId, type HostMethodName, type HostParams } from '@harnessdesk/protocol'
import { wholeTextDiff } from '../editor'
import { useStore } from '../state/context'
import type { AppStore } from '../state/store'

export type EditorModeScene = 'conversation' | 'source' | 'changes' | 'preview' | 'ask' | 'conflict' | 'panel' | 'minimap' | 'deleted' | 'alias'
const fixtures = new WeakMap<AppStore, ReturnType<typeof installEditorModeFixture>>()
export const editorModeFixture = (store: AppStore) => fixtures.get(store)

/** The real frame and editor, backed by synthetic working-tree and HEAD bytes only. */
export function installEditorModeFixture(store: AppStore, scene: EditorModeScene) {
  const snapshot = store.getSnapshot(), key = snapshot.activeSessionKey!
  const retained = snapshot.sessions.get(key)!, root = '/work/storefront-branch', runtime = retained.runtime
  const subject = `session:${key}`, path = `${root}/src/auth.ts`, readme = `${root}/README.md`
  const head = new Map([
    [path, 'export function authorize(token: string) {\n  if (!token) return false;\n  return token.length > 8;\n}\n'],
    [readme, '# Storefront\n\nCheckout records are ready to inspect.\n\n## Retry policy\n\nA cancelled payment can be resumed after confirmation.\n'],
    [`${root}/src/checkout.ts`, 'export const paymentTimeout = 3000;\n'],
    [`${root}/unchanged.ts`, 'export const currency = "USD";\n'],
  ])
  const auth = 'export function authorize(token: string) {\n  if (!token) return false;\n  return token.length >= 12;\n}\n'
  const draft = 'export function authorize(token: string) {\n  if (!token) return false;\n  return retryPayment(token);\n}\n\nfunction retryPayment(token: string) {\n  return token.length >= 12;\n}\n'
  const readmeContent = '# Storefront\n\nCheckout records are ready to inspect.\n\n## Retry policy\n\nA cancelled payment can be resumed after confirmation.\n\n1. Keep the payment reference.\n2. Verify the last outcome.\n3. Retry once the customer confirms.\n'
  const files = new Map([
    [path, { content: auth, hash: 'fixture-auth', modifiedAt: 1 }],
    [readme, { content: readmeContent, hash: 'fixture-readme', modifiedAt: 1 }],
    [`${root}/src/checkout.ts`, { content: 'export const paymentTimeout = 5000;\n', hash: 'fixture-checkout', modifiedAt: 1 }],
    [`${root}/docs/retry.md`, { content: '# Payment recovery\n\nConfirm the previous attempt before retrying.\n', hash: 'fixture-retry', modifiedAt: 1 }],
    [`${root}/unchanged.ts`, { content: head.get(`${root}/unchanged.ts`)!, hash: 'fixture-unchanged', modifiedAt: 1 }],
  ])
  const status = { root, branch: 'feature/payment-retry', ahead: 1, behind: 0, files: [
    { path: 'src/auth.ts', status: 'modified' as const, staged: false },
    { path: 'README.md', status: 'modified' as const, staged: false },
    { path: 'src/checkout.ts', status: 'modified' as const, staged: false },
    { path: 'docs/retry.md', status: 'added' as const, staged: false },
  ] }
  const listings: Record<string, readonly { name: string; kind: 'directory' | 'file' }[]> = {
    [root]: [{ name: 'src', kind: 'directory' }, { name: 'docs', kind: 'directory' }, { name: 'README.md', kind: 'file' }, { name: 'unchanged.ts', kind: 'file' }],
    [`${root}/src`]: [{ name: 'auth.ts', kind: 'file' }, { name: 'checkout.ts', kind: 'file' }],
    [`${root}/docs`]: [{ name: 'retry.md', kind: 'file' }],
  }
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: HostMethodName, params: HostParams<HostMethodName>) => {
    if (method === 'git/status') {
      const current = { ...status, files: status.files.map(file => file.path === 'src/auth.ts' && !files.has(path) ? { ...file, status: 'deleted' as const } : file) }
      return scene === 'alias' ? { ...current, root: '/canonical/storefront', resolvedRoot: '/canonical/storefront/subfolder', files: current.files.map(file => ({ ...file, path: `subfolder/${file.path}` })) } : current
    }
    if (method === 'workspace/readFile') {
      const file = files.get((params as HostParams<'workspace/readFile'>).path)
      return file ? { kind: 'text', content: file.content, hash: file.hash, truncated: false } : { kind: 'missing' }
    }
    if (method === 'workspace/stat') {
      const file = files.get((params as HostParams<'workspace/stat'>).path)
      if (!file) throw new Error('Synthetic file not found')
      return { kind: 'file', isSymlink: false, modifiedAt: file.modifiedAt }
    }
    if (method === 'git/diff') {
      const p = params as HostParams<'git/diff'>
      const paths = p.path ? [`${root}/${scene === 'alias' ? p.path.replace(/^subfolder\//, '') : p.path}`] : [...new Set([...files.keys(), ...head.keys()])].filter(file => file !== `${root}/unchanged.ts`)
      return { diff: p.staged ? '' : paths.map(file => {
        const relative = `${scene === 'alias' ? 'subfolder/' : ''}${file.slice(root.length + 1)}`, after = files.get(file)?.content ?? ''
        const before = head.get(file) ?? ''
        const added = after.replace(/\n$/, '').split('\n')
        const removed = before.replace(/\n$/, '').split('\n')
        const patch = !files.has(file) ? `@@ -1,${removed.length} +0,0 @@\n${removed.map(line => `-${line}`).join('\n')}`
          : head.has(file) ? wholeTextDiff(before.replace(/\n$/, ''), after.replace(/\n$/, ''))
          : `@@ -0,0 +1,${added.length} @@\n${added.map(line => `+${line}`).join('\n')}`
        return before === after ? '' : `diff --git a/${relative} b/${relative}\n--- ${head.has(file) ? `a/${relative}` : '/dev/null'}\n+++ ${files.has(file) ? `b/${relative}` : '/dev/null'}\n${patch}\n`
      }).join('\n'), truncated: false }
    }
    if (method === 'workspace/browse' && (params as HostParams<'workspace/browse'>).mode === 'entries') {
      const p = params as HostParams<'workspace/browse'>, folder = p.path ?? root
      return { path: folder, parent: folder === root ? null : root, entries: (listings[folder] ?? []).map(entry => ({ ...entry, path: `${folder}/${entry.name}` })) }
    }
    if (method === 'workspace/files') {
      const p = params as HostParams<'workspace/files'>
      return [...files.keys()].filter(file => file.toLowerCase().includes(p.query.toLowerCase()))
        .map(file => ({ path: file, relativePath: file.slice(root.length + 1), kind: 'file', score: 1 }))
    }
    if (method === 'file/save') {
      const p = params as HostParams<'file/save'>, file = files.get(p.path)
      if (!file) return { saved: false, conflict: { content: '', hash: '', missing: true } }
      if (file.hash !== p.expectedHash) return { saved: false, conflict: { content: file.content, hash: file.hash } }
      const hash = `fixture-saved-${file.modifiedAt + 1}`
      files.set(p.path, { content: p.content, hash, modifiedAt: file.modifiedAt + 1 })
      return { saved: true, hash }
    }
    return request(method, params as never)
  }) as typeof store.transport.request
  Object.assign(snapshot, { sessions: new Map(snapshot.sessions).set(key, { ...retained, cwd: root, title: 'Payment retry review', turns: [{
    id: turnId('editor-mode-work'), status: 'completed', diff: null, items: [
      { id: itemId('editor-mode-files'), type: 'fileChange', status: 'completed', changes: status.files.map(file => ({
        path: `${root}/${file.path}`, kind: { type: file.status === 'added' ? 'add' as const : 'update' as const },
        diff: wholeTextDiff(head.get(`${root}/${file.path}`) ?? '', files.get(`${root}/${file.path}`)!.content),
      })) },
      { id: itemId('editor-mode-answer'), type: 'assistantMessage', text: 'The retry policy now checks the previous payment before another attempt. Read [auth.ts:3](src/auth.ts:3) and [README.md:7](README.md:7), or review the four changed files.' },
    ],
  }] }), workspace: { ...snapshot.workspace!, path: '/work/storefront', name: 'storefront' } })
  if (scene === 'deleted') files.delete(path)
  store.openEditorFile(subject, path, { keep: true, view: scene === 'changes' || scene === 'deleted' ? 'changes' : 'source' })
  if (scene !== 'deleted') store.setEditorLiveDocument(subject, path, { base: { content: auth, hash: 'fixture-auth', truncated: false }, content: draft, pendingCreation: false })
  store.openEditorFile(subject, readme)
  store.selectEditorFile(subject, scene === 'preview' ? readme : path)
  store.setEditorExpandedFolders(subject, [`${root}/src`, `${root}/docs`])
  store.setWindowMode(scene === 'conversation' || scene === 'panel' ? 'conversation' : 'editor')
  if (scene === 'panel') store.openFile(readme)
  if (scene === 'minimap') store.setEditorPrefs({ minimap: true })
  const control = { scene, subject, path, readme, root, runtime, deleteOnDisk: () => files.delete(path), changeOnDisk: (target = path) => {
    const file = files.get(target)
    if (file) files.set(target, { content: `${file.content}\n// Updated on disk.\n`, hash: 'fixture-disk-change', modifiedAt: file.modifiedAt + 1 })
  } }
  fixtures.set(store, control)
  if (scene === 'conflict') control.changeOnDisk()
  return control
}

/** Stage a real Source selection only for the explicit Ask preview destination. */
export const EditorModeSelection = () => {
  const store = useStore()
  useEffect(() => {
    if (editorModeFixture(store)?.scene !== 'ask') return
    let selected = false, frame = 0
    const select = () => {
      const line = document.querySelector('[data-slot="editor-main"] .cm-content .cm-line:nth-child(3)')
      if (!line || selected) return
      selected = true
      frame = requestAnimationFrame(() => {
        ;(line.closest('.cm-content') as HTMLElement).focus()
        const range = document.createRange(); range.selectNodeContents(line)
        const selection = document.getSelection()!
        selection.removeAllRanges(); selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
    }
    const observer = new MutationObserver(select)
    observer.observe(document.body, { childList: true, subtree: true })
    select()
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [store])
  return null
}
