import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** This file runs from `dist/test`, so find the checkout rather than count `..`. */
const checkout = (): string => {
  let root = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const up = dirname(root)
    assert.notEqual(up, root, 'ran outside the checkout')
    root = up
  }
  return root
}

test('the PATH walk is one text in the three packages that need it (#129)', () => {
  const read = (path: string) => readFileSync(join(checkout(), path), 'utf8')
  const server = read('packages/server/src/installs/which.ts')
  assert.equal(read('packages/adapter-acp/src/which.ts'), server, 'adapter-acp has drifted from the server copy')
  assert.equal(read('packages/codex/src/which.ts'), server, 'codex has drifted from the server copy')
})

type Strip = (source: string, fileName: string, options: { readonly strict: boolean }) => string

/**
 * The layering gate's comment stripper, borrowed.
 *
 * What stood here was a line-start pattern, which is the technique the other
 * half of this pull request exists to replace — and it had the same hole, in
 * the same commit: a line that *begins* with comment punctuation was dropped
 * whole, so a real call written after a `*​/` was never looked at (review of
 * #228, round 2, from Codex and Claude Code both). `withoutComments` is
 * TypeScript's parser underneath, so what it removes is exactly what the
 * compiler would drop, and a string is never mistaken for prose.
 *
 * Reached by path because `script/` is plain Node with no build step and this
 * package may not import it. `typescript` resolves from the checkout's own
 * `node_modules`, which `pnpm verify` and CI both install before anything runs.
 */
const stripper = async (): Promise<Strip> => {
  const gate: { withoutComments: Strip } = await import(
    pathToFileURL(join(checkout(), 'script', 'check-layering.mjs')).href
  )
  return gate.withoutComments
}

/**
 * The path this forbids, spelled in pieces.
 *
 * The walk below now reads this file too, and written out whole here it would
 * be its own first offender. The quotes are the rule: an absolute path handed
 * to a spawn, not a path named in prose.
 */
const ASKED = ['', 'usr', 'bin', 'which'].join('/')
const QUOTED = new RegExp(`['"\`]${ASKED}['"\`]`)

/** Whether `source` asks for it once everything the compiler would drop is gone. */
const asksForIt = (strip: Strip, source: string, fileName: string): boolean =>
  QUOTED.test(strip(source, fileName, { strict: true }))

/**
 * Build output and the trees `.gitignore` keeps out of the repository.
 *
 * A `release/` left behind by `pnpm dist` holds a packaged app's vendored
 * JavaScript, and `internal/` holds working notes: neither is this checkout's
 * source, and reading either would make the answer depend on whose machine
 * ran it. Dot-directories go the same way, agent state included.
 */
const NOT_SOURCE = new Set(['node_modules', 'dist', 'dist-site-demo', 'release', 'vendor', 'coverage', 'internal', 'out'])

const CODE = /\.(?:ts|mts|cts|tsx|mjs|cjs|js)$/

test('nothing this checkout runs asks /usr/bin/which (#129)', async () => {
  /* Absent on Windows and on minimal images, and at `/bin/which` on some Linux:
     there, every agent read as not installed. The walk starts at the checkout
     root rather than at a list of directories inside each package, because the
     list was wrong — it read `src` and `electron` and so never opened
     `packages/desktop/script/`, which is where this would next be written: it
     is the code that runs `security`, `xcrun` and `codesign` around a release.
     Also unread were every package's `test/`, `packages/ui/site-demo/`, the
     Vite configs and `examples/` (review of #228, round 2). A directory added
     next year is read the day it appears, which a list cannot manage. */
  const strip = await stripper()
  const root = checkout()
  const offenders: string[] = []
  const scanned: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || NOT_SOURCE.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (CODE.test(entry.name)) {
        scanned.push(relative(root, path))
        if (asksForIt(strip, readFileSync(path, 'utf8'), path)) offenders.push(relative(root, path))
      }
    }
  }
  walk(root)

  // The directories the old walk missed, named one by one so that narrowing it again fails here.
  for (const parts of [
    ['packages', 'desktop', 'script', 'staple-dmgs.mjs'],
    ['packages', 'desktop', 'electron', 'main.mjs'],
    ['packages', 'server', 'src', 'installs', 'which.ts'],
    ['packages', 'server', 'test', 'which.test.ts'],
    ['packages', 'ui', 'site-demo', 'fake-host.ts'],
    ['packages', 'ui', 'vite.config.ts'],
    ['examples', 'browser-plugin', 'index.js'],
    ['script', 'check-layering.mjs'],
  ]) {
    assert.ok(scanned.includes(join(...parts)), `${join(...parts)} was not read`)
  }
  // A walk that read nothing would pass on nothing.
  assert.ok(scanned.length > 1000, `only ${scanned.length} files were read`)
  assert.deepEqual(offenders, [])
})

test('a call on a line that begins with a comment is still a call (review of #228, round 2)', async () => {
  const strip = await stripper()
  /* The two shapes the line-start pattern dropped whole, both of which are
     ordinary code: a call after a closed block comment, and a call after the
     `*​/` that ends a wrapped one. Round 2 ran both through the old regexes and
     got `scanned=false` for each. */
  assert.equal(asksForIt(strip, `/* why */ execFile('${ASKED}', [command])\n`, 'a.ts'), true)
  const afterClose = ['/* why this asks a binary at all', ` */ execFile('${ASKED}', [command])`].join('\n')
  assert.equal(asksForIt(strip, afterClose, 'a.ts'), true)

  /* The controls, which must stay false both before this change and after, or
     the gate would only be trading one bug for another. Each of these quotes
     the path in a shape `QUOTED` matches before the comments come off, so they
     fail the moment the stripping stops happening. */
  assert.equal(asksForIt(strip, `// \`${ASKED}\` is absent on Windows\n`, 'a.ts'), false)
  assert.equal(asksForIt(strip, `/*\n * Both copies ran \`${ASKED}\`, an absolute POSIX path.\n */\nconst a = 1\n`, 'a.ts'), false)
  /* And prose on a continuation line that starts with a word, which is how the
     three copies of `which.ts` wrap their own blocks: the old pattern read that
     line as code and flagged it, so the next person to explain this bug in the
     house style would have failed the build on a comment. */
  const wrapped = ['/* A command with a path in it is not a PATH question, and', `   asking \`${ASKED}\` would not answer it. */`, 'const a = 1'].join('\n')
  assert.equal(asksForIt(strip, wrapped, 'a.ts'), false)
})
