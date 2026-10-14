# Contributing

HarnessDesk is a macOS desktop app for coding agents, owned by no model
vendor. Contributions are welcome — and the bar they are held to is the same
one the existing code holds itself to, which this file states rather than
implies.

## Setup

macOS 13+ · Node 22.19+ · pnpm 10 · at least one agent installed (for Codex,
`brew install codex` or `npm i -g @openai/codex`, version 0.145.0 or later).

```bash
pnpm install
pnpm build
pnpm app        # the Electron shell
pnpm serve      # or headless, against a browser
```

[docs/getting-started.md](docs/getting-started.md) covers signing in,
registering ACP agents, and troubleshooting.

## The gate

Before you push, run `pnpm check:push`. It uses CI's planners for the committed,
uncommitted and untracked change against the merge base with `origin/main`,
without fetching, and reports selected checks, skips and timings. Use `--plan`
for a JSON plan, `--base <ref>` for another local base, `--map <file>` (or
`UI_IMPACT_MAP`) for a downloaded impact map, and `--fast` to leave Node-package
tests and browser specs to CI. Broad suites and shared-input changes stay with
CI; `pnpm verify` remains the full gate.

```bash
pnpm verify
```

Run it bare — never piped into anything, because a pipe eats the exit code
and a red run reads green. It is the whole pre-commit gate: the lockfile
install, the build, every test suite (Node packages, gate scripts, UI and
desktop) plus the server's flow-host-evidence and intake test files and the
command line's end-to-end file in runs of their own, at a wider per-file
timeout than the rest (Node 22 caps
`--test-timeout` per file, cumulatively, where these legitimately run long; it
is a per-test default on newer Node), the UI typecheck, the layering rules, the half-applied-fixes check, a tracked-secrets scan, the
reachable-methods check, the third-party notices check, the design-system
gates, the UI-system architecture gate, interface drift, the command-line reference check, the recorded-claims link, the doc-paths check, the
check that holds this gate and CI to one list, Codex protocol drift, and the
check that this paragraph and AGENTS.md name every step the gate runs. CI runs
these checks except protocol drift, which needs a real `codex` binary, and
also runs selected browser integration and native smoke checks. A passing
local gate does not replace those CI results.

On pull requests, “Build, typecheck, test” always runs. It stands for the whole
gate and is green only when each of four jobs that run side by side is: the
Node tests, the Node end-to-end tests, the UI tests, and the checks. Browser
integration selects one of three modes: `all` runs the browser shards for changes
to the UI, its transitive workspace dependencies (read from package manifests),
browser specs/configuration, or shared root inputs. The shards are dealt by how
long each spec file takes, not by how many tests it holds
(`script/ci-browser-shards.mjs`, from `e2e/ui-system/durations.json` and
`durations.pr.json`), and each runs two browsers at once. A run gets as many
shards as its work needs, one to sixteen, so a change
that reaches one spec does not pay for sixteen runners.

Two rules keep a pull request from running more than it can learn from:

- **A change to the suite alone runs the specs it can reach.** The selector
  follows imports, `new URL('./helper', import.meta.url)` loads and any spec that
  names a helper, so a changed spec runs itself and a changed helper runs the
  specs that use it, in both themes. A data file a spec reads at run time, a
  deleted helper, or any change outside the suite cannot be traced and runs
  every spec. Edits to `durations.json` open no browser: they only change how
  specs are dealt.
- **A pull request that touches the UI reads the geometry contracts in the light
  theme.** The dark theme rewrites colours and nothing else, so a box measured
  in it is the box measured in the light one. With `UI_SYSTEM_MATRIX=pr`
  `playwright.ui-system.config.ts` skips the dark cases of the `frame-*` specs
  that assert geometry; the specs that assert a colour (`COLOUR_SPECS` there, and
  a gate test finds one that is missing) and every spec that is not a `frame-*`
  spec read both. Pushes to `main` and runs started by hand read both themes
  everywhere, so a dark-only regression is found when it lands and not before;
  a pull request whose UI diff names a theme, that edits a stylesheet which
  names one anywhere (a declaration added inside the dark block does not say so
  itself), the foundation, the shared styles or the UI's build configuration, or
  whose inputs are shared (the lockfile, root configuration, assets, CI, the
  browser configuration), reads both too. To reproduce either run on a branch, start CI by hand
  (`gh workflow run ci.yml --ref <branch> -f matrix=full`, or `-f matrix=pr`;
  GitHub offers a manual run only for a workflow that is on the default branch).
  Refresh `e2e/ui-system/durations.json` (dev server with coverage, both themes)
  from the last five push runs of `main` that ran the whole suite, and
  `durations.pr.json` (PR theme matrix, built pages where supported, dev server
  elsewhere, no coverage) from one `workflow_dispatch` run of `ci.yml` on a
  branch with `matrix=pr`: save each log with `gh run view <id> --log > run.log`,
  then use `node script/ci-browser-shards.mjs --refresh run.log …` and write its
  output to the corresponding table. A missing PR measurement uses the full
  time scaled by the median PR/full ratio of shared specs (the full time if
  none overlap); a stale table shows up as a shard much slower than its plan.

A third rule narrows a change to the UI's own source, once there is a map of what
the specs ran:

- **A change to the UI's source runs the specs in which that source ran.** Every
  full run (a push to `main`, a run started by hand, a pull request that has to
  read everything) records, for each spec, which modules of the UI its page
  loaded and in which of them a function ran; `script/ui-impact.mjs merge` folds
  the shards' records into one map, and `main` keeps the newest in the Actions
  cache. A pull request reads that map: a changed file runs the specs that ran
  it, a stylesheet or a constant (nothing in it runs) runs the specs that ran
  whoever imports it, and a file added or deleted also runs the specs that ran
  the modules that load files by a pattern. A module that hands data to its
  importers (`export const LABEL = …`) also runs the specs in which they ran, and
  a stylesheet the bundler took into another (`@import`, `url()`) is followed to
  whoever imports that. A spec the map has not seen, or whose own code or helpers
  have changed since, always runs, and so does a spec that opens pages of its own
  (the recorder sees only the page a test is given) or whose recording was not
  complete (`playwright test --list` says how many tests it has). Anything the
  map cannot speak for runs every spec: no map, a file that changed on the base
  branch since the map was recorded, a change to the setup it was recorded in
  (the browser configuration, dependencies, the pages, the workspace packages the
  preview loads), a file outside the UI's source, a change to shared inputs. `main` always runs everything, so a miss is found there and fixed
  forward. To see what a change would run, with a map downloaded from a run
  (`ui-impact-map`): `node script/ui-impact.mjs select --map ui-impact-map.json --fresh <paths>`.
  The recording is `script/ui-impact/test.ts`, a build of `@playwright/test` the
  specs are pointed at only while recording; it costs under a tenth of a run.

Non-recording browser shards share one build of `preview.html`, `design.html`,
`narrow-overlay.html` and the embedded Seat page,
`packages/ui/src/preview/tile-page.html`, in `packages/ui/dist-e2e`.
The classifier in `script/ci-server-split.mjs` follows the suite import graph
and keeps specs that load source URLs, rewrite source responses, or need an
unbuilt or unknown route on the dev server; the rest run against the build.
`node script/ui-system-run.mjs <spec paths>` runs that same split locally and
rebuilds before serving static pages;
`pnpm check:push` uses it too.
Only `UI_SYSTEM_PAGES=prebuilt`, set after CI downloads the shared artifact,
uses an existing build; a missing or incomplete artifact then fails the run.
To choose static explicitly, run `pnpm run build:node`, then `pnpm run build:e2e`,
then `UI_SYSTEM_SERVER=static pnpm test:ui-system <spec paths>`; the Node build
must come first because the UI resolves workspace packages through their
compiled output. Recording stays one dev-server run, with the recording
configuration and module URLs intact; because that run never serves the build,
the build job runs a few static specs from each built page itself (the
`Try the build` step) on a recording run, so a build that compiles but cannot
run fails the run that broke it.

The UI's unit tests follow the same idea with the tool that already knows their
imports: a pull request that changes only the UI's own source runs `vitest
related` on the changed files, plus the tests that read the tree by themselves
(the file system, `import.meta.glob`, in the test or in a helper it imports) and
the importers of a file that is imported with a query (`?raw`), which Vitest does
not follow; a pull request that changes anything a test may read from elsewhere
(another package the UI is built from, or one a file of the UI reads by import or
pattern), a deleted file or anything the test setup imports, and every run of
`main`, runs them all. A package the UI is not built from and does not read is
nothing to these tests (`script/ci-unit-tests.mjs`).

Full unit runs are sharded by measured file time, longest first onto the lightest
shard, using `script/ci-unit-shards.mjs` and `script/ci-unit-durations.json`.
Refresh the table from the last five full `main` run logs with
`node script/ci-unit-shards.mjs --refresh run.log … > script/ci-unit-durations.json`;
new files use the median recorded time. Related tests use one shard; UI typecheck
and desktop tests run once in their own job, and `UI tests` aggregates both jobs'
results. Files under `script/` that no UI file imports or mentions by path do not
select unit tests, unless they configure Vitest or belong to the setup closure;
scripts read by the UI include their transitive script imports.

`server` runs only specs that import packages outside those UI inputs, in
one Ubuntu job, for other package changes. The selector discovers those
imports, including local helpers; the spec list needs no manual update. `none`
skips both browser jobs for docs-only and unrelated script changes.
Desktop-only changes run native smoke.

Native smoke still runs for every package change, its isolated rig and launch
helpers. Shared manifests, the lockfile, root tool configuration, assets, CI
or its selection script, and unreadable changed paths run the full browser
suite and native smoke. The required browser check accepts only the selected
job's success and the other job's intentional skip (or both skips for `none`);
failed selection, failures, cancellations and unexpected skips fail it. The
native required check also accepts intentional skips. Pushes to `main` always
run everything. The path rules and their reasons live in
`script/ci-changes.mjs`.

Three of its checks are worth knowing before they surprise you:

- **Layering.** Nothing above `adapter-codex` may import Codex; nothing above
  `cordis-host` may import Cordis; the renderer never touches `node:*` or the
  keystore. These rules are what keep a second runtime an adapter rather than
  a rewrite, and the check is proven to fire (`pnpm layering`).
- **Runtime-neutral UI.** A backend brand name in rendered interface text —
  or a `runtime.id === '…'` comparison in the renderer — fails the build.
  Gate on `runtime.capabilities`, never on backend identity; every string
  the interface says *about* an agent comes from `RuntimeInfo.presentation`.
- **Generated files.** `docs/design-system.md` is generated by
  `pnpm design:doc`, `docs/cli.md` by `pnpm cli:doc` from the command table in
  `packages/cli/src/cli.ts`, and `packages/codex/src/generated` by
  `pnpm codex:protocol`. Edit the source they are generated from, never them;
  verify notices either way.

## Commits and pull requests

A commit message is a lowercase area prefix and a sentence that carries the
*why* — `library: a copy on disk is not a skill an agent can load` — not a
category label. Keep pull requests small enough to hold in one read, say what
was verified and how, and report outcomes plainly: if a test fails, the PR
says so with the output.

Behaviour changes carry their documentation in the same PR. A feature whose
doc lands "later" is a feature the docs now lie about.

### How review happens

**Nothing here is asked of you.** Open the pull request; the rest is the
maintainers' side.

Review is done by three agents from three vendors at once, in HarnessDesk
itself. A skill opens the app on the checkout, seats Claude Code, Codex and
Cursor in one room, and hands all three the same brief. Each leaves one comment
signed with its own name and model version.

So expect three reviews on your pull request, sometimes disagreeing with each
other — that is the point rather than a malfunction, and the signature is what
lets a reader tell a month later which agent said what. A human reads them and
decides. Three agents agreeing is three opinions, not a merge.

## Writing documentation

The documentation's voice is a feature, and it is easier to keep than to
recover. Five rules:

1. **Name the measurement or link the code.** "Measured 2026-08-28 against
   codex-cli 0.149.0" can be maintained; "supports the latest Codex" cannot.
2. **State the gap in the same voice as the feature.** The README's "What it
   does not do yet" is the most trust-building section in it; never quietly
   shorten that kind of section.
3. **No wire-level names in anything a user reads.** Method names and
   protocol vocabulary belong in the architecture documents.
4. **Second person in guides, third person in reference.** Mixed voice is the
   loudest signal that two writers disagreed.
5. **A version number is a fact with a date.** A sentence that cannot carry
   one does not belong in an evergreen guide: keep the measurement with the
   work it came from, and let the guide say what is true whatever version you
   are on. An evergreen guide carries no version snapshot; a dated measurement
   carries nothing evergreen.

[docs/README.md](docs/README.md) explains where a new document belongs.

## Where to start

Issues labelled `good first issue` when they exist; otherwise the honest gap
lists — the README's "What it does not do yet" and the open questions inside
each document. An issue describing what you intend before a large PR saves
both of us the polite version of "not like this".
