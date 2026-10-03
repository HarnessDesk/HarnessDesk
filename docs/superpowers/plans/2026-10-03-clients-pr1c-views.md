# PR 1c of the clients design: one set of view selectors, and `status` from them

This brief is the plan. Your **first commit** adds it unchanged as `docs/superpowers/plans/2026-10-03-clients-pr1c-views.md`, so the reviewers read the code against it.

## Read first

- `docs/superpowers/specs/2026-10-02-clients-outside-the-window-design.md`: "The event stream" and its rule "One set of view selectors", and phases 1b and 1c.
- `docs/superpowers/plans/2026-10-03-clients-pr1b-team-activity.md`, and what landed for it in #1285:
  - `seat/activity` and `SeatActivity`;
  - `seatDoing`/`doingSentence` in `packages/protocol/src/tool-activity.ts`;
  - `FindingRunView.rounds`.
- `docs/superpowers/plans/2026-10-02-teams-runs-view.md`:
  - "Coordination with the "Wire client and CLI" session";
  - its PR 1, which wrote the overview model;
  - its PR 16, which will read from what this PR builds.
- `packages/ui/src/lib/team-overview.ts` and its test: the model this PR moves.
- `packages/client/src/index.ts`, `packages/cli/src/cli.ts`, `packages/server/src/client-door.ts` and `script/check-layering.mjs`.

## What this PR adds

**The selectors move to one place.**
- The Team overview model moves into `@harnessdesk/client/views`, a new entry of the client package. It holds pure functions over plain data, with no transport.
- The window keeps its imports through a re-export, and imports nothing else from the client package.
- The model also accepts a seat's host-derived activity in place of its whole conversation, so an outside client gets the same rows.

**`harnessdesk status` uses them.** It prints each Team's overview from the same selector the window uses: the run strip, what needs a person, and a row per seat.
- To do that, the library can say when a subscription's starting state has fully arrived.
- `insight/goal` joins the read tier, so `status` can show cost.

**Not in this PR:**
- The run timeline selector. The view plan's PR 3 writes it in the UI; it moves into `views` later, the same way.
- Starting a flow (PR 2) and stopping one (PR 3).
- Any visible change in the window.

## Global constraints

The same as PR 1 and PR 1b:
- **A wire method is three edits,** in order: `wire.ts`, `wire-validators.ts`, then `methods/<domain>.ts`.
- **Tests first** where a test makes sense.
- **Run what you change for real.** `TMPDIR=/tmp/hdv pnpm verify`, run unpiped, prints "All checks passed." before you push.
- **Short socket directories:** use `/tmp/hd-door-*`. If this sandbox cannot bind a socket, commit, say so, and list those proofs separately.
- **Rule 13:** identities in tests are `Jane Doe` and `dev@example.com`, with no home paths and no real accounts anywhere.
- **Wording:** no weakness wording about any existing surface. No runtime name in UI text.
- **Commits:** on a board card, use `commit_work`; it adds the desk's co-author credit itself. One commit per task. Never merge.
- **Branch:** work on `client-views`, from a fresh `origin/main`. Push it, then open the pull request with `pr_create`. If it refuses or reads the wrong checkout, say so in the hand-off and stop; whoever runs the Team opens it.

**Two promises to the view plan's session**, which also edits this model (its PR 2 adds a `done` field to `SeatRow`):
- **`SeatRow` stays an open interface.** No test or type may fail because one more field is added: no exact-key snapshot of a row, and no exhaustive `satisfies` over its keys.
- **The caller still supplies `TeamOverviewInput.run.startedAt`.** `FlowExecution` now carries `startedAt` (#1281). This PR may *default* to `execution.startedAt` when the caller passes none, but must not remove the field.

## Task 1. The `views` entry, with the overview model moved into it

1. **Create the entry.** Make `packages/client/src/views/index.ts` and add `"./views"` to `packages/client/package.json`'s `exports`.
   - `views` imports only `@harnessdesk/protocol` and its own files. It never imports the client's core or `node`, and never `ws` or a Node builtin.
2. **Move the model.** Move `packages/ui/src/lib/team-overview.ts` and its test into `packages/client/src/views/`.
   - `packages/ui/src/lib/team-overview.ts` becomes a re-export from `@harnessdesk/client/views`, so no UI import changes.
   - Add `@harnessdesk/client` to `packages/ui/package.json` as a workspace dependency, and resolve it the way the UI resolves `@harnessdesk/protocol` today: typecheck, the Vite build and Vitest.
   - The moved test runs under `node:test` like the rest of the client package. Every case passes unchanged in meaning.
3. **Layering.** In `script/check-layering.mjs`, with a sample-based rule test for each case:
   - the UI may import `@harnessdesk/client/views` and nothing else from the client package;
   - `views` imports only protocol and itself.

## Task 2. The model accepts a seat's activity

1. **Add the field.** `TeamOverviewSeat` gains `activity?: SeatActivity | null`.
2. **Use it only when there is no conversation.** When a seat has no matching session but has an activity:
   - `busy` is `activity.state === 'working'`;
   - the doing line is `doingSentence(activity.doing, sentences)` when `activity.doing` is a tool, and none for `thinking`. A `thinking` seat is working with no tool line, exactly as the window shows it today;
   - a working seat's `since` is `activity.since`, else the card claim's `at`, as today.

   Needs-you still comes from `approvals` and blocked cards, as today. An activity's `waiting` state never adds a second needs-you item.
3. **Parity test.** For a table of scripted seats, the rows built from a session equal the rows built from the activity the host derives from that same session. Use the protocol's `inFlightItem`, `seatDoing` and `isBusy`, as the host does. The cases:
   - idle;
   - working on a read with a path;
   - working on a command;
   - thinking;
   - waiting on an approval;
   - a claimed card with no turn.

## Task 3. The library knows when its state is whole, and shows it as plain data

1. **The subscribe result.** `client/subscribe`'s result changes from `null` to `{ readonly baseline: number }`. The number counts the notifications the door sends right after the acknowledgement as that subscription's starting state.
   - They are already sent contiguously, inside one step of the connection's queue. Keep it that way, and say so in a comment.
   - Change it in `wire.ts` and in `client-door.ts`. No validator change is needed for a result.
   - Extend the door's tests: the acknowledgement's count equals the number of baseline frames that follow, including for a subscription whose starting state reconciled queued changes (PR 1's and PR 1b's rule).
2. **`synced()`.** `Client` gains `synced(): Promise<void>`. It resolves once the current subscription's starting state has fully arrived and applied:
   - after `hello`, and again after every `gap`;
   - including the review-round reads that 1b starts at those points.

   If the connection ends first, it rejects with the stream's error, or resolves when the stream ends cleanly. Test both paths.
3. **`snapshot()`.** `Client` gains `snapshot(): ClientSnapshot`, a plain-data copy of what the library holds:
   - `teams` (`GoalView[]`);
   - `runs` (`FlowExecution[]`);
   - `boards` (`TeamState[]`);
   - `seats` (`SeatActivity[]`);
   - `approvals` (the open `Approval` records the `waiting` topic carries, with their runtime and session);
   - `reviews` (each run's `FindingRoundPublication[]`).

   It holds no functions and no references into the library's own maps. A test proves that mutating a snapshot changes nothing inside the library.

## Task 4. A selector over the client's state

1. **`teamOverviewOf`.** In `views`, add:

   ```ts
   teamOverviewOf(snapshot: ClientSnapshot, team: GoalId, extras: { report: InsightReport | null; runtimes: readonly { id: RuntimeId; name: string; metered: boolean }[]; sentences?: ReadonlyMap<string, string> })
   ```

   It builds a `TeamOverviewInput` from the snapshot and returns `teamOverview(input)`:
   - **seats:** from the Team's `members`;
   - **name:** the window's rule for a seat with no nickname. Read the window's caller and use the same: the Agent's name, else the seat's label;
   - **`session`:** `null`;
   - **`activity`:** from `seats` by `runtime:sessionId`;
   - **`unreadSince`:** `null`, because unread marks belong to the window;
   - **approvals:** those whose session is the seat's;
   - **cards:** from the Team's board;
   - **run:** the Team's newest run, with its `startedAt`;
   - **`signals`:** the board's own held signals if it carries them, otherwise left out;
   - **`runtimeCapabilities`:** from `extras.runtimes`.
2. **Test.** A synthetic snapshot gives the same rows the window's model gives for the equivalent window input.

## Task 5. `client/hello` and the read tier

1. **`client/hello`.** Its `runtimes` items gain `metered: boolean`, the runtime's `capabilities.metered`. The model needs it to decide whether a seat's cost is money or turns.
2. **The read tier.** Add `'insight/goal': 'read'` to `CLIENT_METHODS`. Its caller is `status` (Task 6), so the reachable-methods gate finds it.

## Task 6. `harnessdesk status` from the selector

1. **What it does.** `status [--team <id>] [--json]`:
   - connects, subscribing to `runs`, `cards`, `teams`, `seats` and `waiting` (scoped to `--team` when given);
   - awaits `synced()`;
   - reads `insight/goal` for each Team it will show;
   - prints `teamOverviewOf` for each Team that has an active run, or every Team when `--team` is given.
2. **Header.** Keep today's first lines: the desk's home, its version, and each runtime's health.
3. **Text form.** For each Team:
   - a Team line;
   - the run strip: run, state, round, role, review rounds used of total, and cost;
   - each needs-you item;
   - one line per seat: name, role, card, state, doing, and since as a relative time.

   It prints agent text through the CLI's existing control-character stripping.
4. **`--json`.** Today's keys stay as they are (`hello`, `teams`, `runs`). Add `overviews`, a list of `{ team, overview }` where `overview` is the selector's output unchanged. Document it in the CLI README.
5. **End-to-end test.** On an isolated desk with a synthetic run, `status` and `status --json` show the run strip and a seat row with its doing line. The wire trace shows `client/hello`, one `client/subscribe`, the `insight/goal` reads, and no polling.

## Task 7. Documents

1. **The spec.** Mark phase 1c done in the phasing. In "One set of view selectors", name `teamOverviewOf` and `synced()`, and say that the run timeline joins `views` when the window's PR writes it.
2. **The READMEs.** `packages/client/README.md` covers `views`, `snapshot()` and `synced()`. `packages/cli/README.md` covers `status` and its `--json` shape.
3. **`docs/architecture.md`.** One sentence: the window and every client read a Team through the same selectors in `@harnessdesk/client/views`.

## Done when

- Every task is committed, with tests that ran.
- `pnpm layering` passes.
- `TMPDIR=/tmp/hdv pnpm verify`, run unpiped, prints "All checks passed."
- The built CLI's `status`, run against an isolated desk, prints the overview.
- The window's existing overview tests pass unchanged in meaning.
- The branch is pushed and the PR opened, or the refusal is stated.
- The hand-off lists what ran, what could not run here and why, and every place the code had to differ from this brief, with the reason.
