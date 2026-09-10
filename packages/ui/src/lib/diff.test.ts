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

/**
 * Three defects from the bug hunt — #82, #83, #84 — and all three are one
 * question asked badly: which line is a header. The `diff --git` lines below
 * are copied from what git printed for these files, under both
 * `core.quotePath` settings, rather than written from memory: a fixture
 * invented rather than measured passes while the real wire fails.
 */
describe('multi-file diffs, header by header (#82)', () => {
  const twoFiles = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/b.ts b/src/b.ts',
    'index 3..4 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -10,3 +10,3 @@',
    ' kept',
    '---count;',
    '+++count;',
  ].join('\n')

  test("every file's header is metadata, not only the first file's", () => {
    const lines = parseDiff(twoFiles)
    const at = lines.findIndex((line) => line.text === 'diff --git a/src/b.ts b/src/b.ts')
    expect(at).toBeGreaterThan(0)
    // These read as context, a removal and an addition before.
    expect(lines.slice(at, at + 4).map((line) => line.kind)).toEqual(['meta', 'meta', 'meta', 'meta'])
  })

  test("the second file's header lines carry no gutter numbers", () => {
    const lines = parseDiff(twoFiles)
    const at = lines.findIndex((line) => line.text === 'diff --git a/src/b.ts b/src/b.ts')
    for (const line of lines.slice(at, at + 4)) {
      expect(line).toMatchObject({ oldNumber: null, newNumber: null })
    }
    /* The control, and it passes either way: the hunk header resets the
       numbers, so the *content* was always numbered right. What was wrong is
       that the header lines above it were given numbers too. */
    expect(lines.find((line) => line.text === 'kept')).toMatchObject({ oldNumber: 10, newNumber: 10 })
  })

  test('inside each file the position still holds: after a hunk, --- and +++ are content', () => {
    const lines = parseDiff(twoFiles)
    expect(lines.find((line) => line.text === '--count;')?.kind).toBe('remove')
    expect(lines.find((line) => line.text === '++count;')?.kind).toBe('add')
  })
})

describe('countChanges agrees with what is drawn (#83)', () => {
  test('a removed --count; and an added ++count; are counted', () => {
    // Pre-decrement, a SQL comment, a Lua comment: all ordinary content.
    expect(countChanges(['@@ -1,2 +1,2 @@', '---count;', '+++count;'].join('\n'))).toEqual({
      added: 1,
      removed: 1,
    })
  })

  test('every file header in a multi-file diff is left out of the count', () => {
    const diff = [
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/b b/b',
      '--- a/b',
      '+++ b/b',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n')
    expect(countChanges(diff)).toEqual({ added: 2, removed: 2 })
  })

  test('the count is the additions and removals parseDiff draws, for any diff', () => {
    /* The invariant rather than one case. The `+N −M` beside a file and the
       diff under it are two readings of one text, and they disagreed: the old
       counter skipped `---`/`+++` anywhere, the view only before a hunk. */
    for (const diff of [
      ['@@ -1,2 +1,2 @@', '---count;', '+++count;'].join('\n'),
      ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '-old', '+new', ' same'].join('\n'),
      ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '---x', '+++y'].join('\n'),
      ' unchanged\n context',
    ]) {
      const drawn = parseDiff(diff)
      expect(countChanges(diff), diff).toEqual({
        added: drawn.filter((line) => line.kind === 'add').length,
        removed: drawn.filter((line) => line.kind === 'remove').length,
      })
    }
  })
})

describe('splitByFile reads every header git writes (#84)', () => {
  const file = (header: string, body: readonly string[] = ['@@ -1 +1 @@', '-a', '+b']): string =>
    [header, ...body].join('\n')

  test('a quoted non-ASCII name is decoded from its UTF-8 bytes', () => {
    // core.quotePath=true — git's default — writes café.txt as octal escapes of its bytes.
    const [only] = splitByFile(file(String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`))
    expect(only?.path).toBe('café.txt')
    // Each escape turned into a character on its own gives this: a name no file has.
    expect(only?.path).not.toBe('cafÃ©.txt')
  })

  test('the same name with core.quotePath off arrives raw and unquoted', () => {
    expect(splitByFile(file('diff --git a/café.txt b/café.txt'))[0]?.path).toBe('café.txt')
  })

  test('git quotes each side on its own, so a rename can quote only one', () => {
    // Measured: a rename from plain.txt to a name containing a tab.
    expect(splitByFile(file(String.raw`diff --git a/plain.txt "b/tab\tname.txt"`))[0]?.path).toBe('tab\tname.txt')
  })

  test('an escaped quote and an escaped backslash decode to themselves', () => {
    expect(splitByFile(file(String.raw`diff --git "a/quo\"te.txt" "b/quo\"te.txt"`))[0]?.path).toBe('quo"te.txt')
    expect(splitByFile(file(String.raw`diff --git "a/back\\slash.txt" "b/back\\slash.txt"`))[0]?.path).toBe(
      'back\\slash.txt',
    )
  })

  test('a name containing " b/" is one name, not a place to split', () => {
    // Unquoted: git quotes for quotes, backslashes and control characters, not for spaces.
    expect(splitByFile(file('diff --git a/x b/y.txt b/x b/y.txt'))[0]?.path).toBe('x b/y.txt')
  })

  test('a quoted header is a boundary, so its file does not join the one before', () => {
    const diff = [
      file('diff --git a/first.txt b/first.txt'),
      file(String.raw`diff --git "a/tab\tx.txt" "b/tab\tx.txt"`, ['@@ -1 +1 @@', '-quoted-old', '+quoted-new']),
    ].join('\n')
    const files = splitByFile(diff)
    expect(files.map((entry) => entry.path)).toEqual(['first.txt', 'tab\tx.txt'])
    // The symptom as a reader met it: the quoted file's lines filed under first.txt.
    expect(files[0]?.diff).not.toContain('quoted-new')
  })

  test('a rename between two plain names still keys the new one', () => {
    // The control: the ordinary rename the old pattern already handled.
    expect(splitByFile(file('diff --git a/old.txt b/new.txt'))[0]?.path).toBe('new.txt')
  })
})
