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

for (const filter of ['all', 'changed'] as const) it(`preserves a listed directory for a non-slash Git path under ${filter}, including expanded children`, () => {
  const vendor = `${root}/vendor`, library = `${vendor}/library`
  const listings = new Map<string, readonly editor.ExplorerEntry[]>([
    [root, [{ name: 'vendor', path: vendor, kind: 'directory' }]],
    [vendor, [{ name: 'library', path: library, kind: 'directory' }]],
    [library, [{ name: 'source.ts', path: `${library}/source.ts`, kind: 'file' }]],
  ])
  const changes = editor.explorerChanges(root, { root: '/project/branch', ahead: 0, behind: 0,
    files: [{ path: 'src/vendor/library', status: 'modified', staged: false }] })
  const closed = editor.explorerRows(root, listings, [vendor], filter, changes)
  expect(closed.map(row => [row.name, row.kind, row.letter])).toEqual([
    ['vendor', 'directory', null], ['library', 'directory', null],
  ])
  const expanded = editor.explorerRows(root, listings, [vendor, library], filter, changes)
  expect(expanded.map(row => [row.name, row.kind, row.depth])).toEqual([
    ['vendor', 'directory', 0], ['library', 'directory', 1], ['source.ts', 'file', 2],
  ])
})

for (const filter of ['all', 'changed'] as const) it(`keeps children visible without inheriting tracked-directory status under ${filter}`, () => {
  const vendor = `${root}/vendor`, library = `${vendor}/library`, nested = `${library}/nested`
  const listings = new Map<string, readonly editor.ExplorerEntry[]>([
    [root, [{ name: 'vendor', path: vendor, kind: 'directory' }]],
    [vendor, [{ name: 'library', path: library, kind: 'directory' }]],
    [library, [
      { name: 'unchanged.ts', path: `${library}/unchanged.ts`, kind: 'file' },
      { name: 'changed.ts', path: `${library}/changed.ts`, kind: 'file' },
      { name: 'nested', path: nested, kind: 'directory' },
    ]],
    [nested, [{ name: 'also-unchanged.ts', path: `${nested}/also-unchanged.ts`, kind: 'file' }]],
  ])
  // A gitlink's aggregate status names that directory, not every file beneath it.
  for (const status of ['modified', 'added', 'deleted', 'renamed', 'conflicted'] as const) {
    const changes = editor.explorerChanges(root, { root: '/project/branch', ahead: 0, behind: 0, files: [
      { path: 'src/vendor/library', status, staged: false },
      { path: 'src/vendor/library/changed.ts', status: 'deleted', staged: false },
    ] })
    const rows = editor.explorerRows(root, listings, [vendor, library, nested], filter, changes)
    expect(rows.find(row => row.name === 'library'), status).toMatchObject({ kind: 'directory', letter: null })
    expect(rows.find(row => row.name === 'unchanged.ts'), status).toMatchObject({ kind: 'file', letter: null })
    expect(rows.find(row => row.name === 'also-unchanged.ts'), status).toMatchObject({ kind: 'file', letter: null })
    expect(rows.find(row => row.name === 'changed.ts'), status).toMatchObject({ kind: 'file', letter: 'D' })
  }
})

it('inherits A through untracked folders while named statuses retain authority', () => {
  const folder = `${root}/newdir`, nested = `${folder}/nested`
  const listings = new Map<string, readonly editor.ExplorerEntry[]>([
    [folder, [
      { name: 'nested', path: nested, kind: 'directory' },
      { name: 'named.ts', path: `${folder}/named.ts`, kind: 'file' },
    ]],
    [nested, [{ name: 'new.ts', path: `${nested}/new.ts`, kind: 'file' }]],
  ])
  const changes = editor.explorerChanges(root, { root: '/project/branch', ahead: 0, behind: 0, files: [
    { path: 'src/newdir/', status: 'untracked', staged: false },
    { path: 'src/newdir/named.ts', status: 'modified', staged: false },
  ] })
  const rows = editor.explorerRows(root, listings, [folder, nested], 'changed', changes)
  expect(rows.find(row => row.name === 'new.ts')?.letter).toBe('A')
  expect(rows.find(row => row.name === 'named.ts')?.letter).toBe('M')
})
