#!/usr/bin/env node
/**
 * The pre-commit gate: typecheck, tests, layering, and Codex protocol drift.
 *
 * Run it before pushing. CI runs these same steps (minus the Codex protocol
 * drift check, which needs a real `codex` binary the runner does not have), so
 * a green local run means a green pipeline. Keep the two in step: this list and
 * `.github/workflows/ci.yml` drifting apart is what let a broken build reach
 * main once already.
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSteps } from './lib/steps.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/* The steps themselves, their failures, and what a step that reads another
   step's output does when that one failed: `script/lib/steps.mjs`, where a
   test can reach them (#208). */
const { step, report, failures } = createSteps()

const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    // stderr goes straight to the terminal, and stdout gets a buffer a real
    // run fits in. Node's default is 1MB per stream and the reporter prints
    // a line per test: a branch that adds enough of them overruns it, and
    // `execFileSync` answers by killing the child — which arrives here as a
    // failed step with no failing test named in it. Inheriting stderr is the
    // other half: a child that dies says so where it dies, rather than in a
    // buffer nobody prints.
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 50 * 1024 * 1024,
  })

/*
 * CI's own first command, run first here too — and it *installs*, which is
 * why the step says so rather than calling itself a check.
 *
 * This is the step that was missing. A dependency PR moved one package to a
 * new major and dropped the old package entry while another package went on
 * pinning it exactly, so the lockfile's importer named a version the file no
 * longer described. `git merge` had nothing to conflict about, every check
 * here passed against the `node_modules` already on disk, and `main` spent a
 * day where a fresh checkout could not install. CI has run this since it was
 * written, on every pull request, and this is the same command, so a lockfile
 * that cannot install fails here before it fails there.
 *
 * **It repairs as well as reports**, and that is not a side effect to hide:
 * a working tree that has drifted from the lockfile is brought back to what
 * the lockfile says, and every step below then runs against that. Measured:
 * ~0.5s when there is nothing to do, and a re-link of one package in the same
 * half-second when there is. pnpm offers no non-mutating equivalent —
 * `--lockfile-only` skips resolution and passes over exactly the broken
 * lockfile this exists to catch.
 *
 * Verbatim CI's command, with no flags of its own. `--ignore-scripts` was
 * here and came out: measured, a re-link does not re-run a package's
 * postinstall *either way* (electron's `dist` stays missing with the flag and
 * without it), so it bought nothing and implied a difference that is not
 * there. `check-verify-drift.mjs` holds this and CI to the same list.
 *
 * `stop` because everything below is meaningless if this fails.
 */
step('lockfile installs', () => run('pnpm', ['install', '--frozen-lockfile']), { stop: true })

step('build', () => run('pnpm', ['run', 'build']))
step('node tests', () =>
  run('node', [
    '--test',
    // Same deadline CI uses: a hung test should say its name, not time out the run.
    '--test-timeout=120000',
    // The same glob CI runs, so a package that gains tests is covered here the
    // day it does. A hand-kept list of packages once left one out. It matches
    // what was built rather than what exists, which is why `build:node` ends
    // by pruning dist of every output whose source is gone (script/prune-dist.mjs).
    'packages/*/dist/test/**/*.test.js',
  ]),
  // What it reads is what the build writes: over the dist a failed build left, it ran and printed ok (#208).
  { needs: 'build' },
)
/* The gates' own parsers, and whatever else in `script/` has a test beside
   it. `script/` had no test runner, so the two functions that decide what the
   layering check and the doc generator *see* were the only code in the repo
   that nothing could hold — and both were silently wrong. Beside their
   subject, the way packages/desktop already does it. `diagram-pages.test.mjs`
   runs here too: it holds the rendered diagram pages to their hand patch. */
step('gate tests', () => run('node', ['--test', 'script/*.test.mjs']))
step('ui typecheck', () => run('pnpm', ['--filter', '@harnessdesk/ui', 'run', 'typecheck']))
step('ui tests', () => run('pnpm', ['--filter', '@harnessdesk/ui', 'run', 'test']))
step('desktop tests', () => run('pnpm', ['--filter', '@harnessdesk/desktop', 'run', 'test']))

step('layering rule', () => run('node', ['script/check-layering.mjs']))
step('half-applied fixes', () => run('node', ['script/check-half-applied-fixes.mjs']))
step('tracked secrets', () => run('node', ['script/check-secrets.mjs']))
// A host method with no surface that calls it. The compiler holds the other
// direction; this one rots, and ten agents reading the repo found four of them.
step('reachable methods', () => run('node', ['script/check-reachable.mjs']))
step('third-party notices', () => run('node', ['script/check-notices.mjs']))

// A token edit is the one change that repaints every screen at once and shows
// as almost nothing in the diff. The snapshot makes moving a value deliberate;
// the audit refuses drift worse than the recorded baseline.
step('design tokens', () => run('node', ['script/check-design-tokens.mjs']))
step('design drift', () => run('node', ['script/design-audit.mjs', '--strict']))
step('interface drift', () => run('node', ['script/check-interface-drift.mjs']))
step('design doc', () => run('node', ['script/design-doc.mjs', '--check']))

step('recorded claims', () => run('node', ['script/check-claims.mjs']))
/* The prose is the one part of this repository the gate never read, which is
   how two mis-rooted source paths sat in docs/extending.md until a person
   noticed them (#94, #223). Every repository path the documentation names in
   backticks has to resolve to a file. */
step('doc paths', () => run('node', ['script/check-doc-paths.mjs']))
// This file and `ci.yml` drifting apart is named in the header as what let a
// broken build reach main once already; this is the check that says so.
step('gate matches CI', () => run('node', ['script/check-verify-drift.mjs']))
step('codex protocol drift', () => run('node', ['script/generate-codex-protocol.mjs', '--check']))
// The two documents that tell a person what this gate does list its steps by
// hand, and nothing compared either list with this file until now (#246).
step('steps are documented', () => run('node', ['script/check-verify-steps.mjs']))

if (failures.length > 0) {
  report()
  process.exit(1)
}

process.stdout.write('\nAll checks passed.\n')
