import { expect, it, vi } from 'vitest'
import { runtimeId, type GitFileStatus } from '@harnessdesk/protocol'
import * as editor from './index'

const patch = (before: string, after: string) => `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n`
const reader = (disk: string | null, unstaged = '', staged = '', files: readonly GitFileStatus[] = []) => {
  const request = vi.fn(async (method: string, params: { staged?: boolean }) => {
    if (method === 'git/status') return { root: '/project', ahead: 0, behind: 0, files }
    if (method === 'git/diff') return { diff: params.staged ? staged : unstaged }
    if (method === 'workspace/readFile') return disk === null ? { kind: 'missing' } : { kind: 'text', content: disk, truncated: false, hash: 'hash' }
    throw new Error(`Unexpected request: ${method}`)
  })
  return request
}
const file = (status: GitFileStatus['status'], staged = false): GitFileStatus => ({ path: 'file.txt', status, staged })

it('reads HEAD by reversing disk to index before reversing index to HEAD', async () => {
  const request = reader('disk\n', patch('index', 'disk'), patch('head', 'index'), [file('modified'), file('modified', true)])
  expect(await editor.readHead(request as editor.HeadRequest, { root: '/project', path: '/project/file.txt' })).toEqual({ content: 'head\n', status: 'tracked' })
  expect(request.mock.calls).toContainEqual(['git/diff', { root: '/project', path: 'file.txt', staged: true }])
  expect(request.mock.calls).toContainEqual(['git/diff', { root: '/project', path: 'file.txt' }])
})

it('keeps an unchanged tracked file distinct from an untracked file', async () => {
  expect(await editor.readHead(reader('same\n') as editor.HeadRequest, { root: '/project', path: 'file.txt' })).toEqual({ content: 'same\n', status: 'tracked' })
  expect(await editor.readHead(reader('new\n', '', '', [file('untracked')]) as editor.HeadRequest, { root: '/project', path: 'file.txt' })).toEqual({ content: null, status: 'untracked' })
})

it('reconstructs additions and deletions without inventing an empty HEAD file', async () => {
  const add = 'diff --git a/file.txt b/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1 @@\n+new\n'
  const remove = 'diff --git a/file.txt b/file.txt\ndeleted file mode 100644\n--- a/file.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'
  expect(await editor.readHead(reader('new\n', '', add, [file('added', true)]) as editor.HeadRequest, { root: '/project', path: 'file.txt' })).toEqual({ content: null, status: 'added' })
  expect(await editor.readHead(reader(null, remove, '', [file('deleted')]) as editor.HeadRequest, { root: '/project', path: 'file.txt' })).toEqual({ content: 'old\n', status: 'tracked' })
  expect(await editor.readHead(reader(null, '', remove, [file('deleted', true)]) as editor.HeadRequest, { root: '/project', path: 'file.txt' })).toEqual({ content: 'old\n', status: 'tracked' })
})

it('reads HEAD for a staged deletion recreated as an untracked disk file', async () => {
  const remove = 'diff --git a/file.txt b/file.txt\ndeleted file mode 100644\n--- a/file.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'
  expect(await editor.readHead(reader('recreated\n', '', remove, [file('deleted', true), file('untracked')]) as editor.HeadRequest, { root: '/project', path: 'file.txt' })).toEqual({ content: 'old\n', status: 'tracked' })
})

it('uses the conversation runtime and accepts the exact disk snapshot already loaded', async () => {
  const request = reader('disk\n', patch('head', 'disk'), '', [file('modified')])
  await editor.readHead(request as editor.HeadRequest, { root: '/project', path: 'file.txt', runtime: runtimeId('agent') })
  expect(request.mock.calls).toContainEqual(['workspace/readFile', { path: '/project/file.txt', runtime: 'agent' }])
  request.mockClear()
  expect(await editor.readHead(request as editor.HeadRequest, { root: '/project', path: 'file.txt', disk: { kind: 'text', content: 'disk\n', truncated: false, hash: 'snapshot' } })).toEqual({ content: 'head\n', status: 'tracked' })
  expect(request.mock.calls.some(([method]) => method === 'workspace/readFile')).toBe(false)
})

it('preserves Git-quoted Unicode paths, spaces, and CRLF content', async () => {
  const path = 'café notes.txt'
  const quoted = 'caf\\303\\251 notes.txt'
  const diff = `diff --git "a/${quoted}" "b/${quoted}"\n--- "a/${quoted}"\n+++ "b/${quoted}"\n@@ -1 +1 @@\n-before café\r\n+after café\r\n`
  const request = vi.fn(async (method: string, params: { staged?: boolean }) => {
    if (method === 'git/status') return { root: '/project', ahead: 0, behind: 0, files: [{ path, status: 'modified', staged: false }] }
    if (method === 'workspace/readFile') return { kind: 'text', content: 'after café\r\n', truncated: false, hash: 'hash' }
    return { diff: params.staged ? '' : diff }
  })
  expect(await editor.readHead(request as editor.HeadRequest, { root: '/project', path })).toEqual({ content: 'before café\r\n', status: 'tracked' })
})

it('refuses absolute paths whose lexical root differs from the canonical Git root', async () => {
  const request = vi.fn(async () => ({ root: '/private/tmp/project', ahead: 0, behind: 0, files: [] }))
  await expect(editor.readHead(request as editor.HeadRequest, { root: '/tmp/project', path: '/tmp/project/file.txt' })).rejects.toThrow(/outside/i)
  expect(request).toHaveBeenCalledTimes(1)
})

it('preserves missing final newlines and verifies patch context', () => {
  const noNewline = patch('before', 'after').replace('-before\n', '-before\n\\ No newline at end of file\n').replace('+after\n', '+after\n\\ No newline at end of file\n')
  expect(editor.reverseTextPatch('after', noNewline)).toBe('before')
  expect(() => editor.reverseTextPatch('other', noNewline)).toThrow(/match/i)
  expect(() => editor.reverseTextPatch('after\n', noNewline)).toThrow(/match/i)
})

it('reverses multiple hunks using the new-side positions', () => {
  const diff = '@@ -1 +1,2 @@\n-a\n+A\n+extra\n@@ -4 +5 @@\n-d\n+D\n'
  expect(editor.reverseTextPatch('A\nextra\nb\nc\nD\n', diff)).toBe('a\nb\nc\nd\n')
  expect(() => editor.reverseTextPatch('after\n', '@@ -99 +1 @@\n-before\n+after\n')).toThrow(/match/i)
})

it('distinguishes empty tracked additions and deletions from a missing file', async () => {
  const added = 'diff --git a/file.txt b/file.txt\nnew file mode 100644\nindex 0000000..e69de29\n'
  const deleted = 'diff --git a/file.txt b/file.txt\ndeleted file mode 100644\nindex e69de29..0000000\n'
  expect(await editor.readHead(reader('', '', added, [file('added', true)]) as editor.HeadRequest, { root: '/project', path: 'file.txt' })).toEqual({ content: null, status: 'added' })
  expect(await editor.readHead(reader(null, deleted, '', [file('deleted')]) as editor.HeadRequest, { root: '/project', path: 'file.txt' })).toEqual({ content: '', status: 'tracked' })
})

it('refuses incomplete, unsupported, and inconsistent reads', async () => {
  expect(() => editor.reverseTextPatch('after\n', '@@ -1,2 +1 @@\n-before\n+after\n')).toThrow()
  expect(() => editor.reverseTextPatch('bytes', 'Binary files a/file.txt and b/file.txt differ\n')).toThrow()
  expect(() => editor.reverseTextPatch('conflict\n', 'diff --cc file.txt\n@@@ -1 -1 +1 @@@\n++conflict\n')).toThrow()
  const truncated = vi.fn(async (method: string) => method === 'workspace/readFile' ? { kind: 'text', content: 'part', truncated: true, hash: 'hash' } : { root: '/project', ahead: 0, behind: 0, files: [] })
  await expect(editor.readHead(truncated as editor.HeadRequest, { root: '/project', path: 'file.txt' })).rejects.toThrow(/complete/i)
  await expect(editor.readHead(reader('other\n', patch('before', 'after'), '', [file('modified')]) as editor.HeadRequest, { root: '/project', path: 'file.txt' })).rejects.toThrow(/match/i)
})

it('counts real changed lines, including empty files and final-newline changes', () => {
  expect(editor.countTextChanges('', 'one\ntwo\n')).toEqual({ added: 2, removed: 0 })
  expect(editor.countTextChanges('old\nkeep\n', 'new\nkeep\n')).toEqual({ added: 1, removed: 1 })
  expect(editor.countTextChanges('one', 'one\n')).toEqual({ added: 1, removed: 1 })
  expect(editor.countTextChanges('same\n', 'same\n')).toEqual({ added: 0, removed: 0 })
  const unchanged = 'keep\n'.repeat(2100)
  expect(editor.countTextChanges(`${unchanged}before\n`, `${unchanged}after\n`)).toEqual({ added: 1, removed: 1 })
})
