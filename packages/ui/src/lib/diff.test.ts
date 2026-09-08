import { describe, expect, test } from 'vitest'

import { asAdditions, countChanges, parseDiff, splitByFile, splitHunks } from './diff'

describe('parseDiff', () => {
  test('numbers both gutters from the hunk header', () => {
    const lines = parseDiff(
      ['@@ -10,3 +20,4 @@', ' context', '-removed', '+added', '+also added'].join('\n'),
    )
    expect(lines.map((line) => line.kind)).toEqual(['hunk', 'context', 'remove', 'add', 'add'])
    expect(lines[1]).toMatchObject({ oldNumber: 10, newNumber: 20 })
    expect(lines[2]).toMatchObject({ oldNumber: 11, newNumber: null })
    expect(lines[3]).toMatchObject({ oldNumber: null, newNumber: 21 })
    expect(lines[4]).toMatchObject({ oldNumber: null, newNumber: 22 })
  })

  test('single-line hunk headers without counts parse', () => {
    const lines = parseDiff(['@@ -5 +7 @@', ' ctx'].join('\n'))
    expect(lines[1]).toMatchObject({ oldNumber: 5, newNumber: 7 })
  })

  test('file headers before the first hunk are metadata', () => {
    const lines = parseDiff(
      ['diff --git a/x b/x', 'index abc..def 100644', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
    )
    expect(lines.slice(0, 4).every((line) => line.kind === 'meta')).toBe(true)
  })

  test('+++ and --- after a hunk are content, not headers', () => {
    // A diff of a diff, or of a file that starts lines with dashes.
    const lines = parseDiff(['@@ -1,2 +1,2 @@', '--- old text', '+++ new text'].join('\n'))
    expect(lines[1]?.kind).toBe('remove')
    expect(lines[1]?.text).toBe('-- old text')
    expect(lines[2]?.kind).toBe('add')
  })

  test('the no-newline marker is metadata', () => {
    const lines = parseDiff(['@@ -1 +1 @@', '-a', '\\ No newline at end of file'].join('\n'))
    expect(lines[2]?.kind).toBe('meta')
  })

  test('the artefact line from a trailing newline is dropped', () => {
    const lines = parseDiff('@@ -1 +1 @@\n context\n')
    expect(lines).toHaveLength(2)
  })

  test('an empty diff produces nothing', () => {
    expect(parseDiff('')).toEqual([])
  })
})

describe('asAdditions', () => {
  test('numbers whole-file content from one', () => {
    const lines = asAdditions('first\nsecond\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ kind: 'add', text: 'first', newNumber: 1 })
    expect(lines[1]).toMatchObject({ newNumber: 2 })
  })
})

describe('countChanges', () => {
  test('counts additions and removals, ignoring file headers', () => {
    const diff = ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '-old', '+new', ' same'].join('\n')
    expect(countChanges(diff)).toEqual({ added: 1, removed: 1 })
  })

  test('an unchanged file counts as nothing', () => {
    expect(countChanges(' unchanged\n context')).toEqual({ added: 0, removed: 0 })
  })
})

describe('splitByFile', () => {
  const two = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1,2 @@',
    ' hi',
    '+there',
  ].join('\n')

  test('one entry per diff --git header, keyed by the new path', () => {
    const files = splitByFile(two)
    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'README.md'])
    expect(files[1]?.diff).toContain('+there')
    expect(files[0]?.diff).not.toContain('README')
  })

  test('a headerless diff is a single unnamed entry, and an empty one is nothing', () => {
    expect(splitByFile('@@ -1 +1 @@\n-a\n+b')).toEqual([{ path: '', diff: '@@ -1 +1 @@\n-a\n+b' }])
    expect(splitByFile('')).toEqual([])
  })
})

describe('splitHunks', () => {
  const file = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' keep',
    '@@ -10,1 +10,2 @@',
    ' context',
    '+added',
    '',
  ].join('\n')

  test('one entry per @@ line, headers dropped, each fragment self-contained', () => {
    const hunks = splitHunks(file)
    expect(hunks.map((hunk) => hunk.header)).toEqual(['@@ -1,2 +1,2 @@', '@@ -10,1 +10,2 @@'])
    expect(hunks[0]?.text).toBe('@@ -1,2 +1,2 @@\n-old\n+new\n keep')
    expect(hunks[1]?.text).toBe('@@ -10,1 +10,2 @@\n context\n+added')
    expect(hunks[0]?.text).not.toContain('diff --git')
  })

  test('a diff with no hunks — an untracked file, an empty string — is no hunks', () => {
    expect(splitHunks('diff --git a/x b/x\nnew file mode 100644')).toEqual([])
    expect(splitHunks('')).toEqual([])
  })
})
