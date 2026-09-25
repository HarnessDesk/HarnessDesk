# Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution override:** The owner's phase process chooses **one implementer for this phase, using executing-plans, with no per-task reviews**. The routing table below identifies the proof each task requires; it is not a dispatch instruction. One review covers the resulting pull request. The plan writer changes only this document and does not commit. A Codex implementer leaves the tree for the controller to verify and commit.

**Goal:** Observe a project's refs without involving its turns, preserve defensible commit-to-Seat links across rewrites, and show both those links and the health of capture where the person works.

**Architecture:** A host-owned `ProvenancePlane` watches registered Git metadata, journals observations outside the repository, and reconciles immutable fingerprints against Phase 4's Seat records and host-observed diff facts. It answers a separate, batched provenance read beside `git/log`; neither Git history nor a running turn waits for capture. The renderer composes the existing history pane, Seat record view, project page and navigation row.

**Tech Stack:** Existing TypeScript ESM packages, Node child processes with argument vectors, Git plumbing, Node tests, React, Vitest/jsdom, existing Base UI-backed design components. No new package, service, hook, daemon, Git config change, network fetch, Goal, or transcript copy.

## Global Constraints

- **This is Phase 9 of 12. Needs: 2 and 4.** It can land beside 5–8. No import of a Goal type, Goal store, receipt, trigger, findings producer or new flow engine is permitted. A `CardRef.board` is an opaque existing board ID. Phase 3's `standing` and `ceiling` are read in their existing forms, never changed.
- **Design source:** `docs/superpowers/specs/2026-09-17-agents-and-goals-design.md`, sections *Agent*, *Seating*, *Evidence* and *7. Provenance*; roadmap `docs/superpowers/plans/2026-09-17-agents-and-goals-roadmap.md`, section *9. Provenance*. Explicit resolutions of underspecified or impossible guarantees are recorded below.
- **Observed, never reported.** Evidence is written by the host from something it did. Nothing an agent typed becomes a fact.
- **A message is never evidence.** A commit author, trailer, subject, reflog message or an agent's claim does not establish a Seat. Reconciliation does not refresh checks, CI, reviews or findings at the rewritten SHA.
- **Ambiguity orphans; it never guesses.** No best-score winner, probabilistic attribution, author-email matching, nearest-time fallback or splitting an unknown contribution evenly between Seats.
- **The store is `evidence`, never `ledger`.** The existing `packages/server/src/ledger/` remains the usage ledger. Provenance is a sidecar under the evidence project's folder, not another copy of Seat records.
- **A proof counts only if it was run.** Never move a test below the thing it tests. Name every edit to a test you did not write. Run tests in the foreground. A commit's trailer names who wrote it.
- **A wire method is three edits in a fixed order:** declare in `packages/protocol/src/wire.ts`, validate in `packages/protocol/src/wire-validators.ts`, answer in `packages/server/src/methods/provenance.ts`. A handler reaches the host only through `HostContext`.
- **A verb with no caller is pinned in `UNREACHED`** in `script/check-reachable.mjs` with its reason, and its line is removed in the same task that adds its first `transport.request` caller.
- **No reference-app or competitor names in anything public. No real accounts or home paths in anything public; frames come from the shots rig. No hard-coded use cases. The plain path stays plain.** Use Jane Doe, `dev@example.com`, and synthetic `/work/project` paths in examples. Read every frame before sharing it.
- **Sentences, not wire.** Show the Agent's recorded name, a runtime mark from `RuntimeInfo.presentation`, the host's `seatLabel`, and the first seven characters of a commit where appropriate. Do not draw Seat IDs, method names, patch IDs, digests, raw ref paths or seat specifications.
- **Compose, don't draw.** Import public components from `packages/ui/src/design`. Screens use layout-only classes. No new primitive, raw colour, typography, radius, role height, per-screen ring, hand-drawn icon or hand-rolled overlay. Icons come from `components/Icons.tsx` or `BrandIcons.tsx`.
- **One navigation row:** `Button variant="navigation" size="navigation"`; selection uses `data-selected`/`data-current`, never font weight. Use the landed #813 row. Do not edit `Sidebar.module.css` or a design primitive. Before editing `SessionTree.tsx`, message the UI-system session, “Rebuild one canonical UI system 762”, describing the status addition; this is the supplied UI coordination rule, not a request for product approval.
- **State vocabulary:** `Chip` tones `neutral|brand|success|warning|danger|info`, with `stateTone` for existing canonical outcomes. Capture health maps to those tones, without inventing three new system-wide states. The Phase 4 plan's `4382ded9` state-vocabulary prerequisite must be present before Tasks 7–8.
- **Every surface has loading, empty, error, refused and unavailable states**, a preview fixture and keyboard verification. A disabled action keeps its reason visible. Use the canonical Dialog and restore focus on close.
- **The plain path stays plain.** No new sidebar destination, no startup roster read, no change to Command-N or a plain conversation header, no `.harnessdesk/` write in a repository. Capture on by default is the explicit Phase 9 exception to the earlier broad “nothing is read until asked” wording: opening a project registers passive local capture. Healthy capture adds no sidebar decoration; only a stopped capture is called out there.
- **No turn waits for capture.** No observer await in send, queue drain, turn-start, approval, tool delivery or turn-completed. File events and evidence changes enqueue bounded work. Stop/pause of capture never interrupts an Agent.
- **Testing:** server tests use `node:test` and `node:assert/strict`; build with `pnpm run build:node`, then run the named `packages/server/dist/test/*.test.js`. UI tests use `pnpm --filter @harnessdesk/ui exec vitest run <one file>`, in the foreground. Do not substitute a handler test for a `parseClientMessage` validation test.
- **Implementation gate:** the controller runs `pnpm verify` unpiped before committing, plus the real observer and rendered UI acceptance described here. The plan-writing sandbox cannot finish that gate; do not try it there. Commit only named files, with the actual writer's trailer. Do not publish or merge as part of this plan.

## What exists, and the seams this plan consumes

Inspected base: `0a6cc10848451f2c48ef8e1b58c67032735d599f` (Phase 2 Part A). The worktree was clean before this plan. Source was read, not inferred from names:

| Existing surface | What it does now | Phase 9 use |
| --- | --- | --- |
| `packages/server/src/git-history.ts` | Paged history, refs, commit details; uses Git with replacements disabled | Leave its meaning and return shapes unchanged; provenance is a second read |
| `packages/server/src/git.ts`, `git-ops.ts`, `git-actions.ts` | Status/diff and user-requested mutations | No provenance call is awaited by these operations |
| `packages/server/src/methods/git.ts` | Confines roots through `ctx.workspaces.confineGitRoot` | Use the same gate before the stricter observer repository admission |
| `packages/server/src/worktree.ts` | `repositoryRoot(path)` / `repositoryOf(path)`, linked worktree identity | Resolve the logical project, then verify actual metadata membership |
| `packages/server/src/workspace.ts` | A nonrecursive file-tree watch; ignores `.git` in tree browsing | It is not a ref observer and must not be repurposed as one |
| `packages/server/src/host.ts` | Restores workspaces, watches Agent roots, owns lifecycle | Own the provenance plane and register projects without delaying runtime startup |
| `packages/ui/src/components/GitPane.tsx` | Virtualized log, a listbox of commit options, selected `CommitDetail` | Read a batch of provenance beside each log page; put actions in selected detail |
| `packages/ui/src/components/GitGraph.tsx` | Decorative SVG lane geometry, `aria-hidden` | Read and test it; no provenance state or interactive content belongs in this SVG |
| `packages/ui/src/components/SessionTree.tsx` | `GroupHead` uses the canonical navigation Button | Add a stopped label on that existing row, including a folded project |

**Phase 2 Part B:** inspected commit `88c87237` in its worktree with `git show HEAD:…`. `ProjectPage.tsx` was not yet present there. Consume the exact planned `ProjectPage({ root, onBack })` from Phase 2 Task 17 once it lands; do not manufacture a second page or treat that absent file as implemented. Its initial shape is also in the Phase 2 plan already in this checkout.

**Phase 4:** read the revised plan `docs/superpowers/plans/2026-09-18-agents-evidence-ledger.md` in the Phase 4 plan worktree. Its opening seam, Global Constraints, file map and complete Task 3 were inspected, along with the store, Seat book, diff observer and Seat view contracts. It currently has no separately headed “Interfaces for later phases” section; the concrete task signatures below are the consumed contract.

- `SeatRecord` in `packages/protocol/src/evidence.ts`: `id`, `agent: { id, name, origin } | null`, `briefDigest`, resolved `seat`, `seatLabel`, `passedOver`, `standing`, `ceiling`, `checkout: { cwd, project, branch, head }`, `session: { runtime, sessionId }`, nullable `board` and `role`, `openedAt`, nullable `closed: { at, why }`, optional `restored`.
- `EvidenceRecord`: `id`, `fact`, optional `seat`, `card`, `checkout`, `round`, `posted`, `restored`, plus `observedAt`. Only a locally observed **diff** (`from`, `to`) can seed patch ownership. CI/check/PR presence proves no authorship.
- `EvidenceStore.folderOf(project): string`; `.read(project, 'seats'|'evidence'): Promise<{ lines; skipped }>`; `.projects(): Promise<string[]>`; `.flush(): Promise<void>`; `foldSeats(lines): SeatRecord[]`; `SeatBook.byId(id): SeatRecord | null`.
- `EvidencePlane.store`, `.seats`, its startup/close lifecycle and notification `{ method: 'evidence/changed', params: { room: string, evidence: BoardEvidence } }`. Re-read new evidence asynchronously; never modify its immutable lines.
- `SeatRecordView({ seat })` exported by `packages/ui/src/components/SeatRecordBlock.tsx`; render the exact historical Seat selected by ID, not `evidence/seat(runtime, sessionId)`, which returns a session's latest Seat.
- Existing `TeamState.intents`, a fact's `CardRef`, and the existing board pane can supply a card and its current `dependsOn` trail. Missing/deleted cards remain named unavailable. Do not invent historical versions of a mutable card, a Goal receipt, or findings that have not landed.

**Phase 3:** no separate ceilings plan existed in its supplied plans directory during this inspection. The Phase 4 seam already carries `StandingOrder` and `SeatCeiling | null`; consume them read-only. Phase 3 may change rendering within `SeatRecordView`; reuse it. There is no dependency on phase 3 enforcing a ceiling.

## Decisions and limits

1. **Project identity is Phase 4's canonical main-checkout identity.** The machine preference key is a SHA-256 of that canonical path; linked checkouts share one preference and journal. Repository move/reclone is a new capture registration. Keep old history; never merge identities by remote URL or author email.
2. **Capture is local and opt-out.** Absence of a preference means on. Invalid preference data is stopped with an explanation, never silently treated as on. The preference file is `provenance-preferences.json` under the host state directory; it is not committed, not Agent configuration, and not automatically activated from a backup.
3. **Observation is independent of attribution.** Journal every discovered ref transition and commit, including a person's and another tool's. Most historical/person commits can correctly be unattributed. An open Seat alone is not enough. A local host diff fact with an exact patch, matching project/checkout and a compatible Seat lifetime is required to seed ownership; restored records are historical, not new local claims.
4. **A Seat association is evidence of the observed patch, not a verified human identity.** Phase 4 can identify the Seat holding a card when its checkout was observed; it cannot prove which OS process authored each keystroke. The UI says “Associated Seat” in the explanation. Never claim Git's author field authenticates a Seat. If two Seats or another known source explain the same patch differently, leave it unattributed.
5. **Stable patch ID is a candidate index, not sole proof.** Pair `git patch-id --stable` with `--verbatim` to avoid attributing a whitespace-significant change because stable mode removes whitespace. Keep per-file fingerprints, parent/tree object IDs, capture times and matching fact IDs. No prose, author identity or raw patch text is persisted in provenance.
6. **Rewrites add links; they do not move evidence.** Old observations, original SHAs and the Seat's original session pointer survive. New SHA links name their source observation IDs and whether the match was exact, an amended surviving portion, or an aggregate squash range. Checks at the old SHA stay at the old SHA.
7. **A content-changing amend can be partial.** Whole-patch matches are complete. A same-ref, same-parent replacement with exactly surviving file patches retains those contributors and marks the remaining files unattributed. Changed hunks in the same file require a new matching host diff fact; no fuzzy hunk attribution. Replaced/deleted contributions are not credited. Message-only amend needs no new fact.
8. **Squash compares the net range, not a sum of patch IDs.** For bounded, observed first-parent source chains, compute the base-to-tip patch. Collect every distinct Seat for surviving contributions. Disjoint file contributions and repeated changes by one Seat are decidable. A range with multiple Seats touching the same file, a missing source, a reverted contribution, an ambiguous ancestor or several plausible decompositions is conservatively unattributed. It never credits every historical Seat merely because it appeared in the branch. This explicit boundary can be widened later with a separately proven line-survival algorithm; this phase does not invent one.
9. **Passive capture cannot literally guarantee every transient ref move.** Git may have no reflog for a ref, expire it, delete it, or garbage-collect a commit while the desk is closed. Two moves A→B→A with no journal leave the same bytes as no move. No watcher or startup scan can recover that information. Do not install hooks, change `core.logAllRefUpdates`, block ref writers, or pretend polling proves the impossible. Record every available reflog transition plus snapshot delta; retain known gaps, draw degraded health, and explain undecidable links. This is the narrow necessary qualification to “every ref move,” not a quiet best-effort claim.
10. **Supported metadata membership is explicit.** Ordinary `.git` directories and linked worktrees verified against an already admitted project's worktree registrations are supported. A `.git` text pointer is not permission to read an arbitrary path. External separate-git-dir layouts, external object alternates, symlinked metadata, unrecognized reftable storage and missing/promisor objects are refused or degraded as specified below; capture never follows a repository-supplied external link or fetches data.
11. **The observer reads Git objects, never checkout file paths.** A committed symlink, submodule entry or a path in a patch is data. No patch is applied to the checkout or a temp worktree. Git commands take validated full object IDs and literal pathspecs only. Ref names are display/lookup data, never shell text or filesystem paths.
12. **The history list keeps one accessible action model.** A commit option shows plain Seat labels/marks; Enter selects its detail. Detail has real Buttons that open the record Dialog and the session. Do not nest buttons inside listbox options or add links into the decorative graph SVG.
13. **Backup preserves facts, not enabled capture.** Export/import provenance observations as a versioned sidecar alongside Phase 4's evidence backup, with byte/count limits and a restored marker. Imported cursors, health and preferences never activate an observer or seed a local link. Existing Seat IDs resolve the imported history where available.
14. **No extra subsystem for traceability.** Include matching evidence IDs and `CardRef`s in attribution detail; reuse evidence/card navigation. Do not implement findings creation, line blame, a Goal, a second Agent history, a brief-content store, or cost allocation. A brief hash is historical identity, not recoverable user-level brief content.

## Proof needs and routing

| Task | Deliverable | Proof needs: | Suits |
| --- | --- | --- | --- |
| 1 | Types and original Seat association | neither | Codex |
| 2 | Confined Git reader and fingerprints | neither | Codex |
| 3 | Rewrite and squash reconciliation | neither | Codex |
| 4 | Durable journal, preferences and health | neither | Codex |
| 5 | Ref observer, startup catch-up and lifecycle | file-watch events | Sonnet |
| 6 | Host reads, validation and wire integration | neither | Codex |
| 7 | History attribution and historical Seat dialog | the rendered UI | Sonnet |
| 8 | Project health, sidebar, docs and acceptance | the rendered UI | Sonnet |

Because one writer builds the whole phase and Tasks 5, 7 and 8 need Sonnet's surface access, route the complete implementation to Sonnet if choosing only one seat. “Neither” still includes subprocess Git and file I/O tests; it means no listener, watch delivery or rendered browser is needed for that task's focused proof.

## File map

| File | Change and responsibility |
| --- | --- |
| `packages/protocol/src/provenance.ts`, `src/index.ts` | New public read types and export; no Goal import |
| `packages/server/src/provenance/model.ts` | Private fingerprint/source shapes and conservative matching primitives |
| `packages/server/src/provenance/git.ts` | Admitted repository handle; bounded Git reads and fingerprints |
| `packages/server/src/provenance/reconcile.ts` | Exact, amend and squash source graph; evidence joins |
| `packages/server/src/provenance/journal.ts` | Checksummed append-only observations and durable checkpoints |
| `packages/server/src/provenance/preferences.ts`, `health.ts` | Machine preference and one capture-health projection per project |
| `packages/server/src/provenance/observer.ts`, `plane.ts` | Watch/poll scheduling, catch-up, worker lifecycle, query projection |
| `packages/server/src/provenance/backup.ts` | Versioned historical export/import without restoring a live cursor |
| `packages/server/src/host.ts` | Plane lifetime and background registration; backup composition |
| `packages/protocol/src/wire.ts`, `wire-validators.ts` | Five requests and one notification, validated before dispatch |
| `packages/server/src/methods/provenance.ts`, `methods/context.ts`, `methods/index.ts` | Narrow context port and domain table |
| `packages/server/test/provenance-{model,git,reconcile,journal,observer,methods,backup}.test.ts` | New focused server tests |
| `packages/server/test/fixtures/provenance-repo.ts` | Synthetic Git history via commit-tree/update-ref, no real runtime |
| `packages/protocol/test/provenance-wire.test.ts` | Actual `parseClientMessage` boundary tests |
| `packages/ui/src/state/store.ts`, `snapshot.ts` | Batch reads, health snapshot, change revisions, preference actions |
| `packages/ui/src/lib/provenance.ts` | Plain display wording and state-tone projection |
| `packages/ui/src/components/CommitProvenance.tsx`, `ProvenanceDialog.tsx` | Labels, selected-commit attribution, exact Seat record and session |
| `packages/ui/src/components/GitPane.tsx` | Batch load and detail insertion; no CSS rewrite |
| `packages/ui/src/components/ProjectProvenance.tsx`, `ProjectPage.tsx` | Capture preference, health, reason, next action |
| `packages/ui/src/components/SessionTree.tsx` | Stopped capture label in existing GroupHead |
| `packages/ui/src/preview/provenance-fixture.ts`, `preview/harness.tsx`, `preview/main.tsx` | Every visible state and fake request method |
| `packages/ui/src/components/{CommitProvenance,ProjectProvenance}.test.tsx` | New UI tests |
| `packages/ui/src/state/store.provenance.test.ts` | Stale reply, reconnect and preference failure tests |
| `e2e/ui-system/provenance.spec.ts` | Keyboard, widths, themes, graph and focus checks |
| `script/check-reachable.mjs` | Pin then remove only this phase's unused verbs |
| `script/shots/seed.mjs`, `shoot.mjs`, `script/shots-isolation.test.mjs` | Synthetic provenance scene, cleanup and privacy checks |
| `docs/architecture.md`, `docs/decisions.md`, `docs/interface.md`, `docs/data-boundaries.md` | Observer, attribution rules, surfaces, machine-only data |

Existing tests edited, and why: `packages/server/test/backup.test.ts` gains the new backup key and round-trip assertion; `packages/ui/src/components/GitPane.test.tsx` adds the batch stub and list-selection regression; `ProjectPage.test.tsx` adds the new preference read stub and section assertion; `SessionTree.projects.test.tsx` adds the stopped folded-project case. `script/shots-isolation.test.mjs` adds provenance state to its residue assertion. Existing shared helpers retain their current entry points. `GitGraph.test.tsx` is run unchanged. No established expectation is deleted to fit the new feature.

### Task 1: Types and a defensible original association

A Seat is associated only through a local host-observed diff in the same canonical project and checkout, within the Seat's recorded lifetime. Discovery time and Git author time establish no ownership. Two valid Seats for one patch remain ambiguous. This task introduces the read vocabulary and the small, pure rules; Task 3 supplies the immutable observation graph around them.

**Files:**
- Create: `packages/protocol/src/provenance.ts`
- Create: `packages/server/src/provenance/model.ts`
- Create: `packages/server/src/provenance/reconcile.ts`
- Test: `packages/server/test/provenance-model.test.ts` (new)
- Modify: `packages/protocol/src/index.ts` (one export)

**Proof needs:** neither — Codex; no listener, watcher or renderer.

**Interfaces:** Consumes Phase 4's `SeatRecord`, `EvidenceRecord`, `SeatId`, `SessionPointer`, `CardRef` and `Sha`. Produces the complete public read types in Step 4. The host-only `Patch`, `Source`, `SeedSeat`, `SeedFact`, `FilePatch`, `Attribution` and `RefMove` are in `model.ts`, with `seed`, `reconcile`, `surviving` and `moves`. `sourceFromFacts(project, cwd, from, to, patch, seats, records): Source | null` retains the fixed adapter signature. It accepts only records already read through `EvidenceStore.read(project, 'evidence')`; the store's project boundary is not recreated from a record's optional checkout. There is no new Phase 4 field or Goal dependency.

- [ ] **Step 1: Confirm the Phase 4 prerequisite and barrel anchor.**

Run: `test -f packages/protocol/src/evidence.ts && rg -n "export \* from './evidence.js'" packages/protocol/src/index.ts`

Expected: exit 0 and one `export * from './evidence.js'` line. This task runs after Phase 4's types, not directly on the inspected Phase 2 base. The planning proof used the complete Phase 4 type file copied into scratch; it did not pretend those types had landed here.

- [ ] **Step 2: Write every association test before the implementation.**

Create `packages/server/test/provenance-model.test.ts` with these complete contents. The helper is local to this new test file; no existing test is changed.

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import { moves, reconcile, seed, surviving, type Patch } from '../src/provenance/model.js'
import { sourceFromFacts } from '../src/provenance/reconcile.js'

const patch: Patch = { stable: 'stable', exact: 'verbatim', files: ['one'] }
const input = {
  cwd: '/work/project', project: '/work/project', from: 'a', to: 'b',
  firstSeen: 15, patch,
}
const seat = {
  id: 'seat-a', cwd: input.cwd, project: input.project,
  openedAt: 10, closedAt: 20, restored: false,
}
const fact = {
  id: 'fact-a', seat: seat.id, cwd: input.cwd, project: input.project,
  from: input.from, to: input.to, observedAt: 16, restored: false,
}

export const recordedSeat = (id = 'seat-a'): SeatRecord => ({
  id,
  agent: null,
  briefDigest: null,
  seat: { runtime: 'fixture' },
  seatLabel: 'Fixture seat',
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: input.cwd, project: input.project, branch: 'topic', head: 'a' },
  session: { runtime: 'fixture', sessionId: `session-${id}` },
  board: null,
  role: null,
  openedAt: 10,
  closed: { at: 20, why: 'deleted' },
})

const record = (overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: 'fact-a',
  fact: { kind: 'diff', files: 1, added: 1, removed: 0, from: 'a', to: 'b' },
  seat: 'seat-a',
  checkout: { cwd: input.cwd, branch: 'topic' },
  observedAt: 16,
  ...overrides,
})

const fromRecords = (records: readonly EvidenceRecord[], seats = [recordedSeat()]) =>
  sourceFromFacts(input.project, input.cwd, 'a', 'b', patch, seats, records)

test('an open Seat alone cannot bind a patch', () => {
  assert.equal(seed(input, [{ ...seat, closedAt: null }], []), null)
  assert.equal(fromRecords([]), null)
})

test('both the fact and Seat must belong to the same admitted checkout and project', () => {
  assert.deepEqual(seed(input, [seat], [fact])?.seats, ['seat-a'])
  assert.equal(seed(input, [{ ...seat, cwd: '/work/other' }], [
    { ...fact, cwd: '/work/other' },
  ]), null, 'a different checkout must not seed this patch')
  assert.equal(seed(input, [{ ...seat, project: '/work/other' }], [
    { ...fact, project: '/work/other' },
  ]), null)
  assert.equal(seed(input, [], [fact]), null)
  assert.equal(seed(input, [seat], [{ ...fact, from: 'other' }]), null)
  assert.equal(seed(input, [seat], [{ ...fact, to: 'other' }]), null)
})

test('the binding observation is inside the Seat lifetime, including both endpoints', () => {
  for (const at of [10, 20]) {
    assert.ok(seed({ ...input, firstSeen: at }, [seat], [{ ...fact, observedAt: at }]))
  }
  for (const at of [9, 21]) {
    assert.equal(seed({ ...input, firstSeen: at }, [seat], [fact]), null)
    assert.equal(seed(input, [seat], [{ ...fact, observedAt: at }]), null)
  }
  assert.equal(seed(input, [{ ...seat, restored: true }], [fact]), null)
  assert.equal(seed(input, [seat], [{ ...fact, restored: true }]), null)
})

test('duplicate facts agree, while two valid Seats preserve ambiguity', () => {
  const one = fromRecords([record(), record({ id: 'fact-copy' })])
  assert.deepEqual(one?.seats, ['seat-a'])
  assert.equal(one?.ambiguous, false)
  const two = fromRecords([
    record(), record({ id: 'fact-b', seat: 'seat-b' }),
  ], [recordedSeat(), recordedSeat('seat-b')])
  assert.deepEqual(two?.seats, ['seat-a', 'seat-b'])
  assert.equal(two?.ambiguous, true)
  assert.deepEqual(reconcile(patch, two ? [two] : []), {
    state: 'unattributed', reason: 'ambiguous-patch',
  })
})

test('only local diff facts can bind a patch; other evidence remains byte-for-byte unchanged', () => {
  const others: EvidenceRecord['fact'][] = [
    { kind: 'check', name: 'unit', run: 'node --test', exit: 0, timedOut: false, at: 'a', dirty: false, tail: '' },
    { kind: 'ci', checks: [], at: 'a' },
    { kind: 'review', verdict: 'approve', by: 'seat-a', at: 'a' },
    { kind: 'pr', number: 1, head: 'a', state: 'open', url: null },
    { kind: 'finding', id: 'finding', state: 'open', at: 'a' },
    { kind: 'spend', usd: 1, turns: 1, exact: true },
  ]
  const records = others.map((other, n) => record({ id: `other-${n}`, fact: other }))
  const before = JSON.stringify(records)
  for (const other of records) assert.equal(fromRecords([other]), null)
  assert.equal(fromRecords([record({ restored: { at: 30 } })]), null)
  assert.equal(fromRecords([record({ checkout: null })]), null)
  assert.equal(fromRecords([record({ seat: null })]), null)
  assert.equal(JSON.stringify(records), before)
})

test('catch-up uses retained host observation time, not discovery time or author time', () => {
  assert.ok(fromRecords([record()]))
  assert.equal(fromRecords([record({ observedAt: 21 })]), null)
  assert.equal(fromRecords([record()], [{ ...recordedSeat(), restored: { at: 30 } }]), null)
})

test('stable patch equality alone never authorizes a whitespace-changing rewrite', () => {
  const source = { id: 'source-a', seats: ['seat-a'], patch }
  assert.deepEqual(reconcile({ ...patch, exact: 'different whitespace' }, [source]), {
    state: 'unattributed', reason: 'no-matching-patch',
  })
  assert.deepEqual(reconcile(patch, [source, { ...source, id: 'source-copy' }]), {
    state: 'attributed', seats: ['seat-a'], sources: ['source-a', 'source-copy'],
  })
  assert.deepEqual(reconcile(patch, [source, { ...source, id: 'unknown', seats: [] }]), {
    state: 'unattributed', reason: 'ambiguous-patch',
  })
  assert.deepEqual(reconcile({ ...patch, files: [] }, [source]), {
    state: 'unattributed', reason: 'empty-change',
  })
})

test('partial matching keeps exact file patches and names every unresolved target path', () => {
  const before = [{ path: 'one', stable: 's', exact: 'e' }]
  assert.deepEqual(surviving(before, [
    ...before, { path: 'two', stable: 't', exact: 't' },
  ]), { retained: ['one'], unresolved: ['two'] })
  assert.deepEqual(surviving(before, [{ ...before[0]!, exact: 'changed' }]), {
    retained: [], unresolved: ['one'],
  })
  assert.deepEqual(surviving(before, []), { retained: [], unresolved: [] })
})

test('snapshot movements include creation, deletion and rewind in a stable order', () => {
  assert.deepEqual(moves(new Map([['refs/heads/a', 'old'], ['refs/heads/b', 'gone']]),
    new Map([['refs/heads/a', 'older'], ['refs/tags/v1', 'tag']])), [
    { ref: 'refs/heads/a', before: 'old', after: 'older' },
    { ref: 'refs/heads/b', before: 'gone', after: null },
    { ref: 'refs/tags/v1', before: null, after: 'tag' },
  ])
})
```

- [ ] **Step 3: Run the tests to see the missing implementation.**

Run: `pnpm run build:node`

Expected: exit 2 with `error TS2307: Cannot find module '../src/provenance/model.js' or its corresponding type declarations.` and the same diagnostic for `../src/provenance/reconcile.js`. This is an import failure; Step 7 separately proves the behavioral assertions can fail.

- [ ] **Step 4: Add the public types and their one barrel export.**

Create `packages/protocol/src/provenance.ts` with these complete contents. No raw patch, subject, author identity or mutable Agent definition is carried on this read surface.

```ts
import type { CardRef, SeatId, SeatRecord, SessionPointer, Sha } from './evidence.js'

export type CaptureState = 'healthy' | 'degraded' | 'stopped'
export type ProvenanceReason =
  | 'not-observed' | 'capture-off' | 'capture-stopped' | 'catching-up'
  | 'no-seat-evidence' | 'ambiguous-patch' | 'empty-change'
  | 'changed-patch' | 'missing-object' | 'history-gap'
  | 'limit-exceeded' | 'unsupported-merge' | 'restored-history'

export interface CaptureHealth {
  readonly project: string
  readonly enabled: boolean
  readonly state: CaptureState
  readonly reason: string
  readonly nextStep: string
  readonly checkedAt: number | null
  readonly lastCapturedAt: number | null
  readonly pending: number
  readonly gaps: number
  readonly revision: number
}
export interface ProvenanceSeat {
  readonly id: SeatId
  readonly agentName: string | null
  readonly runtime: string
  readonly seatLabel: string
  readonly session: SessionPointer
}
export interface CommitProvenance {
  readonly sha: Sha
  readonly state: 'pending' | 'attributed' | 'unattributed'
  readonly coverage: 'complete' | 'partial' | 'none'
  readonly seats: readonly ProvenanceSeat[]
  readonly via: 'observed' | 'patch' | 'amend' | 'squash' | null
  readonly reason: ProvenanceReason | null
  readonly explanation: string
  readonly evidenceIds: readonly string[]
  readonly cards: readonly CardRef[]
  readonly observedAt: number | null
}
export interface ProjectProvenance {
  readonly project: string
  readonly revision: number
  readonly health: CaptureHealth
  readonly commits: readonly CommitProvenance[]
}
export interface ProvenanceSeatDetail {
  readonly seat: SeatRecord | null
  readonly session: SessionPointer | null
  readonly unavailable: string | null
}
```

In `packages/protocol/src/index.ts`, replace this exact Phase 4 anchor:

```ts
export * from './evidence.js'
```

with:

```ts
export * from './evidence.js'
export * from './provenance.js'
```

- [ ] **Step 5: Add the complete matching rules and Phase 4 adapter.**

Create `packages/server/src/provenance/model.ts`:

```ts
/** Host-only fingerprints. No raw patch, message or author identity is kept. */
export interface Patch {
  stable: string
  exact: string
  files: readonly string[]
}

export interface Source {
  id: string
  seats: readonly string[]
  patch: Patch
  ambiguous?: boolean
}

export type Attribution =
  | { state: 'attributed'; seats: string[]; sources: string[] }
  | { state: 'unattributed'; reason: string }

export interface SeedSeat {
  id: string
  cwd: string
  project: string
  openedAt: number
  closedAt: number | null
  restored: boolean
}

export interface SeedFact {
  id: string
  seat: string
  cwd: string
  project: string
  from: string
  to: string
  observedAt: number
  restored: boolean
}

export interface FilePatch {
  path: string
  stable: string
  exact: string
}

export interface RefMove {
  ref: string
  before: string | null
  after: string | null
}

/** Every plausible candidate must agree, including a known unknown source. */
export const reconcile = (target: Patch, sources: readonly Source[]): Attribution => {
  const matching = sources.filter((source) =>
    source.patch.stable === target.stable && source.patch.exact === target.exact,
  )
  if (!target.files.length) return { state: 'unattributed', reason: 'empty-change' }
  if (matching.some((source) => source.ambiguous || !source.seats.length)) {
    return { state: 'unattributed', reason: 'ambiguous-patch' }
  }
  const groups = new Map(matching.map((source) => {
    const seats = [...new Set(source.seats)].sort()
    return [JSON.stringify(seats), seats] as const
  }))
  if (groups.size !== 1) {
    return {
      state: 'unattributed',
      reason: groups.size ? 'ambiguous-patch' : 'no-matching-patch',
    }
  }
  return {
    state: 'attributed',
    seats: [...groups.values()][0]!,
    sources: [...new Set(matching.map((source) => source.id))].sort(),
  }
}

/** firstSeen is the binding diff's time; discovery time belongs to the journal. */
export const seed = (
  input: {
    cwd: string
    project: string
    from: string
    to: string
    firstSeen: number
    patch: Patch
  },
  seats: readonly SeedSeat[],
  facts: readonly SeedFact[],
): Source | null => {
  const valid = facts.filter((fact) =>
    !fact.restored &&
    fact.cwd === input.cwd &&
    fact.project === input.project &&
    fact.from === input.from &&
    fact.to === input.to &&
    seats.some((seat) =>
      !seat.restored &&
      seat.id === fact.seat &&
      seat.cwd === fact.cwd &&
      seat.project === fact.project &&
      seat.openedAt <= input.firstSeen &&
      seat.openedAt <= fact.observedAt &&
      (seat.closedAt === null || Math.max(input.firstSeen, fact.observedAt) <= seat.closedAt),
    ),
  )
  if (!valid.length) return null
  const ids = [...new Set(valid.map((fact) => fact.seat))].sort()
  return { id: input.to, seats: ids, patch: input.patch, ambiguous: ids.length !== 1 }
}

export const surviving = (
  old: readonly FilePatch[],
  next: readonly FilePatch[],
): { retained: string[]; unresolved: string[] } => {
  const retained = old.filter((before) => next.some((after) =>
    after.path === before.path && after.stable === before.stable && after.exact === before.exact,
  )).map((file) => file.path).sort()
  return {
    retained,
    unresolved: next.filter((file) => !retained.includes(file.path)).map((file) => file.path).sort(),
  }
}

export const moves = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): RefMove[] => [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((ref) =>
  before.get(ref) === after.get(ref)
    ? []
    : [{ ref, before: before.get(ref) ?? null, after: after.get(ref) ?? null }],
)
```

Create `packages/server/src/provenance/reconcile.ts`:

```ts
import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import { seed, type Patch, type Source } from './model.js'

/**
 * Records have already passed EvidenceStore.read(project, 'evidence'). Both
 * checkout paths must be canonical admitted identities, never a cwd fallback.
 * A range fact binds this range; it says nothing about intermediate commits.
 */
export const sourceFromFacts = (
  project: string,
  cwd: string,
  from: string,
  to: string,
  patch: Patch,
  seats: readonly SeatRecord[],
  records: readonly EvidenceRecord[],
): Source | null => {
  const shaped = seats.map((seat) => ({
    id: seat.id,
    cwd: seat.checkout.cwd,
    project: seat.checkout.project,
    openedAt: seat.openedAt,
    closedAt: seat.closed?.at ?? null,
    restored: !!seat.restored,
  }))
  const found = records.flatMap((record) => {
    if (record.fact.kind !== 'diff' || !record.seat || !record.checkout) return []
    const fact = {
      id: record.id,
      seat: record.seat,
      cwd: record.checkout.cwd,
      project,
      from: record.fact.from,
      to: record.fact.to,
      observedAt: record.observedAt,
      restored: !!record.restored,
    }
    const source = seed({
      project, cwd, from, to, firstSeen: fact.observedAt, patch,
    }, shaped, [fact])
    return source ? [source] : []
  })
  if (!found.length) return null
  const ids = [...new Set(found.flatMap((source) => source.seats))].sort()
  return { id: to, seats: ids, patch, ambiguous: ids.length !== 1 }
}
```

`firstSeen` is the time of the binding diff observation. The commit's discovery timestamp remains a separate immutable `CommitObservation.firstSeenAt` in Task 3. A fact whose `from` is a range base binds that range, never each intermediate commit. Canonical checkout identities are supplied by Task 2's admitted map; a missing checkout is unavailable, never the host process's cwd. Restored records and skipped invalid Phase 4 lines cannot seed a local source. The coordinator retains the store's skipped count as degraded health.

- [ ] **Step 6: Run the association tests green.**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/provenance-model.test.js`

Expected: exit 0; **9 tests, 9 pass, 0 fail**. All six non-diff evidence kinds are exercised, and the input evidence array remains byte-for-byte unchanged.

- [ ] **Step 7: Prove the checkout and verbatim guards, then restore them.**

In `model.ts`, temporarily replace this exact line:

```ts
    fact.cwd === input.cwd &&
```

with:

```ts
    true &&
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='both the fact and Seat' packages/server/dist/test/provenance-model.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, with `a different checkout must not seed this patch`. Both the fact and Seat intentionally agree with each other in the other checkout: their agreement is insufficient.

Restore the exact original line.

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='both the fact and Seat' packages/server/dist/test/provenance-model.test.js`

Expected: exit 0; **1 test, 1 pass, 0 fail**.

Temporarily replace this exact expression in `reconcile`:

```ts
    source.patch.stable === target.stable && source.patch.exact === target.exact,
```

with:

```ts
    source.patch.stable === target.stable && true,
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='stable patch equality' packages/server/dist/test/provenance-model.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:`; actual `state: 'attributed'`, expected `state: 'unattributed'` with `reason: 'no-matching-patch'`.

Restore the original expression.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/provenance-model.test.js`

Expected: exit 0; **9 tests, 9 pass, 0 fail**. These tests prove association boundaries, never author authentication.

- [ ] **Step 8: Controller commit after the phase gate.**

The plan writer does not commit. The controller runs the unpiped `pnpm verify` gate before committing; the execution override governs that timing. The trailer below names the Codex writer of this batch's code; if another writer implements it, the controller records that actual writer instead.

```bash
git add packages/protocol/src/provenance.ts packages/protocol/src/index.ts packages/server/src/provenance/model.ts packages/server/src/provenance/reconcile.ts packages/server/test/provenance-model.test.ts
git commit -m "feat: define commit provenance and Seat associations" --trailer "Co-Authored-By: Codex GPT-6 <agent@harnessdesk.app>"
```

### Task 2: A confined Git reader and immutable fingerprints

The reader never starts Git against project configuration. Admission checks metadata before creating a generated bare view in the host state directory. Object reads use only that view, the admitted object directory, validated full object IDs and literal pathspecs. File paths from a tree remain data; neither the reader nor the fixture needs to open checkout files.

**Files:**
- Create: `packages/server/src/provenance/git.ts`
- Create: `packages/server/test/fixtures/provenance-repo.ts`
- Test: `packages/server/test/provenance-git.test.ts` (new)

**Proof needs:** neither — Codex; these are subprocess and filesystem tests, without listeners or watch delivery.

**Interfaces:** The exact fixed `RepoHandle`, `RefSnapshot`, `CommitObject`, `ReflogMove`, `LogCursor`, `ReflogPage`, `GitReader`, `admitProject(root, stateDir, known)` and `gitReader(handle)` declarations are included in the complete file in Step 4. `Patch` and `FilePatch` remain Task 1's host-only shapes. `known` contains explicit host registrations, never a path learned from a ref. An unrelated unavailable/non-Git registration cannot invalidate this project's admission. `runChild` is an internal testable process boundary; no wire method exposes it.

- [ ] **Step 1: Add a synthetic Git fixture with a private index and object store.**

Create `packages/server/test/fixtures/provenance-repo.ts` with these complete contents. `tempDir` is the unchanged existing helper in `test/scratch.ts`. The fixture creates its own `main`, index, object store, state directory and optional linked worktree; it never changes the developer checkout. All fixture identities are synthetic.

```ts
import { spawn } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { tempDir } from '../scratch.js'

export interface Repo {
  readonly dir: string
  readonly stateDir: string
  git(...args: string[]): Promise<string>
  input(args: readonly string[], bytes: string | Buffer): Promise<string>
  commitTree(parent: string | null, files: Readonly<Record<string, string | Buffer | null>>, message: string): Promise<string>
}

/** Plumbing writes only this fixture's index and object store, never checkout files. */
export const makeRepo = async (format: 'sha1' | 'sha256' = 'sha1'): Promise<Repo> => {
  const home = await realpath(tempDir('hd-provenance-'))
  const dir = join(home, 'repo')
  const stateDir = join(home, 'state')
  await mkdir(dir)
  await mkdir(stateDir)
  const input = (args: readonly string[], bytes: string | Buffer = ''): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', dir, ...args], {
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Jane Doe',
          GIT_AUTHOR_EMAIL: 'dev@example.com',
          GIT_COMMITTER_NAME: 'Jane Doe',
          GIT_COMMITTER_EMAIL: 'dev@example.com',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (bytes: Buffer) => out.push(bytes))
      child.stderr.on('data', (bytes: Buffer) => err.push(bytes))
      child.on('error', reject)
      child.stdin.on('error', () => {})
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(Buffer.concat(err).toString('utf8')))
        else resolve(Buffer.concat(out).toString('utf8').trim())
      })
      child.stdin.end(bytes)
    })
  const git = (...args: string[]) => input(args)
  await git('init', '-q', '-b', 'main', `--object-format=${format}`)
  const commitTree: Repo['commitTree'] = async (parent, files, message) => {
    await git('read-tree', ...(parent ? [parent] : ['--empty']))
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) {
        await git('update-index', '--force-remove', '--', path)
      } else {
        const blob = await input(['hash-object', '-w', '--stdin'], contents)
        await git('update-index', '--add', '--cacheinfo', '100644', blob, path)
      }
    }
    const tree = await git('write-tree')
    return git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message)
  }
  return { dir, stateDir, git, input, commitTree }
}
```

- [ ] **Step 2: Write the complete trust-boundary and object-reading tests.**

Create `packages/server/test/provenance-git.test.ts`. The capability skip is limited to Git explicitly refusing SHA-256 support; any other initialization failure fails the test. An option-like filename is a literal tree entry after `--`, and malformed UTF-8 is refused before it could alias a different filename.

```ts
import assert from 'node:assert/strict'
import { access, appendFile, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  admitProject, gitReader, oid, runChild, type GitReader,
} from '../src/provenance/git.js'
import { makeRepo, type Repo } from './fixtures/provenance-repo.js'

const signal = () => new AbortController().signal
const readerFor = async (repo: Repo): Promise<GitReader> =>
  gitReader(await admitProject(repo.dir, repo.stateDir, [repo.dir]))
const absent = async (path: string) => assert.rejects(access(path), { code: 'ENOENT' })

test('only full object IDs reach object-reading commands', () => {
  for (const value of ['HEAD~1', '--output=/work/escape', 'a'.repeat(41), 'A'.repeat(40)]) {
    assert.throws(() => oid(value), /Expected a full object id/)
  }
  assert.equal(oid('a'.repeat(40)), 'a'.repeat(40))
  assert.equal(oid('b'.repeat(64)), 'b'.repeat(64))
})

test('root, message amend and whitespace fingerprints use real immutable objects', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const first = await repo.commitTree(base, { one: 'base\nseat one\n' }, 'first')
  const amended = await repo.git('commit-tree', `${first}^{tree}`, '-p', base, '-m', '$(touch escaped)')
  const whitespace = await repo.commitTree(base, { one: 'base\nseat  one\n' }, 'whitespace')
  const empty = await repo.commitTree(first, {}, 'empty')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  const patch = await reader.patch(base, first, signal())
  assert.deepEqual(await reader.patch(base, amended, signal()), patch)
  const spaced = await reader.patch(base, whitespace, signal())
  assert.equal(spaced.stable, patch.stable)
  assert.notEqual(spaced.exact, patch.exact)
  assert.deepEqual((await reader.patch(null, base, signal())).files, ['one'])
  assert.deepEqual(await reader.patch(first, empty, signal()), { stable: '', exact: '', files: [] })
  assert.deepEqual((await reader.commit(first, signal()))?.parents, [base])
  assert.equal(await reader.commit('f'.repeat(40), signal()), null)
  await absent(join(repo.dir, 'escaped'))
})

test('binary, mode, Unicode, newline, option-like, symlink and gitlink paths stay object data', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.commitTree(base, {
    '--output=elsewhere': 'literal\n', 'line\nbreak': 'newline\n', '雪': 'unicode\n',
    binary: Buffer.from([0, 255, 1]),
  }, 'populate index')
  const blob = await repo.input(['hash-object', '-w', '--stdin'], '/work/outside')
  await repo.git('update-index', '--add', '--cacheinfo', '120000', blob, 'link')
  await repo.git('update-index', '--add', '--cacheinfo', '160000', base, 'module')
  await repo.git('update-index', '--cacheinfo', '100755', await repo.git('rev-parse', `${base}:one`), 'one')
  const target = await repo.git('commit-tree', await repo.git('write-tree'), '-p', base, '-m', 'special entries')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  const files = await reader.files(base, target, signal())
  assert.deepEqual(files.map((file) => file.path), [
    '--output=elsewhere', 'binary', 'line\nbreak', 'link', 'module', 'one', '雪',
  ])
  assert.ok(files.every((file) => file.stable && file.exact))
  await absent(join(repo.dir, 'elsewhere'))
  await absent(join(repo.dir, 'link'))
})

test('invalid UTF-8 tree names are refused instead of being aliased', async (t) => {
  const repo = await makeRepo()
  const blob = await repo.input(['hash-object', '-w', '--stdin'], 'bytes')
  const tree = await repo.input(['mktree', '-z'], Buffer.concat([
    Buffer.from(`100644 blob ${blob}\t`), Buffer.from([255, 0]),
  ]))
  const commit = await repo.git('commit-tree', tree, '-m', 'invalid path bytes')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  await assert.rejects(reader.files(null, commit, signal()), /unsupported-path/)
})

test('private configuration ignores source commands, include files and replacement refs', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const target = await repo.commitTree(base, { one: 'changed\n', '.gitattributes': '* diff=evil\n' }, 'change')
  const marker = join(repo.stateDir, 'executed')
  const helper = join(repo.stateDir, 'helper.sh')
  await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 })
  await repo.git('config', 'diff.external', helper)
  await repo.git('config', 'diff.evil.textconv', helper)
  await repo.git('config', 'include.path', join(repo.stateDir, 'absent-config'))
  await repo.git('replace', target, base)
  await appendFile(join(repo.dir, '.git/config'), '\n[core]\nrepositoryformatversion = 999\n')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  assert.deepEqual((await reader.patch(base, target, signal())).files, ['.gitattributes', 'one'])
  await reader.files(base, target, signal())
  await absent(marker)
})

test('symlinked metadata, alternates, external gitdirs and unsupported storage are refused', async () => {
  const linked = await makeRepo()
  await symlink(linked.stateDir, join(linked.dir, '.git/objects/outside'))
  await assert.rejects(admitProject(linked.dir, linked.stateDir, [linked.dir]), /Linked metadata/)
  const alternate = await makeRepo()
  await writeFile(join(alternate.dir, '.git/objects/info/alternates'), alternate.stateDir)
  await assert.rejects(admitProject(alternate.dir, alternate.stateDir, [alternate.dir]), /external-objects/)
  const external = await makeRepo()
  await rename(join(external.dir, '.git'), join(external.stateDir, 'metadata'))
  await writeFile(join(external.dir, '.git'), `gitdir: ${join(external.stateDir, 'metadata')}\n`)
  await assert.rejects(admitProject(external.dir, external.stateDir, [external.dir]), /Open its main checkout/)
  const storage = await makeRepo()
  await appendFile(join(storage.dir, '.git/config'), '\n[extensions]\nrefStorage = reftable\n')
  await assert.rejects(admitProject(storage.dir, storage.stateDir, [storage.dir]), /unsupported-ref-storage/)
  const format = await makeRepo()
  await appendFile(join(format.dir, '.git/config'), '\n[extensions]\nobjectFormat = other\n')
  await assert.rejects(admitProject(format.dir, format.stateDir, [format.dir]), /unsupported-object-format/)
})

test('linked worktrees require an explicit root and the common-directory backlink', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const linked = join(dirname(repo.dir), 'linked')
  await repo.git('worktree', 'add', '-q', '--detach', linked, base)
  await assert.rejects(admitProject(linked, repo.stateDir, [linked]), /Open its main checkout/)
  const handle = await admitProject(linked, repo.stateDir, [repo.dir, linked])
  assert.equal(handle.project, repo.dir)
  assert.equal(handle.checkouts.size, 2)
  const reader = gitReader(handle)
  t.after(() => reader.close())
  assert.equal((await reader.snapshot(signal())).heads.get(linked), base)
  const gitdir = handle.checkouts.get(linked)!
  await writeFile(join(gitdir, 'gitdir'), join(repo.stateDir, 'not-a-checkout'))
  await assert.rejects(reader.snapshot(signal()), /metadata-changed/)
})

test('loose and packed refs preserve raw tags and peel HEAD without trusting names as paths', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  await repo.git('tag', '-a', 'v1', base, '-m', 'tag')
  const tag = await repo.git('rev-parse', 'refs/tags/v1')
  await repo.git('pack-refs', '--all')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  const snapshot = await reader.snapshot(signal())
  assert.equal(snapshot.refs.get('refs/tags/v1'), tag)
  assert.equal(snapshot.heads.get(repo.dir), base)
  await mkdir(join(repo.dir, '.git/refs/heads'), { recursive: true })
  await writeFile(join(repo.dir, '.git/refs/heads/cycle-a'), 'ref: refs/heads/cycle-b\n')
  await writeFile(join(repo.dir, '.git/refs/heads/cycle-b'), 'ref: refs/heads/cycle-a\n')
  await assert.rejects(reader.snapshot(signal()), /symbolic-ref-cycle/)
})

test('reflog cursors recover A to B to A and detect replacement and incomplete tails', async (t) => {
  const repo = await makeRepo()
  const a = await repo.commitTree(null, { one: 'a\n' }, 'a')
  const b = await repo.commitTree(a, { one: 'b\n' }, 'b')
  await repo.git('update-ref', '--create-reflog', 'refs/heads/topic', a)
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  const first = await reader.reflogs(new Map(), signal())
  await repo.git('update-ref', 'refs/heads/topic', b)
  await repo.git('update-ref', 'refs/heads/topic', a)
  const second = await reader.reflogs(first.cursors, signal())
  assert.deepEqual(second.moves.map((move) => [move.before, move.after]), [[a, b], [b, a]])
  assert.equal(new Set(second.moves.map((move) => move.id)).size, 2)
  assert.deepEqual((await reader.reflogs(second.cursors, signal())).moves, [])
  const log = join(repo.dir, '.git/logs/refs/heads/topic')
  const bytes = await readFile(log)
  await appendFile(log, 'incomplete')
  const partial = await reader.reflogs(second.cursors, signal())
  assert.equal(partial.cursors.get('common:refs/heads/topic')?.offset, bytes.length)
  assert.ok(partial.gaps.includes('incomplete-reflog'))
  await writeFile(`${log}.new`, bytes)
  await rename(`${log}.new`, log)
  const replaced = await reader.reflogs(partial.cursors, signal())
  assert.ok(replaced.gaps.includes('reflog-replaced'))
  await rm(log)
  assert.ok((await reader.reflogs(replaced.cursors, signal())).gaps.includes('reflog-missing'))
})

test('metadata replacement after admission refuses before reading another object', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  await rename(join(repo.dir, '.git/objects'), join(repo.stateDir, 'moved-objects'))
  await symlink(join(repo.stateDir, 'moved-objects'), join(repo.dir, '.git/objects'))
  await assert.rejects(reader.commit(base, signal()), /Linked metadata/)
})

test('bounded children wait for exit on timeout, cancellation and overflow; stderr is never exposed', async () => {
  const controller = new AbortController()
  const running = runChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(running, /capture-aborted/)
  await assert.rejects(runChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: signal(), timeoutMs: 30,
  }), /git-timeout/)
  await assert.rejects(runChild(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
    signal: signal(), stdoutLimit: 64,
  }), /limit-exceeded/)
  await assert.rejects(runChild(process.execPath, ['-e', 'process.stderr.write("private"); process.exit(1)'], {
    signal: signal(),
  }), (error: unknown) => error instanceof Error && error.message === 'git-failed')
  let active = 0
  let maximum = 0
  await Promise.all([1, 2, 3, 4].map(() => runChild(process.execPath, ['-e', 'setTimeout(() => {}, 30)'], {
    signal: signal(),
    started: () => { active += 1; maximum = Math.max(maximum, active) },
    stopped: () => { active -= 1 },
  })))
  assert.equal(maximum, 2)
  assert.equal(active, 0)
})

test('ancestors are bounded, stop at known objects and close removes only the private view', async () => {
  const repo = await makeRepo()
  const a = await repo.commitTree(null, { one: 'a\n' }, 'a')
  const b = await repo.commitTree(a, { one: 'b\n' }, 'b')
  const c = await repo.commitTree(b, { one: 'c\n' }, 'c')
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const reader = gitReader(handle)
  assert.deepEqual(await reader.ancestors([c], new Set([a]), 2, signal()), [b, c])
  assert.equal((await reader.ancestors([c], new Set(), 1, signal())).length, 1)
  await reader.close()
  await absent(handle.viewDir)
  await access(join(repo.dir, '.git/objects'))
  await assert.rejects(reader.commit(c, signal()), /capture-aborted/)
})

test('SHA-256 repositories use their own object width and private-view format', async (t) => {
  let repo: Repo
  try {
    repo = await makeRepo('sha256')
  } catch (error) {
    if (error instanceof Error && /unknown hash algorithm|unknown option.*object-format/.test(error.message)) {
      t.skip('installed Git does not support SHA-256 repositories')
      return
    }
    throw error
  }
  const a = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const b = await repo.commitTree(a, { one: 'changed\n' }, 'changed')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  assert.equal(a.length, 64)
  assert.deepEqual((await reader.patch(a, b, signal())).files, ['one'])
})


test('unrelated registered folders do not prevent admitting this project', async () => {
  const repo = await makeRepo()
  const other = await makeRepo()
  await rename(join(other.dir, '.git'), join(other.stateDir, 'separate'))
  await writeFile(join(other.dir, '.git'), `gitdir: ${join(other.stateDir, 'separate')}\n`)
  const handle = await admitProject(repo.dir, repo.stateDir, [
    repo.dir, other.dir, other.stateDir, join(other.stateDir, 'missing'),
  ])
  assert.equal(handle.project, repo.dir)
  assert.equal(handle.checkouts.size, 1)
  await gitReader(handle).close()
})
```

- [ ] **Step 3: Run the tests before the reader exists.**

Run: `pnpm run build:node`

Expected: exit 2; `error TS2307: Cannot find module '../src/provenance/git.js' or its corresponding type declarations.` Secondary implicit-`any` errors at assertions depending on that import disappear with the implementation.

- [ ] **Step 4: Add the complete admitted reader.**

Create `packages/server/src/provenance/git.ts` with these complete contents. The private view is generated, never copied from project configuration. Metadata enumeration derives filesystem paths only from trusted roots and directory entries; symbolic ref names are map keys. The initial metadata walk yields every 200 entries; subsequent checks revisit directory identities and enumerate changed directories. A Git process waits for a global slot and a reader's serialized job before it starts, and cancellation waits for `close` before releasing the slot.

```ts
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { devNull } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import type { FilePatch, Patch } from './model.js'

export interface RepoHandle {
  readonly project: string
  readonly commonDir: string
  readonly objectDir: string
  readonly viewDir: string
  readonly checkouts: ReadonlyMap<string, string>
  readonly objectFormat: 'sha1' | 'sha256'
}

export interface RefSnapshot {
  readonly refs: ReadonlyMap<string, string>
  readonly heads: ReadonlyMap<string, string | null>
  readonly takenAt: number
}

export interface CommitObject {
  readonly sha: string
  readonly tree: string
  readonly parents: readonly string[]
}

export interface ReflogMove {
  readonly id: string
  readonly ref: string
  readonly checkout: string | null
  readonly before: string | null
  readonly after: string | null
  readonly recordedAt: number | null
}

export interface LogCursor {
  readonly fileId: string
  readonly offset: number
  readonly tailHash: string
}

export interface ReflogPage {
  readonly moves: readonly ReflogMove[]
  readonly cursors: ReadonlyMap<string, LogCursor>
  readonly gaps: readonly string[]
  readonly more: boolean
}

export interface GitReader {
  snapshot(signal: AbortSignal): Promise<RefSnapshot>
  reflogs(cursors: ReadonlyMap<string, LogCursor>, signal: AbortSignal): Promise<ReflogPage>
  commit(sha: string, signal: AbortSignal): Promise<CommitObject | null>
  patch(from: string | null, to: string, signal: AbortSignal): Promise<Patch>
  files(from: string | null, to: string, signal: AbortSignal): Promise<readonly FilePatch[]>
  ancestors(tips: readonly string[], known: ReadonlySet<string>, limit: number, signal: AbortSignal): Promise<readonly string[]>
  close(): Promise<void>
}

const OUTPUT_LIMIT = 8 * 1024 * 1024
const LOG_LIMIT = 2 * 1024 * 1024
const REF_LIMIT = 50_000
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
function fail(reason: string): never {
  throw new Error(reason)
}
const aborted = (signal: AbortSignal): void => {
  if (signal.aborted) fail('capture-aborted')
}
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT'
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !part.startsWith(sep))
}

export const oid = (value: string): string => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail('Expected a full object id.')
  return value
}

/** A name is a map key. No name read here is passed to join or to a shell. */
const refName = (value: string): boolean =>
  value.startsWith('refs/') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
  !value.includes('..') && !value.includes('@{') &&
  value.split('/').every((part) => !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))

const utf8 = (bytes: Buffer): string => {
  const value = bytes.toString('utf8')
  if (!Buffer.from(value, 'utf8').equals(bytes)) fail('unsupported-path')
  return value
}

/** Two children across all readers; waiting cancellation never starts a child. */
let activeChildren = 0
const childWaiters = new Set<() => void>()
const childSlot = async (signal: AbortSignal): Promise<() => void> => {
  while (activeChildren >= 2) {
    aborted(signal)
    await new Promise<void>((resolve) => {
      const wake = () => {
        childWaiters.delete(wake)
        signal.removeEventListener('abort', wake)
        resolve()
      }
      childWaiters.add(wake)
      signal.addEventListener('abort', wake, { once: true })
      if (signal.aborted) wake()
    })
  }
  aborted(signal)
  activeChildren += 1
  return () => {
    activeChildren -= 1
    for (const wake of [...childWaiters]) wake()
  }
}

/** Internal process boundary, exposed to these tests; never a wire operation. */
export const runChild = async (
  executable: string,
  args: readonly string[],
  options: {
    signal: AbortSignal
    env?: NodeJS.ProcessEnv
    input?: Buffer
    timeoutMs?: number
    stdoutLimit?: number
    started?: () => void
    stopped?: () => void
  },
): Promise<Buffer> => {
  const release = await childSlot(options.signal)
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        env: options.env ?? { PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      options.started?.()
      let reason: string | null = null
      let bytes = 0
      let stderrBytes = 0
      const chunks: Buffer[] = []
      const stop = (why: string) => {
        reason ??= why
        child.kill('SIGKILL')
      }
      const abort = () => stop('capture-aborted')
      const timer = setTimeout(() => stop('git-timeout'), options.timeoutMs ?? 5000)
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) abort()
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > (options.stdoutLimit ?? OUTPUT_LIMIT)) stop('limit-exceeded')
        else chunks.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        // Drain everything, retain no repository text, account for at most 4 KiB.
        stderrBytes = Math.min(4096, stderrBytes + chunk.length)
      })
      child.stdin.on('error', () => {})
      child.on('error', () => { reason ??= 'git-unavailable' })
      child.on('close', (code) => {
        clearTimeout(timer)
        options.signal.removeEventListener('abort', abort)
        options.stopped?.()
        if (reason || code !== 0) reject(new Error(reason ?? 'git-failed'))
        else resolve(Buffer.concat(chunks))
      })
      child.stdin.end(options.input)
    })
  } finally {
    release()
  }
}

/** Refuse metadata links before opening bytes. The descriptor is checked too. */
const fileBytes = async (path: string, limit = OUTPUT_LIMIT): Promise<Buffer | null> => {
  const info = await lstat(path).catch((error: unknown) => {
    if (missing(error)) return null
    throw error
  })
  if (!info) return null
  if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
  if (!info.isFile()) fail('Special metadata is not captured.')
  if (info.size > limit) fail('limit-exceeded')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) fail('metadata-changed')
    const bytes = Buffer.alloc(limit + 1)
    let used = 0
    while (used < bytes.length) {
      const read = await file.read(bytes, used, bytes.length - used, used)
      if (!read.bytesRead) break
      used += read.bytesRead
    }
    if (used > limit) fail('limit-exceeded')
    return bytes.subarray(0, used)
  } finally {
    await file.close()
  }
}

/**
 * Initial admission checks every entry, yielding every 200. Later batches
 * recheck directory identities and enumerate only directories that changed.
 */
class MetadataWalk {
  readonly directories = new Map<string, { stamp: string; children: readonly string[] }>()
  private steps = 0

  async check(path: string, signal: AbortSignal): Promise<void> {
    aborted(signal)
    const info = await lstat(path)
    if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
    if (!info.isFile() && !info.isDirectory()) fail('Special metadata is not captured.')
    if (++this.steps % 200 === 0) await setImmediate()
    if (!info.isDirectory()) return
    const stamp = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`
    const cached = this.directories.get(path)
    if (cached?.stamp === stamp) {
      for (const child of cached.children) await this.check(child, signal)
      return
    }
    const children: string[] = []
    for (const name of await readdir(path)) {
      const child = join(path, name)
      const entry = await lstat(child).catch((error: unknown) => {
        if (missing(error)) return null
        throw error
      })
      if (!entry) continue
      if (entry.isSymbolicLink()) fail('Linked metadata is not captured.')
      if (!entry.isFile() && !entry.isDirectory()) fail('Special metadata is not captured.')
      if (++this.steps % 200 === 0) await setImmediate()
      if (entry.isDirectory()) {
        children.push(child)
        await this.check(child, signal)
      }
    }
    this.directories.set(path, { stamp, children })
  }
}

interface Admission {
  readonly walk: MetadataWalk
  readonly stamps: ReadonlyMap<string, string>
  readonly pointers: ReadonlyMap<string, string>
}
const admissions = new WeakMap<RepoHandle, Admission>()
const identity = async (path: string): Promise<string> => {
  const info = await lstat(path)
  if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
  return `${info.dev}:${info.ino}`
}

/** Read storage declarations as data; never ask Git to expand project config. */
const storage = async (commonDir: string): Promise<'sha1' | 'sha256'> => {
  const config = utf8((await fileBytes(join(commonDir, 'config'))) ?? Buffer.alloc(0))
  let section = ''
  let format = 'sha1'
  for (const line of config.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)
    if (header) {
      section = header[1]!.toLowerCase()
      continue
    }
    if (section !== 'extensions') continue
    const value = /^\s*([a-z]+)\s*=\s*([^#;]*?)\s*(?:[#;].*)?$/i.exec(line)
    if (!value) continue
    const key = value[1]!.toLowerCase()
    const text = value[2]!.replace(/^"(.*)"$/, '$1').toLowerCase()
    if (key === 'objectformat') format = text
    if (key === 'refstorage' && text !== 'files') fail('unsupported-ref-storage')
  }
  if (format !== 'sha1' && format !== 'sha256') fail('unsupported-object-format')
  for (const name of ['alternates', 'http-alternates']) {
    if (await fileBytes(join(commonDir, 'objects/info', name)) !== null) fail('external-objects')
  }
  return format
}

export const admitProject = async (
  root: string,
  stateDir: string,
  known: readonly string[],
): Promise<RepoHandle> => {
  const opened = await realpath(root)
  const roots = [...new Set((await Promise.all(known.map((path) =>
    realpath(path).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    }),
  ))).filter((path): path is string => path !== null))]
  if (!roots.includes(opened)) fail('unregistered-project')
  const mains = new Map<string, string>()
  const markers = new Set<string>()
  for (const path of roots) {
    const marker = join(path, '.git')
    const info = await lstat(marker).catch((error: unknown) => {
      if (missing(error) && path !== opened) return null
      throw error
    })
    if (!info) continue
    if (info.isSymbolicLink()) {
      if (path === opened) fail('Linked metadata is not captured.')
      continue
    }
    if (info.isDirectory()) mains.set(path, marker)
    else if (info.isFile()) markers.add(path)
    else if (path === opened) fail('Special metadata is not captured.')
  }
  let project = opened
  let commonDir = mains.get(opened)
  const pointers = new Map<string, string>()
  const linked = async (path: string): Promise<{ common: string; gitdir: string } | null> => {
    const marker = join(path, '.git')
    const text = utf8((await fileBytes(marker, 4096)) ?? fail('missing-metadata'))
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(text)
    if (!match) return null
    const gitdir = resolve(path, match[1]!)
    // Lexical admission precedes reading any repository-supplied pointer target.
    const common = (commonDir ? [commonDir] : [...mains.values()]).find((candidate) =>
      dirname(gitdir) === join(candidate, 'worktrees'),
    )
    if (!common) return null
    if (await realpath(gitdir) !== gitdir) fail('Linked metadata is not captured.')
    const backPath = join(gitdir, 'gitdir')
    const back = utf8((await fileBytes(backPath, 4096)) ?? fail('metadata-changed'))
    if (resolve(gitdir, back.trim()) !== marker) fail('metadata-changed')
    const commonPath = join(gitdir, 'commondir')
    const commonText = utf8((await fileBytes(commonPath, 4096)) ?? fail('metadata-changed'))
    if (resolve(gitdir, commonText.trim()) !== common) fail('metadata-changed')
    pointers.set(marker, text)
    pointers.set(backPath, back)
    pointers.set(commonPath, commonText)
    return { common, gitdir }
  }
  if (!commonDir) {
    const link = await linked(opened)
    if (!link) fail('Open its main checkout to capture this project.')
    commonDir = link.common
    project = [...mains].find(([, common]) => common === commonDir)![0]
  }
  if (!inside(project, commonDir)) fail('external-metadata')
  const checkouts = new Map<string, string>([[project, commonDir]])
  for (const path of markers) {
    const link = await linked(path)
    if (link?.common === commonDir) checkouts.set(path, link.gitdir)
  }
  const walk = new MetadataWalk()
  await walk.check(commonDir, new AbortController().signal)
  const objectFormat = await storage(commonDir)
  const objectDir = join(commonDir, 'objects')
  const stamps = new Map<string, string>()
  for (const path of [commonDir, objectDir, ...checkouts.values()]) stamps.set(path, await identity(path))
  await mkdir(stateDir, { recursive: true })
  const viewDir = await mkdtemp(join(await realpath(stateDir), 'provenance-view-'))
  try {
    await mkdir(join(viewDir, 'refs'))
    await mkdir(join(viewDir, 'objects'))
    await writeFile(join(viewDir, 'HEAD'), 'ref: refs/heads/capture\n', { mode: 0o600 })
    await writeFile(join(viewDir, 'config'), objectFormat === 'sha256'
      ? '[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectFormat = sha256\n'
      : '[core]\nrepositoryformatversion = 0\nbare = true\n', { mode: 0o600 })
    const handle: RepoHandle = { project, commonDir, objectDir, viewDir, checkouts, objectFormat }
    admissions.set(handle, { walk, stamps, pointers })
    return handle
  } catch (error) {
    await rm(viewDir, { recursive: true, force: true })
    throw error
  }
}

export const gitReader = (handle: RepoHandle): GitReader => {
  const admission = admissions.get(handle) ?? fail('unadmitted-project')
  const lifetime = new AbortController()
  let queue: Promise<unknown> = Promise.resolve()
  const width = handle.objectFormat === 'sha1' ? 40 : 64
  const objectId = (value: string) => {
    oid(value)
    if (value.length !== width) fail('wrong-object-format')
    return value
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
    GIT_OBJECT_DIRECTORY: handle.objectDir,
  }
  const run = (args: readonly string[], signal: AbortSignal, input?: Buffer) => runChild('git', [
    '--no-pager', '--no-replace-objects', '--literal-pathspecs', '-C', handle.viewDir,
    '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false',
    '-c', 'diff.external=', '-c', 'core.quotePath=true', ...args,
  ], { signal, input, env })
  const validate = async (signal: AbortSignal) => {
    aborted(signal)
    for (const [path, stamp] of admission.stamps) {
      if (await identity(path) !== stamp) fail('metadata-changed')
    }
    await admission.walk.check(handle.commonDir, signal)
    if (await storage(handle.commonDir) !== handle.objectFormat) fail('metadata-changed')
    for (const [path, text] of admission.pointers) {
      if ((await fileBytes(path, 4096))?.toString('utf8') !== text) fail('metadata-changed')
    }
  }
  const job = <T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const combined = AbortSignal.any([signal, lifetime.signal])
    const next = queue.then(async () => {
      aborted(combined)
      await validate(combined)
      return action(combined)
    })
    queue = next.catch(() => {})
    return next
  }
  const kind = async (sha: string, signal: AbortSignal): Promise<string | null> => {
    const answer = utf8(await run(['cat-file', '--batch-check=%(objecttype)'], signal,
      Buffer.from(`${objectId(sha)}\n`))).trim()
    return answer.endsWith(' missing') ? null : answer
  }
  const commit = async (sha: string, signal: AbortSignal): Promise<CommitObject | null> => {
    if (await kind(sha, signal) !== 'commit') return null
    const bytes = await run(['cat-file', 'commit', objectId(sha)], signal)
    const end = bytes.indexOf('\n\n')
    if (end < 0) fail('invalid-commit')
    const headers = utf8(bytes.subarray(0, end)).split('\n')
    const tree = headers.find((line) => line.startsWith('tree '))?.slice(5)
    if (!tree) fail('invalid-commit')
    return {
      sha,
      tree: objectId(tree),
      parents: headers.filter((line) => line.startsWith('parent ')).map((line) => objectId(line.slice(7))),
    }
  }
  const peel = async (sha: string, signal: AbortSignal): Promise<string | null> => {
    for (let depth = 0; depth < 8; depth += 1) {
      const type = await kind(sha, signal)
      if (type === 'commit') return sha
      if (type !== 'tag') return null
      const tag = utf8(await run(['cat-file', 'tag', objectId(sha)], signal))
      const target = /^object ([a-f0-9]+)\n/.exec(tag)?.[1]
      if (!target) fail('invalid-tag')
      sha = objectId(target)
    }
    return fail('tag-depth-exceeded')
  }
  const entries = async (root: string): Promise<readonly { path: string; name: string }[]> => {
    const found: { path: string; name: string }[] = []
    let visited = 0
    const visit = async (path: string, prefix: string) => {
      const names = await readdir(path).catch((error: unknown) => {
        if (missing(error)) return []
        throw error
      })
      for (const name of names.sort()) {
        if (name.endsWith('.lock')) continue
        if (++visited > REF_LIMIT) fail('limit-exceeded')
        const full = join(path, name)
        const info = await lstat(full)
        if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
        if (info.isDirectory()) await visit(full, `${prefix}${name}/`)
        else if (info.isFile()) found.push({ path: full, name: `${prefix}${name}` })
        else fail('Special metadata is not captured.')
        if (found.length > REF_LIMIT) fail('limit-exceeded')
      }
    }
    await visit(root, '')
    return found
  }
  const snapshot = async (signal: AbortSignal): Promise<RefSnapshot> => {
    const values = new Map<string, string>()
    const packed = await fileBytes(join(handle.commonDir, 'packed-refs'))
    for (const line of packed?.toString('utf8').split('\n') ?? []) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const split = line.indexOf(' ')
      const name = line.slice(split + 1)
      if (split < 0 || !refName(name)) fail('invalid-ref')
      values.set(name, objectId(line.slice(0, split)))
    }
    for (const entry of await entries(join(handle.commonDir, 'refs'))) {
      const name = `refs/${entry.name}`
      if (!refName(name)) fail('invalid-ref')
      const bytes = await fileBytes(entry.path, 4096)
      if (bytes) values.set(name, utf8(bytes).trim())
    }
    if (values.size > REF_LIMIT) fail('limit-exceeded')
    const resolveRef = (value: string): string | null => {
      const seen = new Set<string>()
      for (let depth = 0; depth < 8; depth += 1) {
        if (!value.startsWith('ref: ')) return objectId(value)
        const name = value.slice(5)
        if (!refName(name)) fail('invalid-ref')
        if (seen.has(name)) fail('symbolic-ref-cycle')
        seen.add(name)
        const next = values.get(name)
        if (!next) return null
        value = next
      }
      return fail('symbolic-ref-depth-exceeded')
    }
    const refs = new Map<string, string>()
    for (const [name, value] of values) {
      const sha = resolveRef(value)
      if (sha) refs.set(name, sha)
    }
    const heads = new Map<string, string | null>()
    for (const [cwd, gitdir] of handle.checkouts) {
      const head = await fileBytes(join(gitdir, 'HEAD'), 4096)
      const sha = head ? resolveRef(utf8(head).trim()) : null
      heads.set(cwd, sha ? await peel(sha, signal) : null)
    }
    return { refs, heads, takenAt: Date.now() }
  }
  const deltaArgs = (from: string | null, to: string, names: boolean, path?: string): string[] => [
    'diff-tree', '--no-commit-id', '-r', '--no-renames',
    ...(names ? ['--name-only', '-z'] : [
      '-p', '--binary', '--no-ext-diff', '--no-textconv', '--full-index',
      '--src-prefix=a/', '--dst-prefix=b/',
    ]),
    ...(from === null ? ['--root', objectId(to)] : [objectId(from), objectId(to)]),
    '--', ...(path === undefined ? [] : [path]),
  ]
  const fingerprint = async (from: string | null, to: string, signal: AbortSignal, path?: string): Promise<Patch> => {
    const target = await commit(to, signal)
    if (!target || (from !== null && !await commit(from, signal))) fail('missing-object')
    if (from === null && target.parents.length > 1) fail('unsupported-merge')
    const bytes = await run(deltaArgs(from, to, false, path), signal)
    const names = utf8(await run(deltaArgs(from, to, true, path), signal))
      .split('\0').filter(Boolean).sort()
    if (!names.length) return { stable: '', exact: '', files: [] }
    const stable = utf8(await run(['patch-id', '--stable'], signal, bytes)).trim().split(' ')[0]!
    const exact = utf8(await run(['patch-id', '--verbatim'], signal, bytes)).trim().split(' ')[0]!
    oid(stable)
    oid(exact)
    return { stable, exact, files: names }
  }
  const reflogs = async (previous: ReadonlyMap<string, LogCursor>, signal: AbortSignal): Promise<ReflogPage> => {
    const logs: { key: string; path: string; ref: string; checkout: string | null }[] = []
    for (const entry of await entries(join(handle.commonDir, 'logs/refs'))) {
      const ref = `refs/${entry.name}`
      if (!refName(ref)) fail('invalid-ref')
      logs.push({ key: `common:${ref}`, path: entry.path, ref, checkout: null })
    }
    for (const [checkout, gitdir] of handle.checkouts) {
      const path = join(gitdir, 'logs/HEAD')
      if (await lstat(path).catch((error: unknown) => missing(error) ? null : Promise.reject(error))) {
        logs.push({ key: `head:${checkout}`, path, ref: 'HEAD', checkout })
      }
    }
    const cursors = new Map(previous)
    const moves: ReflogMove[] = []
    const gaps = new Set<string>()
    for (const key of previous.keys()) {
      if (!logs.some((log) => log.key === key)) {
        gaps.add('reflog-missing')
        cursors.delete(key)
      }
    }
    let budget = LOG_LIMIT
    let more = false
    for (const log of logs.sort((a, b) => a.key.localeCompare(b.key))) {
      aborted(signal)
      if (budget <= 0) {
        more = true
        break
      }
      const info = await lstat(log.path)
      if (info.isSymbolicLink()) fail('Linked metadata is not captured.')
      if (!info.isFile()) fail('Special metadata is not captured.')
      const file = await open(log.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await file.stat()
        if (opened.dev !== info.dev || opened.ino !== info.ino) fail('metadata-changed')
        const fileId = `${info.dev}:${info.ino}:${info.birthtimeMs}`
        let offset = previous.get(log.key)?.offset ?? 0
        const prior = previous.get(log.key)
        const tail = async (at: number) => {
          const bytes = Buffer.alloc(Math.min(256, at))
          const read = await file.read(bytes, 0, bytes.length, at - bytes.length)
          return hash(bytes.subarray(0, read.bytesRead))
        }
        if (prior && (prior.fileId !== fileId || offset > info.size || prior.tailHash !== await tail(offset))) {
          gaps.add('reflog-replaced')
          offset = 0
        }
        const bytes = Buffer.alloc(Math.min(budget, Math.max(0, info.size - offset)))
        const read = await file.read(bytes, 0, bytes.length, offset)
        const page = bytes.subarray(0, read.bytesRead)
        const end = page.lastIndexOf(10) + 1
        if (end < page.length && offset + page.length === info.size) gaps.add('incomplete-reflog')
        let start = 0
        while (start < end) {
          const stop = page.indexOf(10, start)
          const line = page.subarray(start, stop)
          if (line.length > 64 * 1024) fail('limit-exceeded')
          const before = line.subarray(0, width).toString('ascii')
          const after = line.subarray(width + 1, 2 * width + 1).toString('ascii')
          if (line[width] !== 32 || line[2 * width + 1] !== 32) fail('invalid-reflog')
          objectId(before)
          objectId(after)
          const time = / (\d+) [+-]\d{4}\t/.exec(line.subarray(2 * width + 2).toString('utf8'))
          moves.push({
            id: hash(JSON.stringify([log.key, fileId, offset + start, hash(line)])),
            ref: log.ref,
            checkout: log.checkout,
            before: /^0+$/.test(before) ? null : before,
            after: /^0+$/.test(after) ? null : after,
            recordedAt: time ? Number(time[1]) * 1000 : null,
          })
          start = stop + 1
        }
        if (!end && page.length === budget && info.size - offset > page.length) fail('limit-exceeded')
        offset += end
        budget -= page.length
        cursors.set(log.key, { fileId, offset, tailHash: await tail(offset) })
        if (offset < info.size && end === page.length) more = true
        if (end < page.length && info.size > offset + page.length - end) more = true
      } finally {
        await file.close()
      }
    }
    return { moves, cursors, gaps: [...gaps].sort(), more }
  }
  return {
    snapshot: (signal) => job(signal, snapshot),
    reflogs: (cursors, signal) => job(signal, (signal) => reflogs(cursors, signal)),
    commit: (sha, signal) => job(signal, (signal) => commit(objectId(sha), signal)),
    patch: (from, to, signal) => job(signal, (signal) => fingerprint(from, to, signal)),
    files: (from, to, signal) => job(signal, async (signal) => {
      const patch = await fingerprint(from, to, signal)
      const files: FilePatch[] = []
      for (const path of patch.files) {
        const file = await fingerprint(from, to, signal, path)
        files.push({ path, stable: file.stable, exact: file.exact })
      }
      return files
    }),
    ancestors: (tips, known, limit, signal) => job(signal, async (signal) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('limit-exceeded')
      const input = [...tips.map(objectId), ...[...known].map((sha) => `^${objectId(sha)}`)]
      const bytes = await run(['rev-list', '--topo-order', '--reverse', `--max-count=${limit}`, '--stdin'], signal,
        Buffer.from(`${input.join('\n')}\n`))
      return utf8(bytes).trim().split('\n').filter(Boolean).map(objectId)
    }),
    close: async () => {
      lifetime.abort()
      await queue
      await rm(handle.viewDir, { recursive: true, force: true })
    },
  }
}
```

Storage errors are internal fixed codes. `unsupported-path`, output/metadata limits, missing objects and unavailable log intervals become degraded capture with a bounded explanation through Tasks 4–5; external metadata, an unsupported storage backend and an unadmitted root refuse capture. Do not send a raw filesystem exception, Git stderr, config line, path, ref identity or command to the renderer. `commit` returning null is an explicit unavailable object result, never an empty successful patch.

`patch(null, rootSha)` uses `diff-tree --root`. An explicit `from`/`to` pair computes the net delta, including for a merge only when Task 3 has independent matching evidence; no first-parent merge attribution is inferred here. `ancestors` returns only the requested bounded page. Task 5 must retain parent/frontier work beyond that page, and a `ReflogPage.more` page must be drained before capture is current. An incomplete trailing reflog line does not advance its cursor or cause a tight immediate retry loop.

- [ ] **Step 5: Run the reader tests green.**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/provenance-git.test.js`

Expected: exit 0; **14 tests, 14 pass, 0 fail** on Git with SHA-256 support. With the explicitly recognized missing capability: **14 tests, 13 pass, 1 skipped, 0 fail**, and the skip says `installed Git does not support SHA-256 repositories`. The planning machine supported it: no test was skipped. The process-limit test observes a maximum of **2** concurrent children and **0** remaining after completion; timeout, abort and overflow each reject only after child exit.

- [ ] **Step 6: Prove admission, private configuration and the output cap.**

In `MetadataWalk.check`, temporarily replace this exact entry guard:

```ts
      if (entry.isSymbolicLink()) fail('Linked metadata is not captured.')
```

with:

```ts
      if (entry.isSymbolicLink()) continue
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='symlinked metadata' packages/server/dist/test/provenance-git.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: Missing expected rejection.` Restore the guard before the next mutation.

In the `run` argument vector, replace this exact line:

```ts
    '--no-pager', '--no-replace-objects', '--literal-pathspecs', '-C', handle.viewDir,
```

with:

```ts
    '--no-pager', '--no-replace-objects', '--literal-pathspecs', '-C', handle.project,
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='private configuration' packages/server/dist/test/provenance-git.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `Error: git-failed`, because the source repository's deliberately invalid configuration reaches Git. Restore `handle.viewDir`.

In `runChild`, replace this exact line:

```ts
        if (bytes > (options.stdoutLimit ?? OUTPUT_LIMIT)) stop('limit-exceeded')
```

with:

```ts
        if (false && bytes > (options.stdoutLimit ?? OUTPUT_LIMIT)) stop('limit-exceeded')
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='bounded children' packages/server/dist/test/provenance-git.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: Missing expected rejection.` Restore the cap.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/provenance-git.test.js`

Expected: exit 0; **14 tests, 14 pass, 0 fail** on the planning machine. The malicious-config test still finds no marker file. Admission does not claim to sandbox a separate malicious process with the same OS account racing metadata replacements.

- [ ] **Step 7: Controller commit after the phase gate.**

The plan writer does not run this step. The controller uses the actual implementation writer's trailer and the header's unpiped verification gate.

```bash
git add packages/server/src/provenance/git.ts packages/server/test/fixtures/provenance-repo.ts packages/server/test/provenance-git.test.ts
git commit -m "feat: read provenance from confined Git objects" --trailer "Co-Authored-By: Codex GPT-6 <agent@harnessdesk.app>"
```

### Task 3: Reconcile amend, rebase and squash without guessing

The journal keeps original observations and links. Reconciliation appends a decision for the new SHA, naming its original observation/range IDs and matching evidence IDs; it never moves a check, CI result, review or Seat session pointer. A newer contradiction withdraws an older unique link. A retry with the same last decision produces no duplicate; a return to an earlier decision after a withdrawal is a new transition.

**Files:**
- Modify: `packages/server/src/provenance/reconcile.ts` (replace the complete Task 1 file below)
- Test: `packages/server/test/provenance-reconcile.test.ts` (new)
- Consume unchanged: Task 1's `model.ts` and Task 2's reader and repository fixture

**Proof needs:** neither — Codex; real temporary Git histories and pure journal projections, no listener or watch delivery.

**Interfaces:** Keeps the fixed `CommitObservation`, `RangeObservation`, `LinkObservation`, `ReconcileInput` and `reconcileProject(input, git, signal): Promise<readonly LinkObservation[]>` shapes. All declarations are in the complete replacement below. `sourceFromFacts` retains its Task 1 signature. `factSource` adds host-only proof context while remaining assignable to `Source`; unscoped matching `Source` values count as ambiguity rather than disappearing from the candidate set. `captureRange(from, parts, links, git, signal, at): Promise<RangeObservation>` captures an immutable contiguous range before objects can disappear. `rangeSource(range, links, restored = false): ProvenanceSource` rebuilds its in-memory source after replay. `rangeCandidates(commits, captured)` returns at most 256 ready candidates, each with its durable work key, and the pending keys; the maximum source chain is 64. `relatedEvidence(link, seats, records)` projects recorded Seat names/session pointers, the exact proof evidence IDs, deduplicated `CardRef`s and missing Seat IDs. No public protocol shape changes here.

- [ ] **Step 1: Write every rewrite, refusal and durability test.**

Create `packages/server/test/provenance-reconcile.test.ts` with these complete contents. Each fixture's commits are created with Git plumbing. The missing-object case removes only a fixture's original loose object after recording the range; it reopens the actual production reader and proves the old commit is unavailable. No synthetic return value stands in for that disappearance.

```ts
import assert from 'node:assert/strict'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import { admitProject, gitReader, type ReflogMove } from '../src/provenance/git.js'
import type { Source } from '../src/provenance/model.js'
import {
  captureRange, factSource, rangeCandidates, rangeSource, reconcileProject, relatedEvidence,
  type CommitObservation, type LinkObservation,
} from '../src/provenance/reconcile.js'
import { makeRepo, type Repo } from './fixtures/provenance-repo.js'

const signal = () => new AbortController().signal
const seat = (repo: Repo, id: string): SeatRecord => ({
  id,
  agent: null,
  briefDigest: null,
  seat: { runtime: 'fixture' },
  seatLabel: `Recorded ${id}`,
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: repo.dir, project: repo.dir, branch: 'topic', head: null },
  session: { runtime: 'fixture', sessionId: `original-session-${id}` },
  board: null,
  role: null,
  openedAt: 1,
  closed: null,
})
const diff = (repo: Repo, from: string, to: string, id = 'fact-a', owner = 'seat-a'): EvidenceRecord => ({
  id,
  seat: owner,
  checkout: { cwd: repo.dir, branch: 'topic' },
  observedAt: 10,
  card: { board: 'board', id: 1 },
  fact: { kind: 'diff', files: 1, added: 1, removed: 0, from, to },
})
const move = (before: string, after: string): ReflogMove => ({
  id: `move-${before}-${after}`,
  ref: 'refs/heads/topic',
  checkout: null,
  before,
  after,
  recordedAt: null,
})
const setup = async (t: TestContext) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const first = await repo.commitTree(base, { one: 'base\nseat a\n' }, 'first')
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const git = gitReader(handle)
  t.after(() => git.close())
  let time = 20
  const observe = async (sha: string): Promise<CommitObservation> => {
    const object = await git.commit(sha, signal())
    assert.ok(object)
    const from = object.parents[0] ?? null
    return {
      id: `commit-${sha}`, sha, tree: object.tree, parents: object.parents,
      firstSeenAt: time++, fingerprintVersion: 1,
      discoveredBy: [], checkoutHints: [repo.dir], window: { from: null, to: 30 },
      patch: await git.patch(from, sha, signal()),
      files: await git.files(from, sha, signal()), why: null,
    }
  }
  const a = await observe(first)
  const seats = [seat(repo, 'seat-a'), seat(repo, 'seat-b')]
  const records = [diff(repo, base, first)]
  const source = factSource(repo.dir, repo.dir, base, first, a.patch!, seats, records)
  assert.ok(source)
  const reconcile = (commits: readonly CommitObservation[], sources: readonly Source[],
    moves: readonly ReflogMove[] = [], priorLinks: readonly LinkObservation[] = []) =>
    reconcileProject({ commits, sources, moves, priorLinks, now: 50 }, git, signal())
  return { repo, git, base, first, a, observe, source, seats, records, reconcile }
}

test('message amend and rebase retain the original Seat and evidence without refreshing checks', async (t) => {
  const f = await setup(t)
  const amended = await f.repo.git('commit-tree', f.a.tree, '-p', f.base, '-m', 'message only')
  const b = await f.observe(amended)
  const upstream = await f.repo.commitTree(f.base, { upstream: 'unrelated\n' }, 'upstream')
  const rebased = await f.repo.commitTree(upstream, { one: 'base\nseat a\n' }, 'rebased')
  const c = await f.observe(rebased)
  const check: EvidenceRecord = {
    id: 'old-check', observedAt: 11, seat: 'seat-a',
    fact: { kind: 'ci', at: f.first, checks: [] },
  }
  const evidence = [...f.records, check]
  const before = JSON.stringify(evidence)
  const links = await f.reconcile([f.a, b, c], [f.source], [move(f.first, amended), move(amended, rebased)])
  assert.deepEqual(links.map((link) => link.seats), [['seat-a'], ['seat-a'], ['seat-a']])
  assert.equal(links[0]?.via, 'observed')
  assert.equal(links[1]?.via, 'patch')
  assert.equal(links[2]?.coverage, 'complete')
  assert.ok(links[2]?.sourceIds.includes(f.a.id))
  const detail = relatedEvidence(links[2]!, f.seats, evidence)
  assert.deepEqual(detail.seats[0]?.session, { runtime: 'fixture', sessionId: 'original-session-seat-a' })
  assert.deepEqual(detail.evidenceIds, ['fact-a'])
  assert.deepEqual(detail.cards, [{ board: 'board', id: 1 }])
  assert.equal(JSON.stringify(evidence), before)
})

test('a content amend retains only exact files and a later local fact completes it', async (t) => {
  const f = await setup(t)
  const sha = await f.repo.commitTree(f.base, { one: 'base\nseat a\n', two: 'unknown\n' }, 'content amend')
  const amended = await f.observe(sha)
  const movements = [move(f.first, sha)]
  const initial = await f.reconcile([f.a, amended], [f.source], movements)
  const partial = initial.find((link) => link.sha === sha)!
  assert.equal(partial.coverage, 'partial', 'the unresolved file must keep coverage partial')
  assert.equal(partial.reason, 'changed-patch')
  assert.deepEqual(partial.retainedPaths, ['one'])
  assert.deepEqual(partial.seats, ['seat-a'])
  const record = diff(f.repo, f.base, sha, 'fact-amend')
  const source = factSource(f.repo.dir, f.repo.dir, f.base, sha, amended.patch!, f.seats, [record])!
  const final = await f.reconcile([f.a, amended], [f.source, source], movements, initial)
  const complete = final.find((link) => link.sha === sha)!
  assert.equal(complete.coverage, 'complete')
  assert.notEqual(complete.id, partial.id)
  assert.equal(partial.coverage, 'partial')
})

test('same file with changed whitespace and an unrelated equal patch do not become rewrites', async (t) => {
  const f = await setup(t)
  const whitespace = await f.repo.commitTree(f.base, { one: 'base\nseat  a\n' }, 'whitespace')
  const changed = await f.observe(whitespace)
  const independent = await f.repo.git('commit-tree', f.a.tree, '-p', f.base, '-m', 'independent branch')
  const same = await f.observe(independent)
  const result = await f.reconcile([f.a, changed, same], [f.source], [move(f.first, whitespace)])
  assert.equal(result.find((link) => link.sha === whitespace)?.reason, 'changed-patch')
  assert.equal(result.find((link) => link.sha === independent)?.reason, 'ambiguous-patch')
})

test('new competing and known source-less candidates withdraw a previous unique link', async (t) => {
  const f = await setup(t)
  const rewritten = await f.repo.git('commit-tree', f.a.tree, '-p', f.base, '-m', 'rewrite')
  const target = await f.observe(rewritten)
  const movements = [move(f.first, rewritten)]
  const original = await f.reconcile([f.a, target], [f.source], movements)
  const other = factSource(f.repo.dir, f.repo.dir, f.base, f.first, f.a.patch!, f.seats,
    [diff(f.repo, f.base, f.first, 'fact-b', 'seat-b')])!
  const result = await f.reconcile([f.a, target], [f.source, other], movements, original)
  assert.equal(result.find((link) => link.sha === rewritten)?.reason, 'ambiguous-patch')
  assert.equal(original.find((link) => link.sha === rewritten)?.coverage, 'complete')
  const unscoped: Source = { id: 'unknown-origin', seats: ['seat-b'], patch: f.a.patch! }
  const unscopedResult = await f.reconcile([f.a, target], [f.source, unscoped], movements)
  assert.equal(unscopedResult.find((link) => link.sha === rewritten)?.reason, 'ambiguous-patch')
  const unknownSha = await f.repo.git('commit-tree', f.a.tree, '-p', f.base, '-m', 'unknown source')
  const unknown = await f.observe(unknownSha)
  const unknownResult = await f.reconcile([f.a, target, unknown], [f.source], movements)
  assert.equal(unknownResult.find((link) => link.sha === rewritten)?.reason, 'ambiguous-patch')
})

test('a persisted disjoint squash range survives deleted branches and missing source objects', async (t) => {
  const f = await setup(t)
  const second = await f.repo.commitTree(f.first, { two: 'seat b\n' }, 'second')
  const b = await f.observe(second)
  const sourceB = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'fact-b', 'seat-b')])!
  const original = await f.reconcile([f.a, b], [f.source, sourceB])
  const range = await captureRange(f.base, [f.a, b], original, f.git, signal(), 40)
  assert.equal(range.ambiguous, false)
  assert.deepEqual(range.seats, ['seat-a', 'seat-b'])
  const squash = await f.repo.git('commit-tree', b.tree, '-p', f.base, '-m', 'squash')
  const s = await f.observe(squash)
  const saved = JSON.parse(JSON.stringify(range)) as typeof range
  const source = rangeSource(saved, original)
  await f.repo.git('update-ref', 'refs/heads/topic', second)
  await f.repo.git('update-ref', '-d', 'refs/heads/topic')
  await f.git.close()
  await rename(join(f.repo.dir, '.git/objects', f.first.slice(0, 2), f.first.slice(2)),
    join(f.repo.stateDir, 'old-object'))
  const reopened = gitReader(await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir]))
  t.after(() => reopened.close())
  assert.equal(await reopened.commit(f.first, signal()), null)
  const result = await reconcileProject({
    commits: [f.a, b, s], sources: [f.source, sourceB, source], priorLinks: original,
    moves: [move(second, squash)], now: 60,
  }, reopened, signal())
  const link = result.find((value) => value.sha === squash)!
  assert.deepEqual(link.seats, ['seat-a', 'seat-b'])
  assert.equal(link.via, 'squash')
  assert.deepEqual(link.evidenceIds, ['fact-a', 'fact-b'])
  assert.equal(relatedEvidence(link, f.seats, f.records).seats[0]?.session.sessionId, 'original-session-seat-a')
  await assert.rejects(captureRange(f.base, [f.a, b], original, reopened, signal(), 70), /missing-object/)
})

test('overlapping owners, reverted files, incomplete chains and missing sources refuse ranges', async (t) => {
  const f = await setup(t)
  const second = await f.repo.commitTree(f.first, { one: 'base\nseat a\nseat b\n' }, 'overlap')
  const b = await f.observe(second)
  const sourceB = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'fact-b', 'seat-b')])!
  const links = await f.reconcile([f.a, b], [f.source, sourceB])
  const overlap = await captureRange(f.base, [f.a, b], links, f.git, signal(), 40)
  assert.equal(overlap.ambiguous, true, 'two Seats touching one file cannot seed a squash')
  const reverted = await f.repo.commitTree(f.first, { one: 'base\n', two: 'seat b\n' }, 'revert one')
  const c = await f.observe(reverted)
  const sourceC = factSource(f.repo.dir, f.repo.dir, f.first, reverted, c.patch!, f.seats,
    [diff(f.repo, f.first, reverted, 'fact-c', 'seat-b')])!
  const revertLinks = await f.reconcile([f.a, c], [f.source, sourceC])
  assert.equal((await captureRange(f.base, [f.a, c], revertLinks, f.git, signal(), 40)).ambiguous, true)
  await assert.rejects(captureRange(f.base, [b, f.a], links, f.git, signal(), 40), /history-gap/)
  assert.equal((await captureRange(f.base, [f.a, b], [], f.git, signal(), 40)).ambiguous, true)
  await assert.rejects(captureRange(f.base, Array.from({ length: 65 }, () => f.a), links, f.git, signal(), 40), /limit-exceeded/)
})

test('one Seat can make repeated surviving changes to the same file', async (t) => {
  const f = await setup(t)
  const second = await f.repo.commitTree(f.first, { one: 'base\nseat a\nmore from a\n' }, 'more')
  const b = await f.observe(second)
  const sourceB = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'fact-b')])!
  const links = await f.reconcile([f.a, b], [f.source, sourceB])
  const range = await captureRange(f.base, [f.a, b], links, f.git, signal(), 40)
  assert.equal(range.ambiguous, false)
  assert.deepEqual(range.seats, ['seat-a'])
})

test('empty, missing, restored and unsupported merge observations keep specific reasons', async (t) => {
  const f = await setup(t)
  const emptySha = await f.repo.commitTree(f.first, {}, 'empty')
  const empty = await f.observe(emptySha)
  const other = await f.repo.commitTree(f.base, { other: 'other\n' }, 'other')
  const merged = await f.repo.git('commit-tree', f.a.tree, '-p', f.first, '-p', other, '-m', 'merge')
  const merge = await f.observe(merged)
  const missing = { ...f.a, id: 'missing', sha: 'f'.repeat(40), patch: null, why: 'missing-object' }
  const imported = { ...f.source, proof: { ...f.source.proof, restored: true } }
  const result = await f.reconcile([f.a, empty, merge, missing], [imported])
  assert.equal(result.find((link) => link.sha === f.first)?.reason, 'restored-history')
  assert.equal(result.find((link) => link.sha === emptySha)?.reason, 'empty-change')
  assert.equal(result.find((link) => link.sha === merged)?.reason, 'unsupported-merge')
  assert.equal(result.find((link) => link.sha === missing.sha)?.reason, 'missing-object')
})

test('deterministic link IDs deduplicate retries and retain missing historical Seats as unavailable', async (t) => {
  const f = await setup(t)
  const first = await f.reconcile([f.a], [f.source])
  assert.deepEqual(await f.reconcile([f.a], [f.source], [], first), [])
  const withdrawn: LinkObservation = {
    ...first[0]!, id: 'withdrawn', coverage: 'none', seats: [],
    reason: 'history-gap', via: null, at: 55,
  }
  const again = await f.reconcile([f.a], [f.source], [], [...first, withdrawn])
  assert.equal(again.length, 1)
  assert.equal(again[0]?.coverage, 'complete')
  assert.notEqual(again[0]?.id, first[0]?.id)
  const detail = relatedEvidence(first[0]!, [], f.records)
  assert.deepEqual(detail.missingSeats, ['seat-a'])
  assert.deepEqual(detail.cards, [{ board: 'board', id: 1 }])
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(reconcileProject({ commits: [f.a], sources: [f.source], moves: [], priorLinks: [], now: 50 },
    f.git, aborted.signal), /capture-aborted/)
})


test('amending a multi-Seat squash removes the Seat whose entire file contribution disappeared', async (t) => {
  const f = await setup(t)
  const second = await f.repo.commitTree(f.first, { two: 'seat b\n' }, 'second')
  const b = await f.observe(second)
  const sourceB = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'fact-b', 'seat-b')])!
  const originals = await f.reconcile([f.a, b], [f.source, sourceB])
  const range = await captureRange(f.base, [f.a, b], originals, f.git, signal(), 40)
  const rangeProof = rangeSource(range, originals)
  const squash = await f.repo.git('commit-tree', b.tree, '-p', f.base, '-m', 'squash')
  const s = await f.observe(squash)
  const amended = await f.repo.commitTree(f.base, { one: 'base\nseat a\n', other: 'unknown\n' }, 'amend squash')
  const c = await f.observe(amended)
  const result = await f.reconcile([f.a, b, s, c], [f.source, sourceB, rangeProof], [
    move(second, squash), move(squash, amended),
  ], originals)
  const retained = result.find((link) => link.sha === amended)!
  assert.deepEqual(retained.seats, ['seat-a'])
  assert.deepEqual(retained.evidenceIds, ['fact-a'])
  assert.equal(retained.coverage, 'partial')
  const rival = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'rival', 'seat-a')])!
  const withdrawn = await f.reconcile([f.a, b, s], [f.source, sourceB, rangeProof, rival],
    [move(second, squash)], originals)
  assert.equal(withdrawn.find((link) => link.sha === squash)?.reason, 'ambiguous-patch')
})

test('range discovery offers at most 256 contiguous ranges and retains the remainder', () => {
  const commits: CommitObservation[] = Array.from({ length: 30 }, (_, n) => ({
    id: `commit-${n}`, sha: `sha-${n}`, tree: `tree-${n}`,
    parents: [n === 0 ? 'base' : `sha-${n - 1}`], firstSeenAt: n,
    fingerprintVersion: 1, discoveredBy: [], checkoutHints: [],
    window: { from: null, to: n }, patch: null, files: [], why: null,
  }))
  const candidates = rangeCandidates(commits, new Set())
  assert.equal(candidates.ready.length, 256)
  assert.equal(candidates.pending.length, 179)
  const next = rangeCandidates(commits, new Set(candidates.ready.map((range) => range.key)))
  assert.equal(next.ready.length, 179)
  assert.deepEqual(next.pending, [])
  assert.ok(candidates.ready.every((range) => range.commits.length >= 2 && range.commits.length <= 64))
  const limited = rangeCandidates(Array.from({ length: 65 }, (_, n) => ({
    ...commits[0]!, id: `long-${n}`, sha: `long-${n}`,
    parents: [n === 0 ? 'base' : `long-${n - 1}`],
  })), new Set())
  assert.ok(limited.pending.includes('limit:long-64'))
})
```

- [ ] **Step 2: Run the tests against Task 1's adapter to see the missing exports.**

Run: `pnpm run build:node`

Expected: exit 2; `error TS2305: Module '"../src/provenance/reconcile.js"' has no exported member 'captureRange'.` The same diagnostic names `factSource`, `rangeCandidates`, `rangeSource`, `reconcileProject`, `relatedEvidence`, `CommitObservation` and `LinkObservation`. The file exists after Task 1; this red is a missing implementation API, not a missing module.

- [ ] **Step 3: Replace the complete Task 1 adapter with the complete reconciler.**

The exact existing file anchor, from Task 1, is:

```ts
import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import { seed, type Patch, type Source } from './model.js'

/**
 * Records have already passed EvidenceStore.read(project, 'evidence'). Both
 * checkout paths must be canonical admitted identities, never a cwd fallback.
 * A range fact binds this range; it says nothing about intermediate commits.
 */
export const sourceFromFacts = (
  project: string,
  cwd: string,
  from: string,
  to: string,
  patch: Patch,
  seats: readonly SeatRecord[],
  records: readonly EvidenceRecord[],
): Source | null => {
  const shaped = seats.map((seat) => ({
    id: seat.id,
    cwd: seat.checkout.cwd,
    project: seat.checkout.project,
    openedAt: seat.openedAt,
    closedAt: seat.closed?.at ?? null,
    restored: !!seat.restored,
  }))
  const found = records.flatMap((record) => {
    if (record.fact.kind !== 'diff' || !record.seat || !record.checkout) return []
    const fact = {
      id: record.id,
      seat: record.seat,
      cwd: record.checkout.cwd,
      project,
      from: record.fact.from,
      to: record.fact.to,
      observedAt: record.observedAt,
      restored: !!record.restored,
    }
    const source = seed({
      project, cwd, from, to, firstSeen: fact.observedAt, patch,
    }, shaped, [fact])
    return source ? [source] : []
  })
  if (!found.length) return null
  const ids = [...new Set(found.flatMap((source) => source.seats))].sort()
  return { id: to, seats: ids, patch, ambiguous: ids.length !== 1 }
}
```

Replace that whole file with:

```ts
import { createHash } from 'node:crypto'

import type { CardRef, EvidenceRecord, ProvenanceSeat, SeatRecord } from '@harnessdesk/protocol'

import type { GitReader, ReflogMove } from './git.js'
import { reconcile, seed, surviving, type FilePatch, type Patch, type Source } from './model.js'

/**
 * Records have already passed EvidenceStore.read(project, 'evidence'). Both
 * checkout paths must be canonical admitted identities, never a cwd fallback.
 * A range fact binds this range; it says nothing about intermediate commits.
 */
export const sourceFromFacts = (
  project: string,
  cwd: string,
  from: string,
  to: string,
  patch: Patch,
  seats: readonly SeatRecord[],
  records: readonly EvidenceRecord[],
): Source | null => {
  const shaped = seats.map((seat) => ({
    id: seat.id,
    cwd: seat.checkout.cwd,
    project: seat.checkout.project,
    openedAt: seat.openedAt,
    closedAt: seat.closed?.at ?? null,
    restored: !!seat.restored,
  }))
  const found = records.flatMap((record) => {
    if (record.fact.kind !== 'diff' || !record.seat || !record.checkout) return []
    const fact = {
      id: record.id,
      seat: record.seat,
      cwd: record.checkout.cwd,
      project,
      from: record.fact.from,
      to: record.fact.to,
      observedAt: record.observedAt,
      restored: !!record.restored,
    }
    const source = seed({
      project, cwd, from, to, firstSeen: fact.observedAt, patch,
    }, shaped, [fact])
    return source ? [source] : []
  })
  if (!found.length) return null
  const ids = [...new Set(found.flatMap((source) => source.seats))].sort()
  return { id: to, seats: ids, patch, ambiguous: ids.length !== 1 }
}

export interface CommitObservation {
  readonly id: string
  readonly sha: string
  readonly parents: readonly string[]
  readonly tree: string
  readonly firstSeenAt: number
  readonly fingerprintVersion: 1
  readonly discoveredBy: readonly string[]
  readonly checkoutHints: readonly string[]
  readonly window: { readonly from: number | null; readonly to: number }
  readonly patch: Patch | null
  readonly files: readonly FilePatch[]
  readonly why: string | null
}

export interface RangeObservation {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly commits: readonly string[]
  readonly patch: Patch
  readonly seats: readonly string[]
  readonly ambiguous: boolean
  readonly at: number
}

export interface LinkObservation {
  readonly id: string
  readonly sha: string
  readonly seats: readonly string[]
  readonly sourceIds: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly retainedPaths: readonly string[]
  readonly coverage: 'complete' | 'partial' | 'none'
  readonly via: 'observed' | 'patch' | 'amend' | 'squash' | null
  readonly reason: string | null
  readonly at: number
}

export interface ReconcileInput {
  readonly commits: readonly CommitObservation[]
  readonly sources: readonly Source[]
  readonly priorLinks: readonly LinkObservation[]
  readonly moves: readonly ReflogMove[]
  readonly now: number
}

/** Additional internal proof, rebuilt from durable facts/ranges on startup. */
export interface ProvenanceSource extends Source {
  readonly proof: {
    readonly kind: 'diff' | 'range'
    readonly from: string
    readonly to: string
    readonly commits: readonly string[]
    readonly evidenceIds: readonly string[]
    readonly restored: boolean
  }
}

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort()
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a: Patch, b: Patch): boolean => a.stable === b.stable && a.exact === b.exact
const live = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('capture-aborted')
}
const proven = (source: Source): source is ProvenanceSource =>
  'proof' in source && typeof source.proof === 'object' && source.proof !== null

/** Source IDs bind the exact fact set, so new competing evidence is a new decision. */
export const factSource = (
  project: string,
  cwd: string,
  from: string,
  to: string,
  patch: Patch,
  seats: readonly SeatRecord[],
  records: readonly EvidenceRecord[],
): ProvenanceSource | null => {
  const source = sourceFromFacts(project, cwd, from, to, patch, seats, records)
  if (!source) return null
  const evidenceIds = unique(records.filter((record) =>
    sourceFromFacts(project, cwd, from, to, patch, seats, [record]) !== null,
  ).map((record) => record.id))
  return {
    ...source,
    id: digest(['diff', 1, project, cwd, from, to, patch, evidenceIds, source.seats]),
    proof: { kind: 'diff', from, to, commits: [to], evidenceIds, restored: false },
  }
}

const latestLinks = (links: readonly LinkObservation[]): Map<string, LinkObservation> => {
  const latest = new Map<string, LinkObservation>()
  // Journal order breaks an equal-time tie. Wall-clock time never reorders records.
  for (const link of links) latest.set(link.sha, link)
  return latest
}

/**
 * Capture before the source objects disappear. The caller appends this range
 * durably before offering rangeSource to reconciliation or advancing a cursor.
 */
export const captureRange = async (
  from: string,
  parts: readonly CommitObservation[],
  links: readonly LinkObservation[],
  git: GitReader,
  signal: AbortSignal,
  at: number,
): Promise<RangeObservation> => {
  live(signal)
  if (!parts.length || parts.length > 64) throw new Error('limit-exceeded')
  let parent = from
  for (const part of parts) {
    if (part.parents.length !== 1 || part.parents[0] !== parent) throw new Error('history-gap')
    if (!await git.commit(part.sha, signal)) throw new Error('missing-object')
    parent = part.sha
  }
  const latest = latestLinks(links)
  const owners = new Map<string, Set<string>>()
  let ambiguous = false
  for (const part of parts) {
    const link = latest.get(part.sha)
    if (!part.patch || part.why || !link || link.coverage !== 'complete' || !link.seats.length) {
      ambiguous = true
      continue
    }
    for (const file of part.files) {
      const seats = owners.get(file.path) ?? new Set<string>()
      for (const seat of link.seats) seats.add(seat)
      owners.set(file.path, seats)
    }
  }
  const to = parts.at(-1)!.sha
  const patch = await git.patch(from, to, signal)
  const netFiles = await git.files(from, to, signal)
  // One Seat owns all mutations on a path: a nonempty net delta retains some
  // of that Seat's contribution. Two Seats require line survival, which this
  // phase deliberately does not infer. A reverted path supplies no survivor.
  for (const [path, seats] of owners) {
    if (seats.size !== 1 || !netFiles.some((file) => file.path === path)) ambiguous = true
  }
  if (!patch.files.length || netFiles.some((file) => !owners.has(file.path))) ambiguous = true
  const sourceIds = parts.flatMap((part) => [part.id, latest.get(part.sha)?.id ?? 'missing-link'])
  return {
    id: digest(['range', 1, from, to, sourceIds]),
    from,
    to,
    commits: parts.map((part) => part.sha),
    patch,
    seats: unique([...owners.values()].flatMap((set) => [...set])),
    ambiguous,
    at,
  }
}

/** A restored range can be displayed as history; it cannot seed a local rewrite. */
export const rangeSource = (
  range: RangeObservation,
  links: readonly LinkObservation[],
  restored = false,
): ProvenanceSource => {
  const latest = latestLinks(links)
  const parts = range.commits.map((sha) => latest.get(sha))
  const seats = unique(parts.flatMap((part) => part?.seats ?? []))
  const incomplete = parts.some((part) => !part || part.coverage !== 'complete') ||
    JSON.stringify(seats) !== JSON.stringify(unique(range.seats))
  return {
    id: range.id,
    seats: range.seats,
    patch: range.patch,
    ambiguous: range.ambiguous || incomplete,
    proof: {
      kind: 'range', from: range.from, to: range.to, commits: range.commits,
      evidenceIds: unique(parts.flatMap((part) => part?.evidenceIds ?? [])), restored,
    },
  }
}

/** Contiguous first-parent suffixes only; the worker persists the returned remainder. */
export const rangeCandidates = (
  commits: readonly CommitObservation[],
  captured: ReadonlySet<string>,
): { ready: readonly { key: string; from: string; commits: readonly CommitObservation[] }[]; pending: readonly string[] } => {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  const ready: { key: string; from: string; commits: readonly CommitObservation[] }[] = []
  const pending: string[] = []
  for (const tip of [...commits].sort((a, b) => a.sha.localeCompare(b.sha))) {
    const parts: CommitObservation[] = []
    const seen = new Set<string>()
    let current: CommitObservation | undefined = tip
    while (current && current.parents.length === 1 && parts.length < 64 && !seen.has(current.sha)) {
      seen.add(current.sha)
      parts.unshift(current)
      const from = current.parents[0]!
      const key = digest([from, tip.sha, parts.map((part) => part.id)])
      if (parts.length > 1 && !captured.has(key)) {
        if (ready.length < 256) ready.push({ key, from, commits: [...parts] })
        else pending.push(key)
      }
      current = bySha.get(from)
    }
    if (current && parts.length === 64) pending.push(`limit:${tip.sha}`)
  }
  return { ready, pending }
}

const related = (input: ReconcileInput, from: string, to: string): boolean => {
  if (from === to) return true
  const graph = new Map<string, Set<string>>()
  const edge = (a: string, b: string) => {
    const neighbours = graph.get(a) ?? new Set<string>()
    neighbours.add(b)
    graph.set(a, neighbours)
  }
  // Rewrite movement edges are undirected. A range names its observed tip.
  // Sharing a base never joins independent branches into a rewrite lineage.
  for (const move of input.moves) {
    if (!move.before || !move.after) continue
    edge(move.before, move.after)
    edge(move.after, move.before)
  }
  const todo = [from]
  const seen = new Set<string>()
  while (todo.length) {
    const sha = todo.pop()!
    if (sha === to) return true
    if (seen.has(sha)) continue
    seen.add(sha)
    for (const next of graph.get(sha) ?? []) todo.push(next)
  }
  return false
}

/**
 * The fixed phase API retains git; object reads belong to captureRange, before
 * its journal append. This decision pass needs only durable observations, so
 * reopening it does not require original objects to remain in Git.
 */
export const reconcileProject = async (
  input: ReconcileInput,
  git: GitReader,
  signal: AbortSignal,
): Promise<readonly LinkObservation[]> => {
  void git
  const output: LinkObservation[] = []
  const latest = latestLinks(input.priorLinks)
  const oldIds = new Set(input.priorLinks.map((link) => link.id))
  const observed = new Map(input.commits.map((commit) => [commit.sha, commit]))
  const sources = input.sources.filter(proven)
  const decide = (commit: CommitObservation, result: Omit<LinkObservation, 'id' | 'sha' | 'at'>) => {
    const normalized = {
      ...result,
      seats: unique(result.seats), sourceIds: unique(result.sourceIds),
      evidenceIds: unique(result.evidenceIds), retainedPaths: unique(result.retainedPaths),
    }
    const previous = latest.get(commit.sha)
    if (previous) {
      const { id: previousId, sha: previousSha, at: previousAt, ...decision } = previous
      void [previousId, previousSha, previousAt]
      if (decision.coverage === normalized.coverage && decision.via === normalized.via &&
        decision.reason === normalized.reason &&
        JSON.stringify(unique(decision.seats)) === JSON.stringify(normalized.seats) &&
        JSON.stringify(unique(decision.sourceIds)) === JSON.stringify(normalized.sourceIds) &&
        JSON.stringify(unique(decision.evidenceIds)) === JSON.stringify(normalized.evidenceIds) &&
        JSON.stringify(unique(decision.retainedPaths)) === JSON.stringify(normalized.retainedPaths)) return
    }
    const id = digest(['link', 1, commit.id, commit.sha, previous?.id ?? null, normalized])
    const link: LinkObservation = { ...normalized, id, sha: commit.sha, at: input.now }
    latest.set(commit.sha, link)
    if (!oldIds.has(id)) output.push(link)
  }
  for (const commit of [...input.commits].sort((a, b) =>
    a.firstSeenAt - b.firstSeenAt || a.sha.localeCompare(b.sha),
  )) {
    live(signal)
    const refuse = (reason: string, sourceIds: readonly string[] = []) => decide(commit, {
      seats: [], sourceIds, evidenceIds: [], retainedPaths: [],
      coverage: 'none', via: null, reason,
    })
    const patch = commit.patch
    if (!patch) {
      refuse(commit.why ?? 'missing-object')
      continue
    }
    const currentSources = sources.map((source): ProvenanceSource => {
      if (source.proof.kind !== 'range') return source
      const parts = source.proof.commits.map((sha) => latest.get(sha))
      const seats = unique(parts.flatMap((part) => part?.seats ?? []))
      const invalid = parts.some((part) => !part || part.coverage !== 'complete') ||
        JSON.stringify(seats) !== JSON.stringify(unique(source.seats))
      return { ...source, ambiguous: source.ambiguous || invalid }
    })
    const matches = currentSources.filter((source) => same(source.patch, patch))
    const direct = matches.filter((source) => !source.proof.restored &&
      source.proof.to === commit.sha &&
      source.proof.from === commit.parents[0],
    )
    if (commit.parents.length > 1 && !direct.length) {
      refuse('unsupported-merge')
      continue
    }
    if (!patch.files.length) {
      refuse('empty-change')
      continue
    }
    if (commit.why) {
      refuse(commit.why)
      continue
    }
    const unscoped = input.sources.filter((source) => !proven(source) && same(source.patch, patch))
      .map((source) => ({ ...source, seats: [], ambiguous: true }))
    let candidates: Source[] = [...direct, ...unscoped]
    if (!direct.length) {
      candidates = [...matches.filter((source) => !source.proof.restored), ...unscoped]
      // A discovered equal patch with no binding proof is a known alternative.
      // Copies already explained by the same lineage are represented by their
      // source, rather than being counted twice as known and unknown.
      for (const other of input.commits) {
        if (other.sha === commit.sha || !other.patch || !same(other.patch, patch)) continue
        const explained = sources.some((source) => !source.proof.restored &&
          same(source.patch, patch) &&
          (source.proof.to === other.sha || related(input, source.proof.to, other.sha)),
        )
        if (!explained) candidates.push({ id: other.id, patch: other.patch, seats: [] })
      }
      if (candidates.some((source) => proven(source) && !related(input, source.proof.to, commit.sha))) {
        refuse('ambiguous-patch', candidates.map((source) => source.id))
        continue
      }
    }
    const complete = reconcile(patch, candidates)
    if (complete.state === 'attributed') {
      const used = candidates.filter((source) => complete.sources.includes(source.id))
      decide(commit, {
        seats: complete.seats,
        sourceIds: unique([commit.id, ...used.flatMap((source) => {
          if (!proven(source)) return [source.id]
          if (source.proof.kind === 'range') return [source.id]
          return source.proof.commits.flatMap((sha) => {
            const original = observed.get(sha)
            return original ? [original.id] : []
          })
        })]),
        evidenceIds: unique(used.flatMap((source) => proven(source) ? source.proof.evidenceIds : [])),
        retainedPaths: patch.files,
        coverage: 'complete',
        via: direct.length ? 'observed' : used.some((source) => proven(source) && source.proof.kind === 'range') ? 'squash' : 'patch',
        reason: null,
      })
      continue
    }
    if (complete.reason === 'ambiguous-patch') {
      refuse('ambiguous-patch', candidates.map((source) => source.id))
      continue
    }
    const replacements = input.moves.filter((move) => move.after === commit.sha && move.before &&
      (move.checkout === null || commit.checkoutHints.includes(move.checkout)),
    ).map((move) => observed.get(move.before!)).filter((old): old is CommitObservation =>
      !!old && JSON.stringify(old.parents) === JSON.stringify(commit.parents),
    )
    const ownership = (
      sha: string,
      path: string,
      seen = new Set<string>(),
    ): { seats: string[]; evidenceIds: string[] } | null => {
      if (seen.has(sha)) return null
      seen.add(sha)
      const link = latest.get(sha)
      if (!link || link.coverage === 'none' || !link.retainedPaths.includes(path)) return null
      if (link.seats.length === 1) return { seats: [...link.seats], evidenceIds: [...link.evidenceIds] }
      const ranges = currentSources.filter((source) => source.proof.kind === 'range' &&
        !source.ambiguous && link.sourceIds.includes(source.id),
      )
      const parts = unique(ranges.flatMap((range) => range.proof.commits))
        .filter((part) => observed.get(part)?.files.some((file) => file.path === path))
      const owners = parts.map((part) => ownership(part, path, new Set(seen)))
      if (!owners.length || owners.some((owner) => !owner)) return null
      const seats = unique(owners.flatMap((owner) => owner!.seats))
      if (seats.length !== 1) return null
      return { seats, evidenceIds: unique(owners.flatMap((owner) => owner!.evidenceIds)) }
    }
    const retained: {
      old: CommitObservation
      link: LinkObservation
      paths: string[]
      seats: string[]
      evidenceIds: string[]
    }[] = []
    let ambiguous = false
    for (const old of replacements) {
      const link = latest.get(old.sha)
      const paths = surviving(old.files, commit.files).retained
        .filter((path) => link?.retainedPaths.includes(path))
      if (!paths.length) continue
      const owners = paths.map((path) => ownership(old.sha, path))
      if (!link || owners.some((owner) => !owner)) {
        ambiguous = true
        continue
      }
      retained.push({
        old, link, paths,
        seats: unique(owners.flatMap((owner) => owner!.seats)),
        evidenceIds: unique(owners.flatMap((owner) => owner!.evidenceIds)),
      })
    }
    const seatSets = new Set(retained.map((part) => JSON.stringify(part.seats)))
    if (ambiguous || seatSets.size > 1) {
      refuse('ambiguous-patch')
      continue
    }
    if (retained.length) {
      const paths = unique(retained.flatMap((part) => part.paths))
      const unresolved = commit.files.filter((file) => !paths.includes(file.path))
      decide(commit, {
        seats: retained[0]!.seats,
        sourceIds: retained.flatMap(({ old, link }) => [old.id, link.id, ...link.sourceIds]),
        evidenceIds: retained.flatMap((part) => part.evidenceIds),
        retainedPaths: paths,
        coverage: unresolved.length ? 'partial' : 'complete',
        via: 'amend',
        reason: unresolved.length ? 'changed-patch' : null,
      })
      continue
    }
    refuse(replacements.length ? 'changed-patch' :
      matches.some((source) => source.proof.restored) ? 'restored-history' : 'no-seat-evidence')
  }
  return output
}

/** Join proof IDs only. Other facts retain the revision they were observed at. */
export const relatedEvidence = (
  link: LinkObservation,
  seats: readonly SeatRecord[],
  records: readonly EvidenceRecord[],
): {
  seats: readonly ProvenanceSeat[]
  missingSeats: readonly string[]
  evidenceIds: readonly string[]
  cards: readonly CardRef[]
} => {
  const found = seats.filter((seat) => link.seats.includes(seat.id))
  const evidence = records.filter((record) => link.evidenceIds.includes(record.id))
  const cards = new Map(evidence.flatMap((record) => record.card
    ? [[JSON.stringify([record.card.board, record.card.id]), record.card] as const]
    : []))
  return {
    seats: found.map((seat) => ({
      id: seat.id, agentName: seat.agent?.name ?? null,
      runtime: seat.session.runtime, seatLabel: seat.seatLabel, session: seat.session,
    })),
    missingSeats: link.seats.filter((id) => !found.some((seat) => seat.id === id)),
    evidenceIds: link.evidenceIds,
    cards: [...cards.values()],
  }
}
```

- [ ] **Step 4: Pin the durable handoff to Tasks 4–5.**

The implemented order is direct matching local evidence, a complete stable-and-verbatim match within observed rewrite lineage, a complete captured range match under that same agreement rule, then same-ref/same-parent surviving file patches. Independent equal patches, unknown candidates, competing Seats and ambiguous range decompositions stay unattributed. A matching whole-range fact can explain a displayed merge delta; an unproved merge stays `unsupported-merge`.

`captureRange` verifies an ordered first-parent chain and checks source objects while capturing. Every part must have a complete current link. It compares a real base-to-tip patch, not a sum of per-commit patch IDs. A path touched by two Seats is ambiguous; a reverted-away path is not credited. Repeated changes by one Seat can be associated when all changes on that path belong to that Seat and a nonempty net file delta survives. No line-survival algorithm or fuzzy hunk match is introduced.

A partial amendment looks up owners of the exact surviving file patches. For a former multi-Seat squash, ownership is recovered through its retained range and part links: removing Seat B's whole file cannot leave B credited through a union of old Seats. Remaining target files keep coverage partial until an exact local fact establishes them. Evidence joins use only the surviving proof; unrelated check/CI/review records remain attached to their original revisions.

The worker's transaction boundary is mandatory: append each `RangeObservation` and await durability; rebuild sources with `rangeSource`; call `reconcileProject`; append its returned links; only then append the successful reconciliation cursor. Store successful `rangeCandidates.ready[].key` values alongside the reconciliation frontier. Pass those keys as `captured` on the next pass: the test proves the remaining 179 candidates are returned after the first 256. Keep a `limit:<tip>` frontier entry and degraded status for a chain beyond 64; do not feed that marker to a Git object read. The commit frontier and this range frontier are different work sets.

On restart, hydrate ranges from journal records and links, including the source commit observations. `reconcileProject` deliberately uses only those durable inputs; the retained `git` parameter preserves this plan's fixed API, while `captureRange` owns the object reads. A captured range works after source objects disappear; an uncaptured range reports `missing-object`. Imported records pass `restored = true` and never create a new local link. A source fact observed across a range must be fingerprinted across that exact range before calling `factSource`; it cannot be copied to each intermediate SHA.

- [ ] **Step 5: Run all rewrite tests green.**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/provenance-reconcile.test.js`

Expected: exit 0; **11 tests, 11 pass, 0 fail**. This includes 64/256 bounds, resumed range work, original session pointers, unavailable historical Seats, multi-Seat amendment ownership, newly competing evidence, and retained squash attribution after actual object loss.

- [ ] **Step 6: Prove the five distinct reconciliation guards, restoring each immediately.**

For whitespace, temporarily replace this exact `same` expression in `reconcile.ts`:

```ts
const same = (a: Patch, b: Patch): boolean => a.stable === b.stable && a.exact === b.exact
```

with:

```ts
const same = (a: Patch, b: Patch): boolean => a.stable === b.stable
```

In Task 1's `model.ts`, also replace:

```ts
    source.patch.stable === target.stable && source.patch.exact === target.exact,
```

with:

```ts
    source.patch.stable === target.stable && true,
```

Both candidate selection and the pure matching check must be bypassed to exercise this mutation.

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='same file with changed whitespace' packages/server/dist/test/provenance-reconcile.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` with actual `'ambiguous-patch'` and expected `'changed-patch'`. Restore both verbatim comparisons.

In `model.ts`, replace this exact anchor:

```ts
  const groups = new Map(matching.map((source) => {
```

with:

```ts
  matching.splice(1)
  const groups = new Map(matching.map((source) => {
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='new competing' packages/server/dist/test/provenance-reconcile.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` with actual `undefined` and expected `'ambiguous-patch'`. Remove the inserted `matching.splice(1)` line.

In `captureRange`, replace this exact guard:

```ts
    if (seats.size !== 1 || !netFiles.some((file) => file.path === path)) ambiguous = true
```

with:

```ts
    if ((seats.size !== 1 && false) || !netFiles.some((file) => file.path === path)) ambiguous = true
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='overlapping owners' packages/server/dist/test/provenance-reconcile.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, with `two Seats touching one file cannot seed a squash` and `false !== true`. Restore the shared-file guard.

Replace this exact amendment coverage line:

```ts
        coverage: unresolved.length ? 'partial' : 'complete',
```

with:

```ts
        coverage: unresolved.length ? 'complete' : 'complete',
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='a content amend' packages/server/dist/test/provenance-reconcile.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, with `the unresolved file must keep coverage partial` and actual `'complete'`, expected `'partial'`. Restore the coverage line.

Replace this exact range refresh line:

```ts
      return { ...source, ambiguous: source.ambiguous || invalid }
```

with:

```ts
      return { ...source, ambiguous: source.ambiguous || (invalid && false) }
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern='multi-Seat squash' packages/server/dist/test/provenance-reconcile.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` with actual `null` and expected `'ambiguous-patch'`. Restore the refresh line. A stored range must not keep its earlier unique verdict after its parts gain competing evidence.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/provenance-model.test.js packages/server/dist/test/provenance-git.test.js packages/server/dist/test/provenance-reconcile.test.js`

Expected: exit 0; **34 tests, 34 pass, 0 fail**, with no SHA-256 skip on the planning machine. These are the three new test files only; this does not claim the complete phase gate, real watcher proof or rendered UI acceptance.

Planning evidence for this batch: the exact file bodies above, with Phase 4's complete evidence types copied into a scratch protocol, were compiled by `../../HarnessDesk/node_modules/.bin/tsc -p .plan-scratch/tsconfig.json`. The compiler enabled `strict`, `noUncheckedIndexedAccess` and `noUnusedLocals`. Each named Node file was run in the foreground from `.plan-scratch/dist/test/`, with `TMPDIR` confined to `.plan-scratch/tmp`. All ten named mutations in Tasks 1–3 were executed, each returned exit 1, and each restored focused test returned exit 0. No existing source or test file was edited during the planning proof. Scratch was removed after the plan body was compared with the tested files.

- [ ] **Step 7: Controller commit after the phase gate.**

The plan writer does not commit. The controller runs `pnpm verify` unpiped and records the actual implementation writer in the trailer.

```bash
git add packages/server/src/provenance/reconcile.ts packages/server/test/provenance-reconcile.test.ts
git commit -m "feat: reconcile Seat provenance across Git rewrites" --trailer "Co-Authored-By: Codex GPT-6 <agent@harnessdesk.app>"
```

### Task 4: Durable observations, machine preference and capture health

Every published observation has a durable journal prefix behind it. A damaged prefix stops capture and stays intact. Preferences belong to this machine; a backup carries historical observations, and cannot carry a cursor or enable an observer.

**Files:**
- Create: `packages/server/src/provenance/journal.ts`, `preferences.ts`, `health.ts`, `backup.ts`
- Create: `packages/server/test/provenance-journal.test.ts`, `packages/server/test/provenance-backup.test.ts`
- Modify: `packages/protocol/src/provenance.ts`, `packages/protocol/src/wire.ts`, `packages/server/src/host.ts`
- Named test edit: `packages/server/test/backup.test.ts` adds the provenance key and a historical round trip, preserving every previous key and assertion.
- Named fixture edits: `packages/ui/src/lib/backup-words.test.ts` and `packages/ui/src/components/Settings.backup.test.tsx` add the required zeroed provenance report counter to their existing `BackupReport` fixtures; their wording assertions remain unchanged because Task 4 adds historical transport, not new Backup-page copy.

**Proof needs:** neither — Codex; temporary local files, Node tests and injected write failures. No listener, runtime, file event or renderer is involved.

**Interfaces:** The complete files below preserve `JournalKind = 'ref' | 'commit' | 'range' | 'link' | 'cursor' | 'gap'`, `JournalEntry { seq; kind; value }`, `JournalRead { entries; broken }`, `ProvenanceJournal(file).read/append/flush`, `CapturePreference { enabled; problem }`, `ProvenancePreferences(file).load/get/set`, `HealthInput`, and `captureHealth(input): CaptureHealth`. `ProvenanceBackup` is public protocol data, with version 1 and opaque, server-validated project entries. `BackupFile.provenance?` and the required `BackupReport.provenance { restored; duplicate; refused }` use that type. `ProvenanceBackups` is the Task 4 host owner; Task 5 transfers ownership to the live plane so there is never a second writer beside an active observer.

`writeCheckpoint(journal, value)` writes bounded `cursor` parts followed by a final manifest naming their preceding sequence numbers. `readCheckpoint(entries)` ignores an unfinished part set and validates each completed manifest. Both are private to this phase. Imported records use `{ id, restoredAt, data }`; local reads must exclude that wrapper. Imported and local identities occupy different namespaces, so a restored record cannot prevent a later local observation.

- [ ] **Step 1: Write the crash, preference, health and backup tests first.**

Create `packages/server/test/provenance-journal.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { captureHealth, type HealthInput } from '../src/provenance/health.js'
import { digest, ProvenanceJournal, readCheckpoint, writeCheckpoint } from '../src/provenance/journal.js'
import { ProvenancePreferences } from '../src/provenance/preferences.js'
import { tempDir } from './scratch.js'

const gap = (id = 'gap-1') => ({ id, reason: 'history-gap', from: null, to: 10 })
const checkpoint = () => ({
  generation: 1, refs: [], heads: [], logs: [], frontier: [],
  capturedThrough: 10, scanStartedAt: 9, baseline: [], rangeKeys: [], rangePending: [],
})
const health = (over: Partial<HealthInput> = {}) => captureHealth({
  project: '/work/project', enabled: true, fatal: false, issues: [],
  checkedAt: 10, lastCapturedAt: 9, pending: 0, gaps: 0, revision: 1, ...over,
})

test('serialized observations and chunked checkpoints replay in durable prefix order', async () => {
  const file = join(tempDir('journal-'), 'provenance.ndjson')
  const journal = new ProvenanceJournal(file)
  await Promise.all(Array.from({ length: 220 }, (_, n) => journal.append('gap', gap(`gap-${n}`))))
  const value = { ...checkpoint(), rangeKeys: Array.from({ length: 2000 }, (_, n) => digest(n)) }
  await writeCheckpoint(journal, value)
  await journal.append('gap', gap('gap-1'))
  await journal.flush()
  const reopened = await new ProvenanceJournal(file).read()
  assert.equal(reopened.broken, false)
  assert.deepEqual(readCheckpoint(reopened.entries), value)
  assert.equal(reopened.entries.filter((entry) => entry.kind === 'gap').length, 220)
  assert.ok((await fs.readFile(file, 'utf8')).split('\n').every((line) => Buffer.byteLength(line) < 65536))
})

test('a torn tail refuses appends and leaves every original byte in place', async () => {
  const file = join(tempDir('journal-'), 'provenance.ndjson')
  await new ProvenanceJournal(file).append('gap', gap())
  await fs.appendFile(file, '{"version":1')
  const before = await fs.readFile(file)
  const reopened = new ProvenanceJournal(file)
  assert.equal((await reopened.read()).broken, true)
  await assert.rejects(reopened.append('gap', gap('later')), /provenance-journal-damaged/)
  assert.deepEqual(await fs.readFile(file), before)
})

test('unknown versions and checksum damage stop at the first damaged record', async () => {
  for (const field of ['version', 'checksum']) {
    const file = join(tempDir('journal-'), 'provenance.ndjson')
    const journal = new ProvenanceJournal(file)
    await journal.append('gap', gap())
    await journal.append('gap', gap('second'))
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    const first = JSON.parse(lines[0]!)
    first[field] = field === 'version' ? 2 : 'wrong'
    await fs.writeFile(file, `${JSON.stringify(first)}\n${lines[1]}\n`)
    const read = await new ProvenanceJournal(file).read()
    assert.equal(read.broken, true)
    assert.deepEqual(read.entries, [])
  }
})

test('short writes and sync failures are sticky and never publish an entry', async (t) => {
  const original = fs.open
  for (const failure of ['short', 'sync']) {
    const file = join(tempDir('journal-'), 'provenance.ndjson')
    const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      if (failure === 'short') t.mock.method(handle, 'write', async () => ({ bytesWritten: 1 }))
      else t.mock.method(handle, 'sync', async () => { throw new Error('injected-sync') })
      return handle
    })
    const journal = new ProvenanceJournal(file)
    await assert.rejects(journal.append('gap', gap()), /short-write|injected-sync/)
    mock.mock.restore()
    assert.deepEqual((await journal.read()).entries, [])
    await assert.rejects(journal.flush(), /short-write|injected-sync/)
    await assert.rejects(journal.append('gap', gap('retry')), /short-write|injected-sync/)
  }
})

test('an incomplete checkpoint attempt is inert and later replay deduplicates observations', async () => {
  const file = join(tempDir('journal-'), 'provenance.ndjson')
  const journal = new ProvenanceJournal(file)
  await journal.append('gap', gap())
  await journal.append('cursor', { id: 'orphan-part', type: 'part', bytes: '{}' })
  assert.equal(readCheckpoint((await journal.read()).entries), null)
  await assert.rejects(journal.append('cursor', {
    id: 'future', type: 'checkpoint', parts: [99], hash: digest({}),
  }), /provenance-invalid-record/)
  const reopened = new ProvenanceJournal(file)
  await reopened.append('gap', gap())
  await writeCheckpoint(reopened, checkpoint())
  assert.equal((await reopened.read()).entries.filter((entry) => entry.kind === 'gap').length, 1)
  assert.deepEqual(readCheckpoint((await reopened.read()).entries), checkpoint())
})

test('preferences default on, persist off, isolate projects and refuse malformed files', async () => {
  const file = join(tempDir('preferences-'), 'provenance-preferences.json')
  const first = new ProvenancePreferences(file)
  await first.load()
  assert.deepEqual(first.get('/work/one'), { enabled: true, problem: null })
  await first.set('/work/one', false)
  const second = new ProvenancePreferences(file)
  await second.load()
  assert.equal(second.get('/work/one').enabled, false)
  assert.equal(second.get('/work/two').enabled, true)
  assert.throws(() => second.get('../outside'), /provenance-invalid-project/)
  await fs.writeFile(file, '{bad')
  const broken = new ProvenancePreferences(file)
  await broken.load()
  assert.equal(broken.get('/work/one').problem, 'preference-invalid')
  await assert.rejects(broken.set('/work/one', true), /preference-invalid/)
  assert.equal(await fs.readFile(file, 'utf8'), '{bad')
})

test('a failed preference rename retains the published value and removes its own temporary file', async (t) => {
  const dir = tempDir('preferences-')
  const preferences = new ProvenancePreferences(join(dir, 'provenance-preferences.json'))
  await preferences.load()
  const mock = t.mock.method(fs, 'rename', async () => { throw new Error('injected-rename') })
  await assert.rejects(preferences.set('/work/project', false), /injected-rename/)
  assert.equal(preferences.get('/work/project').enabled, true)
  assert.deepEqual(await fs.readdir(dir), [])
  mock.mock.restore()
  await preferences.set('/work/project', false)
  assert.equal(preferences.get('/work/project').enabled, false)
})

test('health keeps off and fatal precedence, fixed copy, and historical gaps', () => {
  assert.equal(health().state, 'healthy')
  assert.equal(health({ pending: 1 }).reason, 'Catching up with this project.')
  assert.equal(health({ enabled: false, fatal: true, pending: 4 }).reason, 'Capture is off on this machine.')
  assert.equal(health({ fatal: true, pending: 4 }).state, 'stopped')
  assert.equal(health({ enabled: false, fatal: true, issues: ['preference-invalid'] }).reason, 'Capture could not save its observations.')
  assert.equal(health({ issues: ['watch-unavailable'] }).state, 'degraded')
  assert.equal(health({ gaps: 1 }).reason, 'Some history was unavailable when capture resumed.')
  assert.equal(health({ issues: ['limit-exceeded'] }).reason, 'Capture reached its background work limit.')
  assert.equal(health({ fatal: true, issues: ['external-metadata'] }).nextStep, 'Open its main checkout, or use a checkout with local metadata.')
  assert.equal(health({ fatal: true, issues: ['folder-unavailable'] }).reason, "This project's folder is unavailable.")
  assert.doesNotMatch(health({ fatal: true, issues: ['/outside/private text'] }).reason, /private/)
})
```

Create `packages/server/test/provenance-backup.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { exportProvenance, importProvenance, ProvenanceBackups } from '../src/provenance/backup.js'
import { ProvenanceJournal } from '../src/provenance/journal.js'
import { tempDir } from './scratch.js'
import { EvidenceStore } from '../src/evidence/store.js'

const setup = () => {
  const folder = tempDir('provenance-backup-')
  const journals = new Map<string, ProvenanceJournal>()
  return {
    projects: async () => [...journals.keys()],
    journal: (project: string) => {
      let journal = journals.get(project)
      if (!journal) {
        journal = new ProvenanceJournal(join(folder, String(journals.size), 'provenance.ndjson'))
        journals.set(project, journal)
      }
      return journal
    },
  }
}

test('backup round-trips ranges as restored history and leaves cursors and preferences behind', async () => {
  const from = setup()
  const journal = from.journal('/work/project')
  await journal.append('range', {
    id: 'range-1', from: 'a'.repeat(40), to: 'b'.repeat(40), commits: ['b'.repeat(40)],
    patch: { stable: 'c'.repeat(40), exact: 'd'.repeat(40), files: ['one'] },
    seats: ['seat-1'], ambiguous: false, at: 10,
  })
  await journal.append('cursor', { id: 'part', type: 'part', bytes: '{}' })
  const backup = await exportProvenance(from)
  assert.deepEqual(Object.keys(backup).sort(), ['projects', 'version'])
  assert.equal(backup.projects[0]?.entries.length, 1)
  const to = setup()
  assert.deepEqual(await importProvenance(to, backup, 20), { restored: 1, duplicate: 0, refused: 0 })
  assert.deepEqual(await importProvenance(to, backup, 30), { restored: 0, duplicate: 1, refused: 0 })
  const read = await to.journal('/work/project').read()
  assert.deepEqual(read.entries.map((entry) => entry.kind), ['range'])
  assert.equal((read.entries[0]?.value as { restoredAt: number }).restoredAt, 20)
})

test('restores refuse live cursors, invalid projects, wrong versions and oversized records', async () => {
  const port = setup()
  const raw = { version: 1, projects: [{ project: '/work/project', entries: [
    { kind: 'cursor', value: { id: 'part', type: 'part', bytes: '{}' } },
    { kind: 'gap', value: { id: 'bad', reason: 'x'.repeat(70000), from: null, to: 1 } },
  ] }, { project: '../outside', entries: [] }] }
  assert.deepEqual(await importProvenance(port, raw), { restored: 0, duplicate: 0, refused: 3 })
  assert.equal((await importProvenance(port, { ...raw, version: 2 })).refused, 1)
  assert.equal((await importProvenance(port, { version: 1, projects: Array(101).fill({}) })).refused, 1)
  assert.equal((await importProvenance(port, { version: 1, projects: [], padding: 'x'.repeat(10 * 1024 * 1024) })).refused, 1)
  assert.deepEqual(await importProvenance(port, undefined), { restored: 0, duplicate: 0, refused: 0 })
})

test('a local observation wins over an imported observation with the same identity', async () => {
  const port = setup()
  const value = { id: 'local', reason: 'history-gap', from: null, to: 1 }
  await port.journal('/work/project').append('gap', value)
  assert.deepEqual(await importProvenance(port, { version: 1, projects: [{
    project: '/work/project', entries: [{ kind: 'gap', value }],
  }] }), { restored: 0, duplicate: 1, refused: 0 })
  assert.deepEqual((await port.journal('/work/project').read()).entries[0]?.value, value)
})


test('the host backup owner serializes imports and preserves project discovery after restart', async () => {
  const folder = tempDir('provenance-backup-owner-')
  const store = new EvidenceStore(folder)
  const owner = new ProvenanceBackups(store)
  const backup = { version: 1, projects: [{ project: '/work/project', entries: [{
    kind: 'gap', value: { id: 'history', reason: 'history-gap', from: null, to: 1 },
  }] }] }
  const reports = await Promise.all([owner.restore(backup), owner.restore(backup)])
  assert.deepEqual(reports.map((report) => report.restored), [1, 0])
  assert.equal(reports[1]?.duplicate, 1)
  await owner.close()
  const reopened = new ProvenanceBackups(store)
  assert.equal((await reopened.backup()).projects[0]?.project, '/work/project')
  await reopened.close()
})
```

- [ ] **Step 2: Compile before the persistence implementation exists.**

Run: `pnpm run build:node`

Expected: exit 2; `error TS2307: Cannot find module '../src/provenance/journal.js' or its corresponding type declarations.` The imports for `preferences.js`, `health.js` and `backup.js` also fail. Keep the tests above the implementation steps.

- [ ] **Step 3: Add the complete journal, preference transaction and fixed health projection.**

A record is at most 64 KiB including its wrapper and newline. Replay streams bounded chunks and yields every 200 records. The file is never repaired in place: malformed version, kind, checksum, sequence, checkpoint or tail leaves its bytes untouched and refuses another append. Appends snapshot caller data, serialize writes, check short writes, sync before publishing indexes, and retain write failure for `flush`. No chmod-based fault test substitutes for the injected failures above.

Create `packages/server/src/provenance/journal.ts` with these complete contents:

```ts
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { setImmediate } from 'node:timers/promises'

export type JournalKind = 'ref' | 'commit' | 'range' | 'link' | 'cursor' | 'gap'
export interface JournalEntry {
  readonly seq: number
  readonly kind: JournalKind
  readonly value: unknown
}
export interface JournalRead {
  readonly entries: readonly JournalEntry[]
  readonly broken: boolean
}
export const JOURNAL_LIMIT = 64 * 1024
export const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullable = (value: unknown, check: (value: unknown) => boolean) => value === null || check(value)
const array = (value: unknown, check: (value: unknown) => boolean): value is unknown[] =>
  Array.isArray(value) && value.every((item) => check(item))
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const strings = (value: unknown) => array(value, text)
const patch = (value: unknown): boolean => object(value) &&
  ((value.stable === '' && value.exact === '') || (sha(value.stable) && sha(value.exact))) && strings(value.files)
const filePatch = (value: unknown): boolean => object(value) && text(value.path) &&
  sha(value.stable) && sha(value.exact)
const pair = (check: (value: unknown) => boolean) => (value: unknown): boolean =>
  Array.isArray(value) && value.length === 2 && text(value[0]) && check(value[1])
const logCursor = (value: unknown): boolean => object(value) && text(value.fileId) &&
  number(value.offset) && typeof value.tailHash === 'string' && /^[a-f0-9]{64}$/.test(value.tailHash)

/** Check the whole checkpoint after its bounded parts have been joined. */
export const checkpointValue = (value: unknown): boolean => object(value) &&
  number(value.generation) && array(value.refs, pair(sha)) &&
  array(value.heads, pair((head) => nullable(head, sha))) && array(value.logs, pair(logCursor)) &&
  array(value.frontier, sha) && number(value.capturedThrough) && number(value.scanStartedAt) &&
  strings(value.rangeKeys) && strings(value.rangePending) && array(value.baseline, sha)

/** The same admission rule is used for disk and backups; raw patches have no slot. */
export const validValue = (kind: JournalKind, value: unknown, prefix = Infinity): boolean => {
  if (!object(value) || !text(value.id, 200)) return false
  const fields: Record<JournalKind, readonly string[]> = {
    ref: ['id', 'ref', 'checkout', 'before', 'after', 'recordedAt'],
    commit: ['id', 'sha', 'tree', 'parents', 'firstSeenAt', 'fingerprintVersion', 'discoveredBy', 'checkoutHints', 'window', 'patch', 'files', 'why'],
    range: ['id', 'from', 'to', 'commits', 'patch', 'seats', 'ambiguous', 'at'],
    link: ['id', 'sha', 'seats', 'sourceIds', 'evidenceIds', 'retainedPaths', 'coverage', 'via', 'reason', 'at'],
    cursor: ['id', 'type', 'bytes', 'parts', 'hash'],
    gap: ['id', 'reason', 'from', 'to'],
  }
  const allowed = 'restoredAt' in value ? ['id', 'restoredAt', 'data'] : fields[kind]
  if (!allowed || Object.keys(value).some((key) => !allowed.includes(key))) return false
  if ('restoredAt' in value) {
    return kind !== 'cursor' && number(value.restoredAt) && object(value.data) &&
      !('restoredAt' in value.data) && validValue(kind, value.data, prefix)
  }
  switch (kind) {
    case 'ref':
      return text(value.ref) && (value.ref === 'HEAD' || value.ref.startsWith('refs/')) && nullable(value.checkout, text) && nullable(value.before, sha) &&
        nullable(value.after, sha) && nullable(value.recordedAt, number)
    case 'commit':
      return sha(value.sha) && sha(value.tree) && array(value.parents, sha) &&
        number(value.firstSeenAt) && value.fingerprintVersion === 1 &&
        strings(value.discoveredBy) && strings(value.checkoutHints) && object(value.window) &&
        nullable(value.window.from, number) && number(value.window.to) &&
        nullable(value.patch, patch) && array(value.files, filePatch) && nullable(value.why, text)
    case 'range':
      return sha(value.from) && sha(value.to) && array(value.commits, sha) &&
        value.commits.length <= 64 && patch(value.patch) && strings(value.seats) &&
        typeof value.ambiguous === 'boolean' && number(value.at)
    case 'link':
      return sha(value.sha) && strings(value.seats) && strings(value.sourceIds) &&
        strings(value.evidenceIds) && strings(value.retainedPaths) &&
        ['complete', 'partial', 'none'].includes(String(value.coverage)) &&
        [null, 'observed', 'patch', 'amend', 'squash'].includes(value.via as string | null) &&
        nullable(value.reason, text) && number(value.at)
    case 'gap':
      return text(value.reason, 200) && nullable(value.from, number) && number(value.to)
    case 'cursor':
      if (value.type === 'part') return typeof value.bytes === 'string' && value.bytes.length <= 12000
      return value.type === 'checkpoint' && array(value.parts, (seq) => number(seq) && seq > 0 && seq <= prefix) &&
        typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash)
  }
}
const kinds = new Set<JournalKind>(['ref', 'commit', 'range', 'link', 'cursor', 'gap'])
const keyOf = (kind: JournalKind, value: unknown) => `${kind}:${(value as { id: string }).id}`

export class ProvenanceJournal {
  readonly #file: string
  #entries: JournalEntry[] = []
  #ids = new Set<string>()
  #load: Promise<void> | null = null
  #tail: Promise<void> = Promise.resolve()
  #broken = false
  #failed: Error | null = null

  constructor(file: string) {
    this.#file = file
  }

  async #loadOnce(): Promise<void> {
    this.#load ??= this.#stream()
    await this.#load
  }

  async #stream(): Promise<void> {
    let pending = Buffer.alloc(0)
    let count = 0
    try {
      for await (const bytes of createReadStream(this.#file, { highWaterMark: 16 * 1024 })) {
        pending = Buffer.concat([pending, bytes as Buffer])
        let end: number
        while ((end = pending.indexOf(10)) >= 0) {
          if (end + 1 > JOURNAL_LIMIT) throw new Error('journal-line-limit')
          const raw = pending.subarray(0, end)
          const line: unknown = JSON.parse(raw.toString('utf8'))
          if (!Buffer.from(raw.toString('utf8')).equals(raw) || !object(line)) throw new Error('journal-shape')
          const { version, seq, kind, value, checksum } = line
          if (version !== 1 || seq !== this.#entries.length + 1 || !kinds.has(kind as JournalKind) ||
            !validValue(kind as JournalKind, value, this.#entries.length) ||
            checksum !== digest({ version, seq, kind, value })) throw new Error('journal-damaged')
          const entry = { seq, kind, value } as JournalEntry
          this.#entries.push(entry)
          this.#ids.add(keyOf(entry.kind, value))
          pending = pending.subarray(end + 1)
          if (++count % 200 === 0) await setImmediate()
        }
        if (pending.length >= JOURNAL_LIMIT) throw new Error('journal-line-limit')
      }
      if (pending.length) throw new Error('journal-torn-tail')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#broken = true
    }
  }

  async read(): Promise<JournalRead> {
    await this.#loadOnce()
    await this.#tail
    return { entries: structuredClone(this.#entries), broken: this.#broken }
  }

  append(kind: JournalKind, value: unknown): Promise<void> {
    // Snapshot now; the caller cannot change a queued record before its checksum.
    const saved = structuredClone(value)
    const next = this.#tail.then(async () => {
      await this.#loadOnce()
      if (this.#broken) throw new Error('provenance-journal-damaged')
      if (this.#failed) throw this.#failed
      if (!validValue(kind, saved, this.#entries.length)) throw new Error('provenance-invalid-record')
      const key = keyOf(kind, saved)
      if (this.#ids.has(key)) return
      const body = { version: 1, seq: this.#entries.length + 1, kind, value: saved }
      const bytes = Buffer.from(`${JSON.stringify({ ...body, checksum: digest(body) })}\n`)
      if (bytes.length > JOURNAL_LIMIT) throw new Error('provenance-line-limit')
      try {
        await fs.mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
        const file = await fs.open(this.#file, 'a', 0o600)
        try {
          if ((await file.write(bytes)).bytesWritten !== bytes.length) throw new Error('provenance-short-write')
          await file.sync()
        } finally {
          await file.close()
        }
      } catch (error) {
        this.#failed = error instanceof Error ? error : new Error('provenance-write-failed')
        throw this.#failed
      }
      this.#entries.push({ seq: body.seq, kind, value: saved })
      this.#ids.add(key)
    })
    this.#tail = next.catch(() => {})
    return next
  }

  async flush(): Promise<void> {
    await this.#tail
    if (this.#failed) throw this.#failed
    if (this.#broken) throw new Error('provenance-journal-damaged')
  }
}

/** Only a final manifest acknowledges its preceding parts. A torn attempt is inert. */
export const writeCheckpoint = async (journal: ProvenanceJournal, value: unknown): Promise<void> => {
  if (!checkpointValue(value)) throw new Error('provenance-invalid-checkpoint')
  const bytes = JSON.stringify(value)
  const hash = digest(value)
  const ids: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 12000) {
    const id = digest(['part', hash, offset])
    await journal.append('cursor', { id, type: 'part', bytes: bytes.slice(offset, offset + 12000) })
    ids.push(id)
  }
  const entries = (await journal.read()).entries
  const parts = ids.map((id) => entries.find((entry) => entry.kind === 'cursor' &&
    (entry.value as { id: string }).id === id)!.seq)
  await journal.append('cursor', { id: digest(['checkpoint', hash]), type: 'checkpoint', parts, hash })
}

export const readCheckpoint = (entries: readonly JournalEntry[]): unknown | null => {
  let latest: unknown = null
  for (const entry of entries) {
    if (entry.kind !== 'cursor' || !object(entry.value) || entry.value.type !== 'checkpoint') continue
    const bytes = (entry.value.parts as number[]).map((seq) => {
      const part = entries[seq - 1]
      if (!part || part.seq >= entry.seq || part.kind !== 'cursor' ||
        !object(part.value) || part.value.type !== 'part') throw new Error('provenance-invalid-checkpoint')
      return part.value.bytes as string
    }).join('')
    const value: unknown = JSON.parse(bytes)
    if (!checkpointValue(value) || digest(value) !== entry.value.hash) throw new Error('provenance-invalid-checkpoint')
    latest = value
  }
  return latest
}
```

Create `packages/server/src/provenance/preferences.ts` with these complete contents:

```ts
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, isAbsolute, normalize } from 'node:path'

import { object } from './journal.js'

export interface CapturePreference {
  readonly enabled: boolean
  readonly problem: string | null
}
const projectKey = (project: string): string => {
  if (!isAbsolute(project) || normalize(project) !== project || project.includes('\0')) {
    throw new Error('provenance-invalid-project')
  }
  return createHash('sha256').update(project).digest('hex')
}

export class ProvenancePreferences {
  #projects: Record<string, { enabled: boolean }> = {}
  #problem: string | null = null
  #loaded: Promise<void> | null = null
  #tail: Promise<void> = Promise.resolve()
  readonly #file: string

  constructor(file: string) {
    this.#file = file
  }

  load(): Promise<void> {
    this.#loaded ??= this.#read()
    return this.#loaded
  }

  async #read(): Promise<void> {
    try {
      const bytes = await fs.readFile(this.#file)
      if (bytes.length > 1024 * 1024) throw new Error('preference-limit')
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (!object(value) || value.version !== 1 || !object(value.projects) ||
        !Object.entries(value.projects).every(([key, entry]) =>
          /^[a-f0-9]{64}$/.test(key) && object(entry) && typeof entry.enabled === 'boolean',
        )) throw new Error('preference-shape')
      this.#projects = value.projects as Record<string, { enabled: boolean }>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#problem = 'preference-invalid'
    }
  }

  get(project: string): CapturePreference {
    const key = projectKey(project)
    return { enabled: this.#problem ? false : this.#projects[key]?.enabled ?? true, problem: this.#problem }
  }

  set(project: string, enabled: boolean): Promise<void> {
    const key = projectKey(project)
    const next = this.#tail.then(async () => {
      await this.load()
      if (this.#problem) throw new Error(this.#problem)
      const projects = { ...this.#projects, [key]: { enabled } }
      const folder = dirname(this.#file)
      await fs.mkdir(folder, { recursive: true })
      const temporary = `${this.#file}.${randomUUID()}.tmp`
      try {
        const file = await fs.open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(`${JSON.stringify({ version: 1, projects })}\n`)
          await file.sync()
        } finally {
          await file.close()
        }
        await fs.rename(temporary, this.#file)
        const directory = await fs.open(folder, 'r')
        try {
          await directory.sync().catch((error: NodeJS.ErrnoException) => {
            if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code ?? '')) throw error
          })
        } finally {
          await directory.close()
        }
        this.#projects = projects
      } finally {
        await fs.rm(temporary, { force: true })
      }
    })
    this.#tail = next.catch(() => {})
    return next
  }
}
```

Create `packages/server/src/provenance/health.ts` with these complete contents:

```ts
import type { CaptureHealth } from '@harnessdesk/protocol'

export interface HealthInput {
  readonly project: string
  readonly enabled: boolean
  readonly fatal: boolean
  readonly issues: readonly string[]
  readonly checkedAt: number | null
  readonly lastCapturedAt: number | null
  readonly pending: number
  readonly gaps: number
  readonly revision: number
}

const messages = {
  current: ['Capture is current for the refs Git exposes.', 'No action needed.'],
  pending: ['Catching up with this project.', 'Keep the project open; capture continues in the background.'],
  polling: ['File notifications are unavailable; capture is polling.', 'Retry capture to reconnect notifications.'],
  history: ['Some history was unavailable when capture resumed.', 'Retry if the repository has been repaired; those changes may stay unattributed.'],
  limit: ['Capture reached its background work limit.', 'Keep the project open; inspect the named limit if it persists.'],
  off: ['Capture is off on this machine.', 'Turn capture on.'],
  external: ["This repository's metadata is outside the captured project.", 'Open its main checkout, or use a checkout with local metadata.'],
  storage: ['Capture could not save its observations.', 'Repair the local state file or its permissions, then retry capture.'],
  missing: ["This project's folder is unavailable.", 'Open the folder again, then retry capture.'],
} as const

export const captureHealth = (input: HealthInput): CaptureHealth => {
  const { fatal, issues, ...base } = input
  const key: keyof typeof messages = !input.enabled && !issues.includes('preference-invalid') ? 'off'
    : fatal ? issues.includes('external-metadata') ? 'external' : issues.includes('folder-unavailable') ? 'missing' : 'storage'
    : issues.includes('limit-exceeded') ? 'limit'
    : input.gaps > 0 || issues.includes('history-gap') ? 'history'
    : issues.includes('watch-unavailable') ? 'polling'
    : input.pending > 0 || input.checkedAt === null ? 'pending' : 'current'
  const [reason, nextStep] = messages[key]
  return {
    ...base,
    state: key === 'off' || fatal ? 'stopped' : key === 'current' ? 'healthy' : 'degraded',
    reason,
    nextStep,
  }
}
```

The preference queue publishes only after its temporary file has been synced and renamed. An error before rename retains both the old disk file and the old published value. A directory-sync error after rename is reported rather than claimed as success; retry reloads the file before resuming capture. The key is the SHA-256 of an admitted canonical project path. No repository-supplied path or ref becomes a preference filename.

- [ ] **Step 4: Add the protocol backup envelope and historical import implementation.**

In `packages/protocol/src/provenance.ts`, replace this exact anchor:

```ts
export interface ProvenanceSeatDetail {
  readonly seat: SeatRecord | null
  readonly session: SessionPointer | null
  readonly unavailable: string | null
}
```

with:

```ts
export interface ProvenanceSeatDetail {
  readonly seat: SeatRecord | null
  readonly session: SessionPointer | null
  readonly unavailable: string | null
}

/** Historical observations only. A backup never activates local capture. */
export interface ProvenanceBackup {
  readonly version: 1
  readonly projects: readonly {
    readonly project: string
    readonly entries: readonly unknown[]
  }[]
}
```

In `packages/protocol/src/wire.ts`, replace this exact anchor:

```ts
import type { ApprovalDecision } from './approval.js'
```

with:

```ts
import type { ApprovalDecision } from './approval.js'
import type { ProvenanceBackup } from './provenance.js'
```

In `packages/protocol/src/wire.ts`, replace this exact anchor:

```ts
  readonly seating?: Readonly<Record<string, unknown>> | null
```

with:

```ts
  readonly seating?: Readonly<Record<string, unknown>> | null
  /** Historical provenance only; never capture preferences or live cursors. */
  readonly provenance?: ProvenanceBackup
```

In `packages/protocol/src/wire.ts`, replace this exact anchor:

```ts
  readonly seating: { readonly restored: number; readonly skipped: number }
```

with:

```ts
  readonly seating: { readonly restored: number; readonly skipped: number }
  readonly provenance: {
    readonly restored: number
    readonly duplicate: number
    readonly refused: number
  }
```

Create `packages/server/src/provenance/backup.ts` with these complete contents:

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'

import type { ProvenanceBackup } from '@harnessdesk/protocol'

import { digest, JOURNAL_LIMIT, object, ProvenanceJournal, validValue, type JournalKind } from './journal.js'

export interface BackupPort {
  prepare?(project: string): Promise<void>
  projects(): Promise<readonly string[]>
  journal(project: string): ProvenanceJournal
}
export interface ProvenanceRestoreReport {
  restored: number
  duplicate: number
  refused: number
}
const BYTES = 10 * 1024 * 1024
const historical = new Set<JournalKind>(['ref', 'commit', 'range', 'link', 'gap'])
const projectPath = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 4096 && isAbsolute(value) && normalize(value) === value && !value.includes('\0')

export const exportProvenance = async (port: BackupPort): Promise<ProvenanceBackup> => {
  const projects: { project: string; entries: unknown[] }[] = []
  let count = 0
  for (const project of await port.projects()) {
    const read = await port.journal(project).read()
    if (read.broken) throw new Error('provenance-journal-damaged')
    const entries = read.entries.filter((entry) => historical.has(entry.kind))
      .map(({ kind, value }) => ({ kind, value }))
    if (!entries.length) continue
    projects.push({ project, entries })
    count += entries.length
    if (projects.length > 100 || count > 50000 || Buffer.byteLength(JSON.stringify(projects)) > BYTES) {
      throw new Error('provenance-backup-limit')
    }
  }
  return { version: 1, projects }
}

/** The plane serializes imports with its project lifecycle; the journal deduplicates writes. */
export const importProvenance = async (
  port: BackupPort,
  raw: unknown,
  now = Date.now(),
): Promise<ProvenanceRestoreReport> => {
  const report = { restored: 0, duplicate: 0, refused: 0 }
  if (raw === undefined) return report
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.projects) ||
    raw.projects.length > 100 || Buffer.byteLength(JSON.stringify(raw)) > BYTES) {
    return { ...report, refused: 1 }
  }
  let count = 0
  for (const project of raw.projects) {
    if (!object(project) || !projectPath(project.project) || !Array.isArray(project.entries)) {
      report.refused += 1
      continue
    }
    await port.prepare?.(project.project)
    const journal = port.journal(project.project)
    const read = await journal.read()
    const ids = new Set(read.entries.map((entry) => `${entry.kind}:${(entry.value as { id: string }).id}`))
    for (const entry of project.entries) {
      if (++count > 50000 || read.broken || !object(entry) || !historical.has(entry.kind as JournalKind) ||
        !validValue(entry.kind as JournalKind, entry.value) || Buffer.byteLength(JSON.stringify(entry)) > JOURNAL_LIMIT - 512) {
        report.refused += 1
        continue
      }
      const kind = entry.kind as JournalKind
      const input = entry.value as Record<string, unknown>
      const data = 'restoredAt' in input ? input.data as Record<string, unknown> : input
      const id = digest(['restored', kind, data.id])
      // A local observation always wins. Imported IDs never shadow a later local observation.
      if (ids.has(`${kind}:${id}`) || ids.has(`${kind}:${data.id}`)) {
        report.duplicate += 1
        continue
      }
      try {
        await journal.append(kind, { id, restoredAt: now, data })
        ids.add(`${kind}:${id}`)
        report.restored += 1
      } catch {
        report.refused += 1
      }
    }
  }
  return report
}

/** Task 4's host composition; Task 5 moves ownership to the live plane. */
export class ProvenanceBackups {
  readonly #journals = new Map<string, ProvenanceJournal>()
  #tail: Promise<unknown> = Promise.resolve()
  constructor(readonly store: {
    folderOf(project: string): string
    projects(): Promise<readonly string[]>
  }) {}

  #journal(project: string): ProvenanceJournal {
    let journal = this.#journals.get(project)
    if (!journal) {
      journal = new ProvenanceJournal(join(this.store.folderOf(project), 'provenance.ndjson'))
      this.#journals.set(project, journal)
    }
    return journal
  }

  #port(): BackupPort {
    return {
      projects: async () => [...new Set([...await this.store.projects(), ...this.#journals.keys()])],
      journal: (project) => this.#journal(project),
      prepare: async (project) => {
        const folder = this.store.folderOf(project)
        await mkdir(folder, { recursive: true, mode: 0o700 })
        await writeFile(join(folder, 'project.json'), `${JSON.stringify({ root: project })}\n`, { flag: 'wx', mode: 0o600 })
          .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      },
    }
  }

  #queue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(action)
    this.#tail = next.catch(() => {})
    return next
  }

  backup(): Promise<ProvenanceBackup> {
    return this.#queue(() => exportProvenance(this.#port()))
  }

  restore(raw: unknown): Promise<ProvenanceRestoreReport> {
    return this.#queue(() => importProvenance(this.#port(), raw))
  }

  async close(): Promise<void> {
    await this.#tail
    for (const journal of this.#journals.values()) await journal.flush()
  }
}
```

The backup bounds are checked before adding records: 10 MiB, 100 projects, 50,000 records and the journal line limit. A cursor is never historical data. Imports are serialized by the owner and deduplicated by observation identity. Failed writes are counted as refused because this phase fixed the report to those three counters. Export fails explicitly on corruption or an oversized backup; it never returns an apparently complete truncated export. The existing evidence `project.json` marker makes a provenance-only project discoverable after restart without creating a Seat or fact.

- [ ] **Step 5: Compose backup in the host and extend the existing integration test.**

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
import { EvidencePlane } from './evidence/plane.js'
```

with:

```ts
import { EvidencePlane } from './evidence/plane.js'
import { ProvenanceBackups } from './provenance/backup.js'
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
  readonly #evidence: EvidencePlane
```

with:

```ts
  readonly #evidence: EvidencePlane
  readonly #provenanceBackups: ProvenanceBackups
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    this.#context = this.#buildContext()
```

with:

```ts
    this.#provenanceBackups = new ProvenanceBackups(this.#evidence.store)
    this.#context = this.#buildContext()
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
      evidence: await this.#evidence.backup(),
```

with:

```ts
      evidence: await this.#evidence.backup(),
      provenance: await this.#provenanceBackups.backup(),
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    const evidence = await this.#evidence.restore(file.evidence)
    this.#logger.info('backup restored', { agents, preferences, transcripts, agentFolders, seating, evidence })
    return { agents, preferences, transcripts, agentFolders, seating, evidence }
```

with:

```ts
    const evidence = await this.#evidence.restore(file.evidence)
    const provenance = await this.#provenanceBackups.restore(file.provenance)
    this.#logger.info('backup restored', { agents, preferences, transcripts, agentFolders, seating, evidence, provenance })
    return { agents, preferences, transcripts, agentFolders, seating, evidence, provenance }
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    await this.#evidence.close()
```

with:

```ts
    await this.#provenanceBackups.close().catch(() => {
      this.#logger.warn('provenance observations could not be saved')
    })
    await this.#evidence.close()
```

In `packages/server/test/backup.test.ts`, replace this exact anchor:

```ts
    ['agentFolders', 'agents', 'evidence', 'exportedAt', 'hostVersion', 'kind', 'preferences', 'seating', 'transcripts', 'version'],
```

with:

```ts
    ['agentFolders', 'agents', 'evidence', 'exportedAt', 'hostVersion', 'kind', 'preferences', 'provenance', 'seating', 'transcripts', 'version'],
```

Append this complete test to `packages/server/test/backup.test.ts`. It uses that file’s existing `hostAt`, `mkdtemp`, `tmpdir`, `join`, `rm` and `assert`; it adds no runtime or listener.

```ts
test('the host carries provenance as historical observations and deduplicates a second restore', async (t) => {
  const firstDir = await mkdtemp(join(tmpdir(), 'provenance-backup-first-'))
  const secondDir = await mkdtemp(join(tmpdir(), 'provenance-backup-second-'))
  t.after(async () => rm(firstDir, { recursive: true, force: true }))
  t.after(async () => rm(secondDir, { recursive: true, force: true }))
  const first = await hostAt(firstDir)
  const second = await hostAt(secondDir)
  t.after(() => first.host.dispose())
  t.after(() => second.host.dispose())
  const backup = await first.host.call('backup/export', {})
  assert.deepEqual(backup.provenance, { version: 1, projects: [] })
  const carried = {
    ...backup,
    provenance: {
      version: 1,
      projects: [{
        project: '/work/project',
        entries: [{ kind: 'gap', value: { id: 'historical-gap', reason: 'history-gap', from: null, to: 10 } }],
      }],
    },
  }
  const restored = await second.host.call('backup/import', { backup: carried })
  assert.deepEqual(restored.provenance, { restored: 1, duplicate: 0, refused: 0 })
  const again = await second.host.call('backup/import', { backup: carried })
  assert.deepEqual(again.provenance, { restored: 0, duplicate: 1, refused: 0 })
  const exported = await second.host.call('backup/export', {})
  const entry = exported.provenance?.projects[0]?.entries[0] as { value: { restoredAt: number } }
  assert.equal(typeof entry.value.restoredAt, 'number')
})
```

- [ ] **Step 6: Run the focused persistence proof and then the host composition test.**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/provenance-journal.test.js packages/server/dist/test/provenance-backup.test.js`

Expected: exit 0; **12 tests, 12 pass, 0 fail**.

Run: `node --test --test-reporter=spec --test-name-pattern="the host carries provenance" packages/server/dist/test/backup.test.js`

Expected: exit 0; **1 test, 1 pass, 0 fail**. This host-composition test is written in full but was not run in the planning scratch, which has the Phase 4 store and record reader but not its integrated Host. It remains a required implementation check.

- [ ] **Step 7: Prove damaged-prefix, off-state and restored-history guards independently.**

In `packages/server/src/provenance/journal.ts`, replace this exact anchor:

```ts
      if (this.#broken) throw new Error('provenance-journal-damaged')
```

with:

```ts
      if (this.#broken && false) throw new Error('provenance-journal-damaged')
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="a torn tail" packages/server/dist/test/provenance-journal.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: Missing expected rejection.` Restore the original guard immediately.

In `packages/server/src/provenance/health.ts`, replace this exact anchor:

```ts
  const key: keyof typeof messages = !input.enabled && !issues.includes('preference-invalid') ? 'off'
```

with:

```ts
  const key: keyof typeof messages = !input.enabled && false ? 'off'
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="health keeps" packages/server/dist/test/provenance-journal.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, actual `Capture could not save its observations.` versus expected `Capture is off on this machine.` Restore the original condition.

In `packages/server/src/provenance/backup.ts`, replace this exact anchor:

```ts
        await journal.append(kind, { id, restoredAt: now, data })
```

with:

```ts
        await journal.append(kind, data)
        void now
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="backup round-trips" packages/server/dist/test/provenance-backup.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `undefined !== 20` at the restored marker assertion. Restore the original append.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/provenance-journal.test.js packages/server/dist/test/provenance-backup.test.js`

Expected: exit 0; **12 tests, 12 pass, 0 fail**. The planning scratch executed all three mutations and this restored run.

- [ ] **Step 8: Controller commit after the phase gate.**

The plan writer does not commit. After the complete phase passes `pnpm verify` unpiped, the controller records the actual implementation writer and runs:

```bash
git add packages/protocol/src/provenance.ts packages/protocol/src/wire.ts packages/server/src/provenance/journal.ts packages/server/src/provenance/preferences.ts packages/server/src/provenance/health.ts packages/server/src/provenance/backup.ts packages/server/src/host.ts packages/server/test/provenance-journal.test.ts packages/server/test/provenance-backup.test.ts packages/server/test/backup.test.ts
git commit -m "feat: persist provenance and project capture health" --trailer "Co-Authored-By: Codex GPT-6 <agent@harnessdesk.app>"
```

### Task 5: Observe refs independently, catch up on start, and bound the work

A file event is a wakeup. The durable facts come from admitted snapshots, reflog cursors, immutable objects and local evidence. Startup, polling, a history request and an evidence change use the same serialized worker; no turn waits for it. The plane owns project lifecycle and the journal instances used by backup, so a restore cannot accidentally create a second writer.

**Files:**
- Create: `packages/server/src/provenance/observer.ts`, `packages/server/src/provenance/plane.ts`
- Create: `packages/server/test/provenance-observer.test.ts`
- Modify: `packages/server/src/host.ts`, `packages/protocol/src/wire.ts` (notification only)
- Named existing test edit: `packages/server/test/evidence-backup.test.ts` keeps its over-limit restore proof while allowing the already-open project marker passive provenance capture intentionally creates; it additionally asserts that the project's evidence lines remain empty.
- Consume unchanged: Tasks 1–4, including `GitReader`, `CommitObservation`, `RangeObservation`, `LinkObservation`, `ProvenanceJournal`, `ProvenancePreferences` and the Phase 4 evidence store.

**Proof needs:** file-watch events — Sonnet for the complete task. Codex can prove scheduling, storage, polling, cancellation, restart and projection in isolation. A passing polling test never substitutes for the two tests that explicitly disable polling and require real file notifications.

**Interfaces:** `ObserverCheckpoint` preserves `generation`, `refs`, `heads`, `logs`, `frontier`, `capturedThrough`, and `scanStartedAt`. The worker-private extension adds `rangeKeys`, `rangePending`, and `baseline`; it is written through Task 4's chunked manifests. `RefObserver(options).start(handle, checkpoint): Promise<void>`, `.wake(): void`, `.idle(): Promise<void>` and `.close(): Promise<void>` retain their fixed signatures. The additional `.request(shas): void` is an internal bounded history-read queue. `ProvenancePort` retains `evidence`, `stateDir`, `projects`, `push`, and `log`. `ProvenancePlane(port)` implements `start`, `setProjects`, `evidenceChanged`, `read`, `status`, `setCapture`, `retry`, `seat` and `close` with the signatures already fixed by this plan. `backup` and `restore` move Task 4's existing backup composition into that single owner.

The notification is declared here, before the plane emits it; Task 6 then declares and validates the five requests before adding handlers. No request is reachable in this task.

- [ ] **Step 1: Write the scheduler, observer, restart and lifecycle tests in full.**

Create `packages/server/test/provenance-observer.test.ts` with these complete contents:

```ts
import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { SeatRecord } from '@harnessdesk/protocol'

import type { EvidencePlane } from '../src/evidence/plane.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { admitProject, gitReader, type GitReader } from '../src/provenance/git.js'
import { ProvenanceJournal, readCheckpoint } from '../src/provenance/journal.js'
import { Coalesced, RefObserver, type WorkerCheckpoint } from '../src/provenance/observer.js'
import { ProvenancePlane } from '../src/provenance/plane.js'
import { makeRepo } from './fixtures/provenance-repo.js'

const waitUntil = async (condition: () => boolean | Promise<boolean>, name: string): Promise<void> => {
  const deadline = Date.now() + 10000
  while (!await condition()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${name}`)
    await delay(20)
  }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('wake returns immediately and microtask bursts coalesce without concurrent scans', async () => {
  const gate = deferred()
  let calls = 0
  let active = 0
  let peak = 0
  const queue = new Coalesced(async () => {
    calls += 1
    peak = Math.max(peak, ++active)
    if (calls === 1) await gate.promise
    active -= 1
  }, (error) => { throw error })
  assert.equal(queue.wake(), undefined)
  await Promise.resolve()
  for (let i = 0; i < 40; i += 1) {
    queue.wake()
    await Promise.resolve()
  }
  assert.equal(calls, 1, 'only one scan may run while the first is blocked')
  gate.resolve()
  await queue.idle()
  assert.equal(calls, 2)
  assert.equal(peak, 1)
  await queue.close()
})

test('a failed scan can retry and close aborts active work without requeue', async () => {
  let calls = 0
  const errors: unknown[] = []
  const queue = new Coalesced(async (signal) => {
    calls += 1
    if (calls === 1) throw new Error('scan-failed')
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }, (error) => errors.push(error))
  queue.wake()
  await queue.idle()
  assert.equal(errors.length, 1)
  queue.wake()
  await Promise.resolve()
  const closing = queue.close()
  queue.wake()
  await closing
  assert.equal(calls, 2)
  assert.equal(queue.controller.signal.aborted, true)
})

test('settled scans keep existing metadata watches attached', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  let opened = 0
  let closed = 0
  const fakeWatch = (() => {
    opened += 1
    const watcher = {
      on: () => watcher,
      close: () => { closed += 1 },
    }
    return watcher
  }) as unknown as typeof watch
  const observer = new RefObserver({
    git: gitReader(handle), journal, changed: () => {}, problem: () => {}, watch: fakeWatch, pollMs: 0,
  })
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  const attached = opened
  assert.ok(attached > 0)
  observer.wake()
  await observer.idle()
  assert.equal(opened, attached, 'a settled rescan must not replace every existing watcher')
  assert.equal(closed, 0, 'a settled rescan must leave every existing watcher attached')
})

const observed = async (t: TestContext, options: { watch?: typeof watch; pollMs?: number } = {}) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  const problems: string[] = []
  let changed = 0
  const observer = new RefObserver({
    git: gitReader(handle), journal, changed: () => { changed += 1 },
    problem: (_kind, reason) => problems.push(reason), debounceMs: 5, pollMs: 0, ...options,
  })
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  const has = async (sha: string) => (await journal.read()).entries.some((entry) =>
    entry.kind === 'commit' && (entry.value as { sha: string }).sha === sha,
  )
  assert.equal(await has(base), true)
  return { repo, base, journal, observer, problems, has, changed: () => changed }
}

test('real watches capture external branches, tags, rewinds and rapid round trips without turns', async (t) => {
  const f = await observed(t)
  assert.ok(!f.problems.includes('watch-unavailable'), 'real file notifications must attach')
  const next = await f.repo.commitTree(f.base, { one: 'changed\n' }, 'next')
  await f.repo.git('update-ref', 'refs/heads/main', next)
  await waitUntil(() => f.has(next), 'external fast-forward')
  await f.repo.git('update-ref', 'refs/heads/topic', next)
  await f.repo.git('update-ref', 'refs/heads/main', f.base)
  await f.repo.git('update-ref', 'refs/heads/main', next)
  await f.repo.git('update-ref', 'refs/heads/main', f.base)
  await f.repo.git('tag', 'light', next)
  await f.repo.git('tag', '-a', 'annotated', '-m', 'tag', next)
  await f.repo.git('pack-refs', '--all')
  await waitUntil(async () => (await f.journal.read()).entries.filter((entry) => entry.kind === 'ref' &&
    (entry.value as { ref: string; after: string }).ref === 'refs/heads/main' &&
    (entry.value as { after: string }).after === f.base).length >= 2, 'repeated reflog movements')
  await f.repo.git('update-ref', '-d', 'refs/heads/topic')
  await waitUntil(async () => (await f.journal.read()).entries.some((entry) => entry.kind === 'ref' &&
    (entry.value as { ref: string; after: string | null }).ref === 'refs/heads/topic' &&
    (entry.value as { after: string | null }).after === null), 'branch deletion')
  assert.ok(f.changed() > 1)
})

test('detached HEAD, atomic ref replacement and a newly admitted linked HEAD are observed', async (t) => {
  const f = await observed(t)
  assert.ok(!f.problems.includes('watch-unavailable'), 'real file notifications must attach')
  const next = await f.repo.commitTree(f.base, { two: 'next\n' }, 'next')
  await f.repo.git('checkout', '--detach', f.base)
  await f.repo.git('update-ref', '--no-deref', 'HEAD', next)
  await waitUntil(() => f.has(next), 'detached HEAD')
  const ref = join(f.repo.dir, '.git/refs/heads/atomic')
  await writeFile(`${ref}.lock`, `${next}\n`)
  await rename(`${ref}.lock`, ref)
  await waitUntil(async () => (await f.journal.read()).entries.some((entry) => entry.kind === 'ref' &&
    (entry.value as { ref: string }).ref === 'refs/heads/atomic'), 'atomic replacement')
  await f.observer.close()
  const linked = join(f.repo.stateDir, 'linked')
  await f.repo.git('worktree', 'add', '--detach', linked, f.base)
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir, linked])
  const observer = new RefObserver({ git: gitReader(handle), journal: f.journal, changed: () => {},
    problem: () => {}, debounceMs: 5, pollMs: 0 })
  t.after(() => observer.close())
  await observer.start(handle, readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint)
  await observer.idle()
  const linkedHead = join(handle.checkouts.get(linked)!, 'HEAD')
  await writeFile(linkedHead, `${next}\n`)
  await waitUntil(async () => (await f.journal.read()).entries.some((entry) => entry.kind === 'ref' &&
    (entry.value as { checkout: string; after: string }).checkout === linked &&
    (entry.value as { after: string }).after === next), 'linked HEAD')
})

test('restart catches up and a removed reflog leaves a durable gap', async (t) => {
  const f = await observed(t)
  await f.observer.close()
  const next = await f.repo.commitTree(f.base, { one: 'offline\n' }, 'offline')
  await f.repo.git('update-ref', 'refs/heads/main', next)
  await rm(join(f.repo.dir, '.git/logs/refs/heads/main'))
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir])
  const problems: string[] = []
  const observer = new RefObserver({ git: gitReader(handle), journal: f.journal, changed: () => {},
    problem: (_kind, reason) => problems.push(reason) })
  t.after(() => observer.close())
  await observer.start(handle, readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint)
  await observer.idle()
  assert.equal(await f.has(next), true)
  assert.ok(problems.includes('history-gap'))
  assert.ok((await f.journal.read()).entries.some((entry) => entry.kind === 'gap'))
})

test('unavailable watches use real polling and say capture is degraded', async (t) => {
  const f = await observed(t, { watch: (() => { throw new Error('watch-refused') }) as typeof watch, pollMs: 1000 })
  const next = await f.repo.commitTree(f.base, { one: 'poll\n' }, 'poll')
  await f.repo.git('update-ref', 'refs/heads/main', next)
  await waitUntil(() => f.has(next), 'polling fallback')
  assert.ok(f.problems.includes('watch-unavailable'))
})

test('parent work beyond the batch survives checkpoint replay and abort never writes a cursor', async (t) => {
  const f = await observed(t)
  await f.observer.close()
  const start = readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint
  const tip = 'e'.repeat(40)
  const parent = 'd'.repeat(40)
  const controller = deferred()
  let entered = false
  const fake: GitReader = {
    snapshot: async () => ({ refs: new Map([['refs/heads/main', tip]]), heads: new Map(), takenAt: Date.now() }),
    reflogs: async () => ({ moves: [], cursors: new Map(), gaps: [], more: false }),
    commit: async (sha, signal) => {
      if (sha === parent) {
        entered = true
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        signal.throwIfAborted()
      }
      await delay(55)
      return { sha, tree: sha, parents: [parent] }
    },
    patch: async () => ({ stable: '', exact: '', files: [] }), files: async () => [],
    ancestors: async () => [], close: async () => { controller.resolve() },
  }
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir])
  t.after(() => gitReader(handle).close())
  const observer = new RefObserver({ git: fake, journal: f.journal, changed: () => {}, problem: () => {}, pollMs: 60000 })
  await observer.start(handle, start)
  await waitUntil(() => entered, 'second parent read')
  const before = readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint
  assert.ok(before.frontier.includes(parent), 'the unvisited parent must be durable')
  await observer.close()
  await controller.promise
  assert.deepEqual(readCheckpoint((await f.journal.read()).entries), before)
})

test('plane disables, re-enables, forgets and closes independent projects without late registration', async () => {
  const one = await makeRepo()
  const two = await makeRepo()
  const store = new EvidenceStore(join(one.stateDir, 'evidence'))
  const plane = new ProvenancePlane({
    evidence: { store, seats: { byId: () => null } } as unknown as EvidencePlane,
    stateDir: one.stateDir, projects: () => [one.dir, two.dir], push: () => {}, log: () => {},
  })
  try {
    await plane.start()
    await waitUntil(async () => (await plane.status()).length === 2, 'two project registrations')
    await plane.setCapture(one.dir, false)
    assert.equal((await plane.status(one.dir))[0]?.enabled, false)
    assert.equal((await plane.status(two.dir))[0]?.enabled, true)
    const reply = await plane.read(one.dir, ['a'.repeat(40)])
    assert.equal(reply.commits[0]?.reason, 'capture-off')
    await plane.setCapture(one.dir, true)
    assert.equal((await plane.status(one.dir))[0]?.enabled, true)
    plane.setProjects([two.dir])
    await waitUntil(async () => (await plane.status()).length === 1, 'forgotten project cleanup')
    assert.equal((await plane.status())[0]?.project, two.dir)
    assert.ok((await readFile(join(store.folderOf(one.dir), 'provenance.ndjson'), 'utf8')).includes('capture-toggle'))
  } finally {
    await plane.close()
  }
  const empty = new ProvenancePlane({ evidence: { store, seats: { byId: () => null } } as unknown as EvidencePlane,
    stateDir: one.stateDir, projects: () => [one.dir], push: () => assert.fail('late notification'), log: () => {} })
  const starting = empty.start()
  await empty.close()
  await starting
  assert.deepEqual(await empty.status(), [])
})


test('restart rebuilds a local fact from durable fingerprints after its original object disappears', async () => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const first = await repo.commitTree(base, { one: 'seat work\n' }, 'first')
  await repo.git('update-ref', 'refs/heads/main', first)
  const store = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const seat: SeatRecord = {
    id: 'seat-1', agent: null, briefDigest: null, seat: { runtime: 'fixture' }, seatLabel: 'Recorded seat',
    passedOver: [], standing: { kind: 'permission', permission: 'read' }, ceiling: null,
    checkout: { cwd: repo.dir, project: repo.dir, branch: 'main', head: base },
    session: { runtime: 'fixture', sessionId: 'original-session' }, board: null, role: null,
    openedAt: 1, closed: null,
  }
  const { closed, ...opening } = seat
  void closed
  await store.append(repo.dir, 'seats', [{ type: 'seat', record: opening }])
  await store.append(repo.dir, 'evidence', [{ type: 'evidence', record: {
    id: 'fact-1', seat: seat.id, checkout: { cwd: repo.dir, branch: 'main' }, observedAt: 10,
    fact: { kind: 'diff', from: base, to: first, files: 1, added: 1, removed: 1 },
  } }])
  const create = () => new ProvenancePlane({
    evidence: { store, seats: { byId: () => seat } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => [repo.dir], push: () => {}, log: () => {},
  })
  const old = create()
  await old.start()
  try {
    await waitUntil(async () => {
      if (!(await old.status()).length) return false
      return (await old.read(repo.dir, [first])).commits[0]?.state === 'attributed'
    }, 'original local association')
  } finally {
    await old.close()
  }
  const tree = await repo.git('rev-parse', `${first}^{tree}`)
  const rewritten = await repo.git('commit-tree', tree, '-p', base, '-m', 'message amend')
  await repo.git('update-ref', 'refs/heads/main', rewritten)
  await rename(join(repo.dir, '.git/objects', first.slice(0, 2), first.slice(2)), join(repo.stateDir, 'old-object'))
  const next = create()
  await next.start()
  try {
    await waitUntil(async () => {
      if (!(await next.status()).length) return false
      return (await next.read(repo.dir, [rewritten])).commits[0]?.state === 'attributed'
    }, 'association after original object loss')
    const result = (await next.read(repo.dir, [rewritten])).commits[0]!
    assert.equal(result.seats[0]?.session.sessionId, 'original-session')
    assert.deepEqual(result.evidenceIds, ['fact-1'])
  } finally {
    await next.close()
  }
})


test('an annotated tag captures its commit even when no branch reaches that commit', async (t) => {
  const repo = await makeRepo()
  const target = await repo.commitTree(null, { one: 'tag only\n' }, 'tag only')
  await repo.git('tag', '-a', 'only-tag', '-m', 'observed tag', target)
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const git = gitReader(handle)
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  const observer = new RefObserver({ git, journal, changed: () => {}, problem: () => {}, pollMs: 0 })
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  const read = await journal.read()
  assert.ok(read.entries.some((entry) => entry.kind === 'commit' && (entry.value as { sha: string }).sha === target))
  const tag = await repo.git('rev-parse', 'refs/tags/only-tag')
  assert.notEqual(tag, target)
  assert.ok(read.entries.some((entry) => entry.kind === 'ref' && (entry.value as { after: string }).after === tag))
  assert.ok(!(read.entries.some((entry) => entry.kind === 'commit' && (entry.value as { sha: string }).sha === tag)))
})


test('a crash after an object append requeues its parents before acknowledging the ref cursor', async (t) => {
  const f = await observed(t)
  await f.observer.close()
  const checkpoint = readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint
  const tip = 'e'.repeat(40)
  const parent = 'd'.repeat(40)
  await f.journal.append('commit', {
    id: 'unacknowledged-tip', sha: tip, tree: tip, parents: [parent], firstSeenAt: Date.now(),
    fingerprintVersion: 1, discoveredBy: [], checkoutHints: [f.repo.dir],
    window: { from: checkpoint.scanStartedAt, to: Date.now() },
    patch: { stable: '', exact: '', files: [] }, files: [], why: null,
  })
  const fake: GitReader = {
    snapshot: async () => ({ refs: new Map([['refs/heads/main', tip]]), heads: new Map(), takenAt: Date.now() }),
    reflogs: async () => ({ moves: [], cursors: new Map(checkpoint.logs), gaps: [], more: false }),
    commit: async (sha) => ({ sha, tree: sha, parents: [f.base] }),
    patch: async () => ({ stable: '', exact: '', files: [] }), files: async () => [],
    ancestors: async () => [], close: async () => {},
  }
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir])
  t.after(() => gitReader(handle).close())
  const observer = new RefObserver({ git: fake, journal: f.journal, changed: () => {}, problem: () => {}, pollMs: 0 })
  t.after(() => observer.close())
  await observer.start(handle, checkpoint)
  await observer.idle()
  assert.ok(await f.has(parent), 'an unacknowledged object must not lose its parent work')
  assert.deepEqual((readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint).frontier, [])
})
```

- [ ] **Step 2: Compile before either owner exists.**

Run: `pnpm run build:node`

Expected: exit 2; `error TS2307: Cannot find module '../src/provenance/observer.js' or its corresponding type declarations.` The missing `plane.js` import also fails.

- [ ] **Step 3: Implement the coalesced worker, durable frontier and watch registration.**

Every ref record and object precedes the cursor that acknowledges it. Baseline tips stop the initial walk; later work retains unvisited parents in `frontier`. A batch takes at most 200 objects and yields after its 50 ms budget; subprocess waits yield naturally. The reader already bounds each child to five seconds and 8 MiB, each reflog page to 2 MiB, global children to two and project children to one. This task never opens a checkout file named by a patch.

Create `packages/server/src/provenance/observer.ts` with these complete contents:

```ts
import { watch, type FSWatcher } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import type { GitReader, LogCursor, RepoHandle, ReflogMove } from './git.js'
import { digest, JOURNAL_LIMIT, object, ProvenanceJournal, type JournalEntry, writeCheckpoint } from './journal.js'
import { moves } from './model.js'
import type { CommitObservation } from './reconcile.js'

export interface ObserverCheckpoint {
  readonly generation: number
  readonly refs: readonly (readonly [string, string])[]
  readonly heads: readonly (readonly [string, string | null])[]
  readonly logs: readonly (readonly [string, LogCursor])[]
  readonly frontier: readonly string[]
  readonly capturedThrough: number
  readonly scanStartedAt: number
}
export interface WorkerCheckpoint extends ObserverCheckpoint {
  readonly rangeKeys: readonly string[]
  readonly rangePending: readonly string[]
  readonly baseline: readonly string[]
}
export interface RefObserverOptions {
  readonly git: GitReader
  readonly journal: ProvenanceJournal
  readonly changed: () => void
  readonly problem: (kind: 'degraded' | 'stopped', reason: string) => void
  readonly now?: () => number
  readonly reconcile?: (
    entries: readonly JournalEntry[], checkpoint: WorkerCheckpoint, signal: AbortSignal,
  ) => Promise<Pick<WorkerCheckpoint, 'rangeKeys' | 'rangePending'>>
  /** Tests can shorten clocks or refuse a watch; real-watch tests use the real function. */
  readonly watch?: typeof watch
  readonly pollMs?: number
  readonly debounceMs?: number
}

/** One active scan and one dirty bit, including wakes arriving between awaits. */
export class Coalesced {
  #dirty = false
  #closed = false
  #running: Promise<void> | null = null
  readonly controller = new AbortController()
  constructor(readonly scan: (signal: AbortSignal) => Promise<void>, readonly failed: (error: unknown) => void) {}

  wake(): void {
    if (this.#closed) return
    this.#dirty = true
    if (this.#running) return
    this.#running = Promise.resolve().then(async () => {
      while (this.#dirty && !this.#closed) {
        this.#dirty = false
        try {
          await this.scan(this.controller.signal)
        } catch (error) {
          if (!this.#closed) this.failed(error)
          this.#dirty = false
        }
        await setImmediate()
      }
    }).finally(() => { this.#running = null })
  }

  async idle(): Promise<void> {
    while (this.#running) await this.#running
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#dirty = false
    this.controller.abort()
    await this.idle()
  }
}

let watchers = 0
const empty = (): WorkerCheckpoint => ({
  generation: 0, refs: [], heads: [], logs: [], frontier: [],
  capturedThrough: 0, scanStartedAt: 0, rangeKeys: [], rangePending: [], baseline: [],
})
const values = <T>(entries: readonly JournalEntry[], kind: JournalEntry['kind']): T[] =>
  entries.filter((entry) => entry.kind === kind && !('restoredAt' in (entry.value as object)))
    .map((entry) => entry.value as T)
export { values as localValues }

export class RefObserver {
  readonly #options: RefObserverOptions
  readonly #queue: Coalesced
  #checkpoint = empty()
  #handle: RepoHandle | null = null
  #closed = false
  #watchers = new Map<string, FSWatcher>()
  #poll: ReturnType<typeof setTimeout> | null = null
  #debounce: ReturnType<typeof setTimeout> | null = null
  #requested = new Set<string>()

  constructor(options: RefObserverOptions) {
    this.#options = options
    this.#queue = new Coalesced((signal) => this.#scan(signal), (error) => {
      const reason = (error as Error).message
      options.problem(reason.startsWith('provenance-') ? 'stopped' : 'degraded',
        reason.includes('limit') ? 'limit-exceeded' : reason.startsWith('provenance-') ? 'storage-failed' : 'history-gap')
    })
  }

  async start(handle: RepoHandle, checkpoint: ObserverCheckpoint | null): Promise<void> {
    if (this.#closed) return
    this.#handle = handle
    this.#checkpoint = checkpoint ? { ...empty(), ...checkpoint } : empty()
    await this.#attach()
    if (this.#closed) return
    this.#schedulePoll(true)
    this.wake()
  }

  wake(): void {
    this.#queue.wake()
  }

  /** History reads queue only full IDs, and never wait for their objects. */
  request(shas: readonly string[]): void {
    for (const sha of shas) this.#requested.add(sha)
    this.wake()
  }

  idle(): Promise<void> {
    return this.#queue.idle()
  }

  #schedulePoll(first = false): void {
    if (this.#closed) return
    const interval = this.#options.pollMs ?? 30000
    if (interval === 0) return
    this.#poll = setTimeout(() => {
      this.wake()
      this.#schedulePoll()
    }, first ? Math.max(1, Math.floor(Math.random() * interval)) : interval)
    this.#poll.unref()
  }

  #event(): void {
    if (this.#closed || this.#debounce) return
    this.#debounce = setTimeout(() => {
      this.#debounce = null
      this.wake()
    }, this.#options.debounceMs ?? 250)
    this.#debounce.unref()
  }

  async #attach(): Promise<void> {
    if (!this.#handle || this.#closed) return
    const directories = new Set<string>()
    let visited = 0
    const add = async (path: string, descend: boolean): Promise<void> => {
      if (this.#closed) return
      if (++visited > 50000) throw new Error('limit-exceeded')
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!info) return
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('external-metadata')
      directories.add(path)
      if (descend) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('external-metadata')
          if (entry.isDirectory()) await add(join(path, entry.name), true)
        }
      }
    }
    try {
      await add(this.#handle.commonDir, false)
      await add(join(this.#handle.commonDir, 'refs'), true)
      await add(join(this.#handle.commonDir, 'logs'), true)
      await add(join(this.#handle.commonDir, 'worktrees'), false)
      for (const gitdir of this.#handle.checkouts.values()) {
        await add(gitdir, false)
        await add(join(gitdir, 'logs'), true)
      }
      for (const directory of directories) {
        if (this.#closed) break
        if (this.#watchers.has(directory)) continue
        if (this.#watchers.size >= 256 || watchers >= 1024) throw new Error('watch-limit')
        const watcher = (this.#options.watch ?? watch)(directory, () => this.#event())
        watcher.on('error', () => {
          if (this.#watchers.get(directory) === watcher) {
            this.#watchers.delete(directory)
            watcher.close()
            watchers -= 1
          }
          this.#options.problem('degraded', 'watch-unavailable')
          // Polling retries attachment; an error must not create a rescan loop.
        })
        this.#watchers.set(directory, watcher)
        watchers += 1
      }
      for (const [directory, watcher] of this.#watchers) {
        if (directories.has(directory)) continue
        watcher.close()
        this.#watchers.delete(directory)
        watchers -= 1
      }
    } catch {
      this.#options.problem('degraded', 'watch-unavailable')
    }
  }

  async #scan(signal: AbortSignal): Promise<void> {
    if (!this.#handle) return
    const { git, journal } = this.#options
    const now = this.#options.now ?? Date.now
    const prior = this.#checkpoint
    const read = await journal.read()
    if (read.broken) throw new Error('provenance-journal-damaged')
    const commits = new Map(values<CommitObservation>(read.entries, 'commit').map((entry) => [entry.sha, entry]))
    const acknowledged = [...read.entries].reverse().find((entry) => entry.kind === 'cursor' &&
      object(entry.value) && entry.value.type === 'checkpoint')?.seq ?? 0
    const unacknowledged = new Set(read.entries.filter((entry) => entry.seq > acknowledged &&
      entry.kind === 'commit' && object(entry.value) && !('restoredAt' in entry.value))
      .map((entry) => (entry.value as CommitObservation).sha))
    const snapshot = await git.snapshot(signal)
    const logs = await git.reflogs(new Map(prior.logs), signal)
    const generation = prior.generation + 1
    const delta: ReflogMove[] = moves(new Map(prior.refs), snapshot.refs).map((move) => ({
      ...move, id: digest(['snapshot', generation, move]), checkout: null, recordedAt: null,
    }))
    for (const checkout of new Set([...new Map(prior.heads).keys(), ...snapshot.heads.keys()])) {
      const before = new Map(prior.heads).get(checkout) ?? null
      const after = snapshot.heads.get(checkout) ?? null
      if (before !== after) delta.push({
        id: digest(['head', generation, checkout, before, after]), ref: 'HEAD', checkout,
        before, after, recordedAt: null,
      })
    }
    for (const move of [...logs.moves, ...delta]) await journal.append('ref', move)
    const gaps = [...logs.gaps]
    if (prior.generation && delta.some((move) => !logs.moves.some((logged) =>
      logged.ref === move.ref && logged.checkout === move.checkout && logged.after === move.after,
    ))) gaps.push('snapshot-only')
    for (const reason of new Set(gaps)) {
      await journal.append('gap', {
        id: digest(['gap', generation, reason]), reason, from: prior.scanStartedAt || null, to: snapshot.takenAt,
      })
      this.#options.problem('degraded', 'history-gap')
    }
    const first = prior.generation === 0
    const tips = first ? [...snapshot.refs.values(), ...snapshot.heads.values()]
      : [...logs.moves, ...delta].flatMap((move) => [move.before, move.after])
    const requested = [...this.#requested]
    const frontier = [...new Set([...prior.frontier, ...tips, ...requested].filter((sha): sha is string => !!sha))]
    const baseline = first ? [...new Set(tips.filter((sha): sha is string => !!sha))] : [...prior.baseline]
    const began = performance.now()
    let captured = 0
    while (frontier.length && captured < 200 && performance.now() - began < 50) {
      signal.throwIfAborted()
      const sha = frontier.shift()!
      const existing = commits.get(sha)
      if (existing) {
        if (unacknowledged.delete(sha) && !first && !baseline.includes(sha)) {
          for (const parent of existing.parents) if (!commits.has(parent) && !frontier.includes(parent)) frontier.push(parent)
        }
        continue
      }
      const object = await git.commit(sha, signal)
      if (!object) {
        // Refs retain tag object IDs. A bounded rev-list peels a tag without
        // executing project configuration or traversing its whole ancestry.
        const targets = await git.ancestors([sha], new Set(), 1, signal).catch(() => [])
        signal.throwIfAborted()
        const target = targets[0]
        if (target && target !== sha) {
          if (first && !baseline.includes(target)) baseline.push(target)
          if (!commits.has(target) && !frontier.includes(target)) frontier.unshift(target)
          captured += 1
          continue
        }
      }
      let observation: CommitObservation = {
        id: digest(['commit', 1, sha]), sha, tree: object?.tree ?? sha, parents: object?.parents ?? [],
        firstSeenAt: now(), fingerprintVersion: 1,
        discoveredBy: [...logs.moves, ...delta].filter((move) => move.before === sha || move.after === sha).map((move) => move.id),
        checkoutHints: [...this.#handle.checkouts.keys()],
        window: { from: prior.scanStartedAt || null, to: snapshot.takenAt },
        patch: null, files: [], why: object ? null : 'missing-object',
      }
      if (object) {
        try {
          const from = object.parents[0] ?? null
          observation = { ...observation, patch: await git.patch(from, sha, signal), files: await git.files(from, sha, signal) }
        } catch (error) {
          signal.throwIfAborted()
          observation = { ...observation, why: (error as Error).message === 'limit-exceeded' ? 'limit-exceeded' : 'missing-object' }
        }
      }
      if (Buffer.byteLength(JSON.stringify(observation)) > JOURNAL_LIMIT - 1024) {
        observation = { ...observation, patch: null, files: [], discoveredBy: [], checkoutHints: [], why: 'limit-exceeded' }
      }
      await journal.append('commit', observation)
      commits.set(sha, observation)
      if (observation.why) this.#options.problem('degraded', observation.why === 'limit-exceeded' ? 'limit-exceeded' : 'history-gap')
      if (!first && !baseline.includes(sha)) {
        for (const parent of observation.parents) if (!commits.has(parent) && !frontier.includes(parent)) frontier.push(parent)
      }
      captured += 1
    }
    signal.throwIfAborted()
    let next: WorkerCheckpoint = {
      generation, refs: [...snapshot.refs], heads: [...snapshot.heads], logs: [...logs.cursors],
      frontier, capturedThrough: captured ? now() : prior.capturedThrough, scanStartedAt: snapshot.takenAt,
      baseline, rangeKeys: prior.rangeKeys, rangePending: prior.rangePending,
    }
    if (this.#options.reconcile) {
      const ranges = await this.#options.reconcile((await journal.read()).entries, next, signal)
      next = { ...next, ...ranges }
    }
    signal.throwIfAborted()
    await writeCheckpoint(journal, next)
    this.#checkpoint = next
    for (const sha of requested) this.#requested.delete(sha)
    await this.#attach()
    this.#options.changed()
    if (logs.more || frontier.length || next.rangePending.some((key) => !key.startsWith('limit:'))) this.wake()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#poll) clearTimeout(this.#poll)
    if (this.#debounce) clearTimeout(this.#debounce)
    for (const watcher of this.#watchers.values()) {
      watcher.close()
      watchers -= 1
    }
    this.#watchers.clear()
    await this.#queue.close()
    await this.#options.git.close()
    await this.#options.journal.flush()
  }
}
```

Watch registration enumerates only admitted metadata directories, caps a project at 256 watches and the process at 1,024, and never treats the event filename as a path. Renames, null filenames and ordinary changes all schedule the same debounced rescan. Watch errors retain degraded health and wait for polling to retry attachment; immediately waking on every attachment error creates an unbounded retry loop. The test-only `pollMs: 0` disables polling for the real-event proofs. Production omits the option and uses a randomized initial offset followed by 30-second polling, with unreferenced timers.

- [ ] **Step 4: Declare the notification, then add the complete project plane.**

In `packages/protocol/src/wire.ts`, replace this exact anchor:

```ts
import type { ProvenanceBackup } from './provenance.js'
```

with:

```ts
import type { CaptureHealth, ProvenanceBackup } from './provenance.js'
```

In `packages/protocol/src/wire.ts`, replace this exact anchor:

```ts
export type WireNotification =
```

with:

```ts
export type WireNotification =
  | {
      readonly method: 'provenance/changed'
      readonly params: {
        readonly project: string
        readonly revision: number
        readonly health: CaptureHealth
      }
    }
```

Create `packages/server/src/provenance/plane.ts` with these complete contents:

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  CaptureHealth, CommitProvenance, EvidenceRecord, ProjectProvenance,
  ProvenanceReason, ProvenanceSeatDetail, SeatRecord, WireNotification,
} from '@harnessdesk/protocol'

import type { EvidencePlane } from '../evidence/plane.js'
import { foldSeats } from '../evidence/records.js'
import { exportProvenance, importProvenance } from './backup.js'
import { admitProject, gitReader, oid, type GitReader, type RepoHandle } from './git.js'
import { captureHealth } from './health.js'
import { digest, object, ProvenanceJournal, readCheckpoint, type JournalEntry } from './journal.js'
import { localValues, RefObserver, type WorkerCheckpoint } from './observer.js'
import { ProvenancePreferences } from './preferences.js'
import {
  captureRange, factSource, rangeCandidates, rangeSource, reconcileProject, relatedEvidence,
  type CommitObservation, type LinkObservation, type RangeObservation, type ProvenanceSource,
} from './reconcile.js'

export interface ProvenancePort {
  readonly evidence: EvidencePlane
  readonly stateDir: string
  readonly projects: () => readonly string[]
  readonly push: (notice: WireNotification) => void
  readonly log: (message: string, details?: Readonly<Record<string, unknown>>) => void
}
interface Project {
  project: string
  handle: RepoHandle | null
  observer: RefObserver | null
  journal: ProvenanceJournal
  entries: readonly JournalEntry[]
  seats: readonly SeatRecord[]
  facts: readonly EvidenceRecord[]
  health: CaptureHealth
  issues: Set<string>
  fatal: boolean
  pending: Set<string>
  catchingUp: boolean
  factSources: Map<string, ProvenanceSource>
  reconciled: string | null
  links: Map<string, LinkObservation>
  historical: Map<string, LinkObservation>
  observed: Set<string>
}
const reasons = new Set<ProvenanceReason>([
  'not-observed', 'capture-off', 'capture-stopped', 'catching-up', 'no-seat-evidence',
  'ambiguous-patch', 'empty-change', 'changed-patch', 'missing-object', 'history-gap',
  'limit-exceeded', 'unsupported-merge', 'restored-history',
])
const explanation = (reason: ProvenanceReason | null): string => {
  switch (reason) {
    case null: return 'Associated with the Seat whose observed patch matches this commit.'
    case 'catching-up': return 'Capture is still reading this commit.'
    case 'capture-off': return 'Capture is off on this machine.'
    case 'capture-stopped': return 'Capture needs attention before this commit can be read.'
    case 'ambiguous-patch': return 'More than one source could explain this patch.'
    case 'changed-patch': return 'Only the unchanged file contributions could be associated.'
    case 'missing-object': return 'Git no longer exposes an object needed for this association.'
    case 'history-gap': return 'The observed history does not establish this association.'
    case 'limit-exceeded': return 'This commit exceeded a background capture limit.'
    case 'unsupported-merge': return 'No observed fact establishes ownership of this merge.'
    case 'restored-history': return 'This association came from a backup and is historical.'
    case 'empty-change': return 'This commit has no changed patch to associate.'
    case 'no-seat-evidence': return 'No matching local Seat evidence was observed.'
    case 'not-observed': return 'This commit has not been observed on this machine.'
  }
}

export class ProvenancePlane {
  readonly #port: ProvenancePort
  #preferences: ProvenancePreferences
  #projects = new Map<string, Project>()
  #aliases = new Map<string, string>()
  #journals = new Map<string, ProvenanceJournal>()
  #roots: readonly string[] = []
  #revision = 0
  #generation = 0
  #closed = false
  #started = false
  #tail: Promise<void> = Promise.resolve()

  constructor(port: ProvenancePort) {
    this.#port = port
    this.#preferences = new ProvenancePreferences(join(port.stateDir, 'provenance-preferences.json'))
  }

  async start(): Promise<void> {
    await this.#preferences.load()
    if (this.#closed) return
    this.#started = true
    this.setProjects(this.#port.projects())
  }

  #queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work)
    this.#tail = next.then(() => {}, () => {})
    return next
  }

  setProjects(roots: readonly string[]): void {
    if (this.#closed) return
    const next = [...new Set(roots)].sort()
    if (JSON.stringify(next) === JSON.stringify(this.#roots) && this.#projects.size) return
    this.#roots = next
    const generation = ++this.#generation
    if (!this.#started) return
    void this.#queue(async () => {
      if (generation !== this.#generation || this.#closed) return
      for (const state of this.#projects.values()) await this.#stop(state)
      this.#projects.clear()
      this.#aliases.clear()
      for (const root of next) {
        if (generation !== this.#generation || this.#closed) return
        let handle: RepoHandle | null = null
        try {
          handle = await admitProject(root, this.#port.stateDir, next)
          if (generation !== this.#generation || this.#closed) {
            await gitReader(handle).close()
            return
          }
          this.#aliases.set(root, handle.project)
          if (this.#projects.has(handle.project)) {
            await gitReader(handle).close()
            continue
          }
          const state = this.#state(handle.project, handle)
          this.#projects.set(handle.project, state)
          await this.#open(state)
        } catch (error) {
          if (handle) await gitReader(handle).close().catch(() => {})
          const state = this.#state(root, null)
          this.#projects.set(root, state)
          this.#aliases.set(root, root)
          this.#problem(state, 'stopped', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'folder-unavailable' : 'external-metadata')
        }
      }
    }).catch(() => this.#port.log('provenance registration failed'))
  }

  #journal(project: string): ProvenanceJournal {
    let journal = this.#journals.get(project)
    if (!journal) {
      journal = new ProvenanceJournal(join(this.#port.evidence.store.folderOf(project), 'provenance.ndjson'))
      this.#journals.set(project, journal)
    }
    return journal
  }

  async #prepare(project: string): Promise<void> {
    const folder = this.#port.evidence.store.folderOf(project)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'project.json'), JSON.stringify({ root: project }), { flag: 'wx', mode: 0o600 })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  }

  #state(project: string, handle: RepoHandle | null): Project {
    const preference = this.#preferences.get(project)
    return {
      project, handle, observer: null, journal: this.#journal(project), entries: [], seats: [], facts: [],
      catchingUp: true, factSources: new Map(), reconciled: null,
      links: new Map(), historical: new Map(), observed: new Set(),
      issues: new Set(preference.problem ? [preference.problem] : []), fatal: !!preference.problem, pending: new Set(),
      health: captureHealth({
        project, enabled: preference.enabled, fatal: !!preference.problem, issues: preference.problem ? [preference.problem] : [],
        checkedAt: null, lastCapturedAt: null, pending: 1, gaps: 0, revision: ++this.#revision,
      }),
    }
  }

  async #load(state: Project): Promise<void> {
    const read = await state.journal.read()
    if (read.broken) throw new Error('provenance-journal-damaged')
    for (const entry of read.entries.slice(state.entries.length)) {
      if (entry.kind === 'link' && object(entry.value)) {
        if ('restoredAt' in entry.value) {
          const link = entry.value.data as LinkObservation
          state.historical.set(link.sha, link)
        } else {
          const link = entry.value as unknown as LinkObservation
          state.links.set(link.sha, link)
        }
      }
      if (entry.kind === 'commit' && object(entry.value) && !('restoredAt' in entry.value)) {
        const commit = entry.value as unknown as CommitObservation
        state.observed.add(commit.sha)
        state.pending.delete(commit.sha)
        if (commit.why) state.issues.add(commit.why === 'limit-exceeded' ? 'limit-exceeded' : 'history-gap')
      }
    }
    state.entries = read.entries
    state.seats = foldSeats((await this.#port.evidence.store.read(state.project, 'seats')).lines)
    state.facts = (await this.#port.evidence.store.read(state.project, 'evidence')).lines.flatMap((line) =>
      line.type === 'evidence' ? [line.record] : [],
    )
  }

  #publish(state: Project): void {
    if (this.#closed || this.#projects.get(state.project) !== state) return
    const preference = this.#preferences.get(state.project)
    const checkpoint = readCheckpoint(state.entries) as WorkerCheckpoint | null
    const pending = state.pending.size + (checkpoint?.frontier.length ?? 0) + (checkpoint?.rangePending.length ?? 0)
    state.health = captureHealth({
      project: state.project, enabled: preference.enabled, fatal: state.fatal,
      issues: [...state.issues], checkedAt: checkpoint?.scanStartedAt ?? null,
      lastCapturedAt: checkpoint?.capturedThrough || null, pending: pending + (state.catchingUp && preference.enabled ? 1 : 0),
      gaps: state.entries.filter((entry) => entry.kind === 'gap').length,
      revision: ++this.#revision,
    })
    this.#port.push({ method: 'provenance/changed', params: {
      project: state.project, revision: state.health.revision, health: state.health,
    } })
  }

  #problem(state: Project, kind: 'degraded' | 'stopped', reason: string): void {
    state.issues.add(reason)
    state.fatal ||= kind === 'stopped'
    this.#publish(state)
  }

  async #open(state: Project): Promise<void> {
    await this.#prepare(state.project)
    try {
      await this.#load(state)
      const preference = this.#preferences.get(state.project)
      if (!preference.enabled || preference.problem || !state.handle || this.#closed) {
        if (state.handle) await gitReader(state.handle).close()
        state.handle = null
        this.#publish(state)
        return
      }
      state.catchingUp = true
      const git = gitReader(state.handle)
      const observer = new RefObserver({
        git, journal: state.journal,
        changed: () => {
          void this.#load(state).then(() => { state.catchingUp = false; this.#publish(state) })
            .catch(() => this.#problem(state, 'stopped', 'storage-failed'))
        },
        problem: (kind, reason) => this.#problem(state, kind, reason),
        reconcile: (entries, checkpoint, signal) => this.#reconcile(state, entries, checkpoint, git, signal),
      })
      state.observer = observer
      await observer.start(state.handle, readCheckpoint(state.entries) as WorkerCheckpoint | null)
      if (this.#closed) await this.#stop(state)
    } catch {
      if (state.handle && !state.observer) await gitReader(state.handle).close()
      this.#problem(state, 'stopped', 'storage-failed')
    }
  }

  async #reconcile(
    state: Project, entries: readonly JournalEntry[], checkpoint: WorkerCheckpoint, git: GitReader, signal: AbortSignal,
  ): Promise<Pick<WorkerCheckpoint, 'rangeKeys' | 'rangePending'>> {
    await this.#load(state)
    const signature = digest([
      entries.filter((entry) => entry.kind === 'commit' || entry.kind === 'ref').map((entry) => entry.seq),
      state.facts.map((fact) => fact.id), state.seats,
    ])
    if (signature === state.reconciled && !checkpoint.rangePending.length) {
      return { rangeKeys: checkpoint.rangeKeys, rangePending: [] }
    }
    const commits = localValues<CommitObservation>(entries, 'commit')
    const storedRanges = localValues<RangeObservation>(entries, 'range')
    const ranges = storedRanges.filter((range) => !range.id.startsWith('fact-'))
    let links = localValues<LinkObservation>(entries, 'link')
    const sources: ProvenanceSource[] = []
    for (const record of state.facts) {
      signal.throwIfAborted()
      if (record.restored || record.fact.kind !== 'diff' || !record.checkout ||
        !state.handle?.checkouts.has(record.checkout.cwd)) continue
      const fact = record.fact
      try {
        let source = state.factSources.get(record.id)
        if (!source) {
          const factId = `fact-${digest([record.id, record.fact.from, record.fact.to])}`
          const saved = storedRanges.find((range) => range.id === factId)
          const observed = commits.find((commit) => commit.sha === fact.to && commit.parents[0] === fact.from)
          const patch = saved?.patch ?? observed?.patch ?? await git.patch(record.fact.from, record.fact.to, signal)
          source = factSource(state.project, record.checkout.cwd, record.fact.from, record.fact.to,
            patch, state.seats, [record]) ?? undefined
          if (source) {
            // An exact fact range is not a first-parent decomposition. Keep its
            // fingerprint for replay, but never offer it as a squash candidate.
            if (!saved) await state.journal.append('range', {
              id: factId, from: record.fact.from, to: record.fact.to,
              commits: [record.fact.to], patch, seats: source.seats, ambiguous: true, at: record.observedAt,
            } satisfies RangeObservation)
            state.factSources.set(record.id, source)
          }
        }
        if (source) sources.push(source)
      } catch {
        signal.throwIfAborted()
        this.#problem(state, 'degraded', 'history-gap')
      }
    }
    const reconcile = async () => {
      const decisions = await reconcileProject({
        commits, sources: [...sources, ...ranges.map((range) => rangeSource(range, links))],
        moves: localValues(entries, 'ref'), priorLinks: links, now: Date.now(),
      }, git, signal)
      for (const link of decisions) await state.journal.append('link', link)
      links = [...links, ...decisions]
    }
    await reconcile()
    const keys = new Set(checkpoint.rangeKeys)
    const candidates = rangeCandidates(commits, keys)
    const failed: string[] = []
    for (const candidate of candidates.ready) {
      signal.throwIfAborted()
      try {
        const range = await captureRange(candidate.from, candidate.commits, links, git, signal, Date.now())
        await state.journal.append('range', range)
        ranges.push(range)
        keys.add(candidate.key)
      } catch (error) {
        signal.throwIfAborted()
        if ((error as Error).message.startsWith('provenance-')) throw error
        failed.push(`limit:${candidate.key}`)
        this.#problem(state, 'degraded', 'history-gap')
      }
    }
    await reconcile()
    state.reconciled = signature
    return { rangeKeys: [...keys], rangePending: [...candidates.pending, ...failed] }
  }

  evidenceChanged(project: string): void {
    this.#projects.get(this.#aliases.get(project) ?? project)?.observer?.wake()
  }

  #registered(root: string): Project {
    const state = this.#projects.get(this.#aliases.get(root) ?? root)
    if (!state) throw new Error('This project is not registered for capture.')
    return state
  }

  async read(root: string, shas: readonly string[]): Promise<ProjectProvenance> {
    if (!Array.isArray(shas) || shas.length > 1000) throw new Error('Expected at most 1000 full object ids.')
    for (const sha of shas) oid(sha)
    const state = this.#registered(root)
    const latest = state.links
    const known = state.observed
    const historical = state.historical
    const requested = [...new Set(shas)]
    const enqueue = requested.filter((sha) => !known.has(sha) && !historical.has(sha) &&
      !state.pending.has(sha) && !!state.observer && state.health.enabled && !state.fatal)
    for (const sha of enqueue) state.pending.add(sha)
    if (enqueue.length) {
      state.observer!.request(enqueue)
      this.#publish(state)
    }
    const commits: CommitProvenance[] = requested.map((sha) => {
      const link = latest.get(sha) ?? historical.get(sha)
      const imported = !latest.has(sha) && historical.has(sha)
      const pending = state.pending.has(sha) && state.health.enabled && !state.fatal
      const joined = link ? relatedEvidence(link, state.seats, state.facts) : null
      const reason: ProvenanceReason | null = imported ? 'restored-history'
        : link ? link.reason && reasons.has(link.reason as ProvenanceReason) ? link.reason as ProvenanceReason :
          link.coverage === 'none' ? 'no-seat-evidence' : null
        : !state.health.enabled ? 'capture-off' : state.fatal ? 'capture-stopped'
        : pending ? 'catching-up' : 'not-observed'
      return {
        sha, state: pending && !link ? 'pending' : link?.seats.length && joined?.seats.length ? 'attributed' : 'unattributed',
        coverage: link?.coverage ?? 'none', seats: joined?.seats ?? [], via: link?.via ?? null,
        reason, explanation: explanation(reason), evidenceIds: joined?.evidenceIds ?? [], cards: joined?.cards ?? [],
        observedAt: link?.at ?? null,
      }
    })
    return { project: state.project, revision: state.health.revision, health: state.health, commits }
  }

  async status(root?: string): Promise<readonly CaptureHealth[]> {
    if (root !== undefined) return [this.#registered(root).health]
    return [...this.#projects.values()].map((state) => state.health)
  }

  setCapture(root: string, enabled: boolean): Promise<CaptureHealth> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Expected a capture preference.'))
    return this.#queue(async () => {
      const state = this.#registered(root)
      // Stop first: no scan may acknowledge a cursor after the disabled preference is published.
      await this.#stop(state)
      try {
        await this.#preferences.set(state.project, enabled)
      } catch (error) {
        this.#problem(state, 'stopped', 'storage-failed')
        throw error
      }
      state.pending.clear()
      state.catchingUp = enabled
      await state.journal.append('gap', {
        id: digest(['toggle', enabled, Date.now(), ++this.#revision]), reason: 'capture-toggle',
        from: state.health.checkedAt, to: Date.now(),
      })
      await this.#load(state)
      if (enabled && !this.#closed && this.#roots.includes(root)) {
        state.handle = await admitProject(root, this.#port.stateDir, this.#roots)
        state.fatal = false
        state.issues.clear()
        await this.#open(state)
      }
      this.#publish(state)
      return state.health
    })
  }

  retry(root: string): Promise<CaptureHealth> {
    return this.#queue(async () => {
      const state = this.#registered(root)
      await this.#stop(state)
      this.#preferences = new ProvenancePreferences(join(this.#port.stateDir, 'provenance-preferences.json'))
      await this.#preferences.load()
      this.#journals.delete(state.project)
      state.journal = this.#journal(state.project)
      state.entries = []
      state.links.clear()
      state.historical.clear()
      state.observed.clear()
      state.factSources.clear()
      state.reconciled = null
      state.fatal = false
      state.issues.clear()
      const preference = this.#preferences.get(state.project)
      if (preference.problem) this.#problem(state, 'stopped', preference.problem)
      if (preference.enabled && !this.#closed) {
        state.handle = await admitProject(root, this.#port.stateDir, this.#roots)
      }
      await this.#open(state)
      this.#publish(state)
      return state.health
    })
  }

  async seat(root: string, id: string): Promise<ProvenanceSeatDetail> {
    const state = this.#registered(root)
    if (!id || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Expected a Seat id.')
    const seat = this.#port.evidence.seats.byId(id)
    if (!seat || seat.checkout.project !== state.project) {
      return { seat: null, session: null, unavailable: 'This Seat record is unavailable in this project.' }
    }
    if (seat.restored) return { seat, session: null, unavailable: 'This Seat record came from another backup.' }
    if (seat.closed?.why === 'deleted') return { seat, session: null, unavailable: 'Its conversation was deleted.' }
    return { seat, session: seat.session, unavailable: null }
  }

  backup() {
    return this.#queue(() => exportProvenance({
      projects: async () => [...new Set([...await this.#port.evidence.store.projects(), ...this.#journals.keys()])],
      journal: (project) => this.#journal(project),
    }))
  }

  restore(raw: unknown) {
    return this.#queue(async () => {
      const report = await importProvenance({
        projects: () => this.#port.evidence.store.projects(), journal: (project) => this.#journal(project),
        prepare: (project) => this.#prepare(project),
      }, raw)
      for (const state of this.#projects.values()) {
        await this.#load(state)
        this.#publish(state)
      }
      return report
    })
  }

  async #stop(state: Project): Promise<void> {
    const observer = state.observer
    state.observer = null
    if (observer) await observer.close().catch(() => this.#problem(state, 'stopped', 'storage-failed'))
    state.handle = null
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#generation += 1
    for (const state of this.#projects.values()) void state.observer?.close().catch(() => {})
    await this.#tail
    for (const state of this.#projects.values()) await this.#stop(state)
    for (const journal of this.#journals.values()) {
      await journal.flush().catch(() => this.#port.log('provenance observations could not be saved'))
    }
  }
}
```

A fact-bound net range is kept under a `fact-` observation ID solely to replay its exact fingerprint after objects disappear. It is excluded from `rangeSource`: it does not pretend to be a first-parent decomposition. The restart test deletes the original loose object and proves the rewritten commit still resolves to its original Seat and evidence. Restored wrappers are excluded from every local source projection.

The host notification seam supplies a room, not a project. The host resolves that room through its existing team registry and invokes `evidenceChanged(project)` without awaiting it. Project roots are canonical Git top levels already learned by the host; `admitProject` still independently verifies metadata membership. Two admitted linked checkouts share the main project’s plane entry and preference. Removed projects lose all watchers, timers and children but keep historical files. Late admission after disposal closes its temporary Git view before returning.

- [ ] **Step 5: Transfer host ownership and wire background lifecycle without a turn await.**

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
import { ProvenanceBackups } from './provenance/backup.js'
```

with:

```ts
import { ProvenancePlane } from './provenance/plane.js'
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
  readonly #provenanceBackups: ProvenanceBackups
```

with:

```ts
  readonly #provenance: ProvenancePlane
  #provenanceGeneration = 0
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    this.#provenanceBackups = new ProvenanceBackups(this.#evidence.store)
```

with:

```ts
    this.#provenance = new ProvenancePlane({
      evidence: this.#evidence,
      stateDir: this.#state.directory,
      projects: () => [],
      push: (notice) => this.#push(notice),
      log: (message, details) => this.#logger.warn(message, details ?? {}),
    })
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    await this.#evidence.load().catch((error: unknown) => {
      this.#logger.error('the Seat records this desk keeps could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
```

with:

```ts
    await this.#evidence.load().catch((error: unknown) => {
      this.#logger.error('the Seat records this desk keeps could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    void this.#provenance.start().then(() => this.#captureProjects()).catch(() => {
      this.#logger.warn('provenance could not start')
    })
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
  async #watchProjects(): Promise<void> {
    const watch = this.#agentWatch
```

with:

```ts
  async #watchProjects(): Promise<void> {
    this.#captureProjects()
    const watch = this.#agentWatch
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
  #repoOf(cwd: string): Promise<RepoInfo | null> {
```

with:

```ts
  /** Register canonical open checkouts without making the opening wait for capture. */
  #captureProjects(): void {
    if (this.#disposed) return
    const generation = ++this.#provenanceGeneration
    const roots = this.#openRoots()
    void Promise.all(roots.map(async (root) => (await this.#topLevelOf(root)) ?? root))
      .then((projects) => {
        if (this.#disposed || generation !== this.#provenanceGeneration) return
        this.#provenance.setProjects(projects)
      })
      .catch(() => this.#logger.warn('provenance projects could not be registered'))
  }

  #repoOf(cwd: string): Promise<RepoInfo | null> {
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
  #push(notification: WireNotification): void {
    for (const broadcast of this.#broadcasters) {
```

with:

```ts
  #push(notification: WireNotification): void {
    if (!this.#disposed && notification.method === 'evidence/changed' && this.#team.hasRoom(notification.params.room)) {
      this.#provenance.evidenceChanged(this.#team.stateFor(notification.params.room).root)
    }
    if (!this.#disposed && (notification.method === 'session/removed' ||
      (notification.method === 'event' && notification.params.event.type === 'session/started'))) {
      this.#captureProjects()
    }
    for (const broadcast of this.#broadcasters) {
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
      provenance: await this.#provenanceBackups.backup(),
```

with:

```ts
      provenance: await this.#provenance.backup(),
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    const provenance = await this.#provenanceBackups.restore(file.provenance)
```

with:

```ts
    const provenance = await this.#provenance.restore(file.provenance)
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
    await this.#provenanceBackups.close().catch(() => {
      this.#logger.warn('provenance observations could not be saved')
    })
```

with:

```ts
    await this.#provenance.close().catch(() => {
      this.#logger.warn('provenance observations could not be saved')
    })
```

Keep the existing `this.#disposed = true` at the top of `dispose()`. The new close stays immediately before `this.#evidence.close()`. No send, tool-delivery, queue-drain, approval or turn-completion function is edited. `#captureProjects` uses the existing top-level cache and discards stale generations; none of its callers awaits capture or metadata admission. The startup port deliberately returns an empty list until this canonical-root registration completes, so a subfolder never becomes a second project beside its Git root.

- [ ] **Step 6: Run the focused work and the complete real-watch acceptance separately.**

Run: `pnpm run build:node && node --test --test-reporter=spec --test-timeout=20000 --test-name-pattern="wake returns|failed scan|restart catches|unavailable watches|parent work|plane disables|restart rebuilds|an annotated tag|a crash after" packages/server/dist/test/provenance-observer.test.js`

Expected: exit 0; **9 tests, 9 pass, 0 fail**. This includes real polling and actual object loss, but intentionally excludes event-delivery assertions.

Run: `node --test --test-reporter=spec --test-timeout=20000 packages/server/dist/test/provenance-observer.test.js`

Expected: on the full-access implementation seat, exit 0; **12 tests, 12 pass, 0 fail**. Both event-delivery tests have polling disabled, perform external Git writes without a host turn, and fail with `real file notifications must attach` when watches cannot attach. The stable-registration test also keeps existing watches attached across settled scans, so one externally observed update cannot open a gap before the next. They do not skip and do not invoke a watch callback themselves.

Planning limitation: real `fs.watch` returned `EMFILE: too many open files, watch` in this sandbox. The two event-delivery tests therefore failed on the attachment assertion. Their green result is not claimed; the complete task requires an unrestricted execution of this exact file. The host lifecycle edits above likewise still require the integrated host and full gate.

- [ ] **Step 7: Prove the scheduler guard and restore it before the final run.**

In `packages/server/src/provenance/observer.ts`, replace this exact anchor:

```ts
    if (this.#running) return
```

with:

```ts
    if (this.#running && false) return
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="wake returns immediately" packages/server/dist/test/provenance-observer.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `only one scan may run while the first is blocked`, with `41 !== 1`. Restore the original running guard.

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="wake returns immediately" packages/server/dist/test/provenance-observer.test.js`

Expected: exit 0; **1 test, 1 pass, 0 fail**, peak concurrency 1 and exactly one follow-up scan.

In `packages/server/src/provenance/plane.ts`, replace this exact anchor:

```ts
          const patch = saved?.patch ?? observed?.patch ?? await git.patch(record.fact.from, record.fact.to, signal)
```

with:

```ts
          void [saved, observed]
          const patch = await git.patch(record.fact.from, record.fact.to, signal)
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-timeout=15000 --test-name-pattern="restart rebuilds" packages/server/dist/test/provenance-observer.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: Timed out waiting for association after original object loss`. Restore the saved-fingerprint lookup.

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="restart rebuilds" packages/server/dist/test/provenance-observer.test.js`

Expected: exit 0; **1 test, 1 pass, 0 fail**. Both the failing mutation and the restored run were executed.

In `packages/server/src/provenance/observer.ts`, replace this exact anchor:

```ts
        if (unacknowledged.delete(sha) && !first && !baseline.includes(sha)) {
```

with:

```ts
        if (unacknowledged.delete(sha) && unacknowledged.has('disabled') && !first && !baseline.includes(sha)) {
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="a crash after" packages/server/dist/test/provenance-observer.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: an unacknowledged object must not lose its parent work`. Restore the original condition.

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="a crash after" packages/server/dist/test/provenance-observer.test.js`

Expected: exit 0; **1 test, 1 pass, 0 fail**. The plan-writing run executed this crash mutation and the restored test.

- [ ] **Step 8: Controller commit after real-event proof and the phase gate.**

The plan writer does not commit. After the complete phase passes `pnpm verify` unpiped, the controller records the actual implementation writer and runs:

```bash
git add packages/protocol/src/wire.ts packages/server/src/provenance/observer.ts packages/server/src/provenance/plane.ts packages/server/src/host.ts packages/server/test/provenance-observer.test.ts
git commit -m "feat: capture project ref movements in the background" --trailer "Co-Authored-By: Codex GPT-6 <agent@harnessdesk.app>"
```

### Task 6: Bounded host reads and validated wire access

A history page asks for one bounded batch. The wire validates before dispatch, every named-root handler confines before reaching the plane, and the plane repeats the object-count and ID bounds for internal callers. Replies are indexed historical facts with a monotonic revision; no request waits for a Git child. A Seat lookup uses its immutable ID and project, never the latest Seat of the same session.

**Files:**
- Modify: `packages/protocol/src/wire.ts`, `packages/protocol/src/wire-validators.ts`
- Modify: `packages/server/src/methods/context.ts`, `packages/server/src/methods/index.ts`, `packages/server/src/host.ts`
- Create: `packages/server/src/methods/provenance.ts`
- Create: `packages/protocol/test/provenance-wire.test.ts`, `packages/server/test/provenance-methods.test.ts`
- Modify: `script/check-reachable.mjs` to pin the five verbs until Tasks 7–8 add callers.
- Consume unchanged: Task 5's indexed projection and exact historical Seat implementation in `packages/server/src/provenance/plane.ts`.

**Proof needs:** neither — Codex; the real protocol parser, a narrow fake context, the real plane with synthetic evidence and an in-process `Host.call`. No socket, runtime or renderer is needed.

**Interfaces:** `HostContext.provenance` is exactly `Pick<ProvenancePlane, 'read' | 'status' | 'setCapture' | 'retry' | 'seat'>`. The public contracts remain `provenance/commits({ root, shas }): ProjectProvenance`, `provenance/status({ root? }): readonly CaptureHealth[]`, `provenance/capture({ root, enabled }): CaptureHealth`, `provenance/retry({ root }): CaptureHealth`, and `provenance/seat({ root, seat }): ProvenanceSeatDetail`. The already-declared `provenance/changed` notification carries `{ project, revision, health }`. There is no session-ID alias, arbitrary ref expression, cursor or journal-write wire API.

- [ ] **Step 1: Write complete tests at the real parser and separate method boundary.**

Create `packages/protocol/test/provenance-wire.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage } from '../src/wire-validators.js'
import { ValidationError } from '../src/validate.js'

const request = (method: string, params: unknown) => ({ id: 1, method, params })

test('all five provenance verbs validate their actual request envelopes', () => {
  const cases = [
    ['provenance/commits', { root: '/work/project', shas: [] }],
    ['provenance/status', {}],
    ['provenance/status', { root: '/work/project' }],
    ['provenance/capture', { root: '/work/project', enabled: false }],
    ['provenance/retry', { root: '/work/project' }],
    ['provenance/seat', { root: '/work/project', seat: 'seat-1' }],
  ] as const
  for (const [method, params] of cases) {
    const parsed = parseClientMessage(request(method, params))
    assert.equal(parsed.method, method)
    assert.equal('id' in parsed && parsed.id, 1)
  }
})

test('root and Seat bounds reject before any host dispatch can run', () => {
  let dispatched = 0
  for (const root of ['', 'x'.repeat(4097), '/work/\0project', 12, null]) {
    for (const method of ['provenance/status', 'provenance/commits', 'provenance/capture', 'provenance/retry', 'provenance/seat']) {
      assert.throws(() => {
        parseClientMessage(request(method, { root, shas: [], enabled: true, seat: 'seat-1' }))
        dispatched += 1
      }, ValidationError)
    }
  }
  for (const seat of ['', 's'.repeat(201), 'bad\nseat', '\x7f', 2]) {
    assert.throws(() => parseClientMessage(request('provenance/seat', { root: '/work/project', seat })), ValidationError)
  }
  for (const enabled of ['true', 1, null, undefined]) {
    assert.throws(() => parseClientMessage(request('provenance/capture', { root: '/work/project', enabled })), ValidationError)
  }
  assert.equal(dispatched, 0)
})

test('the actual wire rejects 1001 SHAs before deduplication', () => {
  assert.throws(() => parseClientMessage(request('provenance/commits', {
    root: '/work/project', shas: Array(1001).fill('a'.repeat(40)),
  })), /expected at most 1000 full object ids/)
})

test('full object IDs of both formats survive in first-requested order and nothing executable does', () => {
  const one = 'a'.repeat(40)
  const two = 'b'.repeat(64)
  const parsed = parseClientMessage(request('provenance/commits', { root: '/work/project', shas: [two, one, two] }))
  assert.equal(parsed.method, 'provenance/commits')
  assert.deepEqual((parsed as unknown as { params: { shas: readonly string[] } }).params.shas, [two, one])
  for (const value of ['HEAD~1', '--output=/work/escape', 'abc1234', 'g'.repeat(40), 'A'.repeat(40), 42]) {
    assert.throws(() => parseClientMessage(request('provenance/commits', { root: '/work/project', shas: [value] })), ValidationError)
  }
  assert.doesNotThrow(() => parseClientMessage(request('provenance/commits', { root: '/work/project', shas: Array(1000).fill(one) })))
})
```

Create `packages/server/test/provenance-methods.test.ts`:

```ts
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { CaptureHealth, SeatRecord } from '@harnessdesk/protocol'

import type { EvidencePlane } from '../src/evidence/plane.js'
import { EvidenceStore } from '../src/evidence/store.js'
import type { HostContext } from '../src/methods/context.js'
import { provenanceMethods } from '../src/methods/provenance.js'
import { ProvenancePlane } from '../src/provenance/plane.js'
import { makeRepo } from './fixtures/provenance-repo.js'
import { Host } from '../src/host.js'
import { Logger } from '../src/log.js'
import { StateStore } from '../src/state.js'
import { tempDir } from './scratch.js'

const health: CaptureHealth = {
  project: '/work/project', enabled: false, state: 'stopped', reason: 'Capture is off on this machine.',
  nextStep: 'Turn capture on.', checkedAt: null, lastCapturedAt: null, pending: 0, gaps: 0, revision: 1,
}

test('every named-root handler confines before reaching its narrow provenance port', async () => {
  const calls: unknown[] = []
  const ctx = {
    workspaces: { confineGitRoot: async (root: string) => { calls.push(['confine', root]); return '/work/project' } },
    provenance: {
      read: async (root: string, shas: readonly string[]) => {
        calls.push(['read', root, shas])
        return { project: root, revision: 1, health, commits: [] }
      },
      status: async (root?: string) => { calls.push(['status', root]); return [health] },
      setCapture: async (root: string, enabled: boolean) => { calls.push(['capture', root, enabled]); return health },
      retry: async (root: string) => { calls.push(['retry', root]); return health },
      seat: async (root: string, seat: string) => {
        calls.push(['seat', root, seat])
        return { seat: null, session: null, unavailable: 'Unavailable.' }
      },
    },
  } as unknown as HostContext
  await provenanceMethods['provenance/commits'](ctx, { root: '/alias', shas: [] })
  await provenanceMethods['provenance/status'](ctx, { root: '/alias' })
  await provenanceMethods['provenance/capture'](ctx, { root: '/alias', enabled: false })
  await provenanceMethods['provenance/retry'](ctx, { root: '/alias' })
  await provenanceMethods['provenance/seat'](ctx, { root: '/alias', seat: 'seat-1' })
  await provenanceMethods['provenance/status'](ctx, {})
  assert.deepEqual(calls, [
    ['confine', '/alias'], ['read', '/work/project', []],
    ['confine', '/alias'], ['status', '/work/project'],
    ['confine', '/alias'], ['capture', '/work/project', false],
    ['confine', '/alias'], ['retry', '/work/project'],
    ['confine', '/alias'], ['seat', '/work/project', 'seat-1'],
    ['status', undefined],
  ])
})

test('a confinement refusal never reaches the provenance service', async () => {
  let reads = 0
  const ctx = {
    workspaces: { confineGitRoot: async () => { throw new Error('outside workspace') } },
    provenance: { read: async () => { reads += 1 } },
  } as unknown as HostContext
  await assert.rejects(provenanceMethods['provenance/commits'](ctx, { root: '/outside', shas: [] }), /outside workspace/)
  assert.equal(reads, 0)
})

test('indexed reads dedupe in order, never queue while off, and preserve historical Seat identity', async (t) => {
  const repo = await makeRepo()
  const store = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const seat: SeatRecord = {
    id: 'original', agent: null, briefDigest: null, seat: { runtime: 'fixture' }, seatLabel: 'Recorded seat',
    passedOver: [], standing: { kind: 'permission', permission: 'read' }, ceiling: null,
    checkout: { cwd: repo.dir, project: repo.dir, branch: null, head: null },
    session: { runtime: 'fixture', sessionId: 'original-session' }, board: null, role: null,
    openedAt: 1, closed: null,
  }
  const records = new Map<string, SeatRecord>([
    [seat.id, seat], ['foreign', { ...seat, id: 'foreign', checkout: { ...seat.checkout, project: '/work/other' } }],
    ['deleted', { ...seat, id: 'deleted', closed: { at: 2, why: 'deleted' } }],
    ['restored', { ...seat, id: 'restored', restored: { at: 3 } }],
  ])
  const plane = new ProvenancePlane({
    evidence: { store, seats: { byId: (id: string) => records.get(id) ?? null } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => [repo.dir], push: () => {}, log: () => {},
  })
  t.after(() => plane.close())
  await plane.start()
  const deadline = Date.now() + 10000
  while (!(await plane.status()).length) {
    assert.ok(Date.now() < deadline, 'project registration completed')
    await delay(10)
  }
  await plane.setCapture(repo.dir, false)
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const read = await plane.read(repo.dir, [b, a, b])
  assert.deepEqual(read.commits.map((commit) => commit.sha), [b, a])
  assert.ok(read.commits.every((commit) => commit.state === 'unattributed' && commit.reason === 'capture-off'))
  assert.equal(read.health.pending, 0)
  assert.deepEqual((await plane.seat(repo.dir, 'original')).session, seat.session)
  assert.equal((await plane.seat(repo.dir, 'foreign')).seat, null)
  assert.equal((await plane.seat(repo.dir, 'missing')).seat, null)
  assert.equal((await plane.seat(repo.dir, 'deleted')).unavailable, 'Its conversation was deleted.')
  assert.equal((await plane.seat(repo.dir, 'restored')).session, null)
  await assert.rejects(plane.read(repo.dir, Array(1001).fill(a)), /at most 1000/)
  await assert.rejects(plane.read(repo.dir, ['HEAD']), /full object id/)
  await assert.rejects(plane.status('/outside'), /not registered/)
  await plane.setCapture(repo.dir, true)
  const pending = await plane.read(repo.dir, [a])
  assert.equal(pending.commits[0]?.state, 'pending')
  assert.equal(pending.commits[0]?.reason, 'catching-up')
  assert.deepEqual(pending.commits[0]?.seats, [])
  assert.ok(pending.revision > read.revision)
})


test('Host.call reaches the real built provenance context without starting a runtime or listener', async () => {
  const host = new Host({
    state: new StateStore(join(tempDir('provenance-host-'), 'state.json')),
    logger: new Logger('test', { level: 'error', console: false }),
    catalogRefreshMs: 0,
  })
  try {
    assert.deepEqual(await host.call('provenance/status', {}), [])
    await assert.rejects(host.call('provenance/seat', { root: '/outside', seat: 'seat-1' }))
  } finally {
    await host.dispose()
  }
})
```

- [ ] **Step 2: Run the protocol tests before declaring or validating a request.**

Run: `pnpm run build:node`

Expected: exit 2; `error TS2307: Cannot find module '../src/methods/provenance.js' or its corresponding type declarations.` The typed `Host.call` also refuses the undeclared provenance method names.

Run: `node --test --test-reporter=spec packages/protocol/dist/test/provenance-wire.test.js`

Expected: before the declarations, exit 1; the first test fails with `unknown method "provenance/commits"`. `build:node` emits the protocol tests before the server compilation fails; this red exercises the actual request parser rather than a duplicate validator.

- [ ] **Step 3: Declare the five requests in the existing protocol map.**

In `packages/protocol/src/wire.ts`, replace this exact anchor:

```ts
import type { CaptureHealth, ProvenanceBackup } from './provenance.js'
```

with:

```ts
import type { CaptureHealth, ProjectProvenance, ProvenanceBackup, ProvenanceSeatDetail } from './provenance.js'
```

In `packages/protocol/src/wire.ts`, replace this exact anchor:

```ts
export interface HostMethods {
```

with:

```ts
export interface HostMethods {
  'provenance/commits': {
    params: { readonly root: string; readonly shas: readonly string[] }
    result: ProjectProvenance
  }
  'provenance/status': {
    params: { readonly root?: string }
    result: readonly CaptureHealth[]
  }
  'provenance/capture': {
    params: { readonly root: string; readonly enabled: boolean }
    result: CaptureHealth
  }
  'provenance/retry': {
    params: { readonly root: string }
    result: CaptureHealth
  }
  'provenance/seat': {
    params: { readonly root: string; readonly seat: string }
    result: ProvenanceSeatDetail
  }
```

- [ ] **Step 4: Validate each request before adding its answer.**

In `packages/protocol/src/wire-validators.ts`, replace this exact anchor:

```ts
const paramsValidators: Record<HostMethodName, Validator<unknown>> = {
```

with:

```ts
const provenanceRoot: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!text.length || text.length > 4096 || text.includes('\x00')) {
    throw new ValidationError(path, 'expected a project root')
  }
  return text
}
const provenanceOptionalRoot: Validator<string | undefined> = (value, path = '') =>
  value === undefined ? undefined : provenanceRoot(value, path)

const provenanceShas: Validator<string[]> = (value, path = '') => {
  if (!Array.isArray(value) || value.length > 1000 || value.some((sha) =>
    typeof sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha),
  )) {
    throw new ValidationError(path, 'expected at most 1000 full object ids')
  }
  return [...new Set(value)] as string[]
}
const provenanceSeat: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!text.length || text.length > 200 || /[\x00-\x1f\x7f]/.test(text)) {
    throw new ValidationError(path, 'expected a Seat id')
  }
  return text
}

const paramsValidators: Record<HostMethodName, Validator<unknown>> = {
  'provenance/commits': shape({ root: provenanceRoot, shas: provenanceShas }),
  'provenance/status': shape({ root: provenanceOptionalRoot }),
  'provenance/capture': shape({ root: provenanceRoot, enabled: isBoolean }),
  'provenance/retry': shape({ root: provenanceRoot }),
  'provenance/seat': shape({ root: provenanceRoot, seat: provenanceSeat }),
```

The existing module already imports `Validator`, `ValidationError`, `shape`, `isString` and `isBoolean`; add no parallel validator framework. The explicit optional-root function accepts absence and rejects null. The shared `optional()` helper treats null as absent, which would bypass the stated named-root check. Validate the 1,000-entry input limit before deduplication so 1,001 identical strings still refuse. Lowercase full SHA-1 and SHA-256 object IDs are accepted; revisions, short IDs, uppercase IDs and option-like input are refused.

- [ ] **Step 5: Expose the narrow context, answer the domain, and pin its callers.**

In `packages/server/src/methods/context.ts`, replace this exact anchor:

```ts
import type { EvidencePlane } from '../evidence/plane.js'
```

with:

```ts
import type { EvidencePlane } from '../evidence/plane.js'
import type { ProvenancePlane } from '../provenance/plane.js'
```

In `packages/server/src/methods/context.ts`, replace this exact anchor:

```ts
  readonly evidence: EvidencePlane
```

with:

```ts
  readonly evidence: EvidencePlane
  readonly provenance: Pick<ProvenancePlane, 'read' | 'status' | 'setCapture' | 'retry' | 'seat'>
```

Create `packages/server/src/methods/provenance.ts` with these complete contents:

```ts
import type { MethodsUnder } from './context.js'

export const provenanceMethods = {
  'provenance/commits': async (ctx, params) =>
    ctx.provenance.read(await ctx.workspaces.confineGitRoot(params.root), params.shas),
  'provenance/status': async (ctx, params) => params.root !== undefined
    ? ctx.provenance.status(await ctx.workspaces.confineGitRoot(params.root))
    : ctx.provenance.status(),
  'provenance/capture': async (ctx, params) =>
    ctx.provenance.setCapture(await ctx.workspaces.confineGitRoot(params.root), params.enabled),
  'provenance/retry': async (ctx, params) =>
    ctx.provenance.retry(await ctx.workspaces.confineGitRoot(params.root)),
  'provenance/seat': async (ctx, params) =>
    ctx.provenance.seat(await ctx.workspaces.confineGitRoot(params.root), params.seat),
} satisfies MethodsUnder<'provenance/'>
```

In `packages/server/src/methods/index.ts`, replace this exact anchor:

```ts
import { evidenceMethods } from './evidence.js'
```

with:

```ts
import { evidenceMethods } from './evidence.js'
import { provenanceMethods } from './provenance.js'
```

In `packages/server/src/methods/index.ts`, replace this exact anchor:

```ts
  ...evidenceMethods,
```

with:

```ts
  ...evidenceMethods,
  ...provenanceMethods,
```

In `packages/server/src/methods/index.ts`, replace this exact anchor:

```ts
  evidenceMethods,
```

with:

```ts
  evidenceMethods,
  provenanceMethods,
```

In `packages/server/src/host.ts`, replace this exact anchor:

```ts
      evidence: this.#evidence,
```

with:

```ts
      evidence: this.#evidence,
      provenance: {
        read: (root, shas) => this.#provenance.read(root, shas),
        status: (root) => this.#provenance.status(root),
        setCapture: (root, enabled) => this.#provenance.setCapture(root, enabled),
        retry: (root) => this.#provenance.retry(root),
        seat: (root, id) => this.#provenance.seat(root, id),
      },
```

Apply the preceding replacement only inside `#buildContext()`. Task 5 also passes an `evidence` property to the plane constructor; that constructor is not a HostContext and must not gain these closures.

In `script/check-reachable.mjs`, replace this exact anchor:

```ts
const UNREACHED = {
```

with:

```ts
const UNREACHED = {
  'provenance/commits': 'the history page batches its provenance read in Task 7 of the provenance phase',
  'provenance/seat': 'the historical Seat dialog reads its exact record in Task 7 of the provenance phase',
  'provenance/status': 'project health and the sidebar read capture status in Task 8 of the provenance phase',
  'provenance/capture': 'project capture controls call this in Task 8 of the provenance phase',
  'provenance/retry': 'project capture retry calls this in Task 8 of the provenance phase',
```

Task 7 removes only `provenance/commits` and `provenance/seat` when their real `transport.request` callers land. Task 8 removes the remaining three with their callers. No request remains pinned after it is reachable.

The Task 5 plane already implements the projection tested here. It preserves first-requested SHA order and returns each once, keeps unknown queued data pending, enqueues nothing while off, includes only registered projects in an unscoped status read, and refuses a foreign project’s Seat. Deleted and restored records retain their exact historical Seat but offer no local session pointer. A local record offers the original pointer; the renderer uses the ordinary session-open path and its failure state. No transcript, prompt, author identity or brief body is added to the response.

- [ ] **Step 6: Run protocol, method and integrated-host proof independently.**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/protocol/dist/test/provenance-wire.test.js`

Expected: exit 0; **4 tests, 4 pass, 0 fail**.

Run: `node --test --test-reporter=spec --test-name-pattern="every named-root|a confinement refusal|indexed reads" packages/server/dist/test/provenance-methods.test.js`

Expected: exit 0; **3 tests, 3 pass, 0 fail**.

Run: `node --test --test-reporter=spec packages/server/dist/test/provenance-methods.test.js`

Expected: exit 0; **4 tests, 4 pass, 0 fail**, including `Host.call` through the actual context. The planning scratch ran the first three, with the real plane, Phase 4 store/record reader, and a type-only context seam; it did not run the integrated Host test.

Run: `node --test --test-reporter=spec --test-name-pattern="every method the wire validates" packages/server/dist/test/methods.test.js`

Expected: exit 0; **1 test, 1 pass, 0 fail**. This unchanged existing test checks both the assembled table and duplicate domain registrations.

- [ ] **Step 7: Prove the real wire limit and the historical project boundary.**

In `packages/protocol/src/wire-validators.ts`, replace this exact anchor:

```ts
  if (!Array.isArray(value) || value.length > 1000 || value.some((sha) =>
```

with:

```ts
  if (!Array.isArray(value) || value.length > 10000 || value.some((sha) =>
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="actual wire rejects" packages/protocol/dist/test/provenance-wire.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, `AssertionError [ERR_ASSERTION]: Missing expected exception.` Restore 1,000 before continuing.

In `packages/server/src/provenance/plane.ts`, replace this exact anchor:

```ts
    if (!seat || seat.checkout.project !== state.project) {
```

with:

```ts
    if (!seat || (seat.checkout.project !== state.project && false)) {
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="indexed reads" packages/server/dist/test/provenance-methods.test.js`

Expected: exit 1; **1 test, 0 pass, 1 fail**, actual Seat `foreign` from `/work/other` versus expected `null`. Restore the project check.

Run: `pnpm run build:node && node --test --test-reporter=spec packages/protocol/dist/test/provenance-wire.test.js`

Expected: exit 0; **4 tests, 4 pass, 0 fail**.

Run: `node --test --test-reporter=spec --test-name-pattern="every named-root|a confinement refusal|indexed reads" packages/server/dist/test/provenance-methods.test.js`

Expected: exit 0; **3 tests, 3 pass, 0 fail**. Both named mutations and restored runs were executed in the planning scratch.

- [ ] **Step 8: Controller commit after the integration checks and phase gate.**

The plan writer does not commit. After the complete phase passes `pnpm verify` unpiped, the controller records the actual implementation writer and runs:

```bash
git add packages/protocol/src/wire.ts packages/protocol/src/wire-validators.ts packages/protocol/test/provenance-wire.test.ts packages/server/src/methods/context.ts packages/server/src/methods/index.ts packages/server/src/methods/provenance.ts packages/server/src/host.ts packages/server/test/provenance-methods.test.ts script/check-reachable.mjs
git commit -m "feat: expose bounded provenance reads and capture controls" --trailer "Co-Authored-By: Codex GPT-6 <agent@harnessdesk.app>"
```

### Task 7: Commit Seats in history, and the exact historical record

History keeps its existing log, graph and selection model. A batch read adds plain labels; selected detail lists every associated Seat and opens the exact immutable record. A rejected read is an error, never an attribution verdict. Root, view, connection and revision generations own their replies, so an old answer cannot draw another project's identity or erase a newer result.

**Files:**
- Create: `packages/ui/src/lib/provenance.ts`, `packages/ui/src/components/CommitProvenance.tsx`, `packages/ui/src/components/ProvenanceDialog.tsx`
- Create: `packages/ui/src/components/CommitProvenance.test.tsx`, `packages/ui/src/state/store.provenance.test.ts`, `packages/ui/src/preview/provenance-fixture.ts`, `e2e/ui-system/provenance.spec.ts`
- Modify: `packages/ui/src/state/snapshot.ts`, `packages/ui/src/state/store.ts`, `packages/ui/src/components/GitPane.tsx`, `packages/ui/src/preview/harness.tsx`, `packages/ui/src/preview/main.tsx`, `script/check-reachable.mjs`
- Named existing test edit: `packages/ui/src/components/GitPane.test.tsx` gains the two read stubs and a noninteractive-label/keyboard regression. Every existing test remains. Run `GitGraph.test.tsx` unchanged.

**Proof needs:** the rendered UI — Sonnet under this plan's routing; jsdom proves cancellation, composition and text handling, but not layout or browser focus.

**Interfaces:**
- Consumes Task 6's `provenance/commits`, `provenance/seat`, `provenance/changed`, `ProjectProvenance`, `CommitProvenance`, `ProvenanceSeatDetail`, and `CaptureHealth` unchanged.
- Consumes Phase 4's `SeatRecordView({ seat: SeatRecord })`, `ObservedDialog({ id, title, card: CardEvidence, onClose })`, and `AppSnapshot.boardEvidence`. `ObservedDialog` receives only matching existing facts with their existing freshness and SHA. No new observation is manufactured.
- Adds `AppStore.readProvenance(root: string, shas: readonly string[]): Promise<ProjectProvenance>` and `readProvenanceSeat(root: string, seat: string): Promise<ProvenanceSeatDetail>`.
- Adds `AppSnapshot.captureHealth: ReadonlyMap<string, CaptureHealth>` and `provenanceRevision: ReadonlyMap<string, number>`, initialized empty and cleared on disconnect.
- Exports `CommitSeatLabels({ value: CommitProvenance | null })`, `CommitProvenance({ root: string, sha: string })`, `ProvenanceDialog({ root: string, seat: string, onClose: () => void })`, and `useProvenanceBatch(root: string | null, shas: readonly string[], scope: string)` returning `{ values: ReadonlyMap<string, CommitProvenance>, error: boolean, retry: () => void }`.
- `loadCaptureHealth(root?: string): Promise<void>` and its reconnect caller land in Task 8, together with the status pin, as Task 6 specifies. Task 7 already accepts revision notifications and health returned with commit batches.

- [ ] **Step 1: Confirm the existing view and design contracts.**

Run: `rg -n 'export const SeatRecordView|export const ObservedDialog|readonly boardEvidence' packages/ui/src/components/SeatRecordBlock.tsx packages/ui/src/components/EvidenceChips.tsx packages/ui/src/state/snapshot.ts`

Expected: exit 0; one export of each view and one snapshot field. Read their complete signatures before applying the patches. Phase 4 is a prerequisite, not a module this task substitutes.

Run: `rg -n 'export type ChipProps|tone: Tone|export const stateTone' packages/ui/src/design/patterns/Settings.tsx packages/ui/src/design/patterns/PublicationCard.tsx`

Expected: exit 0; the `4382ded9` state vocabulary is present. This task changes no primitive or stylesheet.

- [ ] **Step 2: Write the shared synthetic fixtures and complete tests first.**

The capture fixtures below are also used by Task 8. They create no live observer, account or backend connection; the preview is explicit about every new request.

Create `packages/ui/src/preview/provenance-fixture.ts` with these complete contents:

```ts
import type {
  CaptureHealth,
  CommitProvenance,
  ProjectProvenance,
  ProvenanceSeat,
  ProvenanceSeatDetail,
  SeatRecord,
} from '@harnessdesk/protocol'

export const PROVENANCE_ROOT = '/work/project'
export const PROVENANCE_SHA = 'a'.repeat(40)

export const captureHealth = (over: Partial<CaptureHealth> = {}): CaptureHealth => ({
  project: PROVENANCE_ROOT,
  enabled: true,
  state: 'healthy',
  reason: 'Capture is current for the refs Git exposes.',
  nextStep: 'No action needed.',
  checkedAt: 20,
  lastCapturedAt: 20,
  pending: 0,
  gaps: 0,
  revision: 1,
  ...over,
})

export const provenanceSeat = (n = 1): ProvenanceSeat => ({
  id: `seat-${n}`,
  agentName: `Contributor ${n}`,
  runtime: 'fixture',
  seatLabel: 'Alpha · careful',
  session: { runtime: 'fixture', sessionId: `conversation-${n}` },
})

export const historicalSeat = (n = 1): SeatRecord => ({
  id: `seat-${n}`,
  agent: { id: `contributor-${n}`, name: `Contributor ${n}`, origin: 'project' },
  briefDigest: 'b'.repeat(64),
  seat: { runtime: 'fixture' },
  seatLabel: 'Alpha · careful',
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: PROVENANCE_ROOT, project: PROVENANCE_ROOT, branch: 'topic', head: PROVENANCE_SHA },
  session: provenanceSeat(n).session,
  board: null,
  role: null,
  openedAt: 10,
  closed: null,
})

export const commitProvenance = (over: Partial<CommitProvenance> = {}): CommitProvenance => ({
  sha: PROVENANCE_SHA,
  state: 'attributed',
  coverage: 'complete',
  seats: [provenanceSeat()],
  via: 'observed',
  reason: null,
  explanation: 'A local diff observation associates this change with its Seat.',
  evidenceIds: [],
  cards: [],
  observedAt: 20,
  ...over,
})

export const provenancePage = (
  commits: readonly CommitProvenance[] = [commitProvenance()],
  health = captureHealth(),
): ProjectProvenance => ({ project: health.project, revision: health.revision, health, commits })

export const provenanceDetail = (n = 1): ProvenanceSeatDetail => ({
  seat: historicalSeat(n),
  session: provenanceSeat(n).session,
  unavailable: null,
})

export const PROVENANCE_SCENES = [
  'one',
  'squash',
  'partial',
  'unknown',
  'off',
  'pending',
  'error',
  'deleted',
  'missing',
  'absent-runtime',
  'loading',
  'long',
  'hostile',
] as const
export type ProvenanceScene = (typeof PROVENANCE_SCENES)[number]

export const sceneCommit = (scene: ProvenanceScene): CommitProvenance => {
  if (scene === 'hostile')
    return commitProvenance({ seats: [{ ...provenanceSeat(), agentName: '<img src=x onerror=alert(1)>' }] })
  if (scene === 'long')
    return commitProvenance({
      via: 'squash',
      seats: Array.from({ length: 6 }, (_, n) => ({
        ...provenanceSeat(n + 1),
        agentName: `Contributor ${n + 1} with a long historical Agent name`,
      })),
    })
  if (scene === 'squash')
    return commitProvenance({ via: 'squash', seats: Array.from({ length: 6 }, (_, n) => provenanceSeat(n + 1)) })
  if (scene === 'partial')
    return commitProvenance({
      via: 'amend',
      coverage: 'partial',
      reason: 'changed-patch',
      explanation: 'A surviving file is associated with this Seat. The remaining change is unattributed.',
    })
  if (scene === 'pending')
    return commitProvenance({
      state: 'pending',
      coverage: 'none',
      seats: [],
      reason: 'catching-up',
      via: null,
      explanation: 'Capture is catching up.',
    })
  if (scene === 'unknown' || scene === 'off')
    return commitProvenance({
      state: 'unattributed',
      coverage: 'none',
      seats: [],
      via: null,
      reason: scene === 'off' ? 'capture-off' : 'no-seat-evidence',
      explanation: scene === 'off' ? 'Capture is off on this machine.' : 'No local Seat evidence matches this change.',
    })
  return commitProvenance()
}

export const CAPTURE_SCENES = [
  'healthy',
  'off',
  'refused',
  'preferences',
  'watch',
  'backlog',
  'gap',
  'non-git',
  'unavailable',
  'loading',
  'error',
  'write-error',
] as const
export type CaptureScene = (typeof CAPTURE_SCENES)[number]

export const sceneHealth = (scene: CaptureScene): CaptureHealth | null => {
  if (scene === 'non-git' || scene === 'unavailable') return null
  if (scene === 'off')
    return captureHealth({
      enabled: false,
      state: 'stopped',
      reason: 'Capture is off on this machine.',
      nextStep: 'Turn capture on.',
    })
  if (scene === 'refused')
    return captureHealth({
      state: 'stopped',
      reason: 'Repository metadata is refused.',
      nextStep: 'Use a supported checkout.',
    })
  if (scene === 'preferences')
    return captureHealth({
      state: 'stopped',
      reason: 'The capture preference could not be read.',
      nextStep: 'Repair the local preference file, then retry.',
    })
  if (scene === 'watch')
    return captureHealth({
      state: 'degraded',
      reason: 'Watching failed; polling continues.',
      nextStep: 'Retry capture.',
    })
  if (scene === 'backlog')
    return captureHealth({
      state: 'degraded',
      pending: 20,
      reason: 'Capture is catching up.',
      nextStep: 'Let capture finish.',
    })
  if (scene === 'gap')
    return captureHealth({
      state: 'degraded',
      gaps: 1,
      reason: 'A ref history is missing.',
      nextStep: 'Retry capture; missing history may stay unattributed.',
    })
  return captureHealth()
}

export const provenanceLog = (): import('@harnessdesk/protocol').GitLogCommit => ({
  sha: PROVENANCE_SHA,
  parents: [],
  subject: 'Synthetic change',
  author: 'Jane Doe',
  authorEmail: 'dev@example.com',
  authoredAt: 20,
  committedAt: 20,
  refs: [],
})
```

Create `packages/ui/src/components/CommitProvenance.test.tsx` with these complete contents:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ProjectProvenance, ProvenanceSeatDetail } from '@harnessdesk/protocol'

import {
  commitProvenance,
  provenanceDetail,
  provenancePage,
  provenanceSeat,
  PROVENANCE_ROOT,
  PROVENANCE_SHA,
  sceneCommit,
} from '../preview/provenance-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommitProvenance, CommitSeatLabels, useProvenanceBatch } from './CommitProvenance'
import { ProvenanceDialog } from './ProvenanceDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let snapshot: AppSnapshot
let store: AppStore
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const render = async (element: React.ReactNode) => {
  await act(async () => {
    root.render(<StoreProvider store={store}>{element}</StoreProvider>)
  })
}
const text = () => document.body.textContent ?? ''
const button = (label: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)
  expect(found, `button ${label}`).toBeTruthy()
  return found!
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  snapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [{ id: 'fixture', name: 'Alpha', presentation: { name: 'Alpha' }, capabilities: {} }],
  } as unknown as AppSnapshot
  store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    readProvenance: vi.fn(async () => provenancePage()),
    readProvenanceSeat: vi.fn(async () => provenanceDetail()),
    openSession: vi.fn(async () => {}),
    openTeamBoard: vi.fn(),
  } as unknown as AppStore
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('a stale same-SHA reply from another root never draws its Seat', async () => {
  const old = deferred<ProjectProvenance>()
  vi.mocked(store.readProvenance).mockReturnValueOnce(old.promise)
  await render(<CommitProvenance root="/work/old" sha={PROVENANCE_SHA} />)
  expect(text()).toContain('Reading provenance')
  await render(<CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />)
  expect(text()).toContain('Contributor 1')
  await act(async () => {
    old.resolve(provenancePage([commitProvenance({ seats: [{ ...provenanceSeat(), agentName: 'Wrong project' }] })]))
  })
  expect(text()).not.toContain('Wrong project')
  expect(text()).toContain('Contributor 1')
})

it('all squash Seats appear in detail, while a history label stays one noninteractive line', async () => {
  const value = sceneCommit('squash')
  vi.mocked(store.readProvenance).mockResolvedValue(provenancePage([value]))
  await render(
    <>
      <CommitSeatLabels value={value} />
      <CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />
    </>,
  )
  expect(host.querySelector('[data-provenance-label]')?.textContent).toContain('+5 Seats')
  expect(host.querySelector('[data-provenance-label] button, [data-provenance-label] a')).toBeNull()
  expect([...host.querySelectorAll('button')].filter((one) => one.textContent === 'Seat record')).toHaveLength(6)
  for (let n = 1; n <= 6; n += 1) expect(text()).toContain(`Contributor ${n}`)
})

it('partial, unknown, capture-off and pending states keep their exact explanation', async () => {
  for (const scene of ['partial', 'unknown', 'off', 'pending'] as const) {
    const value = sceneCommit(scene)
    vi.mocked(store.readProvenance).mockResolvedValue(provenancePage([value]))
    await render(<CommitProvenance key={scene} root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />)
    expect(text()).toContain(value.explanation)
    expect(text()).toContain(
      scene === 'partial' ? 'Partly attributed' : scene === 'pending' ? 'Capture is catching up' : 'Unattributed',
    )
  }
})

it('a rejected request offers Retry instead of calling the commit unattributed', async () => {
  vi.mocked(store.readProvenance).mockRejectedValueOnce(new Error('private path'))
  await render(<CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />)
  expect(text()).toContain('Provenance could not be read.')
  expect(text()).not.toContain('private path')
  expect(text()).not.toContain('Unattributed')
  await act(async () => {
    button('Retry provenance').click()
  })
  expect(text()).toContain('Contributor 1')
})

it('untrusted Agent names remain literal text and an absent runtime keeps a generic mark', async () => {
  const name = '<img src=x onerror=alert(1)>'
  snapshot = { ...snapshot, runtimes: [] }
  vi.mocked(store.readProvenance).mockResolvedValue(
    provenancePage([commitProvenance({ seats: [{ ...provenanceSeat(), agentName: name }] })]),
  )
  await render(<CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />)
  expect(text()).toContain(name)
  expect(host.querySelector('img, script, a, [onerror]')).toBeNull()
  expect(host.querySelector('svg')).not.toBeNull()
})

it('Seat record requests the immutable ID and opens only its original session pointer', async () => {
  await render(<CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />)
  await act(async () => {
    button('Seat record').click()
  })
  expect(store.readProvenanceSeat).toHaveBeenCalledWith(PROVENANCE_ROOT, 'seat-1')
  expect(text()).toContain('Alpha · careful')
  await act(async () => {
    button('Open conversation').click()
  })
  expect(store.openSession).toHaveBeenCalledWith('conversation-1', { runtime: 'fixture' })
})

it('missing Seats, deleted sessions and removed runtimes explain the disabled action', async () => {
  const cases: [ProvenanceSeatDetail, boolean, string][] = [
    [
      { seat: null, session: null, unavailable: 'The original record is unavailable.' },
      true,
      'The historical Seat record is unavailable.',
    ],
    [
      { ...provenanceDetail(), session: null, unavailable: 'Its conversation was deleted.' },
      true,
      'Its conversation was deleted.',
    ],
    [provenanceDetail(), false, 'Its runtime is no longer available.'],
  ]
  for (const [detail, runtime, reason] of cases) {
    if (!runtime) snapshot = { ...snapshot, runtimes: [] }
    vi.mocked(store.readProvenanceSeat).mockResolvedValue(detail)
    await render(<ProvenanceDialog key={reason} root={PROVENANCE_ROOT} seat="seat-1" onClose={() => {}} />)
    expect(text()).toContain(reason)
    expect(button('Open conversation').disabled).toBe(true)
  }
})

it('switching or closing a Dialog retires its late Seat read', async () => {
  const pending = deferred<ProvenanceSeatDetail>()
  vi.mocked(store.readProvenanceSeat).mockReturnValueOnce(pending.promise).mockResolvedValue(provenanceDetail(2))
  await render(<ProvenanceDialog root={PROVENANCE_ROOT} seat="seat-1" onClose={() => {}} />)
  await render(<ProvenanceDialog root={PROVENANCE_ROOT} seat="seat-2" onClose={() => {}} />)
  await act(async () => {
    pending.resolve(provenanceDetail(1))
  })
  expect(text()).toContain('Contributor 2')
  expect(text()).not.toContain('Contributor 1')
  await render(null)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('a failed Open conversation keeps the historical record and a bounded error', async () => {
  vi.mocked(store.openSession).mockRejectedValue(new Error('private path'))
  await render(<ProvenanceDialog root={PROVENANCE_ROOT} seat="seat-1" onClose={() => {}} />)
  await act(async () => {
    button('Open conversation').click()
  })
  expect(text()).toContain('The original conversation could not be opened.')
  expect(text()).toContain('Contributor 1')
  expect(text()).not.toContain('private path')
})

const Batch = ({ shas }: { shas: readonly string[] }) => {
  const read = useProvenanceBatch(PROVENANCE_ROOT, shas, 'all')
  return <span>{read.values.size}</span>
}

it('paging reads one batch for each loaded page and a revision refreshes only loaded pages', async () => {
  const shas = Array.from({ length: 800 }, (_, n) => n.toString(16).padStart(40, '0'))
  vi.mocked(store.readProvenance).mockImplementation(async (_root, asked) =>
    provenancePage(asked.map((sha) => commitProvenance({ sha }))),
  )
  await render(<Batch shas={shas.slice(0, 400)} />)
  expect(store.readProvenance).toHaveBeenCalledTimes(1)
  await render(<Batch shas={shas} />)
  expect(store.readProvenance).toHaveBeenCalledTimes(2)
  snapshot = { ...snapshot, provenanceRevision: new Map([[PROVENANCE_ROOT, 2]]) }
  await render(<Batch shas={shas} />)
  expect(store.readProvenance).toHaveBeenCalledTimes(4)
  expect(host.textContent).toBe('800')
})

it('a stale same-root retry reply cannot overwrite the current generation', async () => {
  const first = deferred<ProjectProvenance>()
  vi.mocked(store.readProvenance).mockReturnValueOnce(first.promise)
  await render(<CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />)
  snapshot = { ...snapshot, provenanceRevision: new Map([[PROVENANCE_ROOT, 2]]) }
  await render(<CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />)
  expect(text()).toContain('Contributor 1')
  await act(async () => {
    first.resolve(provenancePage([commitProvenance({ seats: [{ ...provenanceSeat(), agentName: 'Superseded' }] })]))
  })
  expect(text()).not.toContain('Superseded')
  expect(text()).toContain('Contributor 1')
})

it('an unavailable Seat read retries and a disconnected detail draws no stale actions', async () => {
  vi.mocked(store.readProvenanceSeat).mockRejectedValueOnce(new Error('private read'))
  await render(<ProvenanceDialog root={PROVENANCE_ROOT} seat="seat-1" onClose={() => {}} />)
  expect(text()).toContain('The Seat record could not be read.')
  expect(button('Open conversation').disabled).toBe(true)
  await act(async () => {
    button('Retry Seat record').click()
  })
  expect(text()).toContain('Contributor 1')
  expect(text()).toContain('its text is not retained')
  snapshot = { ...snapshot, status: 'reconnecting' }
  await render(<ProvenanceDialog root={PROVENANCE_ROOT} seat="seat-1" onClose={() => {}} />)
  expect(text()).not.toContain('Contributor 1')
  expect(button('Open conversation').disabled).toBe(true)
})

it('card navigation names only a present card and leaves a missing historical card unavailable', async () => {
  snapshot = {
    ...snapshot,
    teams: new Map([
      [
        'board-a',
        {
          id: 'board-a',
          name: 'Review',
          intents: [{ id: 3, title: 'Keep the change', dependsOn: [] }],
        } as never,
      ],
    ]),
  }
  vi.mocked(store.readProvenance).mockResolvedValue(
    provenancePage([
      commitProvenance({
        evidenceIds: ['fact-a'],
        cards: [
          { board: 'board-a', id: 3 },
          { board: 'gone', id: 4 },
        ],
      }),
    ]),
  )
  await render(<CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />)
  expect(text()).toContain('1 matching local observation.')
  expect(text()).toContain('The original card is no longer available.')
  expect(text()).not.toContain('fact-a')
  await act(async () => {
    button('Open card #3 in Review').click()
  })
  expect(store.openTeamBoard).toHaveBeenCalledWith('board-a')
})

it('matching evidence opens the existing observation dialog at its original SHA', async () => {
  const fact = {
    record: {
      id: 'fact-a',
      observedAt: 20,
      seat: 'seat-1',
      fact: { kind: 'diff' as const, files: 1, added: 2, removed: 0, from: 'b'.repeat(40), to: 'c'.repeat(40) },
    },
    freshness: { state: 'moved' as const },
    by: { agent: 'Contributor 1', seat: 'Alpha · careful' },
  }
  snapshot = {
    ...snapshot,
    teams: new Map([
      ['board-a', { id: 'board-a', name: 'Review', intents: [{ id: 3, title: 'Keep the change' }] } as never],
    ]),
    boardEvidence: new Map([
      [
        'board-a',
        {
          room: 'board-a',
          stamp: 20,
          checks: [],
          refused: [],
          unreadable: null,
          cards: [{ card: 3, facts: [fact], running: [] }],
        },
      ],
    ]),
  }
  vi.mocked(store.readProvenance).mockResolvedValue(
    provenancePage([
      commitProvenance({
        evidenceIds: ['fact-a'],
        cards: [{ board: 'board-a', id: 3 }],
      }),
    ]),
  )
  await render(<CommitProvenance root={PROVENANCE_ROOT} sha={PROVENANCE_SHA} />)
  await act(async () => {
    button('Matching observations for #3').click()
  })
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('ccccccc')
  expect(dialog.textContent).not.toContain('aaaaaaa')
  expect(snapshot.boardEvidence.get('board-a')!.cards[0]!.facts[0]!.freshness).toEqual({ state: 'moved' })
})
```

Create `packages/ui/src/state/store.provenance.test.ts` with these complete contents:

```ts
import { beforeEach, expect, it, vi } from 'vitest'

import type { CaptureHealth, HostMethodName, WireNotification } from '@harnessdesk/protocol'

import type { TransportEvents } from '../lib/transport'
import {
  captureHealth,
  provenanceDetail,
  provenancePage,
  PROVENANCE_ROOT,
  PROVENANCE_SHA,
} from '../preview/provenance-fixture'
import { AppStore } from './store'

let store: AppStore
let request: ReturnType<typeof vi.fn>
const handlers = () => (store.transport as unknown as { handlers: TransportEvents }).handlers
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const push = (health: CaptureHealth) =>
  handlers().onNotification({
    method: 'provenance/changed',
    params: { project: health.project, revision: health.revision, health },
  } as WireNotification)

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  request = vi.fn(async (method: HostMethodName) => (method === 'provenance/status' ? [] : null))
  vi.spyOn(store.transport, 'request').mockImplementation(request as never)
})

it('reads a bounded history batch and the immutable Seat through their own verbs', async () => {
  const page = provenancePage()
  request.mockResolvedValueOnce(page)
  await expect(store.readProvenance(PROVENANCE_ROOT, [PROVENANCE_SHA])).resolves.toBe(page)
  expect(request).toHaveBeenLastCalledWith('provenance/commits', { root: PROVENANCE_ROOT, shas: [PROVENANCE_SHA] })
  const detail = provenanceDetail()
  request.mockResolvedValueOnce(detail)
  await expect(store.readProvenanceSeat(PROVENANCE_ROOT, 'seat-1')).resolves.toBe(detail)
  expect(request).toHaveBeenLastCalledWith('provenance/seat', { root: PROVENANCE_ROOT, seat: 'seat-1' })
  expect(store.getSnapshot().captureHealth.get(PROVENANCE_ROOT)).toBe(page.health)
})

it('newer notifications advance health while an older one leaves it alone', () => {
  const latest = captureHealth({ revision: 5, state: 'degraded' })
  push(latest)
  push(captureHealth({ revision: 4 }))
  expect(store.getSnapshot().captureHealth.get(PROVENANCE_ROOT)).toBe(latest)
  expect(store.getSnapshot().provenanceRevision.get(PROVENANCE_ROOT)).toBe(5)
})

it('disconnect discards health from a commit response that started on the old connection', async () => {
  const pending = deferred<ReturnType<typeof provenancePage>>()
  request.mockReturnValueOnce(pending.promise)
  const read = store.readProvenance(PROVENANCE_ROOT, [PROVENANCE_SHA])
  handlers().onStatus('closed')
  pending.resolve(provenancePage())
  await read
  expect(store.getSnapshot().captureHealth.size).toBe(0)
  expect(store.getSnapshot().provenanceRevision.size).toBe(0)
})
```

- [ ] **Step 3: Run the missing-component red.**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/CommitProvenance.test.tsx`

Expected: exit 1; `Failed to resolve import "./CommitProvenance" from "src/components/CommitProvenance.test.tsx". Does the file exist?` No assertion ran in this import failure. Step 8 separately proves behavioral assertions go red.

- [ ] **Step 4: Add the typed reads and revision-owned snapshot updates.**

The epoch only prevents old connection replies from updating the current snapshot; it does not cancel the host's work. A commit read merges health using the host revision. A notification must be newer before it is applied. The page retains no copy of the journal or a second Seat cache.

In `packages/ui/src/state/snapshot.ts`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/state/snapshot.ts
+++ b/packages/ui/src/state/snapshot.ts
@@ -200,6 +200,8 @@
   | { readonly kind: 'existing'; readonly path: string; readonly branch: string | null }

 export interface AppSnapshot {
+  readonly captureHealth: ReadonlyMap<string, import('@harnessdesk/protocol').CaptureHealth>
+  readonly provenanceRevision: ReadonlyMap<string, number>
   readonly status: ConnectionStatus
   readonly runtimes: readonly RuntimeInfo[]
   readonly activeRuntime: RuntimeId | null
@@ -603,6 +605,8 @@
  * way out is `emptySnapshot()`, which copies those fields fresh.
  */
 const EMPTY: AppSnapshot = {
+  captureHealth: new Map(),
+  provenanceRevision: new Map(),
   status: 'connecting',
   runtimes: [],
   catalogRefreshing: false,
@@ -689,6 +693,8 @@
 /** A blank snapshot, for tests that render a component against a made-up state. */
 export const emptySnapshot = (): AppSnapshot => ({
   ...EMPTY,
+  captureHealth: new Map(),
+  provenanceRevision: new Map(),
   sessions: new Map(),
   queues: new Map(),
   tasks: new Map(),
```

In `packages/ui/src/state/store.ts`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/state/store.ts
+++ b/packages/ui/src/state/store.ts
@@ -216,6 +216,27 @@
 export { emptySnapshot } from './snapshot'

 export class AppStore {
+  #captureEpoch = 0
+
+  #keepCaptureHealth(health: import('@harnessdesk/protocol').CaptureHealth): void {
+    if (health.revision < (this.#snapshot.provenanceRevision.get(health.project) ?? -1)) return
+    this.#patch({
+      captureHealth: new Map(this.#snapshot.captureHealth).set(health.project, health),
+      provenanceRevision: new Map(this.#snapshot.provenanceRevision).set(health.project, health.revision),
+    })
+  }
+
+  async readProvenance(root: string, shas: readonly string[]): Promise<import('@harnessdesk/protocol').ProjectProvenance> {
+    const epoch = this.#captureEpoch
+    const value = await this.transport.request('provenance/commits', { root, shas })
+    if (epoch === this.#captureEpoch) this.#keepCaptureHealth(value.health)
+    return value
+  }
+
+  async readProvenanceSeat(root: string, seat: string): Promise<import('@harnessdesk/protocol').ProvenanceSeatDetail> {
+    return this.transport.request('provenance/seat', { root, seat })
+  }
+
   #snapshot: AppSnapshot = emptySnapshot()
   #listeners = new Set<() => void>()
   readonly transport: Transport
@@ -224,6 +245,10 @@
     this.transport = new Transport(url, {
       onEvent: (runtime, event) => this.#onEvent(runtime, event),
       onNotification: (notification) => {
+        if (notification.method === 'provenance/changed') {
+          const { project, revision, health } = notification.params
+          if (revision > (this.#snapshot.provenanceRevision.get(project) ?? -1)) this.#keepCaptureHealth(health)
+        }
         if (notification.method === 'sync') {
           const sessions = new Map(this.#snapshot.sessions)
           const rawSessions = Array.isArray(notification.params.sessions)
@@ -391,7 +416,14 @@
           }
         }
       },
-      onStatus: (status) => this.#patch({ status }),
+      onStatus: (status) => {
+        if (status !== 'open') {
+          this.#captureEpoch += 1
+          this.#patch({ status, captureHealth: new Map(), provenanceRevision: new Map() })
+        } else {
+          this.#patch({ status })
+        }
+      },
     })
     this.#watchWindowWidth()
   }
```

In `script/check-reachable.mjs`, replace this exact anchor:

```ts
  'provenance/commits': 'the history page batches its provenance read in Task 7 of the provenance phase',
  'provenance/seat': 'the historical Seat dialog reads its exact record in Task 7 of the provenance phase',
  'provenance/status': 'project health and the sidebar read capture status in Task 8 of the provenance phase',
```

with:

```ts
  'provenance/status': 'project health and the sidebar read capture status in Task 8 of the provenance phase',
```

- [ ] **Step 5: Compose labels, detail and the historical record.**

A label is ordinary React text inside one history option. It has no click handler. Detail carries all actions and all contributors; the decorative graph is untouched. A missing runtime uses the existing generic Agent icon and preserves the recorded name and seat description. An Agent's brief digest identifies history, but its text is not retained: the dialog says this without drawing a digest or claiming the current brief is unchanged.

Create `packages/ui/src/lib/provenance.ts` with these complete contents:

```ts
import type { CaptureHealth, CommitProvenance, WorkspaceEntry } from '@harnessdesk/protocol'

/** Capture is a local observation, not a check verdict. */
export const captureWords = (
  health: CaptureHealth,
): {
  label: string
  tone: 'success' | 'warning' | 'neutral'
} =>
  health.state === 'healthy'
    ? { label: 'Healthy', tone: 'success' }
    : health.state === 'degraded'
      ? { label: 'Degraded', tone: 'warning' }
      : { label: 'Stopped', tone: 'neutral' }

export const provenanceWords = (value: CommitProvenance): string =>
  value.state === 'pending'
    ? 'Capture is catching up'
    : value.state === 'unattributed'
      ? 'Unattributed'
      : value.coverage === 'partial'
        ? 'Partly attributed'
        : 'Associated Seat'

/** A checkout asks by its path; health is held under the canonical project. */
export const captureForRoot = (
  root: string,
  health: ReadonlyMap<string, CaptureHealth>,
  workspaces: readonly WorkspaceEntry[],
): CaptureHealth | undefined => {
  const project = workspaces.find((one) => one.path === root)?.repo?.root ?? root
  return health.get(project) ?? health.get(root)
}
```

Create `packages/ui/src/components/CommitProvenance.tsx` with these complete contents:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'

import type { CommitProvenance as Attribution, ProvenanceSeat } from '@harnessdesk/protocol'

import { Button, Chip, Note, Row, Rows, SectionHead } from '../design'
import { captureForRoot, provenanceWords } from '../lib/provenance'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { AgentIcon } from './Icons'
import { ObservedDialog } from './EvidenceChips'
import { ProvenanceDialog } from './ProvenanceDialog'

const SeatLabel = ({ seat }: { readonly seat: ProvenanceSeat }) => {
  const snapshot = useSnapshot()
  const runtime = snapshot.runtimes.find((one) => one.id === seat.runtime)
  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={seat.seatLabel}>
      {runtime ? <RuntimeMark runtime={runtime} /> : <AgentIcon size={14} />}
      <span className="min-w-0 truncate">{seat.agentName ?? 'Seat'}</span>
    </span>
  )
}

/** Plain text inside the history option; actions belong to selected detail. */
export const CommitSeatLabels = ({ value }: { readonly value: Attribution | null }) => {
  const seat = value?.seats[0]
  if (!seat) return null
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-provenance-label="">
      <SeatLabel seat={seat} />
      {value.seats.length > 1 && <span>{`+${value.seats.length - 1} Seats`}</span>}
    </span>
  )
}

/**
 * Each loaded page is read once per view generation. Adding another page
 * keeps earlier reads; a root, filter or revision change retires them all.
 */
export const useProvenanceBatch = (root: string | null, shas: readonly string[], scope: string) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const health = root ? captureForRoot(root, snapshot.captureHealth, snapshot.workspaces) : undefined
  const revision = snapshot.provenanceRevision.get(health?.project ?? root ?? '') ?? 0
  const [attempt, setAttempt] = useState(0)
  const identity = JSON.stringify([root, scope, revision, snapshot.status, attempt])
  const pages = useMemo(() => {
    const unique = [...new Set(shas)]
    return Array.from({ length: Math.ceil(unique.length / 400) }, (_, n) => unique.slice(n * 400, (n + 1) * 400))
  }, [JSON.stringify(shas)])
  const held = useRef({ identity: '', generation: 0, asked: new Set<string>() })
  const [read, setRead] = useState({ identity: '', values: new Map<string, Attribution>(), error: false })

  useEffect(() => {
    held.current = { identity, generation: held.current.generation + 1, asked: new Set() }
    return () => {
      held.current.generation += 1
    }
  }, [identity])

  useEffect(() => {
    if (!root || snapshot.status !== 'open') return
    const generation = held.current.generation
    for (const page of pages) {
      const pageKey = JSON.stringify(page)
      if (held.current.asked.has(pageKey)) continue
      held.current.asked.add(pageKey)
      void store.readProvenance(root, page).then(
        (value) => {
          if (held.current.generation !== generation) return
          setRead((old) => {
            const values = new Map(old.identity === identity ? old.values : [])
            for (const commit of value.commits) values.set(commit.sha, commit)
            return { identity, values, error: old.identity === identity && old.error }
          })
        },
        () => {
          if (held.current.generation !== generation) return
          setRead((old) => ({ identity, values: old.identity === identity ? old.values : new Map(), error: true }))
        },
      )
    }
  }, [store, root, identity, pages, snapshot.status])

  return {
    values: read.identity === identity ? read.values : new Map<string, Attribution>(),
    error: read.identity === identity && read.error,
    retry: () => setAttempt((n) => n + 1),
  }
}

export const CommitProvenance = ({ root, sha }: { readonly root: string; readonly sha: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const shas = useMemo(() => [sha], [sha])
  const read = useProvenanceBatch(root, shas, 'detail')
  const value = read.values.get(sha)
  const [selected, setSelected] = useState<{ root: string; sha: string; seat: string } | null>(null)
  const [observed, setObserved] = useState<{ root: string; sha: string; board: string; card: number } | null>(null)
  const availableCards =
    value?.cards.flatMap((ref) => {
      const board = snapshot.teams.get(ref.board)
      const card = board?.intents.find((one) => one.id === ref.id)
      return board && card ? [{ ref, board, card }] : []
    }) ?? []
  const matches = value?.evidenceIds.length ?? 0
  const shown =
    observed?.root === root && observed.sha === sha
      ? availableCards.find((one) => one.ref.board === observed.board && one.ref.id === observed.card)
      : undefined
  const observedCard =
    shown && snapshot.boardEvidence.get(shown.ref.board)?.cards.find((one) => one.card === shown.ref.id)

  return (
    <section aria-label="Commit provenance">
      <SectionHead name="Provenance" />
      {snapshot.status !== 'open' ? (
        <Note>Provenance is unavailable while disconnected.</Note>
      ) : read.error ? (
        <>
          <Note>Provenance could not be read.</Note>
          <Button variant="secondary" onClick={read.retry}>
            Retry provenance
          </Button>
        </>
      ) : !value ? (
        <Note>Reading provenance…</Note>
      ) : (
        <>
          <Chip tone="neutral" label={provenanceWords(value)} />
          <Note>{value.explanation}</Note>
          {value.seats.length > 0 && (
            <Rows>
              {value.seats.map((seat) => (
                <Row
                  key={seat.id}
                  title={<SeatLabel seat={seat} />}
                  desc={seat.seatLabel}
                  control={
                    <Button
                      variant="secondary"
                      aria-label={`Seat record for ${seat.agentName ?? 'Seat'}`}
                      onClick={() => setSelected({ root, sha, seat: seat.id })}
                    >
                      Seat record
                    </Button>
                  }
                />
              ))}
            </Rows>
          )}
          {matches > 0 && <Note>{`${matches} matching local ${matches === 1 ? 'observation' : 'observations'}.`}</Note>}
          {availableCards.map(({ ref, board, card }) => {
            const facts = snapshot.boardEvidence.get(ref.board)?.cards.find((one) => one.card === ref.id)?.facts
            const recorded = facts?.some((one) => value.evidenceIds.includes(one.record.id))
            return (
              <div key={`${ref.board}:${ref.id}`} className="flex flex-wrap gap-2">
                <Button variant="link" onClick={() => store.openTeamBoard(ref.board)}>
                  {`Open card #${card.id} in ${board.name}`}
                </Button>
                {recorded && (
                  <Button variant="link" onClick={() => setObserved({ root, sha, board: ref.board, card: ref.id })}>
                    {`Matching observations for #${card.id}`}
                  </Button>
                )}
              </div>
            )
          })}
          {availableCards.length < value.cards.length && <Note>The original card is no longer available.</Note>}
        </>
      )}
      {selected?.root === root && selected.sha === sha && (
        <ProvenanceDialog root={root} seat={selected.seat} onClose={() => setSelected(null)} />
      )}
      {shown && observedCard && value && (
        <ObservedDialog
          id={shown.card.id}
          title={shown.card.title}
          card={{
            ...observedCard,
            running: [],
            facts: observedCard.facts.filter((one) => value.evidenceIds.includes(one.record.id)),
          }}
          onClose={() => setObserved(null)}
        />
      )}
    </section>
  )
}
```

Create `packages/ui/src/components/ProvenanceDialog.tsx` with these complete contents:

```tsx
import { useEffect, useRef, useState } from 'react'

import { runtimeId, sessionId, type ProvenanceSeatDetail } from '@harnessdesk/protocol'

import { Button, Dialog, Note } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { SeatRecordView } from './SeatRecordBlock'

export const ProvenanceDialog = ({
  root,
  seat,
  onClose,
}: {
  readonly root: string
  readonly seat: string
  readonly onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([root, seat, snapshot.status, attempt])
  const [read, setRead] = useState<{
    key: string
    value?: ProvenanceSeatDetail
    error?: string
  } | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ key: string; text: string } | null>(null)

  useEffect(() => {
    if (snapshot.status !== 'open') return
    let live = true
    void store.readProvenanceSeat(root, seat).then(
      (value) => {
        if (live) setRead({ key, value })
      },
      () => {
        if (live) setRead({ key, error: 'The Seat record could not be read.' })
      },
    )
    return () => {
      live = false
    }
  }, [store, root, seat, key, snapshot.status])

  const current = read?.key === key ? read : null
  const pointer = current?.value?.session
  const runtime = pointer && snapshot.runtimes.find((one) => one.id === pointer.runtime)
  const unavailable =
    snapshot.status !== 'open'
      ? 'The desk is disconnected.'
      : (current?.value?.unavailable ??
        (!pointer
          ? 'The original conversation is unavailable.'
          : !runtime
            ? 'Its runtime is no longer available.'
            : null))

  const active = useRef(true)
  const currentKey = useRef(key)
  currentKey.current = key
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const open = async () => {
    if (!pointer || unavailable || opening === key) return
    setOpening(key)
    setProblem(null)
    try {
      await store.openSession(sessionId(pointer.sessionId), { runtime: runtimeId(pointer.runtime) })
      if (active.current && currentKey.current === key) onClose()
    } catch {
      if (active.current && currentKey.current === key)
        setProblem({ key, text: 'The original conversation could not be opened.' })
    } finally {
      if (active.current && currentKey.current === key) setOpening(null)
    }
  }

  return (
    <Dialog
      title="Seat record"
      onClose={onClose}
      footer={
        <Button
          variant="secondary"
          disabled={!current?.value || unavailable !== null || opening === key}
          onClick={() => void open()}
        >
          Open conversation
        </Button>
      }
    >
      {snapshot.status !== 'open' ? (
        <Note>The Seat record is unavailable while disconnected.</Note>
      ) : !current ? (
        <Note>Reading Seat record…</Note>
      ) : current.error ? (
        <>
          <Note>{current.error}</Note>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Retry Seat record
          </Button>
        </>
      ) : current.value?.seat ? (
        <SeatRecordView seat={current.value.seat} />
      ) : (
        <Note>The historical Seat record is unavailable.</Note>
      )}
      {current?.value?.seat && (
        <Note>
          {current.value.seat.briefDigest
            ? 'The recorded brief has an identity, but its text is not retained. The Agent may have changed since this Seat was kept.'
            : 'No brief identity was recorded for this Seat.'}
        </Note>
      )}
      {current?.value && unavailable && <Note>{unavailable}</Note>}
      {problem?.key === key && <Note>{problem.text}</Note>}
    </Dialog>
  )
}
```

- [ ] **Step 6: Insert batches and detail into the existing history pane.**

`loadedFor` is stamped only by a successful current log generation. Without it, the render immediately after a root or filter change still holds the previous page's commits and can submit those SHAs under the new root. Pages of 400 match the existing history page size and stay below the wire's 1,000 limit. The batch hook retains already-read pages when another page is appended, and refreshes loaded pages on a newer revision. Pending reads do not replace the log or graph.

The detail insertion belongs inside the existing summary card because that card is reused in the wide and narrow layouts. The existing diff renderer and commit actions keep their current code.

In `packages/ui/src/components/GitPane.tsx`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/components/GitPane.tsx
+++ b/packages/ui/src/components/GitPane.tsx
@@ -24,7 +24,9 @@
 } from '@harnessdesk/protocol'

 import { laneWindow, layoutGraph, type GraphRow, type LaneWindow } from '../lib/git-graph'
+import { Note } from '../design'
 import { GitGraph } from './GitGraph'
+import { CommitProvenance, CommitSeatLabels, useProvenanceBatch } from './CommitProvenance'
 import { clampColumn, GIT_COLUMNS, type GitColumnName } from '../lib/git-columns'
 import { branchTree, commitDate, inFolder, refChips, shortSha } from '../lib/git-refs'
 import { openExternal } from '../lib/desktop'
@@ -197,6 +199,13 @@
   const [railError, setRailError] = useState<string | null>(null)
   const [branchAt, setBranchAt] = useState<string | null>(null)
   const [tick, setTick] = useState(0)
+  const historyKey = JSON.stringify([root, scope, needle, search, tick])
+  const [loadedFor, setLoadedFor] = useState('')
+  const provenance = useProvenanceBatch(
+    root,
+    loadedFor === historyKey ? commits.map((commit) => commit.sha) : [],
+    historyKey,
+  )

   // One generation per reload: a page arriving for a root or query the pane
   // has moved past must fall on the floor, not into the table.
@@ -226,6 +235,7 @@
       request('git/worktrees', { root }).catch((): readonly GitWorktree[] => []),
     ]).then(([page, refsResult, status, checkouts]) => {
       if (gen.current !== mine) return
+      setLoadedFor(JSON.stringify([root, scope, needle, search, tick]))
       setCommits(page.commits)
       setHasMore(page.hasMore)
       setRefsSummary(refsResult)
@@ -843,6 +853,12 @@
         </span>
       </div>

+      {provenance.error && (
+        <Note>
+          Provenance could not be read.
+          <Button variant="link" onClick={provenance.retry}>Retry provenance</Button>
+        </Note>
+      )}
       <div className={styles.body}>
         {fit.rail && railOpen && refsSummary && (
           <RefsRail
@@ -932,6 +948,7 @@
                     <CommitRow
                       key={commit.sha}
                       commit={commit}
+                      provenance={provenance.values.get(commit.sha) ?? null}
                       row={row}
                       top={index * ROW}
                       gutter={gutter}
@@ -1625,6 +1642,7 @@

 const CommitRow = ({
   commit,
+  provenance,
   row,
   top,
   gutter,
@@ -1638,6 +1656,7 @@
   onMenu,
 }: {
   commit: GitLogCommit
+  provenance: import('@harnessdesk/protocol').CommitProvenance | null
   row: GraphRow | null
   top: number
   gutter: number
@@ -1676,6 +1695,7 @@
         <span className={styles.subjectText} title={commit.subject}>
           {commit.subject}
         </span>
+        <CommitSeatLabels value={provenance} />
       </span>
       {fit.sha && (
         <span className={styles.sha} style={{ width: widths.sha }}>
@@ -2035,6 +2055,7 @@
           </>
         )}
       </dl>
+      <CommitProvenance root={root} sha={sha} />
     </div>
   )
```

In `packages/ui/src/components/GitPane.test.tsx`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/components/GitPane.test.tsx
+++ b/packages/ui/src/components/GitPane.test.tsx
@@ -14,6 +14,7 @@
 import { MountProvider } from '../panels/mount'
 import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
 import { GitPane } from './GitPane'
+import { commitProvenance, provenanceDetail, provenancePage, PROVENANCE_SHA } from '../preview/provenance-fixture'

 /**
  * The history pane against a scripted host. What is held: the pane asks for
@@ -143,6 +144,9 @@
     subscribe: () => () => {},
     getSnapshot: () => snapshot,
     transport: { request },
+    readProvenance: vi.fn(async (_root: string, shas: readonly string[]) =>
+      provenancePage(shas.map((sha) => commitProvenance({ sha })))),
+    readProvenanceSeat: vi.fn(async () => provenanceDetail()),
     setDetailsTab,
     openDetailsTab,
     notice,
@@ -935,7 +939,7 @@
   // No room for a lane is not "one lane hidden", it is no graph: a count
   // that cannot fit beside the label would land on the next column.
   expect(head().textContent).not.toContain('+')
-  expect(document.body.querySelector('[role="option"] span > svg')).toBeNull()
+  expect(document.body.querySelector('[role="option"] [class*="gutter"] > svg')).toBeNull()
   // The handle stays, so the column can be brought back.
   expect(head().querySelector('[aria-label="Resize the Graph column"]')).toBeTruthy()
 })
@@ -1068,3 +1072,18 @@
   const rows = [...document.querySelectorAll('[role="checkbox"]')].filter((node) => node.textContent?.includes('src/a.ts'))
   expect(rows).toHaveLength(1)
 })
+
+it('commit attribution keeps listbox options noninteractive and preserves keyboard selection', async () => {
+  const { store, request } = await mount({ log: [commit(PROVENANCE_SHA, 'Synthetic change')] })
+  expect(store.readProvenance).toHaveBeenCalledWith('/repo/app', [PROVENANCE_SHA])
+  expect(container.querySelector('[role="option"]')?.textContent).toContain('Contributor 1')
+  expect(container.querySelector('[role="option"] button, [role="option"] a')).toBeNull()
+  const list = container.querySelector<HTMLElement>('[role="listbox"]')!
+  await act(async () => {
+    list.focus()
+    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
+    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
+  })
+  expect(request).toHaveBeenCalledWith('git/commit', { root: '/repo/app', sha: PROVENANCE_SHA })
+  expect(container.querySelector('[role="option"]')?.getAttribute('aria-selected')).toBe('true')
+})
```

- [ ] **Step 7: Wire the preview and write the browser proof in full.**

The generic preview store supplies explicit harmless defaults for the new verbs. `provenancePreviewStore` is a separate store for these frames, using only synthetic names, addresses and paths. Its capture methods prepare the next task's fixture; they do not call a wire method or remove a reachable-method pin. Its long-name, hostile-text, missing, deleted, absent-runtime and loading scenes are selected through the frame's dial.

In `packages/ui/src/preview/harness.tsx`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/preview/harness.tsx
+++ b/packages/ui/src/preview/harness.tsx
@@ -1,3 +1,8 @@
+import type { CaptureHealth, HostMethodName } from '@harnessdesk/protocol'
+import {
+  captureHealth, provenanceDetail, provenanceLog, provenancePage, sceneCommit, sceneHealth,
+  PROVENANCE_ROOT, PROVENANCE_SHA, type CaptureScene, type ProvenanceScene,
+} from './provenance-fixture'
 import type { ReactNode } from 'react'

 import {
@@ -593,6 +598,14 @@

 /** The smallest store the mounted screens call. */
 class PreviewStore {
+  readProvenance = async (root: string, shas: readonly string[]) => provenancePage(
+    shas.map((sha) => ({ ...sceneCommit('unknown'), sha })), captureHealth({ project: root }),
+  )
+  readProvenanceSeat = async () => ({ seat: null, session: null, unavailable: 'No historical Seat in this frame.' })
+  loadCaptureHealth = async (): Promise<void> => {}
+  setCapture = async (root: string, enabled: boolean) => captureHealth({ project: root, enabled })
+  retryCapture = async (root: string) => captureHealth({ project: root })
+
   #snapshot: AppSnapshot
   #listeners = new Set<() => void>()

@@ -1329,3 +1342,87 @@
 )

 export { Boundary }
+
+/** An isolated provenance frame; every request is answered by this fixture. */
+export const provenancePreviewStore = (
+  scene: ProvenanceScene,
+  capture: CaptureScene = 'healthy',
+): AppStore => {
+  const health = sceneHealth(capture)
+  const fixtureRuntime = runtime('fixture', 'Alpha')
+  const snapshot = {
+    ...emptySnapshot(),
+    status: 'open' as const,
+    runtimes: scene === 'absent-runtime' ? [] : [fixtureRuntime],
+    captureHealth: new Map(health ? [[PROVENANCE_ROOT, health]] : []),
+    provenanceRevision: new Map([[PROVENANCE_ROOT, health?.revision ?? 0]]),
+    workspace: { path: PROVENANCE_ROOT, name: 'project', lastOpenedAt: 1 },
+    workspaces: [{
+      path: PROVENANCE_ROOT, name: 'project', lastOpenedAt: 1,
+      ...(capture === 'non-git' ? { git: null, repo: null } : { repo: { root: PROVENANCE_ROOT, worktree: false } }),
+    }],
+    listPrefs: { ...emptySnapshot().listPrefs, collapsed: [PROVENANCE_ROOT] },
+  }
+  const desk = previewStore(snapshot)
+  const captureDesk = desk as AppStore & {
+    loadCaptureHealth(root?: string): Promise<void>
+    setCapture(root: string, enabled: boolean): Promise<CaptureHealth>
+    retryCapture(root: string): Promise<CaptureHealth>
+  }
+  const patch = (next: Partial<AppSnapshot>) => (desk as unknown as { patch(value: Partial<AppSnapshot>): void }).patch(next)
+  const keep = (value: CaptureHealth) => {
+    patch({
+      captureHealth: new Map([[value.project, value]]),
+      provenanceRevision: new Map([[value.project, value.revision]]),
+    })
+    return value
+  }
+  desk.readProvenance = async (root, shas) => {
+    if (scene === 'loading') return new Promise(() => {})
+    if (scene === 'error') throw new Error('The preview read is unavailable.')
+    const state = desk.getSnapshot().captureHealth.get(PROVENANCE_ROOT) ?? captureHealth()
+    return provenancePage(shas.map((sha) => ({ ...sceneCommit(scene), sha })), { ...state, project: root })
+  }
+  desk.readProvenanceSeat = async (_root, id) => {
+    const number = Number(id.slice('seat-'.length))
+    if (scene === 'missing') return { seat: null, session: null, unavailable: 'The original record is unavailable.' }
+    const detail = provenanceDetail(number)
+    return scene === 'deleted'
+      ? { ...detail, session: null, unavailable: 'Its conversation was deleted.' }
+      : detail
+  }
+  captureDesk.loadCaptureHealth = async () => {
+    if (capture === 'loading') return new Promise(() => {})
+    if (capture === 'error') throw new Error('The preview status is unavailable.')
+  }
+  captureDesk.setCapture = async (_root, enabled) => {
+    if (capture === 'write-error') throw new Error('The preference cannot be saved.')
+    const old = desk.getSnapshot().captureHealth.get(PROVENANCE_ROOT) ?? captureHealth()
+    return keep(captureHealth({
+      enabled, state: enabled ? 'healthy' : 'stopped', revision: old.revision + 1,
+      reason: enabled ? 'Capture is current for the refs Git exposes.' : 'Capture is off on this machine.',
+      nextStep: enabled ? 'No action needed.' : 'Turn capture on.',
+    }))
+  }
+  captureDesk.retryCapture = async () => {
+    const old = desk.getSnapshot().captureHealth.get(PROVENANCE_ROOT) ?? captureHealth()
+    return keep({ ...old, revision: old.revision + 1 })
+  }
+  desk.openSession = async () => {}
+  const ordinary = desk.transport.request.bind(desk.transport)
+  desk.transport.request = (async (method: string, params: unknown) => {
+    if (method === 'git/log') return { commits: [provenanceLog()], hasMore: false }
+    if (method === 'git/refs') return {
+      headSha: PROVENANCE_SHA, branch: 'topic', branches: [], remotes: [], tags: [], stashes: [],
+    }
+    if (method === 'git/status') return {
+      root: PROVENANCE_ROOT, branch: 'topic', ahead: 0, behind: 0, files: [], concluding: null,
+    }
+    if (method === 'git/worktrees') return []
+    if (method === 'git/commit') return {
+      ...provenanceLog(), message: 'Synthetic change', committer: 'Jane Doe', files: [],
+    }
+    return ordinary(method as HostMethodName, params as never)
+  }) as AppStore['transport']['request']
+  return desk
+}
```

In `packages/ui/src/preview/main.tsx`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/preview/main.tsx
+++ b/packages/ui/src/preview/main.tsx
@@ -1,4 +1,8 @@
-import { StrictMode, useState, useSyncExternalStore, type ReactNode } from 'react'
+import { GitPane } from '../components/GitPane'
+import { MountProvider } from '../panels/mount'
+import { provenancePreviewStore } from './harness'
+import { PROVENANCE_ROOT, PROVENANCE_SCENES, type ProvenanceScene } from './provenance-fixture'
+import { StrictMode, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
 import { createRoot } from 'react-dom/client'

 import { runtimeId, sessionKey, type Worktree, type WorktreeChanges } from '@harnessdesk/protocol'
@@ -225,6 +229,7 @@
           a button, a chip, a card, a column ground and an empty state all in
           one screen, so a change to the system is visible here before it is
           hunted for anywhere else. */}
+      <ProvenanceExamples />
       <Frame title="Board — the pane, with work on it">
         <div className="h-[560px]">
           <TeamBoardPane room={PREVIEW_ROOM} />
@@ -392,3 +397,24 @@
     </StoreProvider>
   </StrictMode>,
 )
+
+const ProvenanceExamples = () => {
+  const [scene, setScene] = useState<ProvenanceScene>('one')
+  const desk = useMemo(() => provenancePreviewStore(scene), [scene])
+  return (
+    <section aria-label="Provenance preview" className="flex min-w-0 flex-col gap-3">
+      <div className="flex flex-wrap gap-3">
+        <Dial label="provenance scene" value={scene} options={PROVENANCE_SCENES} onChange={setScene} />
+      </div>
+      <StoreProvider store={desk}>
+        <Frame title="History — associated Seats">
+          <div className="h-[560px]">
+            <MountProvider scope={{ area: 'main', id: 'provenance', view: { kind: 'git', root: PROVENANCE_ROOT } }}>
+              <GitPane />
+            </MountProvider>
+          </div>
+        </Frame>
+      </StoreProvider>
+    </section>
+  )
+}
```

Create `e2e/ui-system/provenance.spec.ts` with these complete contents:

```ts
import { expect, test, type Page } from '@playwright/test'

const frame = (page: Page) => page.getByRole('region', { name: 'Provenance preview', exact: true })
const scene = async (page: Page, value: string) => {
  await frame(page).getByLabel('provenance scene', { exact: true }).selectOption(value)
}
const selectCommit = async (page: Page) => {
  const list = frame(page).getByRole('listbox')
  await list.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(frame(page).getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
}

for (const [width, theme] of [
  [1440, 'light'],
  [1440, 'dark'],
  [680, 'light'],
  [680, 'dark'],
] as const) {
  test(`history, every Seat and focus at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/preview.html')
    await page.getByLabel('theme', { exact: true }).selectOption(theme)
    await scene(page, 'long')
    await selectCommit(page)
    const options = frame(page).getByRole('option')
    await expect(options.locator('button, a, input, [tabindex]')).toHaveCount(0)
    const marks = options.locator('svg[aria-hidden="true"]')
    expect(await marks.count()).toBeGreaterThan(0)
    const graph = await options
      .first()
      .locator('svg')
      .first()
      .evaluate((node) => node.outerHTML)
    const seats = frame(page).getByRole('button', { name: /^Seat record for Contributor/ })
    await expect(seats).toHaveCount(6)
    for (let n = 0; n < 6; n += 1) {
      await seats.nth(n).focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Seat record', exact: true })
      await expect(dialog).toContainText(`Contributor ${n + 1}`)
      await expect(dialog.getByRole('button', { name: 'Open conversation' })).toBeEnabled()
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(seats.nth(n)).toBeFocused()
    }
    expect(
      await options
        .first()
        .locator('svg')
        .first()
        .evaluate((node) => node.outerHTML),
    ).toBe(graph)
    await expect(frame(page)).not.toContainText('seat-1')
    await expect(frame(page)).not.toContainText('provenance/commits')
    const overflow = await frame(page).evaluate((node) => node.scrollWidth > node.clientWidth + 1)
    expect(overflow).toBe(false)
    await frame(page).screenshot({ path: info.outputPath(`history-${width}-${theme}.png`) })
  })
}

test('partial, pending, unknown and error carry distinct words; unsafe labels stay text', async ({ page }) => {
  await page.goto('/preview.html')
  for (const [choice, words] of [
    ['partial', 'Partly attributed'],
    ['pending', 'Capture is catching up'],
    ['unknown', 'Unattributed'],
    ['off', 'Capture is off on this machine.'],
    ['error', 'Provenance could not be read.'],
    ['loading', 'Reading provenance'],
  ]) {
    await scene(page, choice!)
    await selectCommit(page)
    await expect(frame(page)).toContainText(words!)
  }
  await scene(page, 'hostile')
  await selectCommit(page)
  await expect(frame(page)).toContainText('<img src=x onerror=alert(1)>')
  await expect(frame(page).locator('img[src="x"], script, [onerror]')).toHaveCount(0)
})

test('missing records, deleted sessions and removed runtimes retain the reason', async ({ page }) => {
  await page.goto('/preview.html')
  for (const [choice, words] of [
    ['missing', 'The historical Seat record is unavailable.'],
    ['deleted', 'Its conversation was deleted.'],
    ['absent-runtime', 'Its runtime is no longer available.'],
  ]) {
    await scene(page, choice!)
    await selectCommit(page)
    await frame(page)
      .getByRole('button', { name: /^Seat record for/ })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Seat record', exact: true })
    await expect(dialog).toContainText(words!)
    await expect(dialog.getByRole('button', { name: 'Open conversation' })).toBeDisabled()
    await page.keyboard.press('Escape')
  }
})
```

- [ ] **Step 8: Run green, then prove the key assertions reject regressions.**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/CommitProvenance.test.tsx`

Expected: exit 0; **14 tests, 14 pass, 0 fail**.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/state/store.provenance.test.ts`

Expected: exit 0 after this task; **3 tests, 3 pass, 0 fail**. Task 8 adds seven tests to this same file.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/GitPane.test.tsx`

Expected: exit 0 on the inspected base; **42 tests, 42 pass, 0 fail**. Existing keyboard, context-menu, conflict and graph-column assertions remain intact.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/GitGraph.test.tsx`

Expected: exit 0; **2 tests, 2 pass, 0 fail**, unchanged.

In `CommitProvenance.tsx`, temporarily replace both occurrences of:

```ts
          if (held.current.generation !== generation) return
```

with:

```ts
          if (false) return
```

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/CommitProvenance.test.tsx -t "a stale same-root retry reply"`

Expected: exit 1; **1 failed assertion**, `expected 'ProvenanceReading provenance…' to contain 'Contributor 1'`. The late result erased the current generation. Restore both guards.

In `ProvenanceDialog.tsx`, temporarily replace:

```ts
    void store.readProvenanceSeat(root, seat).then(
```

with:

```ts
    void store.readProvenanceSeat(root, 'latest').then(
```

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/CommitProvenance.test.tsx -t "Seat record requests the immutable ID"`

Expected: exit 1; `expected "vi.fn()" to be called with arguments: [ '/work/project', 'seat-1' ]`; actual second argument is `latest`. Restore the immutable ID.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/CommitProvenance.test.tsx`

Expected: exit 0; **14 tests, 14 pass, 0 fail** after restoration.

Run: `pnpm --filter @harnessdesk/ui run typecheck`

Expected: exit 0, no TypeScript diagnostics.

Run: `node script/design-audit.mjs --strict`

Expected: exit 0; zero findings. Do not change the baseline to pass it.

Run: `pnpm test:ui-system -- provenance.spec.ts`

Expected: on the implementation seat, exit 0; **6 browser cases pass** at this step. The four width/theme cases check every contributor, Escape and restored focus, unchanged graph markup, absence of nested controls and horizontal overflow. Browser results and images are not claimed by the planning scratch.

- [ ] **Step 9: Controller commit after the complete phase gate.**

The plan writer does not commit. The controller verifies the assembled phase unpiped and uses the actual implementation writer's trailer. With the same writer identity used by the earlier tasks:

```bash
git add packages/ui/src/lib/provenance.ts packages/ui/src/components/CommitProvenance.tsx packages/ui/src/components/ProvenanceDialog.tsx packages/ui/src/components/CommitProvenance.test.tsx packages/ui/src/state/store.provenance.test.ts packages/ui/src/state/store.ts packages/ui/src/state/snapshot.ts packages/ui/src/components/GitPane.tsx packages/ui/src/components/GitPane.test.tsx packages/ui/src/preview/provenance-fixture.ts packages/ui/src/preview/harness.tsx packages/ui/src/preview/main.tsx e2e/ui-system/provenance.spec.ts script/check-reachable.mjs
git commit -m "feat: show commit provenance and historical Seats" --trailer "Co-Authored-By: Codex GPT-6 <agent@harnessdesk.app>"
```

### Task 8: Project capture controls, stopped sidebar and complete acceptance

A project's page owns its reversible machine preference and the host's capture status. The control displays the last saved value until the host replies. Every failure has words and a retry route; an unknown status never becomes healthy. The existing project row adds only a stopped label. This task completes status loading, previews, the camera rig, documentation and the phase acceptance record.

**Files:**
- Create: `packages/ui/src/components/ProjectProvenance.tsx`, `packages/ui/src/components/ProjectProvenance.test.tsx`
- Modify: `packages/ui/src/components/ProjectPage.tsx`, `packages/ui/src/components/SessionTree.tsx`, `packages/ui/src/state/store.ts`, `packages/ui/src/preview/main.tsx`, `e2e/ui-system/provenance.spec.ts`, `script/check-reachable.mjs`
- Modify: `script/shots/seed.mjs`, `script/shots/shoot.mjs`, `docs/architecture.md`, `docs/decisions.md`, `docs/interface.md`, `docs/data-boundaries.md`
- Named test edits: append status/persistence cases to `state/store.provenance.test.ts`; add the capture stubs and new section to `ProjectPage.test.tsx`; extend `SessionTree.projects.test.tsx` with optional snapshot overrides and the folded stopped-project regression; append a residue/fixture assertion to `script/shots-isolation.test.mjs`. Existing expectations are preserved except the explicitly widened section list, which becomes `['Agents', 'Checks', 'Provenance']`.
- Reuse Task 7's `preview/provenance-fixture.ts` capture scenes and `preview/harness.tsx` explicit methods unchanged.

**Proof needs:** the rendered UI — Sonnet under this plan's routing; the final native walkthrough also consumes Task 5's real observer.

**Interfaces:**
- Consumes Task 6's `provenance/status({ root? })`, `provenance/capture({ root, enabled })`, `provenance/retry({ root })`, returning the existing `CaptureHealth` shape.
- Adds `AppStore.loadCaptureHealth(root?: string): Promise<void>`, `setCapture(root: string, enabled: boolean): Promise<CaptureHealth>`, and `retryCapture(root: string): Promise<CaptureHealth>`.
- Adds `ProjectProvenance({ root: string })`; consumes Task 7's revision/health maps and `captureForRoot`, including canonical workspace aliases.
- Uses the existing `ProjectPage({ root, onBack })` with Phase 4's `<ProjectChecks root={root} />` anchor. No page is replaced, no new sidebar destination is created, and no Agent or Goal is started.

- [ ] **Step 1: Verify the page anchor and coordinate the shared row.**

Run: `rg -n 'ProjectChecks root=|export const ProjectPage' packages/ui/src/components/ProjectPage.tsx`

Expected: exit 0; one page export and one checks insertion. These are prerequisites. Do not manufacture an alternative page when they are absent.

Before editing `SessionTree.tsx`, follow the Global Constraints' UI coordination rule and message the named UI session with: “Phase 9 adds a noninteractive Capture stopped Chip to GroupHead's existing navigation row. No primitive, stylesheet, height, padding or selection styling changes.” This is coordination already required by the plan; no extra product approval is required.

- [ ] **Step 2: Write the complete control tests and append the store cases.**

Create `packages/ui/src/components/ProjectProvenance.test.tsx` with these complete contents:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { CaptureHealth } from '@harnessdesk/protocol'

import { captureHealth, PROVENANCE_ROOT } from '../preview/provenance-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ProjectProvenance } from './ProjectProvenance'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let snapshot: AppSnapshot
let store: AppStore
let notify: () => void
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const keep = (health: CaptureHealth) => {
  snapshot = { ...snapshot, captureHealth: new Map(snapshot.captureHealth).set(health.project, health) }
  notify()
}
const render = async (project = PROVENANCE_ROOT) => {
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <ProjectProvenance root={project} />
      </StoreProvider>,
    )
  })
}
const toggle = () => host.querySelector<HTMLElement>('[role="switch"]')!
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)!

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  notify = () => {}
  snapshot = { ...emptySnapshot(), status: 'open', captureHealth: new Map([[PROVENANCE_ROOT, captureHealth()]]) }
  store = {
    subscribe: (listener: () => void) => {
      notify = listener
      return () => {
        notify = () => {}
      }
    },
    getSnapshot: () => snapshot,
    loadCaptureHealth: vi.fn(async () => {}),
    setCapture: vi.fn(async (_root, enabled) => {
      const health = captureHealth({ enabled, state: enabled ? 'healthy' : 'stopped', revision: 2 })
      keep(health)
      return health
    }),
    retryCapture: vi.fn(async () => captureHealth()),
  } as unknown as AppStore
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('default-on capture displays the host reason and next step', async () => {
  await render()
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect(host.textContent).toContain(captureHealth().reason)
  expect(host.textContent).toContain(captureHealth().nextStep)
  expect(host.querySelector('[data-tone="success"]')).not.toBeNull()
})

it('a pending preference write leaves the saved value visible and disables both actions', async () => {
  snapshot = {
    ...snapshot,
    captureHealth: new Map([[PROVENANCE_ROOT, captureHealth({ enabled: false, state: 'stopped' })]]),
  }
  const pending = deferred<CaptureHealth>()
  vi.mocked(store.setCapture).mockReturnValue(pending.promise)
  await render()
  await act(async () => {
    toggle().click()
  })
  expect(store.setCapture).toHaveBeenCalledWith(PROVENANCE_ROOT, true)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(toggle().getAttribute('aria-disabled')).toBe('true')
  expect(button('Retry capture').disabled).toBe(true)
  await act(async () => {
    toggle().click()
    button('Retry capture').click()
  })
  expect(store.setCapture).toHaveBeenCalledTimes(1)
  expect(store.retryCapture).not.toHaveBeenCalled()
  await act(async () => {
    pending.reject(new Error('private path'))
  })
  expect(toggle().getAttribute('aria-disabled')).not.toBe('true')
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(host.textContent).toContain('The capture preference could not be saved.')
  expect(host.textContent).not.toContain('private path')
})

it('a saved off preference keeps its reason visible and enabling updates only after success', async () => {
  await render()
  await act(async () => {
    toggle().click()
  })
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(host.textContent).toContain('Turn capture on before retrying.')
  expect(button('Retry capture').disabled).toBe(true)
  await act(async () => {
    toggle().click()
  })
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect(button('Retry capture').disabled).toBe(false)
})

it('retry is serialized, reports failure, and never changes the saved enabled value', async () => {
  const pending = deferred<CaptureHealth>()
  vi.mocked(store.retryCapture).mockReturnValue(pending.promise)
  await render()
  await act(async () => {
    button('Retry capture').click()
  })
  expect(toggle().getAttribute('aria-disabled')).toBe('true')
  expect(button('Retry capture').disabled).toBe(true)
  await act(async () => {
    pending.reject(new Error('no access'))
  })
  expect(host.textContent).toContain('Capture could not be retried.')
  expect(toggle().getAttribute('aria-checked')).toBe('true')
})

it('loading and a failed status read have their own states and a Retry path', async () => {
  const pending = deferred<void>()
  vi.mocked(store.loadCaptureHealth).mockReturnValueOnce(pending.promise)
  await render()
  expect(host.textContent).toContain('Reading capture status')
  expect(toggle()).toBeNull()
  await act(async () => {
    pending.reject(new Error('private status'))
  })
  expect(host.textContent).toContain('Capture status could not be read.')
  expect(host.textContent).not.toContain('Healthy')
  await act(async () => {
    button('Retry status').click()
  })
  expect(toggle().getAttribute('aria-checked')).toBe('true')
})

it('non-Git and unavailable folders keep a disabled control and visible reason', async () => {
  snapshot = {
    ...snapshot,
    captureHealth: new Map(),
    workspaces: [{ path: PROVENANCE_ROOT, name: 'project', lastOpenedAt: 1, git: null, repo: null }],
  }
  await render()
  expect(host.textContent).toContain('This folder has no Git history to capture.')
  expect(store.loadCaptureHealth).not.toHaveBeenCalled()
  expect(toggle().getAttribute('aria-disabled')).toBe('true')
  await render('/work/missing')
  expect(host.textContent).toContain('Capture is unavailable for this folder.')
  expect(toggle().getAttribute('aria-disabled')).toBe('true')
})

it('refused, watch-failure, backlog and gap health preserve the host explanation', async () => {
  for (const health of [
    captureHealth({
      state: 'stopped',
      reason: 'Repository metadata is refused.',
      nextStep: 'Use a supported checkout.',
    }),
    captureHealth({ state: 'degraded', reason: 'Watching failed; polling continues.', nextStep: 'Retry capture.' }),
    captureHealth({ state: 'degraded', reason: 'Catching up.', pending: 20 }),
    captureHealth({ state: 'degraded', reason: 'A ref history is missing.', gaps: 1 }),
  ]) {
    snapshot = { ...snapshot, captureHealth: new Map([[PROVENANCE_ROOT, health]]) }
    await render()
    expect(host.textContent).toContain(health.reason)
    expect(host.textContent).toContain(health.nextStep)
    if (health.pending) expect(host.textContent).toContain('20 commits are waiting for capture.')
    if (health.gaps) expect(host.textContent).toContain('Retrying cannot recreate history Git no longer has.')
  }
})

it('a root switch retires both an old read and an old action error', async () => {
  const pending = deferred<CaptureHealth>()
  vi.mocked(store.setCapture).mockReturnValue(pending.promise)
  snapshot = {
    ...snapshot,
    captureHealth: new Map([
      [PROVENANCE_ROOT, captureHealth()],
      ['/work/next', captureHealth({ project: '/work/next', reason: 'Next project.' })],
    ]),
  }
  await render()
  await act(async () => {
    toggle().click()
  })
  await render('/work/next')
  await act(async () => {
    pending.reject(new Error('old failure'))
  })
  expect(host.textContent).toContain('Next project.')
  expect(host.textContent).not.toContain('could not be saved')
  expect(toggle().getAttribute('aria-disabled')).not.toBe('true')
})

it('linked checkouts resolve the canonical project and disconnected controls are unavailable', async () => {
  snapshot = {
    ...snapshot,
    workspaces: [
      { path: '/work/tree', name: 'tree', lastOpenedAt: 1, repo: { root: PROVENANCE_ROOT, worktree: true } },
    ],
  }
  await render('/work/tree')
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  snapshot = { ...snapshot, status: 'reconnecting' }
  await render('/work/tree')
  expect(host.textContent).toContain('Capture status is unavailable while disconnected.')
  expect(toggle()).toBeNull()
})

it('a late status rejection cannot turn the next project into an error', async () => {
  const pending = deferred<void>()
  vi.mocked(store.loadCaptureHealth).mockReturnValueOnce(pending.promise)
  await render('/work/old')
  expect(host.textContent).toContain('Reading capture status')
  await render()
  await act(async () => {
    pending.reject(new Error('old private failure'))
  })
  expect(host.textContent).not.toContain('could not be read')
  expect(toggle().getAttribute('aria-checked')).toBe('true')
})

it('an uninspected recent workspace is not declared non-Git', async () => {
  snapshot = { ...snapshot, workspaces: [{ path: PROVENANCE_ROOT, name: 'project', lastOpenedAt: 1, git: null }] }
  await render()
  expect(store.loadCaptureHealth).toHaveBeenCalledWith(PROVENANCE_ROOT)
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect(host.textContent).not.toContain('This folder has no Git history to capture.')
})
```

In `packages/ui/src/state/store.provenance.test.ts`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/state/store.provenance.test.ts
+++ b/packages/ui/src/state/store.provenance.test.ts
@@ -66,3 +66,94 @@
   expect(store.getSnapshot().captureHealth.size).toBe(0)
   expect(store.getSnapshot().provenanceRevision.size).toBe(0)
 })
+
+it('a late status read and an older notification cannot replace newer health', async () => {
+  const pending = deferred<readonly CaptureHealth[]>()
+  request.mockReturnValueOnce(pending.promise)
+  const read = store.loadCaptureHealth(PROVENANCE_ROOT)
+  const newest = captureHealth({ revision: 5, state: 'degraded' })
+  push(newest)
+  push(captureHealth({ revision: 4 }))
+  pending.resolve([captureHealth({ revision: 1 })])
+  await read
+  expect(store.getSnapshot().captureHealth.get(PROVENANCE_ROOT)).toBe(newest)
+  expect(store.getSnapshot().provenanceRevision.get(PROVENANCE_ROOT)).toBe(5)
+})
+
+it('an authoritative list removes forgotten projects but preserves notifications received during its read', async () => {
+  push(captureHealth())
+  push(captureHealth({ project: '/work/forgotten' }))
+  const pending = deferred<readonly CaptureHealth[]>()
+  request.mockReturnValueOnce(pending.promise)
+  const read = store.loadCaptureHealth()
+  const arrived = captureHealth({ project: '/work/new', revision: 2 })
+  push(arrived)
+  pending.resolve([captureHealth()])
+  await read
+  expect([...store.getSnapshot().captureHealth.keys()].sort()).toEqual(['/work/new', PROVENANCE_ROOT])
+  expect(store.getSnapshot().provenanceRevision.has('/work/forgotten')).toBe(false)
+})
+
+it('disconnect clears health and rejects every stale response application; reconnect reads once', async () => {
+  push(captureHealth({ revision: 50 }))
+  const pending = deferred<readonly CaptureHealth[]>()
+  request.mockReturnValueOnce(pending.promise)
+  const read = store.loadCaptureHealth()
+  handlers().onStatus('reconnecting')
+  pending.resolve([captureHealth({ revision: 90 })])
+  await read
+  expect(store.getSnapshot().captureHealth.size).toBe(0)
+  expect(store.getSnapshot().provenanceRevision.size).toBe(0)
+  request.mockResolvedValue([captureHealth({ revision: 1 })])
+  const before = request.mock.calls.length
+  handlers().onStatus('open')
+  handlers().onStatus('open')
+  await Promise.resolve()
+  expect(request.mock.calls.length - before).toBe(1)
+  expect(store.getSnapshot().provenanceRevision.get(PROVENANCE_ROOT)).toBe(1)
+})
+
+it('a later complete list owns pruning even when an earlier request arrives last', async () => {
+  const first = deferred<readonly CaptureHealth[]>()
+  request.mockReturnValueOnce(first.promise)
+  const old = store.loadCaptureHealth()
+  request.mockResolvedValueOnce([captureHealth()])
+  await store.loadCaptureHealth()
+  first.resolve([captureHealth({ project: '/work/forgotten', revision: 20 })])
+  await old
+  expect([...store.getSnapshot().captureHealth.keys()]).toEqual([PROVENANCE_ROOT])
+})
+
+it('status errors reject to the view without manufacturing healthy capture', async () => {
+  request.mockRejectedValueOnce(new Error('private path'))
+  await expect(store.loadCaptureHealth(PROVENANCE_ROOT)).rejects.toThrow('private path')
+  expect(store.getSnapshot().captureHealth.size).toBe(0)
+})
+
+it('preference writes keep the saved setting until success and leave it intact on failure', async () => {
+  const off = captureHealth({ enabled: false, state: 'stopped' })
+  push(off)
+  const pending = deferred<CaptureHealth>()
+  request.mockReturnValueOnce(pending.promise)
+  const write = store.setCapture(PROVENANCE_ROOT, true)
+  expect(store.getSnapshot().captureHealth.get(PROVENANCE_ROOT)).toBe(off)
+  pending.reject(new Error('read only'))
+  await expect(write).rejects.toThrow('read only')
+  expect(store.getSnapshot().captureHealth.get(PROVENANCE_ROOT)).toBe(off)
+  const on = captureHealth({ revision: 2 })
+  request.mockResolvedValueOnce(on)
+  await expect(store.setCapture(PROVENANCE_ROOT, true)).resolves.toBe(on)
+  expect(request).toHaveBeenLastCalledWith('provenance/capture', { root: PROVENANCE_ROOT, enabled: true })
+  expect(store.getSnapshot().captureHealth.get(PROVENANCE_ROOT)).toBe(on)
+})
+
+it('retry uses its own verb and an action response from a disconnected generation is discarded', async () => {
+  const pending = deferred<CaptureHealth>()
+  request.mockReturnValueOnce(pending.promise)
+  const action = store.retryCapture(PROVENANCE_ROOT)
+  expect(request).toHaveBeenLastCalledWith('provenance/retry', { root: PROVENANCE_ROOT })
+  handlers().onStatus('closed')
+  pending.resolve(captureHealth({ revision: 99 }))
+  await action
+  expect(store.getSnapshot().captureHealth.size).toBe(0)
+})
```

- [ ] **Step 3: Run the missing-component red.**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectProvenance.test.tsx`

Expected: exit 1; `Failed to resolve import "./ProjectProvenance" from "src/components/ProjectProvenance.test.tsx". Does the file exist?` Step 7 supplies assertion-level red proofs after composition.

- [ ] **Step 4: Load authoritative health and persist capture actions.**

A complete status list owns pruning only while it is the latest complete request in the same connection epoch. It removes a forgotten project only if its health has not been replaced during the read. Newer notifications win over older replies; reconnect clears the old host's revisions and reloads once. Forgetting a workspace reloads the list because a linked checkout may still register the canonical project. A scoped status read never prunes other projects.

In `packages/ui/src/state/store.ts`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/state/store.ts
+++ b/packages/ui/src/state/store.ts
@@ -216,7 +216,22 @@
 export { emptySnapshot } from './snapshot'

 export class AppStore {
+  async setCapture(root: string, enabled: boolean): Promise<import('@harnessdesk/protocol').CaptureHealth> {
+    const epoch = this.#captureEpoch
+    const health = await this.transport.request('provenance/capture', { root, enabled })
+    if (epoch === this.#captureEpoch) this.#keepCaptureHealth(health)
+    return health
+  }
+
+  async retryCapture(root: string): Promise<import('@harnessdesk/protocol').CaptureHealth> {
+    const epoch = this.#captureEpoch
+    const health = await this.transport.request('provenance/retry', { root })
+    if (epoch === this.#captureEpoch) this.#keepCaptureHealth(health)
+    return health
+  }
+
   #captureEpoch = 0
+  #captureList = 0

   #keepCaptureHealth(health: import('@harnessdesk/protocol').CaptureHealth): void {
     if (health.revision < (this.#snapshot.provenanceRevision.get(health.project) ?? -1)) return
@@ -235,6 +250,28 @@

   async readProvenanceSeat(root: string, seat: string): Promise<import('@harnessdesk/protocol').ProvenanceSeatDetail> {
     return this.transport.request('provenance/seat', { root, seat })
+  }
+
+  async loadCaptureHealth(root?: string): Promise<void> {
+    const epoch = this.#captureEpoch
+    const listing = root === undefined ? ++this.#captureList : this.#captureList
+    const before = this.#snapshot.captureHealth
+    const values = await this.transport.request('provenance/status', root === undefined ? {} : { root })
+    if (epoch !== this.#captureEpoch) return
+    if (root === undefined && listing !== this.#captureList) return
+    if (root === undefined) {
+      const present = new Set(values.map((one) => one.project))
+      const captureHealth = new Map(this.#snapshot.captureHealth)
+      const provenanceRevision = new Map(this.#snapshot.provenanceRevision)
+      for (const [project, health] of before) {
+        if (!present.has(project) && captureHealth.get(project) === health) {
+          captureHealth.delete(project)
+          provenanceRevision.delete(project)
+        }
+      }
+      this.#patch({ captureHealth, provenanceRevision })
+    }
+    for (const health of values) this.#keepCaptureHealth(health)
   }

   #snapshot: AppSnapshot = emptySnapshot()
@@ -417,11 +454,13 @@
         }
       },
       onStatus: (status) => {
+        const previous = this.#snapshot.status
         if (status !== 'open') {
           this.#captureEpoch += 1
           this.#patch({ status, captureHealth: new Map(), provenanceRevision: new Map() })
         } else {
           this.#patch({ status })
+          if (previous !== 'open') void this.loadCaptureHealth().catch(() => {})
         }
       },
     })
@@ -954,6 +993,7 @@
     try {
       await this.transport.request('workspace/forget', { path })
       await this.loadWorkspaces()
+      await this.loadCaptureHealth()
     } catch (error) {
       this.notice('error', describe(error))
     }
```

In `script/check-reachable.mjs`, replace this exact anchor:

```ts
const UNREACHED = {
  'provenance/status': 'project health and the sidebar read capture status in Task 8 of the provenance phase',
  'provenance/capture': 'project capture controls call this in Task 8 of the provenance phase',
  'provenance/retry': 'project capture retry calls this in Task 8 of the provenance phase',
```

with:

```ts
const UNREACHED = {
```

- [ ] **Step 5: Compose the control and attach it to the existing page and row.**

Only a workspace whose `git` and `repo` are both explicitly null is treated as known non-Git. An uninspected recent workspace has `git: null` but omits `repo`; it still reads status. A known non-Git folder gets its disabled control without making a named-root request the host must refuse. A Git project's rejected status read remains an explicit read error with Retry. Metadata and preference refusals carried by `CaptureHealth` keep the host's reason and next step. No raw exception detail is rendered. Busy state and a synchronous pending guard prevent duplicate writes; visible enabled state comes only from saved health.

Create `packages/ui/src/components/ProjectProvenance.tsx` with these complete contents:

```tsx
import { useEffect, useRef, useState } from 'react'

import { Button, Chip, Note, Row, Rows, SectionHead, Switch } from '../design'
import { captureForRoot, captureWords } from '../lib/provenance'
import { useSnapshot, useStore } from '../state/context'

export const ProjectProvenance = ({ root }: { readonly root: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([root, snapshot.status, attempt])
  const [read, setRead] = useState<{ key: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ key: string; text: string } | null>(null)
  const generation = useRef(0)
  const currentKey = useRef(key)
  currentKey.current = key
  const pending = useRef<string | null>(null)
  const empty = snapshot.workspaces.some((one) => one.path === root && one.git === null && one.repo === null)

  useEffect(() => {
    const mine = ++generation.current
    pending.current = null
    if (empty) {
      setRead({ key, error: false })
    } else if (snapshot.status === 'open')
      void store.loadCaptureHealth(root).then(
        () => {
          if (mine === generation.current) setRead({ key, error: false })
        },
        () => {
          if (mine === generation.current) setRead({ key, error: true })
        },
      )
    return () => {
      generation.current += 1
    }
  }, [store, root, key, snapshot.status, empty])

  const health = empty ? undefined : captureForRoot(root, snapshot.captureHealth, snapshot.workspaces)
  const current = read?.key === key ? read : null
  const saving = busy === key
  const change = async (enabled?: boolean) => {
    if (!health || pending.current === key || snapshot.status !== 'open') return
    if (enabled === undefined && !health.enabled) return
    const mine = generation.current
    pending.current = key
    setBusy(key)
    setProblem(null)
    try {
      if (enabled === undefined) await store.retryCapture(root)
      else await store.setCapture(root, enabled)
    } catch {
      if (mine === generation.current && currentKey.current === key)
        setProblem({
          key,
          text: enabled === undefined ? 'Capture could not be retried.' : 'The capture preference could not be saved.',
        })
    } finally {
      if (mine === generation.current && currentKey.current === key) {
        pending.current = null
        setBusy(null)
      }
    }
  }

  const words = health && captureWords(health)
  return (
    <section aria-label="Provenance">
      <SectionHead name="Provenance" />
      {snapshot.status !== 'open' ? (
        <Note>Capture status is unavailable while disconnected.</Note>
      ) : !current ? (
        <Note>Reading capture status…</Note>
      ) : current.error ? (
        <>
          <Note>Capture status could not be read.</Note>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Retry status
          </Button>
        </>
      ) : !health ? (
        <>
          <Rows>
            <Row
              title="Capture on this machine"
              control={<Switch checked={false} disabled aria-label="Capture provenance on this machine" />}
            />
          </Rows>
          <Note>
            {empty ? 'This folder has no Git history to capture.' : 'Capture is unavailable for this folder.'}
          </Note>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Retry status
          </Button>
        </>
      ) : (
        <>
          <Rows>
            <Row
              title="Capture on this machine"
              desc="Keep links from changes to the Seats and conversations that produced them."
              control={
                <Switch
                  checked={health.enabled}
                  disabled={saving}
                  aria-label="Capture provenance on this machine"
                  onCheckedChange={(enabled) => {
                    void change(enabled)
                  }}
                />
              }
            />
            <Row
              title={words!.label}
              desc={
                <>
                  {health.reason} {health.nextStep}
                </>
              }
              control={<Chip tone={words!.tone} label={words!.label} />}
            />
          </Rows>
          {health.pending > 0 && <Note>{`${health.pending} commits are waiting for capture.`}</Note>}
          {health.gaps > 0 && (
            <Note>
              Some historical transitions are unavailable. Retrying cannot recreate history Git no longer has.
            </Note>
          )}
          {problem?.key === key && <Note>{problem.text}</Note>}
          <Button
            variant="secondary"
            disabled={saving || !health.enabled}
            onClick={() => {
              void change()
            }}
          >
            Retry capture
          </Button>
          {!health.enabled && <Note>Turn capture on before retrying.</Note>}
        </>
      )}
    </section>
  )
}
```

In `packages/ui/src/components/ProjectPage.tsx`, replace this exact anchor:

```tsx
import { ProjectChecks } from './ProjectChecks'
```

with:

```tsx
import { ProjectChecks } from './ProjectChecks'
import { ProjectProvenance } from './ProjectProvenance'
```

In `packages/ui/src/components/ProjectPage.tsx`, replace this exact anchor:

```tsx
      <ProjectChecks root={root} />
```

with:

```tsx
      <ProjectChecks root={root} />
      <ProjectProvenance root={root} />
```

In `packages/ui/src/components/ProjectPage.test.tsx`, replace this exact anchor:

```tsx
import { WorkspacesSection } from './Settings'
```

with:

```tsx
import { WorkspacesSection } from './Settings'
import { captureHealth } from '../preview/provenance-fixture'
```

In `packages/ui/src/components/ProjectPage.test.tsx`, replace this exact anchor:

```tsx
    workspaces: [STOREFRONT, DOCS, SCRATCH],
```

with:

```tsx
    workspaces: [STOREFRONT, DOCS, SCRATCH],
    captureHealth: new Map([[STOREFRONT.path, captureHealth({ project: STOREFRONT.path })]]),
```

In `packages/ui/src/components/ProjectPage.test.tsx`, replace this exact anchor:

```tsx
    projectChecks: vi.fn(async (path: string) => CHECKS(path)),
```

with:

```tsx
    projectChecks: vi.fn(async (path: string) => CHECKS(path)),
    loadCaptureHealth: vi.fn(async () => {}),
    setCapture: vi.fn(async (path: string, enabled: boolean) => captureHealth({ project: path, enabled })),
    retryCapture: vi.fn(async (path: string) => captureHealth({ project: path })),
```

In `packages/ui/src/components/ProjectPage.test.tsx`, replace this exact anchor:

```tsx
  expect(sections).toEqual(['Agents', 'Checks'])
```

with:

```tsx
  expect(sections).toEqual(['Agents', 'Checks', 'Provenance'])
```

Append this complete test to `packages/ui/src/components/ProjectPage.test.tsx`:

```tsx

it('Provenance follows the existing Agents and checks without taking over their actions', async () => {
  const store = mount(<WorkspacesSection focus={STOREFRONT.path} />)
  await settle()
  const sections = [...container.querySelectorAll('section[aria-label]')].map((one) => one.getAttribute('aria-label'))
  expect(sections).toEqual(['Agents', 'Checks', 'Provenance'])
  expect(agentsText()).toContain('Code reviewer')
  expect(container.querySelector('section[aria-label="Checks"]')?.textContent).toContain('pnpm verify')
  expect(container.querySelector('section[aria-label="Provenance"]')?.textContent).toContain('Capture on this machine')
  expect(store.loadCaptureHealth).toHaveBeenCalledWith(STOREFRONT.path)
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
})
```

In `packages/ui/src/components/SessionTree.tsx`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/components/SessionTree.tsx
+++ b/packages/ui/src/components/SessionTree.tsx
@@ -1,10 +1,13 @@
 import { Button, Input } from '../design'
 import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'

+import { captureForRoot } from '../lib/provenance'
+
 import { openingOf, sessionKey, type Session, type SessionSummary, type TeamState } from '@harnessdesk/protocol'

 import { agentGroups, agentKey, agentKeyOf } from '../lib/accounts'
 import { folderName, groupByProject, isWorktreeSession, projectRootOf, type ProjectGroup } from '../lib/projects'
+import { Chip } from '../design'
 import { sessionLabel } from '../lib/sessions'
 import { ACTIVE_STATES, TRACE_LABEL, traceOf } from '../lib/trace'
 import { panes, sessionOf } from '../state/layout'
@@ -478,6 +481,9 @@
   const store = useStore()
   const snapshot = useSnapshot()
   const menu = useContextMenu()
+  const stopped = projectRoots(group)
+    .map((root) => captureForRoot(root, snapshot.captureHealth, snapshot.workspaces))
+    .find((health) => health?.state === 'stopped')
   const pinned = snapshot.listPrefs.pinned.includes(group.root)
   // The folder the app is working in. It used to be marked only by leading
   // the list, which says nothing once you have arranged the list yourself —
@@ -522,6 +528,9 @@
         )}
         <span className={styles.groupBody}>
           <span className={styles.groupName}>{group.name}</span>
+          {stopped && <span title={`${stopped.reason} ${stopped.nextStep}`}>
+            <Chip tone="neutral" label="Capture stopped" />
+          </span>}
           {pinned && <PinIcon size={11} className={styles.groupPin} />}
           <span className={styles.groupCount}>{group.sessions.length}</span>
         </span>
```

In `packages/ui/src/components/SessionTree.projects.test.tsx`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/components/SessionTree.projects.test.tsx
+++ b/packages/ui/src/components/SessionTree.projects.test.tsx
@@ -7,6 +7,7 @@
 import { StoreProvider } from '../state/context'
 import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
 import { SessionTree } from './SessionTree'
+import { captureHealth } from '../preview/provenance-fixture'

 /**
  * What the list makes of the folder you have open.
@@ -61,7 +62,7 @@
 const workspace = (path: string, repo: { root: string; worktree: boolean }): WorkspaceEntry =>
   ({ path, name: path.split('/').at(-1) ?? path, lastOpenedAt: 1, repo })

-const render = (history: SessionSummary[], open: WorkspaceEntry): void => {
+const render = (history: SessionSummary[], open: WorkspaceEntry, over: Partial<AppSnapshot> = {}): void => {
   const snapshot = {
     ...emptySnapshot(),
     status: 'open',
@@ -70,6 +71,7 @@
     history,
     workspace: open,
     workspaces: [open],
+    ...over,
   } as AppSnapshot
   const store = {
     subscribe: () => () => {},
@@ -131,3 +133,24 @@
   expect(projects().sort()).toEqual(['other', 'repo'])
   expect(currentProject()).toBe('other')
 })
+
+it('only a stopped project adds capture text, including its folded canonical alias', () => {
+  const sub = '/repo/packages/ui'
+  const off = captureHealth({ project: REPO, enabled: false, state: 'stopped', reason: 'Capture is off.', nextStep: 'Turn capture on.' })
+  render([session('Plain conversation', sub, { root: REPO, worktree: false })], workspace(sub, { root: REPO, worktree: false }), {
+    captureHealth: new Map([[REPO, off]]),
+    listPrefs: { ...emptySnapshot().listPrefs, collapsed: [sub] },
+  })
+  const row = container.querySelector('[data-draggable]')!
+  expect(row.textContent).toContain('Capture stopped')
+  expect(row.querySelector('[class*="groupName"]')?.textContent).toBe('ui')
+  expect(row.querySelector('[class*="groupCount"]')?.textContent).toBe('1')
+  expect(row.querySelector('button')).toBeNull()
+  expect(row.querySelector('[title="Capture is off. Turn capture on."]')).not.toBeNull()
+  for (const state of ['healthy', 'degraded'] as const) {
+    render([], workspace(sub, { root: REPO, worktree: false }), {
+      captureHealth: new Map([[REPO, captureHealth({ project: REPO, state })]]),
+    })
+    expect(container.textContent).not.toContain('Capture stopped')
+  }
+})
```

- [ ] **Step 6: Add the project and folded-row preview and browser case.**

The health dial covers healthy, off, refused metadata, malformed preference, watch failure with polling, backlog, a retained historical gap, non-Git, unavailable, loading, read failure and write failure. The fixture remains separate from the page's other surfaces. The store stubs and scene builders were written in full in Task 7; this step only mounts their controls and appends the browser test.

In `packages/ui/src/preview/main.tsx`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/packages/ui/src/preview/main.tsx
+++ b/packages/ui/src/preview/main.tsx
@@ -1,7 +1,9 @@
 import { GitPane } from '../components/GitPane'
+import { ProjectProvenance } from '../components/ProjectProvenance'
+import { SessionTree } from '../components/SessionTree'
 import { MountProvider } from '../panels/mount'
 import { provenancePreviewStore } from './harness'
-import { PROVENANCE_ROOT, PROVENANCE_SCENES, type ProvenanceScene } from './provenance-fixture'
+import { CAPTURE_SCENES, PROVENANCE_ROOT, PROVENANCE_SCENES, type CaptureScene, type ProvenanceScene } from './provenance-fixture'
 import { StrictMode, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
 import { createRoot } from 'react-dom/client'

@@ -400,11 +402,13 @@

 const ProvenanceExamples = () => {
   const [scene, setScene] = useState<ProvenanceScene>('one')
-  const desk = useMemo(() => provenancePreviewStore(scene), [scene])
+  const [capture, setCapture] = useState<CaptureScene>('healthy')
+  const desk = useMemo(() => provenancePreviewStore(scene, capture), [scene, capture])
   return (
     <section aria-label="Provenance preview" className="flex min-w-0 flex-col gap-3">
       <div className="flex flex-wrap gap-3">
         <Dial label="provenance scene" value={scene} options={PROVENANCE_SCENES} onChange={setScene} />
+        <Dial label="capture scene" value={capture} options={CAPTURE_SCENES} onChange={setCapture} />
       </div>
       <StoreProvider store={desk}>
         <Frame title="History — associated Seats">
@@ -414,6 +418,12 @@
             </MountProvider>
           </div>
         </Frame>
+        <Frame title="Project — provenance capture">
+          <ProjectProvenance root={PROVENANCE_ROOT} />
+        </Frame>
+        <Frame title="Sidebar — capture stopped">
+          <SessionTree now={20} />
+        </Frame>
       </StoreProvider>
     </section>
   )
```

In `e2e/ui-system/provenance.spec.ts`, apply this complete patch. The context lines are the exact edit anchors:

```diff
--- a/e2e/ui-system/provenance.spec.ts
+++ b/e2e/ui-system/provenance.spec.ts
@@ -100,3 +100,40 @@
     await page.keyboard.press('Escape')
   }
 })
+
+test('the project control persists before drawing and only stopped capture decorates the sidebar', async ({
+  page,
+}, info) => {
+  await page.goto('/preview.html')
+  const dial = frame(page).getByLabel('capture scene', { exact: true })
+  const toggle = frame(page).getByRole('switch', { name: 'Capture provenance on this machine' })
+  await expect(toggle).toBeChecked()
+  await expect(frame(page)).not.toContainText('Capture stopped')
+  await toggle.focus()
+  await page.keyboard.press('Space')
+  await expect(toggle).not.toBeChecked()
+  await expect(frame(page)).toContainText('Capture stopped')
+  await expect(frame(page).getByRole('button', { name: 'Retry capture', exact: true })).toBeDisabled()
+  await page.keyboard.press('Space')
+  await expect(toggle).toBeChecked()
+  await dial.selectOption('write-error')
+  await toggle.click()
+  await expect(toggle).toBeChecked()
+  await expect(frame(page)).toContainText('The capture preference could not be saved.')
+  for (const [value, words] of [
+    ['refused', 'Repository metadata is refused.'],
+    ['preferences', 'The capture preference could not be read.'],
+    ['watch', 'Watching failed; polling continues.'],
+    ['backlog', '20 commits are waiting for capture.'],
+    ['gap', 'Retrying cannot recreate history Git no longer has.'],
+    ['non-git', 'This folder has no Git history to capture.'],
+    ['unavailable', 'Capture is unavailable for this folder.'],
+    ['loading', 'Reading capture status'],
+    ['error', 'Capture status could not be read.'],
+  ]) {
+    await dial.selectOption(value!)
+    await expect(frame(page)).toContainText(words!)
+  }
+  await dial.selectOption('off')
+  await frame(page).screenshot({ path: info.outputPath('project-stopped.png') })
+})
```

- [ ] **Step 7: Run green and prove saved-state and stopped-row regressions go red.**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectProvenance.test.tsx`

Expected: exit 0; **11 tests, 11 pass, 0 fail**.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/state/store.provenance.test.ts`

Expected: exit 0; **10 tests, 10 pass, 0 fail**.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/SessionTree.projects.test.tsx`

Expected: exit 0 on the inspected base; **4 tests, 4 pass, 0 fail**.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectPage.test.tsx`

Expected: with the Phase 2/4 prerequisites, exit 0; **7 tests, 7 pass, 0 fail**. This composition was not executed in the planning scratch; its existing page is absent from the inspected base.

In `ProjectProvenance.tsx`, temporarily replace:

```tsx
                  disabled={saving}
```

with:

```tsx
                  disabled={false}
```

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectProvenance.test.tsx -t "a pending preference write"`

Expected: exit 1; `AssertionError: expected null to be 'true'` on `aria-disabled`. The saved value must still be false. Restore `disabled={saving}`.

In `ProjectProvenance.tsx`, temporarily replace the exact expression `one.repo === null` with `!one.repo` in the `empty` predicate.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectProvenance.test.tsx -t "an uninspected recent workspace"`

Expected: exit 1; `expected "vi.fn()" to be called with arguments: [ '/work/project' ]`, with **0 calls**. The renderer incorrectly skipped the status read and declared an uninspected repository non-Git. Restore the explicit null check.

In `SessionTree.tsx`, temporarily replace:

```ts
    .find((health) => health?.state === 'stopped')
```

with:

```ts
    .find((health) => health !== undefined)
```

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/SessionTree.projects.test.tsx -t "only a stopped project"`

Expected: exit 1; the healthy row contains `Capture stopped`, which the assertion explicitly forbids. Restore the stopped-only predicate.

In `state/store.ts`, temporarily replace:

```ts
    if (health.revision < (this.#snapshot.provenanceRevision.get(health.project) ?? -1)) return
```

with:

```ts
    if (false) return
```

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/state/store.provenance.test.ts -t "a late status read"`

Expected: exit 1; the expected revision **5**, state **degraded**, is replaced by revision **1**, state **healthy**. Restore the revision guard.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectProvenance.test.tsx`

Expected: exit 0; **11 tests pass** after restoration.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/state/store.provenance.test.ts`

Expected: exit 0; **10 tests pass** after restoration.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/SessionTree.projects.test.tsx`

Expected: exit 0; **4 tests pass** after restoration.

- [ ] **Step 8: Seed and photograph only an isolated synthetic desk.**

The rig seeds two original Seat records and their real Git endpoint facts through Phase 4's `EvidenceStore`; the observer itself discovers and reconciles those commits. It does not seed a provenance link or fake a notification. Both session pointers name conversations in the rig's scripted stores. Each take clears the evidence/provenance residue and machine preference. Only `HD_SHOTS_PROVENANCE=1` rebuilds the two synthetic facts and registers these four scenes; ordinary takes retain Phase 4 Task 23's no-observations contract. Preserve every Phase 2/4 residue entry and scene. The loop replacement below extends their cleanup without replacing their list. The stopped scene restores capture even if its image fails, using the existing `runScene` finish contract.

In `script/shots/seed.mjs`, replace this exact anchor:

```ts
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
```

with:

```ts
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
```

In `script/shots/seed.mjs`, replace this exact anchor:

```ts
for (const name of RESIDUE) rmSync(join(HOME, name), { recursive: true, force: true })
```

with:

```ts
for (const name of [...RESIDUE, 'provenance', 'provenance-preferences.json']) rmSync(join(HOME, name), { recursive: true, force: true })
```

Append to `script/shots/seed.mjs`, after its existing final statement:

```js
/** Historical facts for the camera. The observer still discovers the commits itself. */
const seedProvenance = async () => {
  const { EvidenceStore } = await import('../../packages/server/dist/src/evidence/store.js')
  const project = realpathSync(roots[REPOS[0].dir])
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim()
  const commits = git('rev-list', '--reverse', '--no-merges', 'HEAD').split('\n').slice(1, 3)
  if (commits.length !== 2) throw new Error('The camera history needs two non-root changes.')
  const conversations = REGISTERED_CAST.flatMap((agent) => {
    const index = (CONVERSATIONS[agent.id] ?? []).findIndex((one) => one[2] === REPOS[0].dir)
    return index < 0 ? [] : [{ agent, sessionId: `${agent.id}-${index}` }]
  }).slice(0, 2)
  if (conversations.length !== 2) throw new Error('The camera needs two scripted conversations.')
  const evidence = new EvidenceStore(join(HOME, 'evidence'))
  const at = Date.now()
  const observations = []
  for (const [index, sha] of commits.entries()) {
    const from = git('rev-parse', `${sha}^`)
    const { agent, sessionId } = conversations[index]
    const id = `provenance-seat-${index + 1}`
    const name = `Contributor ${index + 1}`
    const session = { runtime: rigRuntimeId(agent.id), sessionId }
    await evidence.append(project, 'seats', [
      {
        type: 'seat',
        record: {
          id,
          agent: { id: `contributor-${index + 1}`, name, origin: 'project' },
          briefDigest: null,
          seat: { runtime: session.runtime },
          seatLabel: agent.name,
          passedOver: [],
          standing: { kind: 'permission', permission: 'read' },
          ceiling: null,
          checkout: { cwd: project, project, branch: 'main', head: from },
          session,
          board: null,
          role: null,
          openedAt: at - 1,
        },
      },
    ])
    const counts = git('diff', '--numstat', from, sha)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
    const added = counts.reduce((sum, line) => sum + (Number(line[0]) || 0), 0)
    const removed = counts.reduce((sum, line) => sum + (Number(line[1]) || 0), 0)
    await evidence.append(project, 'evidence', [
      {
        type: 'evidence',
        record: {
          id: `provenance-fact-${index + 1}`,
          fact: { kind: 'diff', files: counts.length, added, removed, from, to: sha },
          seat: id,
          checkout: { cwd: project, branch: 'main' },
          observedAt: at,
        },
      },
    ])
    observations.push({ project, sha, seat: id, name })
  }
  await evidence.flush()
  return observations
}

export const PROVENANCE_SHOTS = process.env['HD_SHOTS_PROVENANCE'] === '1' ? await seedProvenance() : []
```

In `script/shots/shoot.mjs`, keep the existing `config.mjs` import: importing `seed.mjs` would rebuild a staged desk while its app is running and violates the existing isolation test. The seeder instead writes a synthetic-only `provenance-shots.json` manifest under the staged home; the shooter reads that manifest after staging. Apply the scene patch using that manifest. This corrects the stale import anchor without weakening the two-fact rig proof.

```diff
--- a/script/shots/shoot.mjs
+++ b/script/shots/shoot.mjs
@@ -37,7 +37,7 @@
 import { TILDIFY, USER, refuseUnpublishable } from './audit.mjs'
 import { CAST, CONVERSATIONS, REPOS, rigRuntimeId } from './cast.mjs'
 import { runScene } from './scene.mjs'
-import { HOME, WORK, SHOT_ENV } from './seed.mjs'
+import { HOME, WORK, SHOT_ENV, PROVENANCE_SHOTS } from './seed.mjs'
 import { LEDGER, SCAN, USAGE } from './usage.mjs'

 /**
@@ -561,6 +561,65 @@
    * turn and photograph a different conversation each time.
    */
   const SCENES = {
+    ...(PROVENANCE_SHOTS.length === 2
+      ? {
+          'provenance-history': {
+            leaveOverlay: true,
+            expect: 'Associated Seat',
+            run: async () => {
+              const fixture = PROVENANCE_SHOTS[0]
+              await waitForSnapshot(
+                () => cdp.eval(`${STORE}.readProvenance(${q(fixture.project)}, [${q(fixture.sha)}])`),
+                (value) => value?.commits?.[0]?.seats?.some((one) => one.id === fixture.seat),
+              )
+              await cdp.eval(`${STORE}.openGitHistory(${q(fixture.project)}); true`)
+              await waitForSnapshot(
+                () =>
+                  cdp.eval(
+                    `Array.from(document.querySelectorAll('[role="option"]')).some(node => node.textContent.includes(${q(fixture.name)}))`,
+                  ),
+                Boolean,
+              )
+              await cdp.eval(
+                `Array.from(document.querySelectorAll('[role="option"]')).find(node => node.textContent.includes(${q(fixture.name)})).click(); true`,
+              )
+            },
+          },
+          'provenance-seat': {
+            leaveOverlay: true,
+            expect: 'Seat record',
+            run: async () => {
+              await SCENES['provenance-history'].run()
+              await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('Seat record')`), Boolean)
+              if (!(await click('Seat record'))) throw new Error('The history selection has no Seat record action.')
+              await waitForSnapshot(
+                () => cdp.eval(`document.querySelector('[role="dialog"]')?.textContent.includes('Contributor 1')`),
+                Boolean,
+              )
+            },
+          },
+          'provenance-project': {
+            leaveOverlay: true,
+            expect: 'Capture on this machine',
+            run: async () => {
+              await cdp.eval(`${STORE}.askSettings('workspaces', ${q(PROVENANCE_SHOTS[0].project)}); true`)
+              await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('Capture on this machine')`), Boolean)
+            },
+          },
+          'provenance-stopped': {
+            leaveOverlay: true,
+            expect: 'Capture stopped',
+            run: async () => {
+              await cdp.eval(`${STORE}.setCapture(${q(PROVENANCE_SHOTS[0].project)}, false)`, 60_000)
+              await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('Capture stopped')`), Boolean)
+            },
+            finish: async () => {
+              await cdp.eval(`${STORE}.setCapture(${q(PROVENANCE_SHOTS[0].project)}, true)`, 60_000)
+            },
+          },
+        }
+      : {}),
+
     /** The desk itself: twelve agents, three projects, work in the sidebar. */
     desk: { expect: 'Workspaces', run: async () => {
       await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
```

Append to `script/shots-isolation.test.mjs`, preserving all existing Phase 2/4 imports and tests:

```js
test('each take removes provenance residue and seeds only synthetic local facts', async (t) => {
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
  const directory = mkdtempSync(join(tmpdir(), 'hd-provenance-shots-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  for (const path of ['evidence', 'provenance']) {
    mkdirSync(join(home, path), { recursive: true })
    writeFileSync(join(home, path, 'previous-take'), 'must not survive')
  }
  writeFileSync(join(home, 'provenance-preferences.json'), 'must not survive')
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: {
      ...process.env,
      HD_SHOTS_HOME: home,
      HD_SHOTS_WORK: work,
      HD_SHOTS_NATIVE_CODEX: '0',
      HD_SHOTS_PROVENANCE: '1',
    },
    stdio: 'pipe',
  })
  assert.equal(existsSync(join(home, 'provenance-preferences.json')), false)
  assert.equal(existsSync(join(home, 'provenance')), false)
  assert.equal(existsSync(join(home, 'evidence', 'previous-take')), false)
  const { EvidenceStore } = await import('../packages/server/dist/src/evidence/store.js')
  const evidence = new EvidenceStore(join(home, 'evidence'))
  const projects = await evidence.projects()
  assert.equal(projects.length, 1)
  const project = projects[0]
  const seats = (await evidence.read(project, 'seats')).lines
  const facts = (await evidence.read(project, 'evidence')).lines
  assert.equal(seats.length, 2)
  assert.equal(facts.length, 2)
  assert.deepEqual(
    seats.map((line) => line.record.agent.name),
    ['Contributor 1', 'Contributor 2'],
  )
  assert.ok(seats.every((line) => line.record.checkout.project === project))
  assert.ok(facts.every((line) => line.record.fact.kind === 'diff' && !line.record.restored))
  assert.ok(project.endsWith('/work/storefront'))
  // Default takes preserve Phase 4's no-observations contract.
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: {
      ...process.env,
      HD_SHOTS_HOME: home,
      HD_SHOTS_WORK: work,
      HD_SHOTS_NATIVE_CODEX: '0',
      HD_SHOTS_PROVENANCE: '0',
    },
    stdio: 'pipe',
  })
  assert.equal(existsSync(join(home, 'evidence')), false)
})
```

Run: `pnpm run build:node && node --test --test-reporter=spec --test-name-pattern="each take removes provenance residue" script/shots-isolation.test.mjs`

Expected: on the implementation tree, exit 0; **1 selected test passes**. The test verifies two historical Seats and two local diff facts, with no retained preference or previous-take sentinel; a subsequent ordinary seed leaves evidence absent, as Phase 4 requires. It was not run in the planning scratch because the integrated Phase 4 host/store build is a prerequisite.

Run: `HD_SHOTS_PROVENANCE=1 HD_SHOTS_HOME="$PWD/.superpowers/sdd/provenance-rig/home" HD_SHOTS_WORK="$PWD/.superpowers/sdd/provenance-rig/work" node script/shots/shoot.mjs --scene provenance-history --scene provenance-seat --scene provenance-project --scene provenance-stopped --out .superpowers/sdd/frames/provenance`

Expected: the isolated Electron desk runs only scripted agents; four scenes each produce light and dark images, and every frame passes the existing rig privacy audit before saving. Read every image yourself, including the seat, name cards and menus. A saved frame alone is not a passed acceptance assertion.

Run: `HD_SHOTS_PROVENANCE=1 HD_SHOTS_HOME="$PWD/.superpowers/sdd/provenance-rig/home" HD_SHOTS_WORK="$PWD/.superpowers/sdd/provenance-rig/work" node script/shots/shoot.mjs --scene provenance-history --scene provenance-project --scene provenance-stopped --width 680 --out .superpowers/sdd/frames/provenance/narrow`

Expected: the three scenes remain usable in both themes at 680px; no horizontal page overflow, clipped reason sentence or hidden project name. Stop to fix any failure, keeping the design primitives unchanged unless their owning session agrees to a system change.

- [ ] **Step 9: Record the real observer and plain-path acceptance.**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/provenance-observer.test.js`

Expected: on the full-access implementation seat, **12 tests, 12 pass, 0 fail**, including Task 5's two event-delivery cases with polling disabled and its stable-registration regression. An injected callback or a polling test does not replace those cases.

Run: `pnpm test:ui-system -- provenance.spec.ts`

Expected: **7 browser cases pass** after Task 8. The browser runs actual components and design primitives in light/dark at 1440px and 680px; each generated image is inspected before being treated as evidence.

In the launched synthetic desk, record each of these observations with the synthetic SHAs, health revision, frame path and observed result in the implementation report. Use the actual fixture repository and an external Git process; never invoke an observer callback or write an attributed response as proof.

| Action in the isolated rig | Required observed result |
| --- | --- |
| Open the seeded history, before sending any turn | The original diff facts resolve the two Seats; opening each record uses its original conversation pointer. |
| Amend a seeded commit's message externally, then amend a disjoint-file change | Message-only amend retains the Seat; the content amendment retains only defensible files and says partly attributed until a matching new local diff fact exists. |
| Make two disjoint contributions under two synthetic Seats and squash the observed range | The squash lists both Seats; both original records survive, and old checks still name their old SHAs. |
| Commit without a matching Seat fact and move a tag from another process | The observer records both movements without a turn; the person-like commit remains unattributed. |
| Close the rig host, move refs, restart; repeat after removing a retained reflog entry in the rig | Startup catches up where Git retained facts and reports a historical gap when it did not. |
| Disable capture for project A, leave B enabled, then re-enable A after an external move | A's folded row says Capture stopped, B continues, A catches up on re-enable, and no conversation is interrupted or created. |
| Delete one synthetic conversation through its ordinary UI action | Its Seat record remains readable; Open conversation is disabled with the deletion reason. |
| Press Command-N and use existing history selection and commit actions | The plain conversation header and draft are unchanged; no Agent or Goal surface or new sidebar destination appears. |

No row is signed off from source inspection alone. A failed or unavailable recording remains an explicit unmet acceptance item. The journal deliberately cannot recover Git history that no longer exists.

- [ ] **Step 10: Document the shipped behavior without making a line-blame claim.**

Append the following complete sections at EOF of the four named pages. Existing text is retained; these are the new behavior's documentation, not a changelog claim made by the plan writer.

Append to `docs/architecture.md`:

```markdown

## Provenance capture

The host owns a `ProvenancePlane` beside the evidence plane. It registers open projects, reads admitted Git metadata through a private Git view and journals observations beneath the evidence project's folder. Metadata watches and polling enqueue bounded work; startup resumes durable catch-up. Neither a turn nor a Git action waits for capture. History reads one bounded batch of indexed provenance beside its ordinary Git log.

An association needs a locally observed diff fact, a matching checkout and a compatible Seat lifetime. Reconciliation adds links to immutable original observations; it does not move checks or reviews to a rewritten commit. Capture preferences belong to this machine, default to on, and are shared by a project's linked checkouts.
```

Append to `docs/decisions.md`:

```markdown

## Provenance preserves a defensible association

A commit's author, message and trailers do not authenticate the Seat that made its changes. HarnessDesk associates only the patches explained by locally observed diff facts and the original Seat record. Stable and verbatim fingerprints must agree; surviving file changes can retain partial attribution through an amend. A squash compares its net change with bounded observed ranges and keeps every defensible contributor. Competing explanations, overlapping contributions that cannot be separated and unavailable source objects remain unattributed.

Passive capture cannot recover a ref move whose reflog and objects Git no longer retains. The desk reads available transitions, preserves known gaps and says when capture is degraded or stopped. It installs no hooks, changes no Git configuration and never delays a turn to observe it.

**The rule:** ambiguity remains visible; a rewritten association never refreshes the original checks, reviews or evidence.
```

Append to `docs/interface.md`:

```markdown

## Provenance

History shows an associated Agent's recorded name beside its runtime's mark. A compact count indicates additional Seats; selecting the commit lists every contributor. The selected detail distinguishes complete, partial, pending and unattributed changes and keeps the explanation visible. Its Seat record opens the exact historical record, with the original conversation available only while the desk can still open it. Matching observations keep their original revisions. A missing card or conversation says why it is unavailable.

Workspaces › a project › Provenance controls capture on this machine. It starts on and shows healthy, degraded or stopped capture with the host's reason and next step. The setting changes on screen after it is saved; Retry does not turn capture on. Only stopped capture appears on the existing project row, even while that row is folded. A plain conversation and its header are unchanged.
```

Append to `docs/data-boundaries.md`:

```markdown

## Local provenance

Capture reads available refs and Git objects for registered projects on this machine. Its journal, immutable patch fingerprints, original Seat links and known history gaps stay beneath the project's folder in the host's evidence directory. It retains neither raw patches nor another transcript or brief body. It contacts no remote and never fetches a missing object.

**Retention:** observations remain until the corresponding local evidence data is removed; disabling capture keeps existing history. Workspaces › a project › Provenance turns capture off for that project on this machine, including its linked checkouts. The preference lives in `provenance-preferences.json` in the host state directory, outside the repository.

A backup may carry the versioned, size-limited historical sidecar. Restored records are marked historical; imported cursors, health and preferences do not activate capture or authorize new local associations. No provenance data leaves unless the person chooses to export or share it.
```

- [ ] **Step 11: Run the assembled phase gate and audit the deliverable.**

Run: `pnpm --filter @harnessdesk/ui run typecheck`

Expected: exit 0, no diagnostics.

Run: `node script/check-reachable.mjs`

Expected: exit 0; the five provenance verbs are reachable and none remains in `UNREACHED`.

Run: `node script/design-audit.mjs --strict`

Expected: exit 0, zero findings, no baseline increase.

Run: `pnpm test:ui-system`

Expected: exit 0; the full browser suite passes, including the seven new provenance cases and all existing graph/navigation/focus checks.

Run: `pnpm verify`

Expected: exit 0, unpiped, after the controller sees every required gate complete. This is an implementation gate; the plan-writing sandbox does not run it.

Run: `git diff --check`

Expected: exit 0, no output.

Run: `git diff --unified=0 -- packages/ui/src script/shots docs/architecture.md docs/decisions.md docs/interface.md docs/data-boundaries.md`

Expected: the reviewer reads every added line, including addresses, account labels and paths. Only placeholders or the approved public demo persona appear. Inspect every captured image manually as well. The plan and implementation authorize no push, publication or merge.

- [ ] **Step 12: Controller commit.**

The controller records the actual implementation writer. With the same writer identity used by the earlier tasks:

```bash
git add packages/ui/src/components/ProjectProvenance.tsx packages/ui/src/components/ProjectProvenance.test.tsx packages/ui/src/components/ProjectPage.tsx packages/ui/src/components/ProjectPage.test.tsx packages/ui/src/components/SessionTree.tsx packages/ui/src/components/SessionTree.projects.test.tsx packages/ui/src/state/store.ts packages/ui/src/state/store.provenance.test.ts packages/ui/src/preview/main.tsx e2e/ui-system/provenance.spec.ts script/check-reachable.mjs script/shots/seed.mjs script/shots/shoot.mjs script/shots-isolation.test.mjs docs/architecture.md docs/decisions.md docs/interface.md docs/data-boundaries.md
git commit -m "feat: show and control project provenance capture" --trailer "Co-Authored-By: Codex GPT-6 <agent@harnessdesk.app>"
```

## Interfaces for later phases

Keep the contract this small; internal observation/range/index schemas are not public extension points.

| Consumer | Exact interface | File / route | Meaning |
| --- | --- | --- | --- |
| Phase 10 | `CommitProvenance`, `ProjectProvenance`; `provenance/commits({ root: string, shas: readonly string[] }): ProjectProvenance` | `packages/protocol/src/provenance.ts`, `wire.ts` | Read attributed Seats, pending/unattributed reason and completeness for a history selection; do not treat attribution as a review verdict |
| Phase 11 | Same batched `provenance/commits` read and immutable `ProvenanceSeat.id/session` | Same files | Join only known Seats; keep partial/unknown slices unattributed; this does not allocate cost or require a Goal |
| Phases 10 and 11 | `CaptureHealth`; `provenance/status({ root?: string }): readonly CaptureHealth[]`; notification `provenance/changed({ project, revision, health })` | Same files | Current capture availability and uncertainty; omitting root lists registered projects only |

The frontend's `AppStore.readProvenance(root,shas)` and `loadCaptureHealth(root?)` are thin consumers of those routes, not a second protocol. Phase 10/11 can remain independently planned: neither needs provenance to create its core feature, and this phase imports neither.

## Overlaps and contradictions resolved

- **Phase 2 Part B:** `ProjectPage.tsx` is a promised prerequisite absent at the inspected Part B head. Its page, store, preview and sidebar are shared files; confirm the exact Phase 2/4 anchors quoted in Task 8 before applying the additive patches. No change to Agent precedence, seating, name cards, Command-N or runtime selection.
- **Phase 3:** the ceilings plan is now available and its Task 2 was read for this depth pass. Consume its durable ceiling/standing union through Phase 4 unchanged. Its `SeatRecordView` changes remain owned by that phase; provenance composes the record rather than parsing a permission into a new ceiling. The earlier inspection note in the header remains a dated statement, not the current availability check.
- **Phase 4:** this phase reads SeatBook/EvidenceStore and extends backup composition. It does not change their record kinds, freshness, card columns or immutable Seat shape. `evidence/seat` returns the latest Seat for a session and is deliberately not reused for history by immutable Seat ID. Its branch diff fact associates a Seat with an observed patch; it does not authenticate the author process, so this plan exposes the association honestly.
- **Phase 5:** mutable card dependency navigation can use the existing board. A permanent Goal receipt or immutable historical decision trail is outside the current Phase 4 data contract; missing historical cards are unavailable. No Goal dependency is smuggled in to meet the provenance UI.
- **Literal every-ref coverage versus passive observation:** no journal can recover evidence Git never kept. The plan captures available transitions, surfaces known gaps and refuses unknowable links; it does not promise offline recovery of expired/deleted reflogs.
- **Patch-id versus content edits:** stable patch IDs alone neither survive arbitrary content changes nor prove that a squash contains each source patch. The plan pairs exact fingerprints, records ranges before source GC, supports surviving per-file amend portions, and explicitly refuses overlapping or cancelled contributions it cannot prove.
- **Default capture versus plain-path wording:** the roadmap's explicit on-by-default project capture wins for passive metadata reads. It creates no repo files, performs no Agent/Goal action and adds no sidebar destination. The stopped label is the required visible exception.
- **Old design-bar primitive wording versus current architecture:** use current `design/ui` and public `design` entrypoint, not the retired Kit layer. The state-vocabulary dependency is explicit. Layout and existing row geometry remain the system's.
- **Common brief's server Vitest example versus repository reality:** this server uses compiled Node tests. The planning pass ran scratch Node tests and foreground per-file Vitest/jsdom runs; implementation commands use the repository's actual runners. No server test was moved below validation to avoid a listener.

## Requirement-to-task audit

| Requirement | Tasks / proof |
| --- | --- |
| Every discoverable project's ref transition, independent of turns | 2, 5; external writers, tags, deletes, worktrees, A→B→A and startup reflog tests |
| No turn waits; large repository cost is bounded | 5; nonblocking queue mutation, child concurrency, persistent frontier, metadata-only watch |
| Original immutable commit-to-Seat/session association | 1, 3, 4; exact diff fact plus checkout/time, append-only source identity |
| Amend/rebase/squash; each defensible Seat; ambiguity visible | 3, 7; real Git fixture, complete/partial distinction, two-Seat ambiguity test |
| Healthy/degraded/stopped; reason/next step; on by default | 4, 8; persistence, malformed pref, write failure, status copy fixtures |
| Stopped sidebar row and project Provenance page | 8; folded project, keyboard and narrow frames |
| History Agent name + runtime mark; Seat record and session | 7; immutable ID lookup, all squash contributors, deleted-session state |
| Untrusted refs/messages/patches never become shell/path/HTML authority | 2, 6, 7; isolated Git view, OID/pathspec bounds, actual wire tests, text-only rendering |
| No Goal dependency; later-phase read interfaces | 1, 6; interface section above |
| Documentation and preserved plain path | 8; docs edits, Command-N and plain-session acceptance |

## Executed proof, with its limits

The depth pass changes this plan only. Tasks 1–6 retain their execution receipts in their own proof steps; this last batch did not rerun or revise those tasks. The superseded miniature-source appendix and its old aggregate totals have been removed. Every new file and modified-file patch needed for Tasks 7–8 is now in the tasks themselves.

The final batch used `.plan-scratch/ui` for copies of the actual renderer, design components and proposed files. Dependencies were read through the existing workspace installation. The scratch protocol copied the real protocol plus Task 1's provenance types, Task 6's wire declarations and validators, and Phase 4's evidence/Freshness/BoardEvidence types. The scratch also copied Phase 4's `SeatRecordBlock`, `EvidenceChips` and `lib/evidence`, and the named `4382ded9` Chip prerequisite. Phase 2's three Agent-word helpers and Phase 4's unused `seatRecord` reader were explicitly isolated stand-ins; no claim about those helpers' wording or that reader's transport behavior is made here. The production plan consumes the real prerequisite implementations.

The exact proposed component bodies, history/sidebar edits, store additions and new tests were run in jsdom. TypeScript strict no-emit checking passed for the scratch renderer with the complete protocol shapes above. No repository source/test file was edited; all copied modules, outputs, mutations and dependency links were removed with `.plan-scratch/` before handoff.

| Batch proof | Restored green result | Observed red |
| --- | --- | --- |
| Commit detail, historical Dialog, batch ownership, unsafe text, matching existing evidence | 14 component tests | Missing module: import failure; removing the batch generation checks: 1 assertion fails; using `latest` instead of the immutable Seat ID: 1 assertion fails |
| Store reads, monotonic health, connection epochs, pruning, reconnect and persistence | 10 store tests | Removing revision guard replaces revision 5/degraded with revision 1/healthy: 1 assertion fails |
| Project capture control, known non-Git refusal, busy persistence and stale completion | 11 component tests | Missing module: import failure; removing busy disabling: 1 assertion fails; conflating an uninspected workspace with non-Git: 1 assertion fails |
| Existing history and folded project regressions | 42 GitPane tests; 4 project-row tests; 2 unchanged GitGraph tests | Widening the stopped-only predicate draws Capture stopped on a healthy row: 1 assertion fails |

The final restored run passed **83 tests across six files**. The three screenshot scripts also passed `node --check`; this proves parsing only, not their integrated execution. Each of the six behavioral mutations exited 1, was restored in `finally`, and its focused rerun exited 0. The two absent-module reds were restored as well. Planning commands ran in the foreground, one Vitest file per invocation:

```bash
node .plan-scratch/missing-red.mjs
node .plan-scratch/mutations.mjs
node .plan-scratch/task7-proof.mjs
node .plan-scratch/ui/node_modules/vitest/vitest.mjs run --configLoader native --config .plan-scratch/vitest.config.mjs src/components/CommitProvenance.test.tsx
node .plan-scratch/ui/node_modules/vitest/vitest.mjs run --configLoader native --config .plan-scratch/vitest.config.mjs src/components/ProjectProvenance.test.tsx
node .plan-scratch/ui/node_modules/vitest/vitest.mjs run --configLoader native --config .plan-scratch/vitest.config.mjs src/state/store.provenance.test.ts
node .plan-scratch/ui/node_modules/vitest/vitest.mjs run --configLoader native --config .plan-scratch/vitest.config.mjs src/components/GitPane.test.tsx
node .plan-scratch/ui/node_modules/vitest/vitest.mjs run --configLoader native --config .plan-scratch/vitest.config.mjs src/components/SessionTree.projects.test.tsx
node .plan-scratch/ui/node_modules/vitest/vitest.mjs run --configLoader native --config .plan-scratch/vitest.config.mjs src/components/GitGraph.test.tsx
node .plan-scratch/ui/node_modules/typescript/bin/tsc --noEmit -p .plan-scratch/ui/tsconfig.json
```

`ProjectPage` integration, actual browser focus/layout, screenshots, the shots seeder's integrated EvidenceStore run, OS watcher delivery, integrated host lifecycle and `pnpm verify` were not executed by this planning batch. Their exact code or acceptance procedure and commands are above. A passing jsdom assertion is not a recording of those surfaces, and a copy of a prerequisite is not a claim that it has landed in the current base.
