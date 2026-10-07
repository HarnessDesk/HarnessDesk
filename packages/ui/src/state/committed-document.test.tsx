import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from './context'
import { useCommittedDocument, mayBeDocument } from './committed-document'
import { runTeamStore } from '../preview/run-view-fixture'
import { DOCUMENT_DIFF } from '../preview/run-shapes-fixture'
import type { RunChange } from '../lib/run-timeline'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const change: RunChange = { cwd: '/repo', branch: 'work', from: '0'.repeat(40), revision: 'a'.repeat(40), files: 1, added: 3, removed: 0 }
it('reads only a bounded one-file addition with a recorded checkout', () => {
  expect(mayBeDocument(change)).toBe(true)
  expect(mayBeDocument({ ...change, removed: 1 })).toBe(true)
  for (const patch of [{ cwd: null }, { files: 2 }, { added: 0 }]) expect(mayBeDocument({ ...change, ...patch })).toBe(false)
})
it('shares immutable revision reads and never carries a document into the next revision', async () => {
  const store = runTeamStore(); let rawText = 'Investigation answer'; let finish!: (result: { diff: string }) => void
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'git/fileAtRevision' ? { text: rawText, bytes: rawText.length } : new Promise(resolve => { finish = resolve })) as never)
  const rendered: string[] = []
  const Probe = ({ value }: { value: RunChange | null }) => { const found = useCommittedDocument(value); rendered.push(found?.text ?? 'empty'); return <div>{found?.text}</div> }
  const container = document.createElement('div'); const root = createRoot(container)
  const render = (value: RunChange | null) => act(() => root.render(<StoreProvider store={store}><Probe value={value} /><Probe value={value} /></StoreProvider>))
  try {
    render(change); expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('git/diffRange', { root: '/repo', from: change.from, to: change.revision })
    await act(async () => finish({ diff: DOCUMENT_DIFF })); expect(container.textContent).toContain('Investigation answer')
    rendered.length = 0
    render({ ...change, revision: 'b'.repeat(40) })
    expect(rendered.every(one => one === 'empty')).toBe(true)
    rawText = 'Second answer'
    await act(async () => finish({ diff: DOCUMENT_DIFF }))
    expect(container.textContent).toContain('Second answer')
    render(null); expect(container.textContent).toBe('')
  } finally { act(() => root.unmount()); request.mockRestore() }
})
it('ignores a late document from a superseded revision and retries a refused read on remount', async () => {
  const store = runTeamStore(); let finish!: (result: { diff: string }) => void
  let nextReads = 0
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { to?: string }) => {
    if (method === 'git/fileAtRevision') return { text: 'Investigation answer', bytes: 20 }
    if (params.to === change.revision) return new Promise(resolve => { finish = resolve })
    if (nextReads++ === 0) throw new Error('Checkout unavailable')
    return { diff: DOCUMENT_DIFF }
  }) as never)
  const Probe = ({ value }: { value: RunChange | null }) => <div>{useCommittedDocument(value)?.text}</div>
  const container = document.createElement('div'); const root = createRoot(container)
  const render = (value: RunChange | null, key = 'probe') => act(() => root.render(<StoreProvider store={store}><Probe key={key} value={value} /></StoreProvider>))
  try {
    render(change); const next = { ...change, revision: 'b'.repeat(40) }; await act(async () => render(next))
    await act(async () => finish({ diff: DOCUMENT_DIFF })); expect(container.textContent).toBe('')
    await act(async () => render(next, 'remount')); expect(container.textContent).toContain('Investigation answer')
    expect(request).toHaveBeenCalledTimes(5)
  } finally { act(() => root.unmount()); request.mockRestore() }
})
it('reads the full updated document at the recorded revision, instead of presenting only changed lines', async () => {
  const store = runTeamStore()
  const diff = 'diff --git a/docs/answer.md b/docs/answer.md\n--- a/docs/answer.md\n+++ b/docs/answer.md\n@@ -1 +1 @@\n-old\n+new\n'
  const request = vi.spyOn(store.transport, 'request').mockResolvedValueOnce({ diff } as never).mockResolvedValueOnce({ text: 'unchanged introduction\nnew\nunchanged ending', bytes: 42 } as never)
  const Probe = () => <div>{useCommittedDocument({ ...change, removed: 1 })?.text}</div>
  const container = document.createElement('div'); const root = createRoot(container)
  try {
    await act(async () => root.render(<StoreProvider store={store}><Probe /></StoreProvider>))
    expect(container.textContent).toContain('unchanged introduction')
    expect(request).toHaveBeenLastCalledWith('git/fileAtRevision', { root: '/repo', sha: change.revision, path: 'docs/answer.md' })
  } finally { act(() => root.unmount()); request.mockRestore() }
})

it('always reads raw committed content instead of trusting the added text in a diff', async () => {
  const store = runTeamStore()
  const request = vi.spyOn(store.transport, 'request').mockResolvedValueOnce({ diff: DOCUMENT_DIFF } as never).mockResolvedValueOnce({ text: 'Raw committed words', bytes: 19 } as never)
  const Probe = () => <div>{useCommittedDocument(change)?.text}</div>
  const container = document.createElement('div'); const root = createRoot(container)
  try {
    await act(async () => root.render(<StoreProvider store={store}><Probe /></StoreProvider>))
    expect(container.textContent).toBe('Raw committed words')
  } finally { act(() => root.unmount()); request.mockRestore() }
})
