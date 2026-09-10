import { describe, expect, test } from 'vitest'

import {
  asAdditions,
  asRemovals,
  countChanges,
  countDrawn,
  countFileChange,
  drawnWhole,
  linesIn,
  parseDiff,
  splitByFile,
  splitHunks,
} from './diff'

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
      // No final newline, and the last line an added blank: drawn, so counted.
      ['@@ -1 +1,2 @@', ' a', '+'].join('\n'),
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

describe('splitByFile, the shapes review asked for', () => {
  const file = (header: string): string => [header, '@@ -1 +1 @@', '-a', '+b'].join('\n')
  const path = (header: string): string | undefined => splitByFile(file(header))[0]?.path

  test('a rename from a quoted name to a plain one', () => {
    // The inverse of the tab-name rename: only the old side needs quoting.
    expect(path(String.raw`diff --git "a/tab\tname.txt" b/plain.txt`)).toBe('plain.txt')
  })

  test('a character outside the BMP, raw inside quotes and as octal bytes', () => {
    // core.quotePath=false: raw, quoted only because the tab forces it.
    expect(path(String.raw`diff --git "a/🎉\tx.txt" "b/🎉\tx.txt"`)).toBe('🎉\tx.txt')
    // core.quotePath=true: U+1F389 is four UTF-8 bytes, F0 9F 8E 89.
    expect(path(String.raw`diff --git "a/\360\237\216\211.txt" "b/\360\237\216\211.txt"`)).toBe('🎉.txt')
  })

  test('a header with CRLF endings reads the same as one without', () => {
    expect(path('diff --git a/src/a.ts b/src/a.ts\r')).toBe('src/a.ts')
    expect(path('diff --git a/x b/y.txt b/x b/y.txt\r')).toBe('x b/y.txt')
    expect(path(String.raw`diff --git a/plain.txt "b/tab\tname.txt"` + '\r')).toBe('tab\tname.txt')
  })

  test('an escape git does not write keeps its backslash', () => {
    expect(path(String.raw`diff --git "a/odd\qname" "b/odd\qname"`)).toBe('odd\\qname')
  })

  test('a quote that never closes is still a boundary, with no path', () => {
    const files = splitByFile([file('diff --git a/first.txt b/first.txt'), file('diff --git "a/never-closes b/x')].join('\n'))
    expect(files.map((entry) => entry.path)).toEqual(['first.txt', ''])
    expect(files[0]?.diff).not.toContain('never-closes')
  })
})

describe('a hunkless file in the middle of a multi-file diff', () => {
  test('the file after it still has its header read as a header', () => {
    const lines = parseDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        'diff --git a/img.png b/img.png',
        'index 1..2 100644',
        'Binary files a/img.png and b/img.png differ',
        'diff --git a/c.ts b/c.ts',
        '--- a/c.ts',
        '+++ b/c.ts',
        '@@ -5 +5 @@',
        '---x',
      ].join('\n'),
    )
    const at = lines.findIndex((line) => line.text === 'diff --git a/c.ts b/c.ts')
    expect(lines.slice(at, at + 3).map((line) => line.kind)).toEqual(['meta', 'meta', 'meta'])
    expect(lines.find((line) => line.text === '--x')).toMatchObject({ kind: 'remove', oldNumber: 5 })
  })
})

describe('countDrawn counts what the file view draws', () => {
  test('an added file that arrives as its content has no removals, whatever its lines start with', () => {
    // YAML front matter and a markdown list — a `---` and a `- item` — in a file just created.
    const content = ['---', 'title: x', '---', '', '- item', '- another', ''].join('\n')
    expect(countDrawn(content, true)).toEqual({ added: 6, removed: 0 })
  })

  test('the addition count is the lines drawn, not the artefact after a final newline', () => {
    expect(countDrawn('one\ntwo\n', true)).toEqual({ added: 2, removed: 0 })
    expect(countDrawn('one\ntwo', true)).toEqual({ added: 2, removed: 0 })
  })

  test('an added file that arrives as a real diff is counted as a diff', () => {
    // DiffView draws whole content only when there are no hunks; the count follows it.
    expect(countDrawn(['@@ -0,0 +1,2 @@', '+one', '+two'].join('\n'), true)).toEqual({ added: 2, removed: 0 })
  })

  test('a modified file is counted by the diff rule', () => {
    expect(countDrawn(['@@ -1 +1 @@', '---count;', '+++count;'].join('\n'), false)).toEqual({ added: 1, removed: 1 })
  })
})

describe('the last line of a diff that does not end in a newline', () => {
  test('an added blank line there is drawn, as the count beside it says', () => {
    const diff = ['@@ -1 +1,2 @@', ' a', '+'].join('\n')
    expect(parseDiff(diff).map((line) => [line.kind, line.text])).toEqual([
      ['hunk', '@@ -1 +1,2 @@'],
      ['context', 'a'],
      ['add', ''],
    ])
    expect(countChanges(diff)).toEqual({ added: 1, removed: 0 })
  })

  test('so is a removed blank, and a blank line of context', () => {
    expect(parseDiff(['@@ -1,2 +1 @@', ' a', '-'].join('\n')).at(-1)).toMatchObject({ kind: 'remove', text: '' })
    expect(parseDiff(['@@ -1,2 +1,2 @@', '-a', '+b', ' '].join('\n')).at(-1)).toMatchObject({ kind: 'context', text: '' })
  })

  test('the empty string after a final newline is still not a line', () => {
    expect(parseDiff(['@@ -1 +1 @@', '-a', '+b', ''].join('\n'))).toHaveLength(3)
  })
})

describe('a rename git had to spell out underneath', () => {
  // Every shape here is what git wrote, measured, not what it might write.
  const paths = (lines: readonly string[]): string[] => splitByFile(lines.join('\n')).map((file) => file.path)

  test('two names that both contain " b/" are keyed by the name git wrote beneath', () => {
    expect(
      paths([
        'diff --git a/Plan b/x.md b/Plan b/y.md',
        'similarity index 79%',
        'rename from Plan b/x.md',
        'rename to Plan b/y.md',
        'index b2f931a..17eb8c9 100644',
        '--- a/Plan b/x.md\t',
        '+++ b/Plan b/y.md\t',
        '@@ -2,4 +2,4 @@ one',
        '-five',
        '+FIVE',
      ]),
    ).toEqual(['Plan b/y.md'])
  })

  test('a pure rename has no +++ line, and rename to still names it', () => {
    expect(
      paths([
        'diff --git a/Plan b/keep.md b/Plan b/kept.md',
        'similarity index 100%',
        'rename from Plan b/keep.md',
        'rename to Plan b/kept.md',
      ]),
    ).toEqual(['Plan b/kept.md'])
  })

  test('a quoted rename to is decoded like a quoted header', () => {
    expect(
      paths([
        'diff --git a/plain.txt "b/tab\\tname.txt"',
        'similarity index 100%',
        'rename from plain.txt',
        'rename to "tab\\tname.txt"',
      ]),
    ).toEqual(['tab\tname.txt'])
  })

  test('a name with a space ends where git put its tab', () => {
    expect(
      paths([
        'diff --git a/my file.txt b/my file.txt',
        'index 7898192..6178079 100644',
        '--- a/my file.txt\t',
        '+++ b/my file.txt\t',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ]),
    ).toEqual(['my file.txt'])
  })

  test('from the first hunk on, a +++ line is content and names nothing', () => {
    expect(paths(['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '-a', '+++ b/elsewhere'])).toEqual(['x'])
  })

  test('a deletion keeps the name its header gives, not /dev/null', () => {
    expect(
      paths(['diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye']),
    ).toEqual(['gone.txt'])
  })
})

describe('an added file whose text merely contains @@', () => {
  test('is drawn and counted as its content: all additions, no removals', () => {
    const content = 'title: @@mention\n- item one\ncontact: a@@b.example\n@@var@@\n'
    expect(drawnWhole(content, true)).toBe(true)
    expect(countDrawn(content, true)).toEqual({ added: 4, removed: 0 })
  })

  test('one that carries a real hunk header is still read as a diff', () => {
    const diff = '--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n'
    expect(drawnWhole(diff, true)).toBe(false)
    expect(countDrawn(diff, true)).toEqual({ added: 2, removed: 0 })
  })

  test('the line count is the lines asAdditions draws', () => {
    for (const content of ['', 'a', 'a\n', 'a\n\n', '\n', 'one\n\nthree']) {
      expect(linesIn(content), JSON.stringify(content)).toBe(asAdditions(content).length)
    }
  })
})

describe("git's extended header, every line of it", () => {
  // Measured: what `git diff -C --find-copies-harder` wrote for a copy, an
  // edit, a binary file and a mode change, in that order.
  const diff = [
    'diff --git a/a.txt b/b.txt',
    'similarity index 100%',
    'copy from a.txt',
    'copy to b.txt',
    'diff --git a/k.txt b/k.txt',
    'index 2fa992c..3827cf0 100644',
    '--- a/k.txt',
    '+++ b/k.txt',
    '@@ -1 +1 @@',
    '-keep',
    '+KEEP',
    'diff --git a/pic.bin b/pic.bin',
    'new file mode 100644',
    'index 0000000..8352675',
    'Binary files /dev/null and b/pic.bin differ',
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
  ].join('\n')

  test('is metadata, with no gutter numbers, whatever it says', () => {
    const drawn = parseDiff(diff).filter((line) => line.kind !== 'meta' && line.kind !== 'hunk')
    expect(drawn.map((line) => [line.kind, line.text])).toEqual([
      ['remove', 'keep'],
      ['add', 'KEEP'],
    ])
  })

  test('and adds nothing to the count', () => {
    expect(countChanges(diff)).toEqual({ added: 1, removed: 1 })
  })

  test('a copy is keyed by the name git wrote beneath, as a rename is', () => {
    const copy = ['diff --git a/Plan b/x.md b/Plan b/copy.md', 'similarity index 100%', 'copy from Plan b/x.md', 'copy to Plan b/copy.md']
    expect(splitByFile(copy.join('\n')).map((file) => file.path)).toEqual(['Plan b/copy.md'])
  })
})

describe('one file change, counted the way it is drawn', () => {
  test('an added file is its lines added, and a deleted one its lines removed', () => {
    expect(countFileChange({ kind: { type: 'add' }, diff: 'a\n\nb\n' })).toEqual({ added: 3, removed: 0 })
    expect(countFileChange({ kind: { type: 'delete' }, diff: 'a\n\nb\n' })).toEqual({ added: 0, removed: 3 })
  })

  test('a whole-file change that arrives as a real diff is counted as one', () => {
    expect(countFileChange({ kind: { type: 'delete' }, diff: '@@ -1,2 +0,0 @@\n-a\n-b\n' })).toEqual({ added: 0, removed: 2 })
    expect(countFileChange({ kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+a\n' })).toEqual({ added: 1, removed: 0 })
  })

  test('a modified file is its diff', () => {
    expect(countFileChange({ kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' })).toEqual({ added: 1, removed: 1 })
  })

  test('a deleted file is drawn as its removals, numbered on the old side', () => {
    expect(asRemovals('a\nb\n').map((line) => [line.kind, line.text, line.oldNumber, line.newNumber])).toEqual([
      ['remove', 'a', 1, null],
      ['remove', 'b', 2, null],
    ])
  })
})

describe('a hunk header, and text that only starts like one', () => {
  test('git closes a hunk header with @@ and then the end of the line or a space', () => {
    expect(drawnWhole('@@ -1 +1 @@not-a-hunk\n- item\n', true)).toBe(true)
    expect(countDrawn('@@ -1 +1 @@not-a-hunk\n- item\n', true)).toEqual({ added: 2, removed: 0 })
    expect(drawnWhole('--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+a\n', true)).toBe(false)
  })

  test('a hunk header with its section heading, or with a CRLF, is still one', () => {
    expect(parseDiff('@@ -1 +1 @@ function retry()\n-a\n+b\n')[0]?.kind).toBe('hunk')
    expect(parseDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n').map((line) => line.kind)).toEqual(['hunk', 'remove', 'add'])
  })
})

describe('whole-file changes at their edges', () => {
  test('a deleted file that arrives with nothing, as Codex sends one, counts nothing', () => {
    expect(countFileChange({ kind: { type: 'delete' }, diff: '' })).toEqual({ added: 0, removed: 0 })
  })

  test('countDrawn asked about a removed file counts removals, not additions', () => {
    expect(countDrawn('a\nb\n', 'removed')).toEqual({ added: 0, removed: 2 })
  })

  test('a file with only a mode change, or a binary, is keyed by its header', () => {
    expect(splitByFile(['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'].join('\n')).map((file) => file.path)).toEqual([
      'run.sh',
    ])
    expect(
      splitByFile(
        ['diff --git a/pic.bin b/pic.bin', 'new file mode 100644', 'index 0000000..8352675', 'Binary files /dev/null and b/pic.bin differ'].join('\n'),
      ).map((file) => file.path),
    ).toEqual(['pic.bin'])
  })
})

describe("a merge's combined diff, which is what git writes for a conflicted file", () => {
  // Review, round five: `@@@` was no hunk header, so everything after `diff --cc` was drawn as header.
  // Both are `git diff` of a conflicted f.txt, byte for byte.
  const header = ['diff --cc f.txt', 'index e788115,42b8e7a..0000000', '--- a/f.txt', '+++ b/f.txt']
  const conflicted = [
    ...header,
    '@@@ -1,3 -1,3 +1,7 @@@',
    '  one',
    '++<<<<<<< HEAD',
    ' +ours',
    '++=======',
    '+ theirs',
    '++>>>>>>> theirs',
    '  three',
    '',
  ].join('\n')
  // Resolved into a line neither side had: a line gone from each parent.
  const resolvedApart = [...header, '@@@ -1,3 -1,3 +1,3 @@@', '  one', '- ours', ' -theirs', '++merged', '  three', ''].join('\n')
  const drawn = (diff: string) =>
    parseDiff(diff)
      .filter((line) => line.kind !== 'meta')
      .map((line) => [line.kind, line.text, line.oldNumber, line.newNumber])

  test('draws the conflict as the additions it is, numbered by the first parent and the result', () => {
    expect(drawn(conflicted)).toEqual([
      ['hunk', '@@@ -1,3 -1,3 +1,7 @@@', null, null],
      ['context', 'one', 1, 1],
      ['add', '<<<<<<< HEAD', null, 2],
      ['add', 'ours', null, 3],
      ['add', '=======', null, 4],
      ['add', 'theirs', null, 5],
      ['add', '>>>>>>> theirs', null, 6],
      ['context', 'three', 3, 7],
    ])
    expect(countChanges(conflicted)).toEqual({ added: 5, removed: 0 })
  })

  test('a line gone from the result is a removal, numbered only where the first parent had it', () => {
    expect(drawn(resolvedApart)).toEqual([
      ['hunk', '@@@ -1,3 -1,3 +1,3 @@@', null, null],
      ['context', 'one', 1, 1],
      ['remove', 'ours', 2, null],
      ['remove', 'theirs', null, null],
      ['add', 'merged', null, 2],
      ['context', 'three', 3, 3],
    ])
    expect(countChanges(resolvedApart)).toEqual({ added: 1, removed: 2 })
  })

  test('a conflicted file in a diff of the whole tree is a file of its own', () => {
    const tree = ['diff --git a/a.txt b/a.txt', 'index 1111111..2222222 100644', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+b', conflicted].join('\n')
    const files = splitByFile(tree)
    expect(files.map((file) => file.path)).toEqual(['a.txt', 'f.txt'])
    expect(countChanges(files[0]!.diff)).toEqual({ added: 1, removed: 1 })
    expect(countChanges(files[1]!.diff)).toEqual({ added: 5, removed: 0 })
  })
})

describe('what comes before the first file', () => {
  // Review, round five: blank lines, or a commit's own header, came back as a file with no name.
  const one = ['diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n')

  test('is no file', () => {
    expect(splitByFile(`\n\n${one}`).map((file) => file.path)).toEqual(['x.txt'])
    expect(splitByFile(`commit 0123abc\n\n    Change x\n\n${one}`).map((file) => file.path)).toEqual(['x.txt'])
  })

  test('and a diff with no file header at all is still one', () => {
    expect(splitByFile('@@ -1 +1 @@\n-a\n+b')).toEqual([{ path: '', diff: '@@ -1 +1 @@\n-a\n+b' }])
  })
})

describe('an added or deleted file of blank lines only', () => {
  // Review, round five: blank lines mixed with text were pinned, blank lines alone were not.
  test('is drawn and counted line for line', () => {
    expect(countDrawn('\n\n', 'added')).toEqual({ added: 2, removed: 0 })
    expect(countDrawn('\n\n', 'removed')).toEqual({ added: 0, removed: 2 })
    expect(asAdditions('\n\n').map((line) => [line.kind, line.text, line.newNumber])).toEqual([
      ['add', '', 1],
      ['add', '', 2],
    ])
  })
})

