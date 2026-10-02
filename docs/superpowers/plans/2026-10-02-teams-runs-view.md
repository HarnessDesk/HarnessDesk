# Teams, Flows and Runs view — Implementation Plan

> **For the Lead and for Teams:** each "PR n" below is a brief that stands on
> its own. Copy its section, and "Rules for every PR", into a Team's brief file.
> Steps use checkbox (`- [ ]`) syntax. The design is approved (owner,
> 2026-10-02, decisions 1 to 8 as recommended):
> `docs/superpowers/specs/2026-10-02-teams-flows-runs-view-design.md`. Read its
> sections named in a brief before writing anything.

**Goal:** Show a Team's work and let a person steer it without opening a chat:
a Team overview (who is working, waiting, stuck, expensive), a Run view (a
timeline with an inspector, a way on when a Run ends, and a link to the Flow it
started with), the controls that go with them, and a Flow view drawn to be
looked at, with the Run's live state laid over it later.

**Architecture:** The window derives its views with pure selector modules in
`packages/ui/src/lib/` from the store snapshot it already holds. Their output
shapes are the ones `@harnessdesk/client`'s core selectors will return (the
clients design, #1271), so the later switch (PR 16) changes an input and no
view. Host changes are additive fields on the Run record (PR 5) and the stop and
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
  line. Idle is quiet text, not a chip. No resting state wears a health tone.
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
| 1 | The overview model (pure selectors) | none | **yes** | M |
| 5 | Host: the Run record learns four things | none (coordinate on `flow-execution.ts`) | **yes** | M |
| 6 | The brief field in the start dialog | none | **yes** | S |
| 2 | The Overview in the Team pane | 1 | after 1 | M |
| 12 | The Teams page | 1 | after 1 | M |
| 3 | The Run model and timeline | none; reads PR 5's fields when present | **yes** (after 2 for the shared pane file) | L |
| 4 | The Run inspector | 3 | after 3 | M |
| 7 | Publication state and its doors | 3, 4 | after 4 | M |
| 8 | Answer, abandon and approve from the Overview | 2 | after 2 | M |
| 9 | Run a check again from the timeline | 3, 4; #1263 merged | after those | S |
| 10 | Stop a run | 2 or 3; the stop method from the clients design | when its method exists | S |
| 11 | The end of a Run, and Run again | 3, 4, 5 | after those | M |
| 13 | `FlowGraph` and the Flow tab (read-only) | 3 | after 3 | L |
| 14 | The Run's state on the Flow | 13 | after 13 | L |
| 15 | The poster and the site demo | 14 | optional | S |
| 16 | Read from the shared client selectors | the Wire client and CLI session's stream and core | **waits** | M |

**One Team at a time in `TeamRoomPane.tsx`.** PRs 2, 3, 8 and 10 all touch the
rail or header of `packages/ui/src/components/TeamRoomPane.tsx`, a 2,400-line
file. Land them in that order, and each one starts from a fresh fetch of main.
PRs 1, 5, 6 and 12 touch other files and can run beside them.

**What waits on the event stream.** Only PR 16, and the two events below. Every
other PR reads what the window's store already holds.

## Coordination with the "Wire client and CLI" session

That session owns the clients design (#1271) and its implementation: the client
door, `client/hello`, `client/subscribe`, `flow/executions`,
`flow/execution/stop`, `@harnessdesk/client`, and the stable event vocabulary
(`run.changed`, `card.changed`, `team.changed`, `waiting`, `waiting.cleared`,
`notice`, `gap`, `end`). This plan asks it to add the following to its
implementation, additively within version 1 (the owner approved this, decision
7):

1. **`seat.changed`**

   ```ts
   { type: 'seat.changed', team, seat, role, card: number | null,
     state: 'working' | 'waiting' | 'idle',
     doing: { kind: 'tool' | 'thinking' | 'waiting' | 'idle', tool?: string, target?: string } | null,
     since: string /* ISO */ }
   ```

   At most one per seat every 2.5 seconds. `doing` is structured, and each
   client renders it with the one shared lookup for tool names; it carries a
   tool and at most a path, never a command's text, a URL or an environment
   value.
2. **`review.changed`**

   ```ts
   { type: 'review.changed', team, run, card: number,
     state: 'recorded' | 'posted' | 'not-posted' | 'none',
     reason: string | null, pr: number | null }
   ```

   Derived from the records `finding/publications` already reads.
3. **Optional fields:** `attempt`, `continues` and `revision` on `run.changed`;
   `seat` and `since` on `card.changed`.
4. **Core selectors** in `@harnessdesk/client`: `teamOverview(state)` and
   `runTimeline(state, run)`, returning the shapes PR 1 and PR 3 define here.
   The command line's `status` and `run show` call them.

Which of their PRs unblocks which of ours: `flow/execution/stop` unblocks PR 10;
the stream, the two events and the core selectors unblock PR 16. The window does
not need `flow/executions` (the run list): it already holds its runs in
`snapshot.flowExecutions`.

---

## PR 1 — The overview model

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
  - `needs-you` when a card addressed to a person waits, a question or a tool approval is open, or the seat is blocked by hand (`blockedBy: 'hand'`) with a reason (that reason is `reason`). A stalled run, a run that ended on an outcome no rule follows, and an unposted review make the Team `needs-you`, not a seat (the Team's state is the strip's, PR 2).
  - `unread` comes from the window's own unread marks and never from the host.
  - `working` when a turn runs or the seat holds a claimed card; `idle` otherwise. A card blocked by the graph (`blockedBy: 'graph'`) is idle and says "after #n" in `card`.
  - `cost.unit` is `money` only when the runtime's `capabilities.metered` is true and the report's provenance has a rate; otherwise `turns`. `estimated` follows the report's provenance. When the report is unavailable, `cost` is `null`, never zero.
  - The doing line is a sentence from the latest in-flight tool call through `toolSentence`. A path may appear. A command's text, a URL and an environment value never do.
- [ ] Do not read from a component, the store object or a module-level cache: the input is plain data, so the same function can move to `@harnessdesk/client` (PR 16).

**Not in this PR.** Any component, any wire call, any CSS.

**Verify.**
- [ ] `packages/ui/src/lib/team-overview.test.ts` with at least twelve cases: each state, a tie, blocked by hand and by graph, no run, a stalled run, metered and not, the report unavailable, the doing hold.
- [ ] Red first for the precedence and for the no-command rule: change the order, or let `shellCommandOf`'s output through, and watch each test fail.
- [ ] `pnpm exec vitest run src/lib/team-overview.test.ts` (from `packages/ui`) and `pnpm verify`.

**Done when.** The tests pass, and the module's exported shapes are written in the file's header comment as the contract PR 16 will hold the client library to.

---

## PR 2 — The Overview in the Team pane

**Goal.** A new first item in the Team's rail, **Overview**, shows the Run strip, what needs the person, and the seats table.

**Read first.**
- Spec: "The Team overview", and the frames `team-overview` and `overview-narrow` (links in the spec's frames section).
- `packages/ui/src/components/TeamRoomPane.tsx` (the rail rows, the header chip, the pane's default view) and `TeamRoomPane.test.tsx`.
- `packages/ui/src/design/ui/table.tsx`, `list-row.tsx`, `packages/ui/src/design/patterns/Settings.tsx` (`Chip`, `Text`), `patterns/InspectorPanel.tsx`.
- PR 1's `team-overview.ts`.

**Scope.**
- [ ] `packages/ui/src/components/TeamOverview.tsx`: the Run strip (name, round and role, started, review budget, total as "$1.43 · 96 turns", no actions yet), the **Needs you** list (rows render; their buttons arrive with PR 8), and the seats table (seat face and name, role, card, round, state chip, doing line, time in state, cost). Idle is plain muted text. The cost cell shows the unit it has, and its title says why ("This account is not metered, so turns are counted").
- [ ] Narrow width (the pane's own narrow rule): a seat is one `ListRow`: face, name and state chip on the title's line, the doing line beneath, the cost at the end.
- [ ] `TeamRoomPane.tsx`: **Overview** as the rail's first item, the default when a Flow run exists on the Team (a Team without one still opens on Chat). The header chip's existing rule is unchanged.
- [ ] A Team with no run: the strip is absent; the table still lists the seats (state, card, time).
- [ ] Catalogue boards and preview frames for: running, needs-you, unread, idle, a stalled run, no run, no seats, narrow, dark.
- [ ] `docs/design.md`: one short section, "The Team overview".

**Not in this PR.** Buttons on the Needs-you rows (PR 8), *Open run* (PR 3), *Stop run…* (PR 10), any wire call.

**Verify.**
- [ ] Component tests: precedence order on screen, the cost title, a seat whose row has no card.
- [ ] `e2e/ui-system/team-overview.spec.ts`: rows sorted by precedence; the doing line truncates with its title; the narrow layout; no resting state computes a health colour; every seat tile is `data-shape="face"`.
- [ ] Frames in the PR body (light and dark, wide and narrow) from the preview harness, placeholder names only.

**Done when.** The Overview matches the spec's frames within the design system's tokens, and `pnpm verify` and the named specs are green.

---

## PR 3 — The Run model and timeline

**Goal.** A **Run** item in the rail opens a read-only timeline of a Run's rounds, cards, checks and findings.

**Read first.**
- Spec: "The Run view" (the header, the timeline table, "Why a Run ended"), the frames `run-timeline` and `run-settled`.
- `packages/protocol/src/flow-policy.ts` (`FlowExecution`, `FlowRoundState`, `FlowOperation`), `packages/protocol/src/team.ts` (`Intent`, the channel entries), `packages/protocol/src/findings.ts`.
- `packages/ui/src/state/store.ts` (`flowExecutions`, `readFlowExecution`); `packages/ui/src/components/FlowRunStatus.tsx`.

**Scope.**
- [ ] `packages/ui/src/lib/run-timeline.ts` (pure): `runTimeline(input): { header; rows }`. Rows: start/brief, round heading, card, check (with its attempts from `operations`), person step, findings, end. Durations come from a card's claim time and `updatedAt`. Fields the host does not yet send (`revision`, `continues`, `brief`, `end`) are optional and their rows or buttons are simply absent until PR 5.
- [ ] `packages/ui/src/components/RunView.tsx`: the **Run** rail item (shown when the Team has a run; the count is the number of runs), the header (Run n, state chip using the app's words, the Flow's name, *Open pull request* when the Team has one), the timeline with a selectable row, and the in-flight row with its doing line (from PR 1's `doingLine`).
- [ ] Selection is a fill (the inspector anatomy's selected row); the selected row id is state the inspector (PR 4) will read.
- [ ] Catalogue boards and frames for: running, settled, stopped, stalled, a check with two attempts, a round with findings, many rounds (scrolling), narrow, dark.

**Not in this PR.** The inspector (PR 4), the Flow tab (PR 13), any control.

**Verify.**
- [ ] `run-timeline.test.ts`: a table-driven test over scripted `FlowExecution` records for each state, a loop that fired twice, a check run again, a run with no findings.
- [ ] `e2e/ui-system/run-view.spec.ts`: ordering, the selected-row fill, narrow width.
- [ ] Frames in the PR body.

**Done when.** A Run on the fake-agent rig is readable end to end without opening a chat.

---

## PR 4 — The Run inspector

**Goal.** Selecting a timeline row shows what happened there, beside it.

**Read first.** Spec: "The inspector" table; `patterns/InspectorPanel.tsx`; `packages/ui/src/lib/sanitize.ts`; PR 3's selection state.

**Scope.**
- [ ] Sections by kind: **a card** (Input, Handoff, Findings, Review, Cost, and *Open the conversation* last), **a check** (the command verbatim, where and under what limit it ran, how its exit mapped, the last lines of its output, Attempts), **a person's step** (the sentence, the outcome buttons the role declares as inert text until PR 8), **the Run** (when nothing is selected: the brief, the Flow and revision, the seats, the base pin, who started it, budgets, cost).
- [ ] A handoff and a finding's text are rendered through `sanitize.ts`.
- [ ] *Open the conversation* uses the existing way a rail seat opens its conversation.
- [ ] A check's output: find where the desk keeps it (the card's evidence record or the Run's check log). If a read method exists, use it; if not, show "Output is not kept for this check" and write the missing read into PR 5's scope as a follow-up issue, with the evidence.
- [ ] At narrow widths the inspector is a pushed detail with a back link, the way Settings drills in.

**Verify.** Component tests for each kind; a test that a handoff containing markup or an escape sequence renders as text; the named Playwright spec extended; frames.

**Done when.** Every row kind in the timeline has an inspector, and nothing in it is copied from a transcript without sanitising.

---

## PR 5 — Host: the Run record learns four things

**Goal.** A Run records what the views need and the host never had to say: the Flow's identity, the Run it continues, its brief, and how it ended.

**Read first.** Spec: "The model, in words", "Why a Run ended, and the doors", "Host changes this needs" items 2 and 4; `packages/protocol/src/flow-policy.ts` (`FlowExecution`); `packages/server/src/flow-execution.ts`, `flow-preview.ts`, `methods/flows.ts`; `docs/flows.md` ("A run holds the flow it started with, frozen").

**Scope.** Additive and optional, so a record saved before this reads as before.
- [ ] `FlowExecution.revision: string | null`: a short digest of the **canonical** parsed document, set when the Run starts and never changed. The same Flow text gives the same digest whatever its formatting.
- [ ] `FlowExecution.continues: string | null`: the Run this one continues, set at the start (used by PR 11).
- [ ] `FlowExecution.brief: string | null`: the `brief` input, frozen with the Run (a Flow that declares no `brief` stores `null`).
- [ ] `FlowExecution.end`: `{ kind: 'complete' } | { kind: 'unrouted'; card: number; outcome: string } | { kind: 'stopped'; by: 'person' | 'desk' } | { kind: 'budget'; which: 'rounds' | 'without-progress'; used: number } | { kind: 'stalled' }`, set when the Run leaves `running`. `reason` keeps its sentence.
- [ ] Declare in `packages/protocol/src/flow-policy.ts`, validate in `wire-validators.ts`, set in `flow-execution.ts`; the compiler refuses a missing edit.
- [ ] `docs/flows.md`: one short section on what a Run records.
- [ ] If PR 4 found a check's output has no read method, add the smallest read here.

**Not in this PR.** `flow/execution/stop` and `flow/executions` (the Wire client and CLI session owns them), any UI.

**Coordinate.** That session edits `flow-execution.ts` for stop. Fetch main before starting and again before the PR, and keep this change to the record's fields and where they are set.

**Verify.** Node tests in `packages/server`: the digest is stable under formatting changes and changes with a rule; `continues` and `brief` round-trip; each `end.kind` is produced by its scenario (complete, an outcome no rule follows, a stop, a budget, a stalled check); a record with none of the fields still loads. `pnpm verify`.

**Done when.** A Run read back through `flow/execution` carries the four fields, and an old record does not break.

---

## PR 6 — The brief field in the start dialog

**Goal.** A long brief has somewhere to go: a text area in the dialog, not the card's title.

**Read first.** Spec: "The brief"; `packages/ui/src/components/FlowStart.tsx` (inputs render as `Field`s), `FlowStart.test.tsx`; `docs/flows.md` (inputs and slots).

**Scope.**
- [ ] When the chosen Flow declares an input named `brief`, the dialog shows a **Brief** text area (paragraphs, a few rows tall, grows) beside the title, with an *Attach a file…* button that reads a text file (a size cap, and a refusal that names the cap) into it.
- [ ] The value goes to the preview and the start as the `brief` variable, through the existing `vars` path.
- [ ] A Flow with no `brief` input shows no field. Other inputs are unchanged.
- [ ] A catalogue case and frames: empty, filled, a very long brief (the area scrolls), the file refused, dark.

**Not in this PR.** Storing the brief on the Run (PR 5) or showing it there (PR 3, PR 4).

**Verify.** Component tests (shown only when declared; file read; cap refusal; the value reaches `previewFlow` as `vars.brief`); frames.

**Done when.** A person can paste three paragraphs and start a Flow whose card title is still its own sentence.

---

## PR 7 — Publication state and its doors

**Goal.** A review that was not posted is visible on the Run, with the reason and a way to post it.

**Read first.** Spec: "A review that was never posted" and the `review-not-posted` frame; `packages/protocol/src/findings.ts` (`FindingPublicationsView`, `FindingPublicationItem`, `FindingPublishAction`); `packages/ui/src/components/FindingPublications.tsx` (the existing post-again, skip and backfill controls); `store.readFindingPublications`.

**Scope.**
- [ ] On a review's timeline row: a chip, **Posted to #n** (neutral) or **Not posted** (warning, because a person acts).
- [ ] In the inspector's Review section: the reason (an item's `reason`, or the view's `backfillRefusal`); **Copy review**, which always works; **Post to pull request**, enabled only when the view offers an item to post again or a backfill, calling `finding/publish` with that action, and with a title that says what it does ("Posts this review to pull request #n as you. Nothing else changes.").
- [ ] Reuse what `FindingPublications.tsx` already does for the call and its refusals; extract the shared piece rather than writing a second.
- [ ] Refresh on the `finding/changed` notification.
- [ ] The desk never posts on its own; no new automatic behaviour.

**Not in this PR.** Posting a handoff's text when no review candidate exists (#1265, a host change).

**Verify.** Component tests for posted, prepared, uncertain, no item and a refusal; the button is disabled with the reason when nothing can be posted; frames (light, dark).

**Done when.** The #1248 case reads as "Not posted, here is why, here is the button", on the Run.

---

## PR 8 — Answer, abandon and approve from the Overview

**Goal.** The Needs-you rows carry their buttons.

**Read first.** Spec: the controls table (Answer a card, Abandon a card, Approve and Deny); `TeamBoardPane.tsx` (the board's referee verb), `components/Approvals.tsx`; `store` methods behind `team/intent` and `approval/respond`.

**Scope.**
- [ ] A step addressed to a person: the outcome buttons its role declares, an optional note, and a line that says what the answer will do. Calls `team/intent` (`done`).
- [ ] A tool approval or a seat's question: Allow once, Deny (and the existing approval's other choices), calling `approval/respond`. The existing docked approval stays; this is a second door to the same answer, and the first to answer wins as it does today.
- [ ] **Abandon a card** (in the card's inspector, PR 4): a confirm dialog that says first that the rule after the card's role still fires, with *Stop the run instead* present only once PR 10 exists.
- [ ] Every button reads `{ available, why }`-shaped data when the host provides it; until it does, disable with the refusal text the existing calls already return.

**Not in this PR.** Anything for outside clients (the clients design's tiers).

**Verify.** Component tests per button; a test that answering from the Overview and from the board are the same call; frames of the abandon dialog.

**Done when.** A person can clear everything that needs them from the Overview.

---

## PR 9 — Run a check again from the timeline

**Goal.** A finished check can be run again from its row, with consent.

**Read first.** Spec: the controls table (Run the check again…); `FlowRunStatus.tsx` (`RetryCheck` and its dialog); `store.previewFlowRetry` and `retryFlowCheck`; #1245 and its fix (#1263).

**Scope.**
- [ ] Extract `RetryCheck` from `FlowRunStatus.tsx` so the timeline row, the check inspector and the existing stalled-run action share it.
- [ ] A check row and its inspector offer **Run again…**; the dialog shows the command verbatim; a new attempt appears under the card; the earlier attempt is unchanged.
- [ ] The control is disabled with the host's reason when the host refuses.

**Depends on.** #1263 merged, so that a finished check can run again and the call returns when the check has started.

**Verify.** Component tests (attempt appears, earlier attempt kept, refusal shown); frames.

**Done when.** The #1245 landing check can be run again from the Run, and its first answer is still there.

---

## PR 10 — Stop a run

**Goal.** One Run can be stopped from the Run itself.

**Read first.** Spec: the controls table (Stop run…) and the `dialog-stop` frame; #1247; the Wire client and CLI session's `flow/execution/stop`.

**Scope.**
- [ ] **Stop run…** in the Run header and the Overview strip, shown while the Run is running. The dialog lists each seat and says "stops now", or, for a runtime without `capabilities.interrupt`, "stops when its current turn ends". Calls `flow/execution/stop { run, reason }`.
- [ ] Afterwards the Run reads *Stopped*, neutral, by the person.
- [ ] The abandon dialog (PR 8) gains *Stop the run instead*.

**Depends on.** The stop method, from the clients design's implementation.

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

**Verify.** Component tests for each `end.kind`; the fake rig runs a Flow to each ending and asserts the doors; frames.

**Done when.** Every ending in the spec's table has its banner and at least one door.

---

## PR 12 — The Teams page

**Goal.** One page lists every Team on the desk by who needs attention first.

**Read first.** Spec: "The Teams page" and its frame; `components/AgentsWindow.tsx` and the left menu (`Sidebar.tsx`, `SessionTree.tsx`); PR 1's selectors.

**Scope.**
- [ ] `packages/ui/src/lib/teams-list.ts` (pure): group by project, order by precedence then time in state, the three filters with counts, the **Ready to wrap** group (settled, nothing waiting).
- [ ] The page, built like the Agents page, and its entry in the left menu.
- [ ] A row: the Team's sentence, its seats as a stack of faces, one state chip, `time · cost`, and one earned second line (the round and who, or what it waits on). A dot before the sentence means something changed since you last looked.
- [ ] The sidebar lists only Teams that are active or need you.
- [ ] **Hide** a settled Team until it changes, stored on this machine; never a delete.

**Verify.** Selector tests; component tests; `e2e/ui-system/teams-page.spec.ts` for order, folding and narrow width; frames.

**Done when.** Five Teams on one desk read at a glance, and settled ones no longer hide the active ones.

---

## PR 13 — `FlowGraph` and the Flow tab (read-only)

**Goal.** The Flow a Run started with, drawn to be looked at.

**Read first.** Spec: "The Flow view" (every bullet of "How it is drawn"), the frames `flow-blueprint`, `flow-overlay` and `flow-hero`, and the considered `flow-alt-track`; `components/ShapeGraph.tsx` and `lib/shapes.ts` (the editor's graph, left as it is); `docs/design.md` § "Shapes say what a mark is".

**Scope.**
- [ ] `packages/ui/src/lib/flow-layout.ts` (pure): steps left to right in the order their rules reach them, loops below the main line, a Flow's own `layout.positions` winning; edge geometry derived from the node boxes.
- [ ] `packages/ui/src/design/patterns/FlowGraph.tsx`: cards (a mark for the kind, a one-word name, one earned line), edges with arrowheads and the outcome word above them, a loop as a curved edge with a retry mark, a fanned pair of cards for a step that opens several seats, a faint dot grid. Agents are square tiles; checks and people have their own tint, the ones the rail already uses. Every value a token. The curves and arrowheads are data geometry: record them as such in the design audit's list, not as an exception.
- [ ] The accessible list of steps and rules under the drawing; below a narrow width the list is the view.
- [ ] The **Flow** half of the Run header's switch and *Open the file* (`flow/source`).
- [ ] A catalogue board with a straight Flow, a loop, a fan-out, a person step, a Flow with positions, a long Flow, dark.

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

**Verify.** Tests that derive node and edge state from scripted `FlowExecution` records (a loop, a check run twice, a waiting person step); a browser rule that reduced motion stops the animation; frames.

**Done when.** The overlay matches the spec's frame, and a Run on the rig draws correctly at each round.

---

## PR 15 — The poster and the site demo (optional)

**Goal.** The same drawing, large, for the site and the changelog.

**Read first.** Spec: "The poster" and the `flow-hero` frame; `packages/ui/site-demo/` (its fake host and demo wire).

**Scope.** A demo scene that renders the real `FlowGraph` from fixture data, a poster layout (the graph alone, the Run as one proportional bar beneath), and a script that renders the poster frames for light and dark. No second drawing.

**Verify.** The demo builds (`vite.site-demo.config.ts`); the frames contain only the demo persona (rule 13).

---

## PR 16 — Read from the shared client selectors

**Goal.** The window and the command line derive the same views from the same code.

**Waits for.** The Wire client and CLI session's stream, `seat.changed`, `review.changed`, and the core selectors `teamOverview` and `runTimeline`, merged.

**Scope.**
- [ ] Feed the window's views from the client core's selectors, adapting the store snapshot to the stream's state shape; delete the window-only derivations PR 1 and PR 3 wrote once they are identical.
- [ ] Consume `seat.changed`'s structured `doing` and render it with the one shared lookup.
- [ ] Replay one scripted stream through the window and through the command line's `status` and `run show`, and assert they agree.

**Verify.** The replay test; the existing component and browser specs unchanged; `pnpm verify`.

---

## After this plan

- `docs/decisions.md` gets its entry with the first code PR (it states what the code does).
- **Side by side** does not need a tab of its own (owner, 2026-10-02). Once the Overview exists, the seats table is the place to pick seats and open them side by side; revisit it then. It is not changed by any PR above.
- Resuming a Run at a chosen round, two Runs side by side, and cost per seat as a meter are the spec's phase 2 and are not planned here.
