import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, CeilingLevel, CeilingUpdate as Shown } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import type { AppStore } from '../state/store'
import { CeilingUpdate } from './CeilingUpdate'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const entry = (ceilingFrom: 'permission' | 'none' = 'permission'): AgentEntry => ({
  id: 'reviewer',
  origin: 'project',
  path: '/work/repo/.harnessdesk/agents/reviewer/AGENT.md',
  digest: 'roster-digest',
  shadows: [],
  problems: [],
  definition: {
    id: 'reviewer',
    name: 'Reviewer',
    description: null,
    ceiling: ceilingFrom === 'none' ? 'read' : 'edit',
    ceilingFrom,
    answers: [],
    produces: [],
    skills: [],
    mcp: [],
    prefer: [],
    brief: 'Review.',
  },
})

const shown = (level: CeilingLevel, digest = `preview-${level}`): Shown => ({
  path: '/work/repo/.harnessdesk/agents/reviewer/AGENT.md',
  digest,
  line: 3,
  before: 'permission: read',
  after: `ceiling: ${level}`,
  diff: `--- a/AGENT.md\n+++ b/AGENT.md\n@@ -3 +3 @@\n-permission: read\n+ceiling: ${level}\n`,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const mount = (over: Partial<AppStore> = {}, source = entry()) => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => ({}),
    previewCeiling: vi.fn(async (_entry: AgentEntry, level: CeilingLevel) => shown(level)),
    writeCeiling: vi.fn(async () => source),
    ...over,
  } as unknown as AppStore
  const onClose = vi.fn()
  act(() => root.render(<StoreProvider store={store}><CeilingUpdate entry={source} onClose={onClose} /></StoreProvider>))
  return { store, onClose }
}

const button = (words: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.includes(words))
  if (!found) throw new Error(`no button containing ${words}`)
  return found
}

it('shows the line before writing it, and writes exactly what it showed', async () => {
  const { store, onClose } = mount()
  await vi.waitFor(() => expect(document.body.textContent).toContain('ceiling: edit'))
  expect(store.writeCeiling).not.toHaveBeenCalled()
  act(() => button('Narrow to Read').click())
  await vi.waitFor(() => expect(document.body.textContent).toContain('ceiling: read'))
  await act(async () => button('Write this line').click())
  expect(store.writeCeiling).toHaveBeenCalledWith(expect.objectContaining({ id: 'reviewer' }), 'read', 'preview-read')
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('ignores a superseded preview and cannot write while the current one waits', async () => {
  const edit = deferred<Shown>()
  const read = deferred<Shown>()
  const previewCeiling = vi.fn((_entry: AgentEntry, level: CeilingLevel) => level === 'edit' ? edit.promise : read.promise)
  const { store } = mount({ previewCeiling } as Partial<AppStore>)
  act(() => button('Narrow to Read').click())
  await act(async () => edit.resolve(shown('edit', 'old')))
  expect(document.body.textContent).not.toContain('ceiling: edit')
  expect(button('Write this line').disabled).toBe(true)
  await act(async () => read.resolve(shown('read', 'current')))
  await act(async () => button('Write this line').click())
  expect(store.writeCeiling).toHaveBeenCalledWith(expect.anything(), 'read', 'current')
})

it('late failures and replies after close do not change the dialog', async () => {
  const first = deferred<Shown>()
  const second = deferred<Shown>()
  const previewCeiling = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  mount({ previewCeiling } as Partial<AppStore>)
  act(() => button('Narrow to Read').click())
  await act(async () => second.resolve(shown('read')))
  await act(async () => first.reject(new Error('stale failure')))
  expect(document.body.textContent).not.toContain('stale failure')
  act(() => root.unmount())
})

it('says why a line cannot be written, and offers nothing to write', async () => {
  mount({ previewCeiling: vi.fn().mockRejectedValue(new Error('rewrite it by hand')) } as Partial<AppStore>)
  await vi.waitFor(() => expect(document.body.textContent).toContain('rewrite it by hand'))
  expect(button('Write this line').disabled).toBe(true)
})

it('a changed file is refused without a retry, and repeat submission is held', async () => {
  const writing = deferred<AgentEntry>()
  const writeCeiling = vi.fn().mockReturnValue(writing.promise)
  mount({ writeCeiling } as Partial<AppStore>)
  await vi.waitFor(() => expect(button('Write this line').disabled).toBe(false))
  act(() => { button('Write this line').click(); button('Write this line').click() })
  expect(writeCeiling).toHaveBeenCalledTimes(1)
  await act(async () => writing.reject(new Error('file changed since it was shown')))
  expect(document.body.textContent).toContain('file changed since it was shown')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

it('a missing key offers Keep Read and Allow Edit, and cancel writes nothing', async () => {
  const { store, onClose } = mount({}, entry('none'))
  expect(button('Keep Read')).not.toBeNull()
  expect(button('Allow Edit')).not.toBeNull()
  await vi.waitFor(() => expect(document.body.textContent).toContain('ceiling: read'))
  act(() => button('Cancel').click())
  expect(store.writeCeiling).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledTimes(1)
})
