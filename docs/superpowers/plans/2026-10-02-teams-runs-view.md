# Teams, Flows and Runs view — Implementation Plan

> **For the Lead and for Teams:** each "PR n" below is a brief that stands on
> its own. Copy its section, and "Rules for every PR", into a Team's brief file.
> Steps use checkbox (`- [ ]`) syntax. The design is approved (owner,
> 2026-10-02, decisions 1 to 9 as recommended, the Flow view being the relay drawing, and decision 10 as the owner made it on #1278):
> `docs/superpowers/specs/2026-10-02-teams-flows-runs-view-design.md`. Read its
> sections named in a brief before writing anything.

**Goal:** Show a Team's work and let a person steer it without opening a chat:
a Team overview (who is working, waiting, stuck, expensive), a Run view (a
timeline with an inspector, a way on when a Run ends, and a link to the Flow it
started with), the controls that go with them, and a Flow view drawn to be
looked at, with the Run's live state laid over it later.

**Architecture:** The window derives its views with pure selector modules in
`packages/ui/src/lib/` from the store snapshot it already holds. Their output
shapes are the ones `@harnessdesk/client`'s core selectors return (the
clients design, #1271); the overview selector has already moved there (#1295),
and the timeline selector follows in PR 16, so the switch changes an input and
no view. Host changes are additive fields on the Run record (PR 5) and the stop and
list methods the clients design already owns. Nothing here waits on the event
stream until PR 16.

**Tech Stack:** React 19, TypeScript, Vitest + jsdom, Playwright
(`playwright.ui-system.config.ts`), the design system in
`packages/ui/src/design`, CSS modules only where a screen needs one. No new
dependency, except possibly a graph-layout library in PR 14 (decided there).

## Rules for every PR

- **Small, and one purpose.** A PR that needs two sentences to say what it does
  is two PRs. Say what it does not do in its body.
- **The UI never names a runtime** (AGENTS.md rule 8). Names come from
  `RuntimeInfo.presentation` and a seat's own nickname; behaviour is gated on
  `runtime.capabilities`, never on which backend is running.
- **A row's second line is earned** (rule 9). A state is a chip on the title's
  line. Idle and Done are quiet text, not chips. No resting state wears a health tone.
- **Type from the scale, built from the design system** (rules 10–11):
  `ListRow`, `Chip`, `Table`, `Text` roles, the inspector anatomy. No raw
  literal where a token exists, no `--hd-*` token defined in a screen, no icon
  drawn in place (`components/Icons.tsx`). `node script/design-audit.mjs
  --strict` stays green.
- **Agent text is untrusted** (rule 5): anything from a transcript, a handoff or
  a finding goes through `packages/ui/src/lib/sanitize.ts`. The "doing" line
  carries a tool and at most a path; never a command's text, a URL or an
  environment value.
- **Faces are someone** (`docs/design.md` § "Shapes say what a mark is"): a seat
  is `shape="face"` and `data-shape="face"`; the faces census must stay green.
- **Nothing public carries a real account** (rule 13). Frames come from the
  preview harness (`preview.html`) or the catalogue, with placeholder names and
  addresses, never a real desk. Grep your own added lines for `@`, handles and
  `/Users/`, and read every image.
- **The catalogue shows the exact UI.** A UI PR updates the design catalogue
  boards (`packages/ui/src/design/explorer/*`, `design/catalog/manifest.ts`,
  `node script/ui-catalog.mjs`) with the real component in every new state
  (empty, failed, pending, narrow, dark), the preview frames
  (`packages/ui/src/preview/*`), and `docs/design.md` or
  `docs/design-system.md` (`pnpm design:doc`) where they change.
- **Tests fail first.** For each behaviour, write the test, watch it fail, then
  make it pass; for a rule a test guards, mutate the code and see it fail.
- **A browser rule for what jsdom cannot see.** Layout, truncation, narrow
  widths and tokens are checked with a named Playwright spec: `pnpm exec
  playwright test -c playwright.ui-system.config.ts e2e/ui-system/<spec>.ts`
  (`pnpm exec tsc -b` first if the build is stale).
- **Verify unpiped.** `mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify`; read
  the exit code, not `tail`. A red step you did not cause is proven on
  `origin/main`, stated in the PR, and filed.
- **Land the usual way.** Draft PR, at most three review rounds, merge only
  through `node script/land-safe.mjs <pr> --head <the sha the last round
  reviewed>`. No UI or behaviour change means nothing to launch; anything a
  person can see needs frames in the PR body.
- **Commit trailer.** `Co-authored-by: HarnessDesk Agent
  <agent@harnessdesk.app>` on a Team's commits; never a trailer copied from
  `git log`.
- **PR text is written for our own record.** Two or three plain sentences (the
  problem, the change, why it is safe), a short "What changed", "How to test",
  the linked issue. No competitor or reference-app names, and no thanks or
  address to an outside project.

## Order, dependencies and what can start now

Sizes: S under a day of Team time, M about a day, L more.

| PR | What | Depends on | Starts now? | Size |
| --- | --- | --- | --- | --- |
| 1 | The overview model (pure selectors) | none | merged (#1276) | M |
| 5 | Host: the Run record learns what the views need | none (coordinate on `flow-execution.ts`) | merged (#1281) | M |
| 6 | The brief field in the start dialog | none | merged (#1274) | S |
| 2 | The Overview in the Team pane, with every Seat a Run opened (closes #1278) | 1, 5 (both merged) | merged (#1284) | L |
| 12 | The Teams page | 1; after 2 for `SessionTree.tsx` | merged (#1293) | M |
| 3 | The Run model and timeline | none (PR 5 has merged; its fields are optional on older records) | **yes** (after 2 for the shared pane file) | L |
| 4 | The Run inspector | 3 | after 3 | M |
| 7 | Publication state and its doors | 3, 4 | after 4 | M |
| 8 | Answer and approve from the Overview, abandon from the inspector | 2, 4 | after 4 | M |
| 9 | Run a check again from the timeline | 3, 4 (#1263 is merged) | after those | S |
| 10 | Stop a run | 2, 3, 8; the stop method from the clients design | when its method exists | S |
| 11 | The end of a Run, and Run again | 3, 4, 5, 6 | after those | M |
| 13 | `FlowGraph` and the Flow tab (read-only) | 3 | after 3 | L |
| 14 | The Run's state on the Flow | 13, 3, 9 | after those | L |
| 15 | The poster and the site demo | 14 | optional | S |
| 16 | Read from the shared client selectors | 3 (the timeline selector it moves) and 7 (`review-publication.ts`, the chips); the Wire client and CLI session's PR 1c has merged (#1295) | after 3 and 7 | M |
| 17 | Host: a finished Seat's process rests | none | merged (#1283) | L |
| 18 | A wrapped Team reads as a record | 2, 12 (merged), 3 | after 3 | M |

**One Team at a time in `SessionTree.tsx`.** PR 2 (nesting a Team's Seats) and PR 12 (listing only active Teams) have merged; PR 18 (the wrapped group) is the one left to change the sidebar tree, from a fresh fetch of main.

**One Team at a time in `flow-execution.ts`.** PR 5 and the other session's
`flow/execution/stop` PR both change it. Whichever lands second starts from the
first's landed revision.

**One Team at a time in `TeamRoomPane.tsx`.** PRs 2, 3, 8 and 10 all touch the
rail or header of `packages/ui/src/components/TeamRoomPane.tsx`, a 2,400-line
file. Land them in that order, and each one starts from a fresh fetch of main.
PRs 1, 5, 6 and 17 have merged and need no scheduling. Of the rest, PR 12 touches the pane's files only through PR 2's order above, and `SessionTree.tsx` after PR 2.

**What waits on the other session.** Only PR 10 (the stop method). Its PR 1c has merged (#1295). The two events below have landed (#1285). Every
other PR reads what the window's store already holds; PR 16 is the exception,
and reads the client snapshot (`Client.snapshot()`).

## Coordination with the "Wire client and CLI" session

That session owns the clients design (#1271) and its implementation: the client
door, `client/hello`, `client/subscribe`, `flow/executions`,
`flow/execution/stop`, `@harnessdesk/client`, and the stable event vocabulary
(`run.changed`, `card.changed`, `team.changed`, `waiting`, `waiting.cleared`,
`notice`, `gap`, `end`). It accepted this plan's four requests, with two changes
to their shape (agreed 2026-10-02, landed in its PR 1b, #1285):

1. **`seat.changed`.** The **host derives it** and sends one `seat/activity`
   notification per seat on a `seats` topic, at most once every 2.5 seconds; the
   library maps it one to one. Reason: one derivation on the host keeps
   every client's rows identical and keeps the stream small.
   - The derivation of the in-flight tool, with the one tool-name lookup (today
     `packages/ui/src/lib/tool-names.ts`), **moves into `packages/protocol`**,
     with a re-export left in the UI so this plan's imports do not change.
   - Landed as `SeatActivity` (`packages/protocol/src/wire.ts`): `{ goal, seat,
     role, card, state: 'working' | 'waiting' | 'idle', doing: SeatDoing |
     null, since? }`. `seat` is `runtime:sessionId`, the same identity as
     `card.changed.seat`, so the window maps it to its Seat ids through the Seat's
     session pointer. `since` comes only from a record.
   - `doing` is structured and null unless the seat is working: `SeatDoing` is
     `{ kind: 'tool', tool, target? }` or `{ kind: 'thinking' }`, a tool and at
     most a path, never a command's text, a URL or an environment value. Waiting
     and idle are the `state`. The shared lookup is `seatDoing` and
     `doingSentence` in `packages/protocol/src/tool-activity.ts`.
   - PR 1's `doingLine` 2.5-second hold stays a pure function. In PR 16 the
     window may read `seat/activity` instead of its own snapshot, or keep both.
2. **`review.changed`**, keyed by round, in the desk's own words:

   ```ts
   { type: 'review.changed', team, run, round: number, cards: number[],
     state: 'local' | 'pending' | 'posted' | 'partial' | 'uncertain' | 'none',
     reason: string | null, pr: number | null }
   ```

   Landed as `FindingRunView.rounds` on `finding/run`:
   `{ round, state, reason, pr, cards }` per round, folded by the host from the
   Run's publication journal with the same rule as the aggregate (`state` is
   `none` before a round has a decision); `finding/run`'s `publication` stays the
   Run's aggregate. The host also sends the existing `finding/changed` after new
   reviews and after the posting state is saved, so a client watching only
   reviews refreshes. (`finding/publications` lists only the postings a person
   must look at, so a post that succeeded is not in it.) The window maps these
   words to its own chips in its selector, not on the wire (PR 7 has the table).
3. **Optional fields:** `attempt`, `continues` and `revision` on `run.changed`;
   `seat` and `since` on `card.changed`. Each is present only when the desk's own
   record carries it, never filled from when a client noticed something.
   `card.changed.since` is the claim's `at` while claimed, and absent until a
   record holds it. `continues` and `revision` pass through now that PR 5 has landed
   (#1281). `attempt` stays absent until a record carries one: no record has an
   attempt field today, and a check's earlier attempts live in its evidence
   (PR 9 adds the read).
4. **Selectors.** Home: `@harnessdesk/client/views`, pure, no transport; the
   window imports only that entry and the other session adds the layering rule.
   **This plan owns the selector code and its tests**: PR 1 and PR 3, written in
   `packages/ui/src/lib` over plain data. The other session owns the package, the
   state feed and the gate; when `status` and `run show` need the selectors it
   moves the files into `client/views` and leaves a re-export in the UI, so
   nothing here breaks. Done for the overview model in its PR 1c (#1295): it is
   in `packages/client/src/views/`, `packages/ui/src/lib/team-overview.ts` is
   only `export * from '@harnessdesk/client/views'`, the layering rule allows
   the window to import nothing else from the client package, `insight/goal` is
   in the read tier, and a change to the model goes in the client package. The
   timeline selector moves the same way in PR 16.

Its order: PR 1 (the read-only door, the library, `desks`, `status`, `teams`,
`runs`, `watch`; merged, #1279), PR 1b (`seat/activity`, `FindingRunView.rounds`,
the tool lookup in protocol; merged, #1285), PR 1c (the `views` entry with
`teamOverview` moved, `status` using it, and `insight/goal`; merged, #1295), PR 2
(starting a flow), PR 3 (`flow/execution/stop`, #1247). It will say when its PR 3
lands (this plan's PR 10). If PR 10 cannot wait for its PR 3, it can pull
`flow/execution/stop` forward into a small host PR of its own; PR 10 follows the
Overview and the Run view in this plan anyway, so it can wait.

**Both sessions edit `flow-execution.ts`** (PR 5's revision, `continues`,
`brief`, `end`, `startedAt` and `endedAt` here; stop there). The two PRs land
one at a time, as the plan does for `TeamRoomPane.tsx`: whichever is second
starts from the first's landed revision, fetched and rebased before its PR is
opened, not after review.

The window does not need `flow/executions` (the run list): it already holds its
runs in `snapshot.flowExecutions`.

---

## PR 1 — The overview model

**Status.** Merged as #1276, and moved by #1295: the model now lives in `packages/client/src/views/team-overview.ts` with its tests in `packages/client/test/views`, the file named below re-exports it, and a later change to the model (such as PR 2's `done` flag, #1284) goes in the client package. This section is kept as the record of what it was asked to do.

**Goal.** One pure function turns what the window already holds into the rows
the Overview draws, in the app's words, ordered by precedence.

**Read first.**
- Spec: "The Team overview" (the state table, "The doing line", "Cost").
- `packages/ui/src/components/TeamRoomPane.tsx`: how `busy`, "needs you" and the
  room's live line are derived (search `isBusy`, `needsYou`, `room-live-line`).
- `packages/ui/src/lib/tool-names.ts`: `toolSentence`, `shellCommandOf`,
  `shortestUniquePathLabels`.
- `packages/protocol/src/goal.ts` (`GoalView`, `activityOf`),
  `packages/protocol/src/team.ts` (`Intent`, `IntentClaim`),
  `packages/protocol/src/flow-policy.ts` (`FlowExecution`, `FlowRoundState`),
  `packages/protocol/src/insight.ts` (`InsightReport`).

**Scope.**
- [ ] Create `packages/ui/src/lib/team-overview.ts`:
  - `type SeatState = 'needs-you' | 'unread' | 'working' | 'idle'`
  - `interface SeatRow { seat: string; name: string; role: string | null; card: { id: number; title: string } | null; round: number | null; state: SeatState; reason: string | null; doing: string | null; since: number | null; cost: { unit: 'money' | 'turns'; value: number; estimated: boolean } | null }`
  - `interface NeedsYouItem { kind: 'card' | 'question' | 'approval'; seat: string | null; card: number | null; summary: string; since: number }`
  - `interface RunStrip { run: string; state: 'running' | 'settled' | 'stopped' | 'stalled'; round: number | null; role: string | null; startedAt: number; reviewRounds: { used: number; of: number } | null; total: { money: number | null; turns: number | null } }`
  - `teamOverview(input): { run: RunStrip | null; needsYou: NeedsYouItem[]; seats: SeatRow[] }`
  - `doingLine(previous, next, now): { line: string | null; at: number }`: the 2.5-second hold, as a pure function.
- [ ] Rules, each with a test:
  - Precedence is `needs-you`, `unread`, `working`, `idle`; ties by card number.
  - `needs-you` when a card addressed to a person waits, a question or a tool approval is open, or the seat is blocked by hand (`blockedBy: 'hand'`) with a reason (that reason is `reason`). A stalled run and a run that ended on an outcome no rule follows make the Team `needs-you`, not a seat (the Team's state is the strip's, PR 2). An unposted review makes it `needs-you` too, but only from PR 7: the selector's input carries the Run and the report, not the Run's publication state, and `GoalView.activity` does not count it.
  - `unread` comes from the window's own unread marks and never from the host.
  - `working` when a turn runs or the seat holds a claimed card; `idle` otherwise. A card blocked by the graph (`blockedBy: 'graph'`) is idle and says "after #n" in `card`.
  - Cost comes from the seat's own row of the report's `seat` breakdown (`InsightReport.breakdowns`), per metric: `cost.unit` is `money` only when the runtime's `capabilities.metered` is true, the USD metric's `basis` is `listPrice`, `vendorMetered` or `mixed` (a rate is known), and its `coverage` is not `none` and `quality` not `unknown`; otherwise `turns` from the turns metric under the same two conditions. `estimated` is true when the metric's `quality` is `estimate` or `floor`, its `coverage` is `partial`, or its `basis` is `listPrice` or `mixed`. An unavailable report or an unknown metric gives `cost: null`, never zero. (`InsightReport.provenance` holds only the report's availability and a note; the rate's provenance is each metric's `basis`.)
  - The doing line is a sentence from the latest in-flight tool call through `toolSentence`. A path may appear. A command's text, a URL and an environment value never do.
- [ ] Do not read from a component, the store object or a module-level cache: the input is plain data, so the same file can move to `@harnessdesk/client/views` (done in #1295: the model lives in `packages/client/src/views/` and `packages/ui/src/lib/team-overview.ts` re-exports it). Keep importing the tool-name lookup from `lib/tool-names.ts`: it is moving into `packages/protocol` with a re-export left in the UI, so the import does not change.

**Depends on.** None.

**Not in this PR.** Any component, any wire call, any CSS.

**Verify.**
- [ ] `packages/ui/src/lib/team-overview.test.ts` with at least twelve cases: each state, a tie, blocked by hand and by graph, no run, a stalled run, metered and not, the report unavailable, the doing hold.
- [ ] Red first for the precedence and for the no-command rule: change the order, or let `shellCommandOf`'s output through, and watch each test fail.
- [ ] `pnpm exec vitest run src/lib/team-overview.test.ts` (from `packages/ui`) and `pnpm verify`.

**Done when.** The tests pass, and the module's exported shapes are written in the file's header comment as the contract PR 16 will hold the client library to.

---

## PR 2 — The Overview in the Team pane

**Status.** Merged as #1284 (it implements the retention decision on #1278: finished Seats stay listed and fold under a done disclosure, and their conversations nest under the Team in the sidebar); this section is kept as the record of what it was asked to do.

**Goal.** A new first item in the Team's rail, **Overview**, shows the Run strip, what needs the person, and the seats table. The same PR makes the Team's seats one set everywhere the window lists them, which closes #1278: a Team whose Flow opened a writer and a reviewer no longer reads "Agents 0", those conversations sit under the Team in the sidebar, and a finished Seat stays on the list as Done and folds into one line in the Overview (the owner's decision on #1278; its process resting is PR 17).

**Read first.**
- Spec: "The Team overview", and the frames `team-overview` and `overview-narrow` (links in the spec's frames section).
- `packages/ui/src/components/TeamRoomPane.tsx` (the rail rows, the header chip, the pane's default view) and `TeamRoomPane.test.tsx`.
- `packages/ui/src/design/ui/table.tsx`, `list-row.tsx`, `packages/ui/src/design/patterns/Settings.tsx` (`Chip`, `Text`), `patterns/InspectorPanel.tsx`.
- PR 1's `team-overview.ts`.
- #1278, and how the two readers get members today: the rail's Agents list and its empty state in `TeamRoomPane.tsx` (the roster from `store.teamPeers`, which answers the board's `members`; the empty-state sentence near `No agents in this room yet`); the sidebar's `roomMembers` and the `inRooms` set in `SessionTree.tsx`. A Flow's membership is the Goal's Seats (`GoalView.members` in `snapshot.goals`; `FlowExecution.rounds[].seats` names the ones a Run opened by role); `lib/goal-run.ts` shows how the window already reads a Goal's Run.

**Scope.**
- [ ] `packages/ui/src/components/TeamOverview.tsx`: the Run strip (name, round and role, started, review budget, total as "$1.43 · 96 turns", no actions yet), the **Needs you** list (rows render; their buttons arrive with PR 8), and the seats table (seat face and name, role, card, round, state chip, doing line, time in state, cost). Idle and Done are plain muted text (resting states: no chip, no colour). PR 1 (merged as #1276) takes the Run's start time from its caller (`TeamOverviewInput.run.startedAt`, and `RunStrip.startedAt: number`). `FlowExecution.startedAt` has been projected since #1281, but it is optional on a record saved before that: pass it when present, and for an older record relax both fields to `number | null` and leave *started* out. The cost cell shows the unit it has, and its title says why ("This account is not metered, so turns are counted").
- [ ] Narrow width (the pane's own narrow rule): a seat is one `ListRow`: face, name and state chip on the title's line, the doing line beneath, the cost at the end.
- [ ] `TeamRoomPane.tsx`: **Overview** as the rail's first item, the default when a Flow run exists on the Team (a Team without one still opens on Chat). The header chip's existing rule is unchanged.
- [ ] A Team with no run: the strip is absent; the table still lists the seats (state, card, time).
- [ ] **Measure first, and put it in the PR body.** On the rig, run a Flow that opens a writer and a reviewer, and record for the Team: what `team.members` holds, what `GoalView.members` holds while the Run works and after it settles, and whether a seat that finished its cards is still an open Seat or a closed one. The design below holds in either case; the measurement says which case the tests cover.
- [ ] `packages/ui/src/lib/team-seats.ts` (pure, tested first): `teamSeats(goalView, teamState, execution)` returns the Team's seats as one list, keyed by the conversation's session key and listed once: the Goal's Seats, the seats the Run's rounds name (with the round's role), and any member of the older list not already there. Each entry says where it came from only in the tests, never on screen. A seat the window cannot resolve to a conversation is left out, not drawn blank.
- [ ] `TeamRoomPane.tsx`: the rail's **Agents** list and its count read `teamSeats` (the chat roster's own verbs, such as add an agent, keep working on the same entries), and keep every row, done ones included. The Overview's table reads the same list, so the two counts agree.
- [ ] **Done, and the fold.** A seat whose every card is done, with no turn running, no question, no approval and no unread mark, is **Done**: plain muted text, the same resting state as Idle, no colour. In the Overview, Done seats collapse into one line ("3 done", a disclosure that opens to the rows) after the working and waiting ones; a seat leaves the fold the moment it is Needs you, Unread or Working. Add `done: boolean` to `SeatRow` in `team-overview.ts` and the rule, with its tests, to PR 1's precedence tests. A seat that never held a card is Idle and is not folded.
- [ ] **A seat without a process is not missing.** A seat the desk holds no live conversation for (its process rested, #1283, or the desk restarted) is listed from the Goal's Seats and the Run's rounds, with its state from its cards; opening its conversation works as it does for any conversation the desk is not holding.
- [ ] The empty state appears only when `teamSeats` is empty, and says Team: "No agents in this Team yet. …" (all three variants of the sentence, which today say "room"). Other uses of the word in comments are the Team rename's, not this PR's.
- [ ] `SessionTree.tsx`: `roomMembers` and the `inRooms` set read `teamSeats`, so a Seat's conversation is nested under its Team and is no longer listed loose under the project. A conversation is still listed once (the existing rule); the agent filter, hidden keys and the wrapped-Team folding still apply to the nested rows.
- [ ] Catalogue boards and preview frames for: running, needs-you, unread, idle, a stalled run, no run, no seats, three done folded and opened, narrow, dark. (The spec's frames predate the fold decision.)
- [ ] `docs/design.md`: one short section, "The Team overview".

**Depends on.** PR 1 (merged as #1276) and PR 5 (merged as #1281, for `startedAt`).

**Not in this PR.** Buttons on the Needs-you rows (PR 8), *Open run* (PR 3), *Stop run…* (PR 10), any wire call. Changing what the host writes into a Team's older member list: if the measurement shows it should, file it as its own issue; the window's one list works either way. A Seat's process resting (PR 17, merged as #1283). A wrapped Team's seats and its read-only behaviour (PR 18): wrapping closes the Seats and empties `GoalView.members`, so until PR 18 a wrapped Team lists what the older member list holds, as it does today.

**Verify.**
- [ ] Component tests: precedence order on screen, the cost title, a seat whose row has no card.
- [ ] `team-seats.test.ts`: a Team whose Run opened two seats lists both with their roles; a member of the older list that is also a Seat appears once; a seat that cannot be resolved is left out; a Team with no Run and no members is empty.
- [ ] `team-overview.test.ts` (extending PR 1's): three finished seats fold to "3 done"; a done seat with a question, an unread mark or a running turn leaves the fold and sorts by precedence; an idle seat with no card is not folded.
- [ ] Component tests for #1278: the Agents count equals the Overview's rows; the empty sentence says Team and is absent when a seat exists; the sidebar test shows both conversations under the Team and none in the project's loose list.
- [ ] `e2e/ui-system/team-overview.spec.ts`: rows sorted by precedence; the doing line truncates with its title; the narrow layout; no resting state computes a health colour; every seat tile is `data-shape="face"`. On a rig Team whose Flow wrote and reviewed: the rail says Agents 2, not 0, the sidebar has the two conversations under the Team, and the Overview shows "2 done" folded once both have finished.
- [ ] Frames in the PR body (light and dark, wide and narrow) from the preview harness, placeholder names only.

**Done when.** The Overview matches the spec's frames within the design system's tokens, #1278's three expectations hold on the rig (every Seat listed with role and state, finished ones kept and folded in the Overview, nested under the Team in the sidebar, an empty state only when there really are none, and it says Team), the PR body says `Closes #1278`, and `pnpm verify` and the named specs are green.

---

## PR 3 — The Run model and timeline

**Goal.** A **Run** item in the rail opens a read-only timeline of a Run's rounds, cards, checks and findings.

**Read first.**
- Spec: "The Run view" (the header, the timeline table, "Why a Run ended"), the frames `run-timeline` and `run-settled`.
- `packages/protocol/src/flow-policy.ts` (`FlowExecution`, `FlowRoundState`, `FlowOperation`), `packages/protocol/src/team.ts` (`Intent`, the channel entries), `packages/protocol/src/findings.ts`.
- `packages/ui/src/state/store.ts` (`flowExecutions`, `readFlowExecution`); `packages/ui/src/components/FlowRunStatus.tsx`.

**Scope.**
- [ ] `packages/ui/src/lib/run-timeline.ts` (pure): `runTimeline(input): { header; rows }`. Rows: start/brief, round heading, card, check (its latest result from the card's evidence, `evidence/board`, and its Flow operation's state; `FlowOperation` carries no attempt or output, so earlier attempts are drawn only when a read returns them, which PR 9 adds), person step, findings, end. Durations come from a card's claim time and `updatedAt`. The Run's `revision`, `continues`, `brief`, `startedAt`, `endedAt` and `end` are projected since PR 5 (#1281) and are optional: a record saved before it has none, and the rows or buttons that need one are simply absent for that Run.
- [ ] `packages/ui/src/components/RunView.tsx`: the **Run** rail item (shown when the Team has a run; the count is the number of runs), the header (Run n, state chip using the app's words, the Flow's name, *Open pull request* when the Team has one), the timeline with a selectable row, and the in-flight row with its doing line (from PR 1's `doingLine`).
- [ ] Selection is a fill (the inspector anatomy's selected row); the selected row id is state the inspector (PR 4) will read.
- [ ] Catalogue boards and frames for: running, settled, stopped, stalled, a round with findings, many rounds (scrolling), narrow, dark.

**Depends on.** None to start; PR 5 (#1281) has merged and its fields are optional on older records. It shares `TeamRoomPane.tsx` with PRs 2, 8 and 10, so it starts after PR 2 has landed.

**Not in this PR.** The inspector (PR 4), the Flow tab (PR 13), any control.

**Verify.**
- [ ] `run-timeline.test.ts`: a table-driven test over scripted `FlowExecution` records for each state, a loop that fired twice, a run with no findings. (A check run again, with two attempts, is PR 9's test.)
- [ ] `e2e/ui-system/run-view.spec.ts`: ordering, the selected-row fill, narrow width.
- [ ] Frames in the PR body.

**Done when.** A Run on the fake-agent rig is readable end to end without opening a chat.

---

## PR 4 — The Run inspector

**Goal.** Selecting a timeline row shows what happened there, beside it.

**Read first.** Spec: "The inspector" table; `patterns/InspectorPanel.tsx`; `packages/ui/src/lib/sanitize.ts`; PR 3's selection state.

**Scope.**
- [ ] Sections by kind: **a card** (Input, Handoff, Findings, Review, Cost, and *Open the conversation* last), **a check** (the command verbatim, where and under what limit it ran, how its exit mapped, the last lines of its output, its latest result; earlier Attempts appear once PR 9 adds the read), **a person's step** (the sentence, the outcome buttons the role declares as inert text until PR 8), **the Run** (when nothing is selected: the brief, the Flow and revision, the seats, the base pin, who started it, budgets, cost).
- [ ] A handoff and a finding's text are rendered through `sanitize.ts`.
- [ ] *Open the conversation* uses the existing way a rail seat opens its conversation.
- [ ] A check's output: find where the desk keeps it (the card's evidence record or the Run's check log). If a read method exists, use it; if not, show "Output is not kept for this check" and write the missing read into PR 5's scope as a follow-up issue, with the evidence.
- [ ] At narrow widths the inspector is a pushed detail with a back link, the way Settings drills in.

**Depends on.** PR 3 (the timeline and its selection state).

**Not in this PR.** Any control (PRs 7 to 11); the Flow tab (PR 13); copying a transcript; a new host read for a check's output (an issue, and PR 5 or PR 9 where the read belongs).

**Verify.** Component tests for each kind; a test that a handoff containing markup or an escape sequence renders as text; the named Playwright spec extended; frames.

**Done when.** Every row kind in the timeline has an inspector, and nothing in it is copied from a transcript without sanitising.

---

## PR 5 — Host: the Run record learns what the views need

**Status.** Merged as #1281 (`revision`, `continues`, `brief`, `startedAt`, `endedAt`, `end`, all optional so older records read as before); this section is kept as the record of what it was asked to do.

**Goal.** A Run records what the views need and the host never had to say: the Flow's identity, the Run it continues, its brief, how and when it ended, and when it started (stored today, but not projected).

**Read first.** Spec: "The model, in words", "Why a Run ended, and the doors", "Host changes this needs" items 2 and 4; `packages/protocol/src/flow-policy.ts` (`FlowExecution`); `packages/server/src/flow-execution.ts`, `flow-preview.ts`, `methods/flows.ts`; `docs/flows.md` ("A run holds the flow it started with, frozen").

**Scope.** Additive and optional, so a record saved before this reads as before.
- [ ] `FlowExecution.revision: string | null`: a short digest of the **canonical** parsed document, set when the Run starts and never changed. The same Flow text gives the same digest whatever its formatting.
- [ ] `FlowExecution.continues: string | null`: the Run this one continues, set at the start (used by PR 11).
- [ ] `FlowExecution.brief: string | null`: the `brief` input, frozen with the Run (a Flow that declares no `brief` stores `null`).
- [ ] `FlowExecution.startedAt: number` (project the value the host already stores; `projectExecution` drops it today) and `FlowExecution.endedAt: number | null` (set when the Run leaves `running`).
- [ ] `FlowExecution.end`: `{ kind: 'complete' } | { kind: 'unrouted'; card: number; outcome: string } | { kind: 'stopped'; by: 'person' | 'desk' } | { kind: 'budget'; which: 'rounds' | 'without-progress'; used: number } | { kind: 'stalled' }`, set when the Run leaves `running`. `reason` keeps its sentence.
- [ ] Declare in `packages/protocol/src/flow-policy.ts`, validate in `wire-validators.ts`, set in `flow-execution.ts`; the compiler refuses a missing edit.
- [ ] `docs/flows.md`: one short section on what a Run records.
- [ ] If PR 4 found a check's output has no read method, add the smallest read here.

**Depends on.** None. It shares `flow-execution.ts` with the Wire client and CLI session's `flow/execution/stop` PR, and the two land one at a time: whichever is second starts from the first's landed revision, fetched and rebased before the PR is opened.

**Not in this PR.** `flow/execution/stop` and `flow/executions` (the Wire client and CLI session owns them), any UI.

**Coordinate.** That session edits `flow-execution.ts` for stop. Fetch main before starting and again before the PR, and keep this change to the record's fields and where they are set.

**Verify.** Node tests in `packages/server`: the digest is stable under formatting changes and changes with a rule; `continues` and `brief` round-trip; `startedAt` is the stored value and `endedAt` is set once; each `end.kind` is produced by its scenario (complete, an outcome no rule follows, a stop, a budget, a stalled check); a record with none of the fields still loads. `pnpm verify`.

**Done when.** A Run read back through `flow/execution` carries the new fields, and an old record does not break.

---

## PR 6 — The brief field in the start dialog

**Status.** Merged as #1274; this section is kept as the record of what it was asked to do.

**Goal.** A long brief has somewhere to go: a text area in the dialog, not the card's title.

**Read first.** Spec: "The brief"; `packages/ui/src/components/FlowStart.tsx` (inputs render as `Field`s), `FlowStart.test.tsx`; `docs/flows.md` (inputs and slots).

**Scope.**
- [ ] When the chosen Flow declares an input named `brief`, the dialog shows a **Brief** text area (paragraphs, a few rows tall, grows) beside the title, with an *Attach a file…* button that reads a text file (a size cap, and a refusal that names the cap) into it.
- [ ] The value goes to the preview and the start as the `brief` variable, through the existing `vars` path.
- [ ] A Flow with no `brief` input shows no field. Other inputs are unchanged.
- [ ] A catalogue case and frames: empty, filled, a very long brief (the area scrolls), the file refused, dark.

**Depends on.** None.

**Not in this PR.** Storing the brief on the Run (PR 5) or showing it there (PR 3, PR 4).

**Verify.** Component tests (shown only when declared; file read; cap refusal; the value reaches `previewFlow` as `vars.brief`); frames.

**Done when.** A person can paste three paragraphs and start a Flow whose card title is still its own sentence.

---

## PR 7 — Publication state and its doors

**Goal.** A review that was not posted is visible on the Run, with the reason and a way to post it.

**Read first.** Spec: "A review that was never posted", its table of the desk's words, and the `review-not-posted` frame. `packages/protocol/src/findings.ts`: `FindingRunView` (`round`, `publication`, `rounds`, `reason`, `boundPr`, `unbound`) and `FindingRoundPublication`, `FindingPublicationsView` and `FindingPublicationItem` (only postings a person must look at, plus the backfill), `FindingPublishAction`. `packages/ui/src/components/FindingPublications.tsx` (the existing post-again, skip and backfill controls) and `GoalFindings.tsx`; `store.readFindingPublications`. `docs/flows.md` § "Findings, budgets and blind rounds": confirm what `local`, `pending`, `partial` and `uncertain` mean before wording anything.

**Scope.**
- [ ] The Team and the Run are **Needs you** when the Run's publication state says a person must act (`local` with a pull request bound and posting on, `partial` or `uncertain`). Read `finding/run` (its aggregate and its `rounds`) for each Team's current Run into the shared selector's input (the Teams page and the Overview both read the same field, so their counts agree), refreshed on `finding/changed`; a test starts from a fresh cache and shows a Team with an unposted review as Needs you only once that read has answered, never before, and never as a guess.
- [ ] A pure `lib/review-publication.ts` mapping the desk's words to the chip and tone, exactly as the spec's table: `posted` is **Posted to #n** (neutral), `pending` or a posting `prepared`/`started` is **Waiting to post** (neutral), `partial` is **Partly posted** (warning), `uncertain` is **Not confirmed** (warning), `local` or a round in the backfill list is **Not posted** (warning) when a pull request is bound and posting is on, otherwise **Kept on the desk** (neutral); no findings, no chip. Tested on every row of the table.
- [ ] Two sources, kept apart. The Run's state is `finding/run`'s `publication` (an aggregate of every posting the Run holds, not one round's): show it once, on the Run strip and header, the end banner and the Findings summary. A round's state is `FindingRunView.rounds` on the same call (`{ round, state, reason, pr, cards }`, landed in #1285): show it on that round's review row. A round whose `state` is `none`, or that the list does not carry, shows no chip; never read a round from the Run's aggregate, and never guess. `finding/publications` stays the read behind the doors (post again, skip, backfill). Refresh on `finding/changed`, which the host now also sends after new reviews and after the posting state is saved.
- [ ] On a review's timeline row: the chip. In the inspector's Review section: the reason (`FindingRunView.reason`, an item's `reason`, or the publications view's `backfillRefusal`), **Copy review** (always works), and **Post to pull request**, enabled only when `finding/publications` offers an item to post again or a backfill, calling `finding/publish` with that action, with a title that says what it does ("Posts this review to pull request #n as you. Nothing else changes.").
- [ ] Reuse what `FindingPublications.tsx` already does for the call and its refusals; extract the shared piece rather than writing a second.
- [ ] Refresh on the `finding/changed` notification.
- [ ] The desk never posts on its own; no new automatic behaviour.

**Depends on.** PR 3 and PR 4 (the timeline rows and the inspector's Review section). It also adds the unposted-review rule to the Team's state (PRs 2 and 12 show it once this lands).

**Not in this PR.** Posting a handoff's text when no review candidate exists (#1265, a host change), and the `review.changed` event (the other session's, landed in #1285).

**Verify.** A test per row of the mapping table; a test that a round the list does not carry, or whose `state` is `none`, gets no chip even when the Run says `posted`; component tests for posted, pending, partial, uncertain, local with and without a bound pull request, and no findings; the button is disabled with the reason when nothing can be posted; frames (light, dark).

**Done when.** The #1248 case reads as "Not posted, here is why, here is the button", on the Run.

---

## PR 8 — Answer and approve from the Overview, abandon from the inspector

**Goal.** The Needs-you rows carry their buttons, and a card's inspector can abandon it.

**Read first.** Spec: the controls table (Answer a card, Abandon a card, Approve and Deny); `TeamBoardPane.tsx` (the board's referee verb), `components/Approvals.tsx`; `store` methods behind `team/intent` and `approval/respond`.

**Scope.**
- [ ] A step addressed to a person: the outcome buttons its role declares, an optional note, and a line that says what the answer will do. Calls `team/intent` (`done`).
- [ ] A tool approval or a seat's question: Allow once, Deny (and the existing approval's other choices), calling `approval/respond`. The existing docked approval stays; this is a second door to the same answer, and the first to answer wins as it does today.
- [ ] **Abandon a card** (in the card's inspector, PR 4): a confirm dialog that says first that the rule after the card's role still fires, with *Stop the run instead* present only once PR 10 exists.
- [ ] Every button reads `{ available, why }`-shaped data when the host provides it; until it does, disable with the refusal text the existing calls already return.

**Depends on.** PR 2 (the Needs-you rows) and PR 4 (the inspector, where Abandon lives).

**Not in this PR.** Anything for outside clients (the clients design's tiers).

**Verify.** Component tests per button; a test that answering from the Overview and from the board are the same call; frames of the abandon dialog.

**Done when.** A person can answer a step and a tool request from the Overview's Needs-you rows, and abandon a card from its inspector, each with the consequence said first.

---

## PR 9 — Run a check again from the timeline

**Goal.** A finished check can be run again from its row, with consent.

**Read first.** Spec: the controls table (Run the check again…); `FlowRunStatus.tsx` (`RetryCheck` and its dialog); `store.previewFlowRetry` and `retryFlowCheck`; #1245 and its fix (#1263: read its description; once it has merged, `packages/server/test/flow-run-check.test.ts` holds "the real wire retry returns at launch, stays busy through downstream settlement and preserves both outputs", and its regression files include `flow-checks.test.ts` and `evidence-run.test.ts`). `FlowOperation` has no attempt or output fields and `evidence/board` returns only the latest fact per card, so this PR adds the read of earlier attempts..

**Scope.**
- [ ] Extract `RetryCheck` from `FlowRunStatus.tsx` so the timeline row, the check inspector and the existing stalled-run action share it.
- [ ] **The read of attempts.** #1263 keeps each attempt's output as durable evidence on the card, not as a second operation record, and today's reads return only the latest. Add the smallest additive read that lists a check's attempts (state, outcome, time, output tail) for a card, validated and declared in the usual three edits, and put it behind the timeline's Attempts rows and the inspector's Attempts section (PRs 3 and 4 draw one attempt until it exists).
- [ ] A check row and its inspector offer **Run again…** while the Run is running or stalled; the dialog shows the command verbatim; a new attempt appears under the card; the earlier attempt and its output are unchanged. Add the frame "a check with two attempts".
- [ ] The control is disabled with the host's reason when the host refuses. On a stopped or settled Run the host refuses and says to start a new Run; show that reason and the **Run again…** of PR 11 beside it, not a second path.

**Depends on.** PR 3 (the timeline) and PR 4 (the inspector). #1263, which makes it so that a finished or interrupted check can run again with fresh consent and the call returns when the check has started, has merged.

**Not in this PR.** Stopping a Run (PR 10); starting a new Run (PR 11); any change to how the host runs a check.

**Verify.** Component tests (attempt appears, earlier attempt kept, refusal shown on a settled Run); frames.

**Done when.** A finished check on a running or stalled Run can be run again from its row and its first attempt is still there; on a settled Run the control says why it cannot and points to *Run again…*.

---

## PR 10 — Stop a run

**Goal.** One Run can be stopped from the Run itself.

**Read first.** Spec: the controls table (Stop run…) and the `dialog-stop` frame; #1247; the Wire client and CLI session's `flow/execution/stop`.

**Scope.**
- [ ] **Stop run…** in the Run header and the Overview strip, shown while the Run is running. The dialog lists each seat and says "stops now", or, for a runtime without `capabilities.interrupt`, "stops when its current turn ends". Calls `flow/execution/stop { run, reason }`.
- [ ] Afterwards the Run reads *Stopped*, neutral, by the person.
- [ ] The abandon dialog (PR 8) gains *Stop the run instead*.

**Depends on.** PR 2 (the Overview strip), PR 3 (the Run header) and PR 8 (the abandon dialog it adds a door to), and the stop method from the clients design's implementation.

**Not in this PR.** Pause and resume; changing a card, a finding or a branch; a stop for any outside client (the clients design owns the method).

**Verify.** Fake-agent rig: start a Flow, stop it, assert no rule fired and the seats were interrupted; component tests for the dialog's seat lines; frames.

**Done when.** #1247's four-step workaround is one button.

---

## PR 11 — The end of a Run, and Run again

**Goal.** An ended Run says why and always offers a way on.

**Read first.** Spec: "Why a Run ended, and the doors", "Attempts and lineage", the `run-settled` frame; PR 5's `end`.

**Scope.**
- [ ] The end banner by `end.kind`, with the doors from the spec's table. An unrouted outcome, a stalled Run and a spent budget make the Run and the Team **Needs you**.
- [ ] **Run again…**: opens the existing start preview with the earlier Run's flow, inputs and brief filled in and the seats open to change; starts a new Run on the same Team with `continues` set. The Run switcher beside the Run's name lists both Runs. This is a fresh start, not a resumption in the middle of a round.
- [ ] The revision button in the header shows the Flow's name and digest; it opens the Flow tab once PR 13 exists.

**Depends on.** PR 3, PR 4, PR 5 (`end`, `continues`, `brief`) and PR 6 (the Brief field it prefills).

**Not in this PR.** Resuming a Run at a chosen round (a later phase); stopping a Run (PR 10); anything in the Flow tab beyond the revision button.

**Verify.** Component tests for each `end.kind`; the fake rig runs a Flow to each ending and asserts the doors; frames.

**Done when.** Every ending in the spec's table has its banner and at least one door.

---

## PR 12 — The Teams page

**Status.** Merged as #1293; this section is kept as the record of what it was asked to do.

**Goal.** One page lists every Team on the desk by who needs attention first.

**Read first.** Spec: "The Teams page" and its frame; `components/AgentsWindow.tsx` and the left menu (`Sidebar.tsx`, `SessionTree.tsx`); PR 1's selectors.

**Scope.**
- [ ] `packages/ui/src/lib/teams-list.ts` (pure): group by project, order by precedence then time in state, the three filters with counts, the **Ready to wrap** group (settled, nothing waiting).
- [ ] The page, built like the Agents page, and its entry in the left menu.
- [ ] A row: the Team's sentence, its seats as a stack of faces, one state chip, `time · cost`, and one earned second line (the round and who, or what it waits on). A dot before the sentence means something changed since you last looked.
- [ ] The sidebar lists only Teams that are active or need you.
- [ ] **Hide** a settled Team until it changes, stored on this machine; never a delete.

**Depends on.** PR 1, and PR 2 for `SessionTree.tsx` (one at a time).

**Not in this PR.** The Overview (PR 2) and the Run view (PR 3); deleting a Team; any change to what Wrap does.

**Verify.** Selector tests; component tests; `e2e/ui-system/teams-page.spec.ts` for order, folding and narrow width; frames.

**Done when.** Five Teams on one desk read at a glance, and settled ones no longer hide the active ones.

---

## PR 13 — `FlowGraph` and the Flow tab (read-only)

**Goal.** The Flow a Run started with, drawn to be looked at.

**Read first.** Spec: "The Flow view" (every bullet of "How it is drawn"), the frames `flow-blueprint`, `flow-overlay` and `flow-hero`, and `flow-alt-track` (the look the owner set aside: take its bold traveled route and solid check badges, not its layout); `components/ShapeGraph.tsx` and `lib/shapes.ts` (the editor's graph, left as it is); `docs/design.md` § "Shapes say what a mark is".

**Scope.**
- [ ] `packages/ui/src/lib/flow-layout.ts` (pure): steps left to right in the order their rules reach them, loops below the main line, a Flow's own `layout.positions` winning; edge geometry derived from the node boxes.
- [ ] `packages/ui/src/design/patterns/FlowGraph.tsx`: cards (a mark for the kind, a one-word name, one earned line), edges with arrowheads and the outcome word above them, a loop as a curved edge with a retry mark, a fanned pair of cards for a step that opens several seats, a faint dot grid. Agents are square tiles; checks and people have their own tint, the ones the rail already uses. Every value a token. The curves and arrowheads are data geometry: record them as such in the design audit's list, not as an exception.
- [ ] The accessible list of steps and rules under the drawing; below a narrow width the list is the view.
- [ ] The **Flow** half of the Run header's switch and *Open the file* (`flow/source`).
- [ ] A catalogue board with a straight Flow, a loop, a fan-out, a person step, a Flow with positions, a long Flow, dark.

**Depends on.** PR 3 (the Run tab it sits beside).

**Not in this PR.** The Run's state on the graph (PR 14), changing `ShapeGraph`.

**Verify.** Layout tests (columns, loops below, positions win, a rule to a missing role is skipped); a component test for the list; `e2e/ui-system/flow-graph.spec.ts` (no overlap of labels and cards, narrow fallback); frames against the spec's.

**Done when.** The drawing matches the spec's blueprint frame in both themes.

---

## PR 14 — The Run's state on the Flow

**Goal.** The blueprint says where the Run is.

**Read first.** Spec: "Phase 2: the Run's state laid over it" and the `flow-overlay` frame; PR 13's `FlowGraph`; `FlowRoundState`, `FlowOperation`.

**Scope.**
- [ ] Done steps: a filled check badge, how long, how many times; the traveled route bold in the accent with a soft glow; the current step: a ring, a halo, *Working*, the doing line beneath, a baton on the edge that brought the work there; steps not reached: dashed and quieter; a person's step that waits: the warning ring and *Needs you*; a loop edge's count.
- [ ] Motion: the baton and the ring breathe; both stop under reduced motion (`prefers-reduced-motion`); none in the blueprint.
- [ ] Selecting a step selects its rows in the timeline, and the other way round.
- [ ] A layout for Flows with no positions better than a single column, if PR 13's is not enough. If it needs a library, its licence must be compatible with Apache-2.0; say so in the PR.

**Depends on.** PR 13 (`FlowGraph`), PR 3 (the timeline rows it selects with) and PR 9 (the read of earlier check attempts: a check's run count on the overlay comes from it; a loop's count comes from the Run's rounds).

**Not in this PR.** Any control; the poster (PR 15); a change to the blueprint's own drawing.

**Verify.** Tests that derive node and edge state from scripted `FlowExecution` records (a loop, a check run twice, a waiting person step); a browser rule that reduced motion stops the animation; frames.

**Done when.** The overlay matches the spec's frame, and a Run on the rig draws correctly at each round.

---

## PR 15 — The poster and the site demo (optional)

**Goal.** The same drawing, large, for the site and the changelog.

**Read first.** Spec: "The poster" and the `flow-hero` frame; `packages/ui/site-demo/` (its fake host and demo wire).

**Scope.** A demo scene that renders the real `FlowGraph` from fixture data, a poster layout (the graph alone, the Run as one proportional bar beneath), and a script that renders the poster frames for light and dark. No second drawing.

**Depends on.** PR 14 (the Run's state on the Flow), so the poster draws the real overlay.

**Not in this PR.** A second drawing, any change to `FlowGraph`, any new Run fixture beyond placeholder data.

**Verify.** The demo builds (`vite.site-demo.config.ts`); the frames contain only the demo persona (rule 13).

**Done when.** The site demo and the changelog can show the poster for light and dark, drawn by the real `FlowGraph`.

---

## PR 16 — Read from the shared client selectors

**Goal.** The window and the command line derive the same views from the same code.

**Read first.** Spec: "Sharing the clients design's event stream"; the other session's spec and its event table; this plan's section "Coordination with the Wire client and CLI session"; `packages/client/src/views/` (`team-overview.ts`, `team-overview-of.ts` with `teamOverviewOf(snapshot, team, { report, runtimes, sentences? })`, `snapshot.ts`), `packages/ui/src/lib/run-timeline.ts` and `review-publication.ts` (once PR 3 and PR 7 have landed), and the command line's `status` in `packages/cli/src/cli.ts`.

**Depends on.** PR 3 (the timeline selector this PR moves) and PR 7 (`review-publication.ts`, which defines the chips it maps round states to). The Wire client and CLI session's PR 1c has merged (#1295): the overview model and `teamOverviewOf` are in `@harnessdesk/client/views`, the window's `team-overview.ts` is a re-export, `insight/goal` is in the read tier, `Client.snapshot()` and `Client.synced()` exist, `client/subscribe` returns `{ baseline }`, and `status` renders the overview. Its PR 1b (#1285) has merged too: `seat/activity`, `FindingRunView.rounds`, the tool lookup in `packages/protocol`.

**Scope.**
- [ ] Move the Run timeline selector (PR 3) into `packages/client/src/views/` the same way #1295 moved the overview model: the file, its tests in `packages/client/test/views`, and a re-export left in the UI. The command line gets a `run show` over it: the Wire client and CLI session owns the command line, so this PR adds `run show` there as a thin command over the moved selector, and says so in its PR body.
- [ ] Feed the window's overview and timeline from the client core's snapshot instead of the store snapshot, adapting the store to the stream's state shape (`ClientSnapshot`); delete the window-only derivations once they are identical. `run.startedAt` stays caller-supplied and `SeatRow` stays open to new fields.
- [ ] Read `seat/activity` (`state`, and `doing` as `{ kind: 'tool', tool, target? }` or `{ kind: 'thinking' }`, null unless working) through `TeamOverviewSeat.activity` where the window has no session of its own, rendering it with `doingSentence` from `packages/protocol`; map its `seat` (`runtime:sessionId`) to the window's Seat ids through the Seat's session pointer. Map the desk's round states to the chips PR 7 defines.
- [ ] Replay one scripted stream through the window and through the command line's `status` and `run show`, and assert they agree.

**Not in this PR.** New views or controls; any change to the stream's shapes (those belong to the other session's PRs); any command-line surface other than `run show`.

**Verify.** The replay test; the existing component and browser specs unchanged; `pnpm verify`.

**Done when.** The window's Overview and Run timeline derive from the shared selectors, the command line's `status` and `run show` and the window agree on the replay, and the window-only derivations are gone.

---

## PR 17 — A finished Seat's process rests

**Status.** Merged as #1283 (`Refs #1278`; the host constant is `SEAT_REST_MS`, ten minutes, overridable by the `seatRestMs` option); this section is kept as the record of what it was asked to do.

**Goal.** A Team that has written and reviewed stops holding its agents' processes open. The Seat stays listed and reachable; only its process goes (the owner's decision on #1278).

**Read first.**
- Spec: "The Team overview" (the bullets on a finished Seat), "What we have today" (the bullet on a finished Seat keeping its runtime's process), and host change 8.
- `packages/server/src/host.ts`: `IDLE_STOP_MS`, `#startIdleReaper`, `#reapIdleRuntime`, `#runtimeIsIdle` (today its last clause counts any Seat that is not closed, and an earlier one counts any live conversation, as work), `#withRuntimeActivity`, and `#teamLive` / `#liveFor` (how a detached member is reopened by the next delivery); `packages/server/src/registry.ts` (`detached`, `detachAll`).
- `packages/protocol/src/goal.ts` (`membersOf`: an open Seat is a member), `packages/server/src/goals/wrap.ts` (`closeSeats`; wrap and deleting a conversation, `session/delete`, are what close a Seat's record), `packages/server/src/goals/members.ts`.
- `packages/adapter-acp/src/runtime.ts` (`stopForIdle`: it refuses while the adapter's own session map holds any session besides its probe), `packages/protocol/src/runtime.ts` (`stopForIdle?` is optional on `AgentRuntime`; `AgentSession.close()`; `resumeSession`; `capabilities.resume`), and `packages/server/src/methods/sessions.ts` (`session/close` closes the live handle, sets `live` to null and leaves `detached` false and the Seat open: this PR follows that path; `session/delete` closes the Seat's record, and this PR must not).
- `packages/server/test/idle-runtime.test.ts` (the existing idle-stop tests; extend them) and the ACP adapter's tests with its scripted fake peer.

**Scope.**
- [ ] **Measure first, in the PR body.** On the fake-agent rig, run a Flow to its end and show that its runtimes' processes are still up after `idleStopMs`, and name the clause that holds them (the live handle, the open Seat, or both).
- [ ] A rule, in one named function and with one named constant (`SEAT_REST_MS`, defaulting to `IDLE_STOP_MS`, overridable by an option as `idleStopMs` is): a Seat is *resting* when every card it held is done and none is open or claimed, it has no turn running, no approval open, no queued message and no running task, and it has been so for `SEAT_REST_MS`.
- [ ] Only a runtime that can come back and can stop takes part: `capabilities.resume` is true and the adapter implements `stopForIdle` (today the ACP adapter alone; it is optional on `AgentRuntime`). Every other runtime keeps its process and is unchanged, and the PR body and `docs/` say so.
- [ ] A resting Seat's conversation is released the way `session/close` releases it: the session's own `close()`, then `live = null` with `detached` left false (the handle was let go on purpose, not lost to a restart), and never the path that closes the Seat's record. Confirm in the adapter that after `close()` its session map no longer holds the id, so `stopForIdle` is not refused, and that the agent's own history is untouched (rule 3); if either is not true, the PR adds the smallest adapter change that makes it so. `#runtimeIsIdle` then stops counting a resting Seat as work, so the existing reaper can stop the runtime. The Seat record is not closed: it stays a member (`membersOf`), so every list still shows it, and the next thing addressed to it reopens it.
- [ ] Reconnect on demand: a message to the Seat, opening its conversation, or the engine handing it a card goes through the existing reopen path (`#ensureStarted`, then `resumeSession`), with the conversation's own context (the agent owns its history; rule 3). A reopen that fails says so in the agent's words, as a detached member's does today.
- [ ] No wire or protocol change, no UI. What the window shows (Done, folded) comes from the Seat's cards and is the same with or without a process.

**Depends on.** None (#1263, which also changed `host.ts`, has merged).

**Not in this PR.** Closing a Seat (wrap and a person still own that); deleting anything; any change to a card, a round or a rule; a state for "stopped" shown to the person; the Overview (PR 2).

**Verify.**
- [ ] Unit tests with a fake runtime and a short `idleStopMs`: after a Flow's last card is done and the rest time passes, the runtime's idle stop runs and the Seat is still in `membersOf`.
- [ ] A Seat with a running turn, an open approval, a queued message or a running task never rests; a Seat holding an open card never rests.
- [ ] A message to a resting Seat reopens it with its prior context and answers; a card handed to it reopens it; a refusal is surfaced and does not close the Seat.
- [ ] A runtime shared by a resting Seat and a working one is not stopped.
- [ ] Adapter level, with the ACP adapter's scripted fake peer: after a session is released with `close()`, `stopForIdle` returns true; `resumeSession` brings back the same conversation with its history. A runtime without `resume` or without `stopForIdle` is never asked to rest a Seat.
- [ ] `pnpm verify`; and on the rig, the finished Team's processes are gone after the rest time while its Agents list is unchanged.

**Done when.** After the rest time a finished Team holds no agent process, every list still shows its Seats, and a follow-up message to a finished reviewer is answered in the same conversation.

---

## PR 18 — A wrapped Team reads as a record

**Goal.** After Wrap, a Team's Seats, conversations and Run timeline stay viewable and nothing more is dispatched (the owner's decision on #1278).

**Read first.**
- Spec: "The Team overview" (the bullets on a finished Seat), "The controls" (what happens after a Team is wrapped), host change 9.
- `packages/protocol/src/goal.ts`: `GoalReceipt`, `GoalReceiptMember` (a Seat id, the Agent's name and the label, with no session pointer), `GoalReceiptEvidenceSeat`, the receipt's `answers[].session` (present only for a Seat that answered), and `membersOf` (answers `[]` for a wrapped Goal).
- `packages/server/src/goals/wrap.ts` and `goals/plane.ts` (where `GoalReceipt['members']` is filled and the Seats are closed), `goals/store.ts` (the receipt's validator).
- `packages/ui/src/lib/team-seats.ts` (PR 2), and the wrapped group in `SessionTree.tsx` (`snapshot.goals.get(room.id)?.goal.state === 'wrapped'`).

**Scope.**
- [ ] **Measure first, in the PR body.** For a Team wrapped on the rig: what the older member list still holds, what the receipt's members and answers give, which of its Seats' conversations the window can open, and whether `flow/execution` still answers for the wrapped Goal's Run (PR 3's timeline depends on it).
- [ ] Host and protocol, additive: `GoalReceiptMember.session?: SeatRecord['session']`, written at wrap from the Seat's own record, validated in the receipt's validator. A receipt wrapped earlier falls back to the `answers[].session` of a Seat that answered, and otherwise lists the Seat without a link ("conversation not kept").
- [ ] `team-seats.ts` reads a wrapped Team's seats from the receipt's members and their sessions; the rail, the Overview and the sidebar's wrapped group show them and open their conversations.
- [ ] One helper, `lib/team-record.ts` (`isRecord(team)`), and every verb that dispatches (add an agent, assign, answer, abandon, stop, run again, post, run a check again, and a message sent in a Seat's conversation: send, steer and queued sends) disabled with "This Team is wrapped", or absent where it can never apply. In a wrapped Seat's conversation the composer is disabled with that reason. The Overview, the Run view, the inspector and the conversations stay readable. If PRs 8 to 11 land after this one, each uses the helper and adds its own wrapped-state test; if before, this PR adds theirs.
- [ ] The host refuses too, so no client can: `turn/send`, `turn/steer` and the queued-send path refuse a session that is a Seat of a wrapped Goal, with "This Team is wrapped" (spec host change 10). Today `turn/send` reaches the session without asking.
- [ ] Deleting a Team stays its own action, and deleted items go to the Trash; nothing here deletes.

**Depends on.** PR 2 (the one list of seats) and PR 3 (the timeline). PR 12 (the sidebar tree it also edits) has merged.

**Not in this PR.** Unwrapping; changing what Wrap does (it still closes the Seats); deleting; a Seat's process resting (PR 17).

**Verify.**
- [ ] Host tests: a receipt written at wrap carries each Seat's session; one without it still reads.
- [ ] `team-seats.test.ts`: a wrapped Flow-opened Seat resolves to its conversation, and one that cannot resolve is listed without a link rather than dropped.
- [ ] Component tests: the rail and the sidebar's wrapped group list the Seats and open their conversations; no dispatching verb is enabled; the composer in a wrapped Seat's conversation is disabled; the timeline opens.
- [ ] Host test: `turn/send`, `turn/steer` and a queued send into a wrapped Goal's Seat are refused, and the same calls into an unwrapped Team's Seat are not.

**Done when.** A wrapped Team on the rig can be read end to end (who did what, in which conversation, and how the Run went) and nothing in it can dispatch work.

---

## After this plan

- `docs/decisions.md` gets its entry with the first code PR (it states what the code does).
- **Side by side** does not need a tab of its own (owner, 2026-10-02). Once the Overview exists, the seats table is the place to pick seats and open them side by side; revisit it then. It is not changed by any PR above.
- Resuming a Run at a chosen round, two Runs side by side, and cost per seat as a meter are the spec's phase 2 and are not planned here.
