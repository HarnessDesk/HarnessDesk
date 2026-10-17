import { expect, it, vi } from 'vitest'
import type { LibraryPlannedOp, LibraryOpResult } from '@harnessdesk/protocol'
import { showToast } from '../design'
import { libraryWriteToasts } from './LibraryWriteToast'
vi.mock('../design', () => ({ showToast: vi.fn() }))
const op = (action: LibraryPlannedOp['action'], id = 'one'): LibraryPlannedOp => ({ id, kind: 'skill', name: 'changelog', action, targetPath: '/home/jane/skills/changelog', guardDigest: null, backup: false })
const done = (id = 'one'): LibraryOpResult => ({ id, outcome: 'done' })
it('says each single write with the page verb and opens changes without Undo', () => {
  for (const [action, title] of [['create', 'Installed changelog'], ['update', 'Updated changelog'], ['replace', 'Replaced a copy of changelog'], ['remove', 'Removed a copy of changelog']] as const) {
    vi.mocked(showToast).mockClear()
    const open = vi.fn()
    libraryWriteToasts([op(action)], [done()], open)
    expect(showToast).toHaveBeenCalledExactlyOnceWith({ tone: 'success', title, action: { label: 'View changes', onSelect: open } })
    vi.mocked(showToast).mock.calls[0]![0].action!.onSelect()
    expect(open).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(showToast).mock.calls)).not.toContain('Undo')
  }
})
it('combines installs and mixed writes, persists failures with their first reason, ignores skips', () => {
  vi.mocked(showToast).mockClear()
  libraryWriteToasts([op('create'), op('create', 'two')], [done(), done('two')], vi.fn())
  expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Added 2 skills to the Library' }))
  libraryWriteToasts([op('create'), op('update', 'two')], [done(), done('two')], vi.fn())
  expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Made 2 changes to the Library' }))
  libraryWriteToasts([op('create'), op('remove', 'two')], [done(), { id: 'two', outcome: 'failed', detail: 'Permission denied' }], vi.fn())
  expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({ tone: 'danger', title: "Couldn't remove a copy of changelog", body: 'Permission denied', action: expect.objectContaining({ label: 'View changes' }) }), { persist: true })
  libraryWriteToasts([op('create'), op('update', 'two')], [{ id: 'one', outcome: 'failed', detail: 'First reason' }, { id: 'two', outcome: 'failed', detail: 'Second reason' }], vi.fn())
  expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "2 changes didn't go through", body: 'First reason' }), { persist: true })
  vi.mocked(showToast).mockClear()
  libraryWriteToasts([op('skip')], [{ id: 'one', outcome: 'skipped' }], vi.fn())
  expect(showToast).not.toHaveBeenCalled()
})

it('uses MCP verbs and never calls MCP additions skills', () => {
  vi.mocked(showToast).mockClear()
  const server = { ...op('create'), kind: 'mcp' as const, name: 'fetcher' }
  libraryWriteToasts([server], [done()], vi.fn())
  expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Added fetcher' }))
  libraryWriteToasts([server, { ...server, id: 'two' }], [done(), done('two')], vi.fn())
  expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Made 2 changes to the Library' }))
})
