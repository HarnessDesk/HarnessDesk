import { expect, it } from 'vitest'
import * as editor from './index'

const root = '/project/branch/src'
const git = { root: '/project/branch', ahead: 0, behind: 0, files: [
  { path: 'src/app/a.ts', status: 'modified', staged: false },
  { path: 'src/app/a.ts', status: 'modified', staged: true },
  { path: 'src/gone.ts', status: 'deleted', staged: false },
  { path: 'src/newdir/', status: 'untracked', staged: false },
  { path: 'outside.ts', status: 'added', staged: false },
] } as const
it('rebases Git paths to the conversation subfolder and deduplicates staged/unstaged entries', () => {
  const changes = editor.explorerChanges(root, git)
  expect([...changes.keys()]).toEqual([`${root}/app/a.ts`, `${root}/gone.ts`, `${root}/newdir`])
  expect(changes.get(`${root}/newdir`)?.kind).toBe('directory')
  expect(editor.explorerChanges(root, null).size).toBe(0)
})
it('Changed synthesizes ancestors and deleted files without turning untracked directories into tabs', () => {
  const rows = editor.explorerRows(root, new Map(), [], 'changed', editor.explorerChanges(root, git))
  expect(rows.map(row => [row.name, row.kind, row.letter])).toEqual([
    ['app', 'directory', null], ['newdir', 'directory', null], ['gone.ts', 'file', 'D'],
  ])
  const opened = editor.explorerRows(root, new Map(), [`${root}/app`], 'changed', editor.explorerChanges(root, git))
  expect(opened.map(row => row.name)).toEqual(['app', 'a.ts', 'newdir', 'gone.ts'])
  expect(opened[1]?.letter).toBe('M')
})
it('All loads only expanded folders and suppresses letters when not in Git', () => {
  const listings = new Map([[root, [
    { name: 'app', path: `${root}/app`, kind: 'directory' as const },
    { name: 'note.md', path: `${root}/note.md`, kind: 'file' as const },
  ]], [`${root}/app`, [{ name: 'a.ts', path: `${root}/app/a.ts`, kind: 'file' as const }]]])
  expect(editor.explorerRows(root, listings, [], 'all', new Map()).map(row => row.name)).toEqual(['app', 'note.md'])
  expect(editor.explorerRows(root, listings, [`${root}/app`], 'all', new Map()).map(row => [row.name, row.depth, row.letter])).toEqual([
    ['app', 0, null], ['a.ts', 1, null], ['note.md', 0, null],
  ])
})
it('a collapsed untracked directory admits lazily read files under Changed', () => {
  const path = `${root}/newdir`
  const listings = new Map([[path, [{ name: 'new.ts', path: `${path}/new.ts`, kind: 'file' as const }]]])
  const rows = editor.explorerRows(root, listings, [path], 'changed', editor.explorerChanges(root, git))
  expect(rows.find(row => row.name === 'new.ts')?.letter).toBe('A')
})
