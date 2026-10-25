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

The package floor remains Node 22.19. Lead's child and its permission probes
require Node 25+; run the complete local gate with that runtime. CI jobs that
exercise the child use Node 25; build, UI and gate jobs also exercise Node 22.
Linux Node fixture jobs install zsh because the fake agents and shell-profile
contracts execute `/bin/zsh`. These tests use scripted agents and local remotes.

Account, Git publication and phone access are separate host services. Account
requests use the desktop's encrypted storage and system-browser opener; local
phone pairing is opt-in through `HARNESSDESK_PHONE_LINK=1` and appears in
Settings › Phone without an account link. Lead is opt-in through
`HARNESSDESK_LEAD=1`; a host below its runtime floor reports it unavailable.
See [data boundaries](docs/data-boundaries.md) for each service's requests and
retained state, and [architecture](docs/architecture.md#the-git-gateway) for the
publication engine. Use isolated homes, placeholder identities and local
fixtures when checking these paths.

## The development branch

Reviewed changes land on the long-lived `development`
branch, one commit per change. Each push runs core CI; a nightly full run starts
at 11:00 UTC, and a failure is fixed the same day. A release pull request from
`development` into `main` runs the full tier and lands with a merge commit,
preserving each change's commit. Every merge into `main` is a release. Bump the
version on `development` before opening that release pull request; follow
[docs/release.md](docs/release.md) to cut it from the merged result.

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
desktop) plus the server's Lead end-to-end test file, flow-host-evidence and
intake test files and the command line's end-to-end file in runs of their own, at a wider per-file
timeout than the rest (Node 22 caps
`--test-timeout` per file, cumulatively, where these legitimately run long; it
is a per-test default on newer Node), the host-retention test file alone at the
ordinary timeout (its heap and CPU workload runs without competing server
fixtures), the Lead supervisor, service and client tests separately, the UI typecheck, the layering rules, the half-applied-fixes check, a tracked-secrets scan, the
reachable-methods check, the third-party notices check, the design-system
gates, the UI-system architecture gate, interface drift, the command-line reference check, the recorded-claims link, the doc-paths check, the
check that holds this gate and CI to one list, Codex protocol drift, and the
check that this paragraph and AGENTS.md name every step the gate runs. CI runs
these checks except protocol drift, which needs a real `codex` binary, and
also runs selected browser integration and native smoke checks. A passing
local gate does not replace those CI results.

On pull requests, “Build, typecheck, test” always runs. It stands for the whole
gate and is green only when each of five jobs that run side by side is: the
Node tests and Node end-to-end tests on Node 22, the Lead end-to-end and
supervisor/service/client tests on Node 25, the UI tests, and the checks.

Browser integration has two tiers. Ordinary pull requests use the **bounded**
tier, as do pushes to `development`. A push to `main`, a pull request whose
head branch is `development` or starts with `batch/`, a pull request labelled
`full-ci`, the nightly run and a manual dispatch use the **full** tier.
Adding `full-ci` starts one full run on the head commit (`full-ci-label.yml`); no other label starts anything. The full tier runs every browser
spec in both themes, with the existing matrix of up to sixteen shards, and
native smoke. A check named `CI tier: bounded` or `CI tier: full`, the browser
aggregate's log and the job summary identify what ran. Required check names stay
the same; bounded success satisfies branch protection, but landing requires full
CI. The development release PR supplies full evidence; batch branches and
`full-ci` remain available for other full runs.

Every bounded run includes core CI: build, typecheck, Node tests and end-to-end,
UI unit tests, UI tests and gates. Ordinary pull requests stay core-only;
their browser and native jobs are intentionally skipped, and their summary
lists the specs local `pnpm check:push` selects.

A push to `development` also runs the browser specs reached by the pushed
change, including server-facing specs when needed. It compares
`github.event.before` with `HEAD`, fetching the before commit if checkout's
two-commit history lacks it. Missing, all-zero or unavailable before commits
run every browser spec with the bounded theme matrix. Native smoke stays
full-tier only. Required check names stay the same and accept intentional
skips, including browser jobs for docs-only pushes.

Development pushes and local `check:push` keep added and edited specs, follow
suite helpers, and resolve files read by specs to their readers. A reader alone
can narrow a file only when the read is its sole tie to the suite. UI package
inputs, UI external imports and global inputs retain broad coverage with their
readers mandatory. Comments create no read edges; unread files under
`script/shots/` select no browser specs. A mixed change to UI source and a
document combines the map's reach with the document's readers.
Development restores its last full-run map first, then main's, then legacy
`ui-impact-map-<sha>` entries. The planner keeps the most specific selections
first within four shards of at most 1,000 recorded test seconds each. Edited
specs and the readers of changed files always survive that budget.
If the map's environment differs (protocol, client, UI configuration or root
setup), its recorded per-file reach still ranks specs first, then the cap fills;
the summary names the mismatch and every
deferred spec. Other stale map evidence also ranks a conservative capped sample.
On a development push, an unknown or unfetchable change range, no impact map
when one is needed, an unreadable input graph, or an unresolvable read runs
every spec without the cap. The `UI_SYSTEM_MATRIX=pr` matrix reads geometry
contracts in light and colour contracts in both themes. Local checks have their
own execution budget and report anything left to full CI. Each development
push has a commit-keyed concurrency group, preserving running and pending
coverage of earlier ranges; dispatches have a separate group, so pushes cannot
cancel the nightly full run.

The full tier uses `UI_SYSTEM_MATRIX=full` everywhere. Regressions beyond core
CI, reached browser specs and local checks are caught by the nightly
development run and the full release PR before main (or a batch or labelled pull request). Main also runs
the full suite. `script/land-safe.mjs` refuses a bounded run even if all required checks pass; its newest full-tier
proof must share the required checks' workflow check suite.

Every full browser run records the UI modules each spec loaded and ran.
`script/ui-impact.mjs merge` folds the records into a map; main and development
cache it after clean full runs.
A changed module selects the specs in which it ran; stylesheets and constants
follow their importers, including data exports, bundler imports and glob loads.
Unseen or changed specs and incomplete recordings join that selection before
the bounded cap. To inspect the uncapped impact selection with a downloaded
`ui-impact-map` artifact, run
`node script/ui-impact.mjs select --map ui-impact-map.json --fresh <paths>`.
The recording runner is `script/ui-impact/test.ts`.

Refresh `e2e/ui-system/durations.json` from full main-run logs, and
`durations.pr.json` from local `UI_SYSTEM_MATRIX=pr` logs without coverage, using
`node script/ci-browser-shards.mjs --refresh run.log …`. The existing PR table
remains in use by bounded development and local selection and may take
several runs to refresh across the suite. A missing PR time uses the full time scaled by the median PR/full
ratio of shared specs; without overlap, it uses the full time.

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
`main`, runs them all. So does one whose files reach more than a third of the test
files (counted from the imports, before anything is installed): that many run in one
serial shard outlast the four shards of the full suite. A package the UI is not built
from and does not read is nothing to these tests (`script/ci-unit-tests.mjs`).

DOM unit tests share a 10-second per-test budget in `packages/ui/vitest.config.ts`.
This includes full App, page and dialog renders (such as navigation, Library and
Flow start), whose first render can cross the default 5 seconds on a loaded
runner. Pure Node tests retain Vitest's 5-second default. Use the shared budget
rather than per-test timeout literals; investigate any render that exceeds it.

Full unit runs are sharded by measured file time, longest first onto the lightest
shard, using `script/ci-unit-shards.mjs` and `script/ci-unit-durations.json`.
Refresh the table from the last five full `main` run logs with
`node script/ci-unit-shards.mjs --refresh run.log … > script/ci-unit-durations.json`;
new files use the median recorded time. Related tests use one shard; UI typecheck
and desktop tests run once in their own job, and `UI tests` aggregates both jobs'
results. Files under `script/` that no UI file imports or mentions by path do not
select unit tests, unless they configure Vitest or belong to the setup closure;
scripts read by the UI include their transitive script imports.

The shared local planner selects `server` for specs importing packages outside
the UI inputs, and `none` for docs-only and unrelated script changes. Native
inputs include package changes, the isolated rig and launch helpers. Global
browser inputs, including shared manifests, the lockfile, UI build and root tool
configuration, protocol and assets, retain the four-shard cap. Their summary
names each global input, and a deterministic rotation keyed by the pushed SHA
(falling back to the before revision) fills the cap after mandatory and reached
specs, varying coverage across pushes; the nightly full run covers the rest.
Changes to `.github/workflows/ci.yml` or `playwright.ui-system.config.ts` run
every browser spec uncapped because they change how the suite runs. Unknown
ranges, unreadable input graphs and unresolvable suite reads also run uncapped
on development. These path rules remain in
`script/ci-changes.mjs` for `check:push` and development pushes; its CLI
suppresses browser integration only for ordinary bounded PRs, and native smoke
for every bounded run. Full CI runs every browser spec and native smoke.

The required browser check accepts only the selected job's success and the
other job's intentional skip (or both skips for `none`); failed selection,
failures, cancellations and unexpected skips fail it. The native required
check also accepts intentional skips.

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
2. **State the gap in the same voice as the feature.** A section like
   [multi-agent.md's "What it does not do yet"](docs/multi-agent.md#what-it-does-not-do-yet)
   builds more trust than any feature list; never quietly shorten that kind
   of section.
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
lists — [multi-agent.md's "What it does not do yet"](docs/multi-agent.md#what-it-does-not-do-yet)
and the open questions inside each document. An issue describing what you intend before a large PR saves
both of us the polite version of "not like this".
