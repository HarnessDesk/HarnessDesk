#!/usr/bin/env node
/**
 * Every host method has somewhere to be called from.
 *
 * The compiler already holds the other direction: a method declared on the
 * wire and not answered by the host does not build (`methods.test.ts` pins
 * the table). Nothing held this one, and it is the direction that rots —
 * a capability is built end to end, the surface that was going to use it is
 * cut or postponed, and what is left is a method that works, is validated,
 * is tested, and cannot be reached by any person using the app.
 *
 * Ten agents reading this repository for an hour found four of them
 * independently, which is the argument for a gate rather than a habit:
 * `credentials/delete` meant a stored key could be created and never
 * removed; `team/inbound` meant a room could be silenced only in whole;
 * `capability/list` meant "what applies here" had no asker; and
 * `runtime/plugin/setEnabled` was `install`/`uninstall` under a name that
 * said otherwise — the dangerous kind, because a caller reading the name
 * would have shipped a "disable" that deletes.
 *
 * A method with no caller is not automatically a bug. Two of them are the
 * pull half of a push the renderer already receives whole. So the check is
 * not "none of them" but "these, and no others": the set is pinned below
 * with a reason each, and drift in either direction fails. Wiring one up
 * fails until its line is removed, which is the point — the removal is the
 * commit saying it is reachable now.
 *
 *   node script/check-reachable.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from '@typescript/typescript6'

import { withoutComments } from './lib/without-comments.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where a person's action can start: the renderer, desktop menus and deep
 * links, and the read client library and command line.
 *
 * Not `packages/server` or `packages/plugins`: the host calling its own
 * method proves nothing about reachability, which is the whole mistake this
 * catches.
 */
const CALLERS = ['packages/ui/src', 'packages/desktop/electron', 'packages/client/src', 'packages/cli/src']

/**
 * The methods no surface calls, and why each is allowed to stay that way.
 *
 * Anything not on this list must be reachable. Anything on it must still be
 * unreachable — a stale entry is a claim about the code that is no longer
 * true, and those are worse than no claim at all.
 */
const UNREACHED = {
  'team/rooms':
    'likewise — every room a workspace holds arrives by push, so nothing needs to ask',
}

/**
 * The method names, read from the validator table.
 *
 * That table rather than `wire.ts`: `knownMethods` is derived from it, so it
 * is the list the host will actually accept, and it is a flat object whose
 * keys are at one indentation — which is what makes this parseable without a
 * TypeScript pass. The type table in `wire.ts` nests its params, so the same
 * pattern there would match fields as well as methods.
 */
export const methodsIn = (source) => {
  const from = source.indexOf('paramsValidators')
  /* And stop at the table's own closing brace. Slicing to the end of the file
     was one later object literal away from inventing methods no host answers
     — review found it; the file has no such literal today, which is exactly
     how long that kind of thing stays true. A top-level `}` closes it,
     because the table is declared at column 0. */
  const rest = source.slice(from)
  const end = rest.search(/^\}/m)
  const table = end === -1 ? rest : rest.slice(0, end)
  /* Hyphens count as name characters: `\w` alone stopped `'flow/start-goal'`
     at the `-`, so the key failed to match at all and the method was neither
     counted nor flagged — a gate that could not see it. */
  return [...new Set(keysOf(table, source, new Set()))]
}

/**
 * The keys of one table, following its spreads.
 *
 * The table is assembled, not only written: `...goalValidators,` pulls a whole
 * domain in from a literal declared above it. Reading only the table's own
 * lines left every such group — `goal/*`, `insight/*`, `finding/*` — out of the
 * list, so none of them could fail however unreachable they were. A spread is
 * resolved to its own column-0 declaration and read with the same key pattern,
 * which keeps an unrelated literal elsewhere in the file out; one that names
 * nothing declared here throws, since skipping it is how the gap opened.
 */
const keysOf = (table, source, seen) => {
  const keys = []
  for (const line of table.matchAll(/^ {2}(?:'([a-z][\w-]*\/[\w/-]*)':|\.\.\.([A-Za-z_$][\w$]*),?\s*$)/gim)) {
    if (line[1]) {
      keys.push(line[1])
      continue
    }
    const name = line[2]
    if (seen.has(name)) continue
    seen.add(name)
    const declared = source.match(new RegExp(`^(?:export\\s+)?const\\s+${name.replace(/\$/g, '\\$')}\\b[^=\\n]*=\\s*\\{`, 'm'))
    if (!declared) throw new Error(`paramsValidators spreads \`...${name}\`, and no \`const ${name} = {\` is declared in the file.`)
    const body = source.slice(declared.index + declared[0].length)
    const close = body.search(/^\}/m)
    keys.push(...keysOf(close === -1 ? body : body.slice(0, close), source, seen))
  }
  return keys
}

/** Every file a call could be written in. */
const filesUnder = (dir) => {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name)) out.push(path)
  }
  return out
}

/**
 * A surface dispatch is a request(...) or client.call(...) whose first
 * argument is a literal method name. The compiler distinguishes these from
 * markers, comments, examples inside strings and concatenated arguments.
 * Tests are excluded by the caller: a test is not a person's surface.
 */
const isDispatch = (expression) =>
  (ts.isIdentifier(expression) && expression.text === 'request') ||
  (ts.isPropertyAccessExpression(expression) && (expression.name.text === 'request' ||
    (expression.name.text === 'call' && ts.isIdentifier(expression.expression) && expression.expression.text === 'client')))

/** `sources` are texts, or `{ file, text }` so that each is parsed as what it is. */
export const reachedBy = (methods, sources) => {
  const calls = new Set()
  for (const source of sources) {
    const name = typeof source === 'string' ? 'source.ts' : source.file
    const code = typeof source === 'string' ? withoutComments(source) : withoutComments(source.text, name, { strict: true })
    const kind = /\.tsx$/.test(name) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS
    const file = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, kind)
    const visit = (node) => {
      if (ts.isCallExpression(node) && isDispatch(node.expression)) {
        const first = node.arguments[0]
        if (first && ts.isStringLiteralLike(first)) calls.add(first.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return new Set(methods.filter((method) => calls.has(method)))
}

/* Imported by `gates.test.mjs`, which tests the two parsers above, so the run
   itself is guarded: without this the import exits the test process before its
   second test — measured, and it took the whole file's report with it. */
const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const methods = methodsIn(readFileSync(join(root, 'packages/protocol/src/wire-validators.ts'), 'utf8'))
  if (methods.length < 100) {
    console.error(`Only ${methods.length} methods parsed out of the validator table — the parser has drifted.`)
    process.exit(1)
  }

  const sources = CALLERS.flatMap((dir) => filesUnder(join(root, dir)))
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file))
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))

  const reached = reachedBy(methods, sources)
  const unreached = methods.filter((method) => !reached.has(method))

  const problems = []
  for (const method of unreached) {
    if (!(method in UNREACHED)) {
      problems.push(
        `${method} is answered by the host and called by no surface.\n` +
          '      Give it one, delete it, or add it to UNREACHED in this file with the reason.',
      )
    }
  }
  for (const [method, why] of Object.entries(UNREACHED)) {
    if (!methods.includes(method)) {
      problems.push(`${method} is listed as unreachable and is not a method any more — drop the line.`)
    } else if (reached.has(method)) {
      problems.push(
        `${method} has a caller now, and is still listed as unreachable (“${why}”).\n` +
          '      Remove its line from UNREACHED in this file.',
      )
    }
  }

  if (problems.length === 0) {
    console.log(
      `${reached.size} of ${methods.length} host methods reachable from a surface; ` +
        `${Object.keys(UNREACHED).length} pinned as not.`,
    )
    process.exit(0)
  }

  console.error('Host methods and the surfaces that call them:\n')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
