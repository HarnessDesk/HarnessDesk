#!/usr/bin/env node
/**
 * A repository path written in the documentation must resolve to a file.
 *
 * A document names a source file in backticks and then the file moves, or the
 * path was written from the wrong root to begin with. Nothing goes red:
 * `pnpm verify` never read the prose, so the two mis-rooted source paths #94
 * reported sat in `docs/extending.md` until a person noticed them, and #189
 * fixed them by hand (#223).
 *
 * This is the check that would have caught them. It pulls every backticked
 * string that looks like a repository path out of the documents a reader is
 * pointed at, resolves each one, and fails on any that resolves nowhere.
 *
 *   node script/check-doc-paths.mjs
 *
 * **It is a link checker, not a style rule.** It has no opinion on how a path
 * should be written — only that whatever was written can be found. That is
 * what keeps it cheap to satisfy: a path that moved is fixed by fixing the
 * path, never by editing this file.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The documents this reads: the two front doors and everything under `docs/`.
 *
 * `CONTRIBUTING.md` is deliberately not here. The sweep #223 measured covered
 * exactly these three, and a gate is only worth landing green — a document
 * nobody swept is a document that may or may not pass, which is a different
 * change from this one.
 */
export const isSweptDocument = (file) =>
  file === 'AGENTS.md' || file === 'README.md' || (file.startsWith('docs/') && file.endsWith('.md'))

/**
 * Does this backticked string claim to be a path in this repository?
 *
 * Every exclusion here is a shape that is *not* a file in this tree, and each
 * one was measured against the documents rather than imagined:
 *
 * - **whitespace** — a shell command, or a CSS value like `0 24px 60px / 0.3`.
 * - **a leading `~`, `/` or `$`** — a path on the reader's machine, such as
 *   `~/.codex/config.toml`. Where those resolve is the reader's business and
 *   this tree cannot say.
 * - **`<` or `>`** — a placeholder standing in for a name the reader supplies.
 * - **an asterisk** — a glob over files rather than one file.
 * - **`://` or `@`** — a URL, or an npm specifier like `@google/gemini-cli@0.58.0`.
 *   This also skips a path through a scoped module directory, which is the one
 *   real path shape it cannot see; those name files inside an installed
 *   package rather than in this tree, so nothing is lost yet.
 *
 * What is left must still end in an extension, because a bare
 * `packages/plugins` is a directory reference whose spelling this check has no
 * business policing.
 */
export const looksLikeRepoPath = (value) => {
  if (/\s/.test(value)) return false
  if (!value.includes('/')) return false
  if (!/\.[A-Za-z0-9]{1,6}$/.test(value)) return false
  if (/^[~/$]/.test(value)) return false
  if (value.includes('://') || value.includes('@')) return false
  if (/[<>*]/.test(value)) return false
  return true
}

/** Every backticked string in a document that looks like a repository path. */
export const pathsIn = (markdown) =>
  [...markdown.matchAll(/`([^`\n]+)`/g)].map(([, value]) => value).filter(looksLikeRepoPath)

/**
 * Paths that are written the way they are on purpose, and why.
 *
 * Each entry is a promise that the path names something outside this tree —
 * not a way to make this check quiet about a path that broke. Seeded from the
 * sweep in #223 and re-measured: these seven are every path in the swept
 * documents that resolves at none of the bases below.
 */
export const ALLOWED = new Map([
  ['.cursor-plugin/plugin.json', 'the plugin directory the Cursor bridge generates per chat, in a temp tree'],
  ['archify/assets/template.html', 'upstream Archify, quoted at a pinned commit — not vendored here'],
  ['docs/built.md', "a maintainer's working file under the gitignored internal/, as the sentence naming it says"],
  ['packages/acp/acp/src/index.ts', "DeepSeek Harness's own tree, as the sentence naming it says"],
  ['profile/harnessdesk.patch.yml', 'the dsh-acp repository, which the same sentence links to'],
  ['rmcp-client/src/oauth/store_lock.rs', "DeepSeek Harness's own Rust source"],
  ['src/server.js', "an invented file name in a demo board card — a path in the reader's project, not this one"],
])

/**
 * Where a documented path is allowed to resolve, in the order tried.
 *
 * Measured over the swept documents: 108 paths resolve at the root, 32 under a
 * package source directory, and 4 beside the document naming them. All three
 * bases earn their place, and none of them is a guess.
 *
 * - **the repository root** — how most paths are written, and the only base a
 *   naive check would have.
 * - **the directory of the document naming it** — how a Markdown link reads,
 *   so it is how a reader would resolve it too.
 * - **any package's `src`** — the package-relative convention #223 names, and
 *   the one the design and interface documents lean on hardest: `lib/limits.ts`
 *   and `design/ui/button.tsx` are written from inside the package they
 *   describe. Resolving them rather than excusing them is what keeps them
 *   honest — delete `lib/limits.ts` and this still goes red.
 */
export const basesFor = (repo) => {
  const packages = join(repo, 'packages')
  const sources = existsSync(packages)
    ? readdirSync(packages, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(packages, entry.name, 'src'))
        .filter((dir) => existsSync(dir))
        .sort()
    : []
  return (value, doc) => {
    if (existsSync(join(repo, value))) return true
    if (existsSync(join(repo, dirname(doc), value))) return true
    return sources.some((base) => existsSync(join(base, value)))
  }
}

/**
 * Every documented path that resolves nowhere, and every allowlist entry that
 * has stopped being true.
 *
 * The second half is the same idiom as `DESCRIBED_AS` in
 * `script/check-verify-steps.mjs`: an exception that outlives its reason is a
 * hole nobody decided to leave open, so an entry for a path that now resolves,
 * or that no document names any more, is reported rather than ignored.
 *
 * `named` maps each path to the documents naming it; `resolves(value, doc)`
 * says whether it can be found from that document. Both are passed in so this
 * can be tested without a repository on disk.
 */
export const problemsWith = (named, resolves, allowed = ALLOWED) => {
  const problems = []
  for (const [value, docs] of named) {
    const found = [...docs].some((doc) => resolves(value, doc))
    if (allowed.has(value)) {
      if (found) problems.push(`${value} — allowed in check-doc-paths.mjs, but it resolves now: drop the entry`)
      continue
    }
    if (!found) problems.push(`${value} — named in ${[...docs].join(', ')} and resolves nowhere`)
  }
  for (const value of allowed.keys()) {
    if (!named.has(value)) {
      problems.push(`${value} — allowed in check-doc-paths.mjs, but no document names it: drop the entry`)
    }
  }
  return problems
}

/** Each path the swept documents name, mapped to the documents naming it. */
export const namedIn = (repo, files) => {
  const named = new Map()
  for (const file of files) {
    for (const value of pathsIn(readFileSync(join(repo, file), 'utf8'))) {
      if (!named.has(value)) named.set(value, new Set())
      named.get(value).add(file)
    }
  }
  return named
}

/* Both sides through realpath, the same guard `check-verify-steps.mjs` uses:
   `import.meta.url` is always resolved through symlinks and `process.argv[1]`
   is whatever was typed, so comparing them any other way disables the command
   through a link, silently, at exit 0. */
const isMain =
  process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))

if (isMain) {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.length > 0 && isSweptDocument(file))

  const named = namedIn(root, files)
  const problems = problemsWith(named, basesFor(root))

  if (problems.length > 0) {
    process.stderr.write(
      'These paths are written in the documentation and do not resolve.\n' +
        'Fix the path, or — if it names something outside this tree on purpose —\n' +
        'record it with its reason in ALLOWED in script/check-doc-paths.mjs:\n\n',
    )
    for (const problem of problems) process.stderr.write(`  ${problem}\n`)
    process.exit(1)
  }

  process.stdout.write(`every documented path resolves (${named.size} paths in ${files.length} documents)\n`)
}
