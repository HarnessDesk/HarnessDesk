# PR 1b of the clients design: what a Team is doing

This brief is the plan. Your **first commit** adds it unchanged to the repository as `docs/superpowers/plans/2026-10-03-clients-pr1b-team-activity.md`, so the reviewers read the code against it.

**Read first:**
- `docs/superpowers/specs/2026-10-02-clients-outside-the-window-design.md`: "The event stream", its four rules, and phase 1b.
- `docs/superpowers/plans/2026-10-02-clients-pr1-read-only-door.md`: how PR 1 was built. Its global constraints hold here unchanged.
- `docs/superpowers/plans/2026-10-02-teams-runs-view.md`, section "Coordination with the "Wire client and CLI" session". That is what the window's views expect from this PR.
- The PR 1 code that landed in #1279:
  - `packages/protocol/src/client-surface.ts`
  - `packages/server/src/client-door.ts`
  - `packages/client/src/index.ts`
  - `packages/cli/src/cli.ts`
  - their tests.

## What this PR adds

- Two read-only topics on the client door, `seats` and `reviews`.
- The events `seat.changed` and `review.changed`, plus the optional fields the records now carry.
- The derivation of what a seat is doing, moved from the window into `packages/protocol` so the host and every client word it the same way.

The tier stays `read`. No new tier, no method that changes anything, and no visible change in the window.

**Not in this PR.** It goes to PR 1c, next:
- `@harnessdesk/client/views`;
- moving `teamOverview` there;
- `status` reading it;
- `insight/goal` joining the read tier.

PR 1c reads the shape this PR defines, which is why the two are split. Write this sentence into the spec's phasing (Task 6).

## Global constraints

- **A wire method is three edits,** in order: `wire.ts`, then `wire-validators.ts`, then `methods/<domain>.ts`. A handler reaches the host only through `HostContext`.
- **A host notification is declared in `WireNotification`** (`packages/protocol/src/wire.ts`). The window must ignore any notification it has no use for. Prove that with a test: the window's store receives `seat/activity` and nothing in its state changes.
- **Tests come first** where a test makes sense. A fix to a test you wrote first is shown red, then green.
- **Run what you change for real:** the tests, a typecheck, the built CLI against an isolated desk. `TMPDIR=/tmp/hdv pnpm verify`, run unpiped, must end with "All checks passed." before you push. Inspection is not verification.
- **Short socket directories:** use `/tmp/hd-door-*` for sockets. If this sandbox cannot bind a socket:
  - commit anyway;
  - say so in the hand-off;
  - list those proofs separately (CI runs the socket tests on Linux).
- **Rule 13:** identities in tests are `Jane Doe` and `dev@example.com`. No home paths and no real accounts, in code, tests, docs or commit messages.
- **Public wording:** no wording about weaknesses of any existing surface. Name no runtime in UI text (rule 8).
- **Commits:** end every commit message with `Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>`. Small commits, one per task below. Never merge.
- **Branch:** work on a new branch `client-team-activity` from a fresh `origin/main`. Push it, then open the pull request with `pr_create`. If `pr_create` refuses or reads the wrong checkout, say so plainly in your hand-off and stop. Whoever runs the Team opens it.

## Task 1. What a seat is doing, as data, in `packages/protocol`

Today `packages/ui/src/lib/team-overview.ts` (`toolLine`) turns a seat's in-flight item straight into words. It uses three things:
- `packages/ui/src/lib/tool-names.ts` (`toolSentence`, `bareToolName`);
- `PATH_KEYS`, `shellCommandOf` and `toolCallVerb` from `packages/ui/src/lib/group-items.ts`.

Split it into a structural half and a wording half, both in protocol.

1. **Move the tool-name lookup.** Move `packages/ui/src/lib/tool-names.ts` whole into `packages/protocol/src/tool-names.ts` and export it from the protocol index.
   - Leave `packages/ui/src/lib/tool-names.ts` as a re-export, so no UI import changes.
   - Move its tests to protocol. Keep one UI test proving the re-export.
2. **Move the item helpers.** Move `PATH_KEYS`, `shellCommandOf`, `toolCallVerb` and the `ToolCallVerb` type, with any private helper they need, into `packages/protocol/src/tool-activity.ts`. `group-items.ts` re-exports them.
   - Moved code may import only from protocol.
   - Run `pnpm layering` to prove that.
3. **Add to `tool-activity.ts`:**

   ```ts
   export type SeatDoing =
     | { readonly kind: 'tool'; readonly tool: string; readonly target?: string }
     | { readonly kind: 'thinking' }
   export type SeatActivityState = 'working' | 'waiting' | 'idle'
   /** The in-flight item of a session's current turn, the same rule the overview uses today. */
   export function inFlightItem(session: Session): AgentItem | undefined
   /** A tool and at most a path: never a command's text, a URL, a query or an environment value. */
   export function seatDoing(item: AgentItem): SeatDoing
   /** The words a client shows, from the one shared lookup. */
   export function doingSentence(doing: SeatDoing, sentences?: ReadonlyMap<string, string>): string
   ```

   - **`inFlightItem`** is the overview's existing rule: in a turn that is `inProgress`, the newest item whose own status is `inProgress` and whose type is `command`, `toolCall`, `fileChange` or `webSearch`.
   - **`seatDoing`** is `toolLine`'s classification, keeping every refusal it makes today:
     - `command`, or a shell-like tool, becomes `{ kind: 'tool', tool: 'command' }`;
     - `webSearch` becomes `'web_search'`;
     - `fileChange` becomes `'edit'` plus a safe path;
     - read, file-verb and search tools become their verb, plus a safe path where today's code allows one;
     - a tool name that is not a plain identifier becomes `'tool'`.

     `target` is set only when `safePath` accepts it.
   - **`doingSentence`** returns exactly the string `toolLine` returns today for the same item.
4. **Rewrite `toolLine`** in `team-overview.ts` as `doingSentence(seatDoing(item), sentences)`. Every existing `team-overview.test.ts` test must pass unchanged.
5. **Add a table test in protocol** over scripted items. It must cover:
   - a command whose text holds a URL and an environment assignment: the result is `{ kind: 'tool', tool: 'command' }`, with no target;
   - a read with a path;
   - an ACP title such as `Read src/a.ts`;
   - a title that is prose;
   - an MCP tool;
   - a web search whose query must not appear.

   Also prove `doingSentence(seatDoing(item))` equals the old `toolLine` output for every row.

## Task 2. The host derives each seat's activity

1. **Declare the notification** in `WireNotification`:

   ```ts
   | { method: 'seat/activity'; params: SeatActivity }
   ```

   ```ts
   export interface SeatActivity {
     readonly goal: GoalId
     /** `${runtime}:${sessionId}`, the same identity `card.changed.seat` already uses. */
     readonly seat: string
     readonly role: string | null
     readonly card: number | null
     readonly state: SeatActivityState
     readonly doing: SeatDoing | null
     /** Only from a record: never the moment the host happened to notice. */
     readonly since?: number
   }
   ```

2. **Derive each field** for every seat of every Team, from what the host already holds:
   - **Seats:** each Team's members (`SeatRecord`, by `session.runtime` plus `session.sessionId`). The session comes from the host's registry, where it is already reduced; `isBusy` works on it.
   - **`card`:** the Team's active card (not done or abandoned) whose `claim` names this seat's session; otherwise `null`.
   - **`role`:** that card's role, or the seat record's role.
   - **`state`:**
     - `waiting` when an approval or a question is open on the seat's session (the same source as `pendingApprovalEvents()`);
     - otherwise `working` when `isBusy(session)`, or when the card is `claimed`;
     - otherwise `idle`.
   - **`doing`:**
     - `null` unless `working`;
     - while `working`, `seatDoing(inFlightItem(session))` when there is such an item;
     - otherwise `{ kind: 'thinking' }`.
   - **`since`:**
     - `waiting`: the open request's `requestedAt`;
     - `working`: the current turn's `startedAt`, else the card claim's `at`;
     - `idle`: absent.

     If the record does not hold a time, leave `since` out.
3. **When to send.**
   - Recompute a seat after any agent event that changes its session, and after a board change that moves a claim. Recompute only that Team's seats, never every Team on every event.
   - Send only when `state`, `doing`, `card` or `role` changed.
   - Send at most once per seat every 2.5 seconds. The first change goes out at once, and the latest one always goes out when the 2.5 seconds end. A throttle that can drop the final state is a defect.
   - Clear a seat's timer when the seat or the host goes away. Nothing may keep the host process alive.
4. **Baseline accessor.** Add `seatActivities(): readonly SeatActivity[]` to the host, beside `pendingApprovalEvents()`. It returns the current activity of every seat, unthrottled, and the door reads it for baselines. It is not a wire method.
5. **Tests, with a fake clock:**
   - the first change goes out at once;
   - two changes inside the window send only the latest, when the window ends;
   - an unchanged recompute sends nothing;
   - `waiting` beats `working`;
   - the command text never reaches the notification;
   - `since` is left out when no record holds a time;
   - no timer is left after `dispose`.

## Task 3. A round's publication state, from the host

`finding/run`'s `publication` is the whole run's aggregate. `Publications.status(run)` in `packages/server/src/findings/publication.ts` folds every posting into one word and takes no round. A round's state has to come from the publication journal, whose decisions (`PublicationRound`) and postings (`PublicationEntry.round`) are keyed by round. Publication round numbers are the run's round numbers (`FlowRoundState.n`); `status()` already joins them that way.

1. **Add `Publications.rounds(run)`.** For each round of the run that has review records or a publication decision, it returns `{ round, state, reason, pr, cards }`:
   - **`state`:** `none` while the round has no decision yet. Otherwise fold only that round's entries, with exactly `status()`'s rule:
     - no entries: `local`;
     - any `uncertain`: `uncertain`;
     - any `started`, or `prepared` without a reason: `pending`;
     - all `posted`: `posted`;
     - otherwise `partial`.
   - **`reason`:** the first reason among that round's entries that are not yet posted, else the round's own decision reason, else `null`.
   - **`pr`:** the decision's `pr`, or `null`.
   - **`cards`:** `FlowRoundState.cards` for that round.
2. **Expose it** as `FindingRunView.rounds: readonly FindingRoundPublication[]`:
   - declare the type in `packages/protocol/src/findings.ts`;
   - fill it in the `finding/run` handler (`packages/server/src/methods/findings.ts`);
   - change no existing field.
3. **Tests:**
   - a run with two rounds, one posted and one kept local, gives two different states while `publication` still gives the aggregate;
   - an uncertain posting in round 2 leaves round 1's state alone;
   - a round with no decision reads `none`.

## Task 4. The client door: `seats` and `reviews`

1. **Topics.** `ClientTopic` gains `'seats'` and `'reviews'`.
   - In `client-door.ts`, `topicsOf` maps `seat/activity` to `seats` and `finding/changed` to `reviews`.
   - A Team, run or project scope applies to both through the notification's `goal`, as it does for the other topics. A run scope means that run's Team.
2. **Allowlist.** Add `'finding/run': 'read'` to `CLIENT_METHODS`. The library calls it for review rounds (Task 5), so the reachable-methods gate finds a real caller. Add nothing else.
3. **Seats baseline.** A subscription with `seats` sends `host.seatActivities()` in scope as part of its baseline.
   - `seat/activity` is a state snapshot. Add the key `seat:<goal>:<seat>` to `snapshotKey`, so PR 1's rule covers it: a newer state is never followed by an older one, including changes queued behind a replacement subscription. That rule took three review rounds in #1279; extend it, do not fork it.
4. **Reviews baseline.** The door sends nothing for `reviews`. The library reads review rounds itself after `hello` and after every `gap` (Task 5).
5. **Tests over a real socket:**
   - `seats` in and out of scope;
   - the seats baseline;
   - a `seat/activity` that arrives while the baseline is read is delivered once, newest last;
   - `finding/changed` reaches only a client subscribed to `reviews`, in scope.

## Task 5. The library's events

In `packages/client/src/index.ts`:

1. **`seat.changed`.** Emit `{ type: 'seat.changed', team, seat, role, card, state, doing, since? }`, one to one from `seat/activity`, deduplicated by `(team, seat)` over `state`, `doing`, `card` and `role`. `since` is present only when the notification carries it.
2. **`review.changed`.** Emit `{ type: 'review.changed', team, run, round, cards, state, reason, pr }`, one per `(run, round)` whose `state`, `reason`, `pr` or `cards` changed, from `finding/run`'s `rounds`.
   - Read `finding/run` for every run the library knows in scope:
     - after `hello`;
     - after every `gap`;
     - for that Team's runs on each `finding/changed`.
   - Serialize the reads per Team. A read that started later is never applied before one that started earlier. A burst of `finding/changed` for one Team becomes at most one read in flight plus one queued.
   - A read that fails becomes a `notice` with the desk's own message, and the stream goes on. Never retry in a loop.
3. **`run.changed`.** It gains the optional `revision` and `continues`. Each is present only when the record carries a non-null value, and both join the compared values. `attempt` stays out until a record carries it.
4. **`card.changed`.**
   - It gains the optional `since`: the claim's `at` while the card is claimed.
   - `seat` and `since` join the compared values, so a claim that moves is an event.
5. **Topics.** `watch` subscribes to `seats` and `reviews` as well, by default. The CLI prints both event types in its text form and passes them through unchanged in `--json`.
6. **Tests:**
   - the mapping;
   - the deduplication;
   - two `finding/changed` that answer out of order still apply in order;
   - a failed read becomes a `notice`.

   **CLI end-to-end:** on an isolated desk with a synthetic run, `watch --json` shows a `seat.changed` and a `review.changed`. The wire trace still has no polling.

## Task 6. Documents

1. **The spec's event table** (`docs/superpowers/specs/2026-10-02-clients-outside-the-window-design.md`):
   - **`review.changed`'s "From":** "`finding/run`'s `rounds`, each round folded from the run's publication journal; read again on `finding/changed`". It must not say the run's `publication`; that word is the run's aggregate.
   - **`seat.changed`:**
     - `doing` is `{ kind: 'tool', tool, target? }` or `{ kind: 'thinking' }`, or `null` unless working;
     - `seat` is `runtime:sessionId`, as in `card.changed`.
2. **The spec's phasing:** split 1b as this brief says. 1b is the topics and the events; 1c is the `views` entry, `teamOverview` moved there, `status` from it, and `insight/goal` in the read tier.
3. **The two READMEs:** `packages/client/README.md` and `packages/cli/README.md` list the new events and topics.
4. **`docs/architecture.md`:** one sentence on `seat/activity`, saying the host derives it once for every client.

## Done when

- Every task above is committed, with tests that ran.
- `pnpm layering` passes.
- `TMPDIR=/tmp/hdv pnpm verify`, run unpiped, prints "All checks passed."
- The built CLI, run against an isolated desk, shows both new events.
- The branch is pushed and the pull request is opened, or its refusal is stated.
- The hand-off lists:
  - what ran;
  - what could not run here and why;
  - every place where the code had to differ from this brief, with the reason.
