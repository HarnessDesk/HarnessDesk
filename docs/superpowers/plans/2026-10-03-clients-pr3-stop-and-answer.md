# PR 3 of the clients design: stopping a run and answering a person's card

This brief is the plan. Your **first commit** adds it unchanged as `docs/superpowers/plans/2026-10-03-clients-pr3-stop-and-answer.md`, so the reviewers read the code against it.

## Read first

- `docs/superpowers/specs/2026-10-02-clients-outside-the-window-design.md`. Read these parts:
  - "The allowlist and its tiers";
  - "Answers from several clients at once";
  - "Attribution";
  - "Commands": `run stop`, `card show`, `card handoff`, `card answer`, `card abandon` and `waiting`;
  - "Exit codes";
  - "Host changes this needs", items 1 and 3;
  - "Security model";
  - "Decisions" 2 and 3;
  - "Phasing" 3.
- Issue #1247, which is the stop this PR answers.
- The plans of the earlier PRs in this lane, for house style: `docs/superpowers/plans/2026-10-03-clients-pr2-flow-start.md` and the 1b and 1c plans beside it.
- The client door and command line as they stand:
  - `packages/protocol/src/client-surface.ts`;
  - `packages/server/src/client-door.ts`;
  - `packages/client/src/index.ts`;
  - `packages/cli/src/cli.ts`;
  - `packages/cli/README.md`.
- The stop path:
  - `FlowExecutions.stop` in `packages/server/src/flow-execution.ts`;
  - `stopRun` in `packages/server/src/flows.ts`;
  - the old `flow/stop`, which is the room API;
  - how a Goal's wrap stops its runs.
- The card path: `team/intent` with `done` and `abandon`, and `goal/read` with its board and each card's handoff and note.
- `docs/superpowers/plans/2026-10-02-teams-runs-view.md`, its "PR 10 — Stop a run". The window will call the method this PR adds, `flow/execution/stop { run, reason }`. Keep that exact shape.

## What this PR adds

**On the host:**
- **`flow/execution/stop { run, reason }`.** It ends the run's round, interrupts the run's seats, and fires no rule. The run then reads `stopped`, by the person, with the reason. This is #1247.
- **The `answer` tier.** It is off by default, as Decision 2 says. A per-desk setting, "Let command-line clients answer for me", turns it on, and so does an environment switch for scripted desks.
- **First answer wins** on a card that a flow addressed to a person. A second answer is refused with `alreadyAnswered`.
- **Attribution.** A card answered through the door shows on the Team's channel as answered from the command line, not as the window.

**On the door:**
- `flow/execution/stop` joins the surface at `run`.
- `team/intent` joins as follows:
  - `abandon` is at `run`;
  - `done` on a person card is at `answer`;
  - any other `team/intent` action stays off the surface.

  Write the per-action tier as an explicit rule beside `CLIENT_METHODS`, with a test, not as a special case hidden in the handler.

**On the command line:** `run stop`, `card show`, `card handoff`, `card answer`, `card abandon` and `waiting`.

**Not in this PR:**
- the install item and the generated command reference (PR 4);
- the window's *Stop run…* button (the view plan's PR 10);
- answering a tool approval or a question from a client;
- any visible window change other than the one Settings row for the `answer` tier.

## Global constraints

These are the same as PR 1 to PR 2.
- **Wire methods.** A wire method is three edits, made in order: `wire.ts`, then `wire-validators.ts`, then `methods/<domain>.ts`.
- **Testing.** Write tests first where a test makes sense. Run what you change for real: `TMPDIR=/tmp/hdv pnpm verify`, run unpiped, prints "All checks passed." before you push. Use short socket directories under `/tmp/hd-door-*`.
- **Rule 13:** test identities are `Jane Doe` and `dev@example.com`, with no home paths and no real accounts anywhere.
- **Wording:** don't describe any existing surface as weak. No runtime name appears in UI text.
- **Commits and branch.** Every commit message ends with `Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>`. Make one commit per task, and never merge. Work on `client-stop-answer`, from a fresh `origin/main`. Push it, then open the pull request with `pr_create`. If that refuses or reads the wrong checkout, say so in the hand-off and stop.
- **This PR changes tiers and lets a client speak as the person.** It gets the critical review. State every security decision plainly, in code comments and in the PR body.
- **`flow-execution.ts` is shared** with the Teams and Runs view plan. Keep your edits there small and well named. Rebase on a fresh `origin/main` before pushing.
- **The end-to-end test file has shared time limits.** In `packages/cli/test/e2e.test.ts`, use its `LOADED_MACHINE_MS` and `REAL_HOST_TEST_MS` for every new wait and test timeout (#1289). Never write a bare number of seconds there.

## Task 1. `flow/execution/stop`

1. **The method.**
   - Declare `flow/execution/stop { run: string; reason: string }` with result `FlowExecution`.
   - Validate it: the run is a non-empty string, and the reason is a bounded non-empty string.
   - Answer it through the flows plane's existing stop, as the person.
   - Stopping a run that has already ended answers with that run unchanged, never an error. Say so in the method's doc comment.
2. **Its seats are interrupted.**
   - Check that the stop interrupts every seat of the run that is mid-turn, through each runtime's interrupt, and fires no rule. Change it if it does not.
   - A runtime without `capabilities.interrupt` ends its current turn on its own, and the run is already `stopped`, so no rule follows that turn. Test both kinds of runtime.
3. **The tests** reproduce #1247's case: a writer mid-turn, then a stop. Assert:
   - no reviewer card opens;
   - the run reads `stopped` with the reason;
   - the writer's turn was interrupted.

## Task 2. The `answer` tier and its setting

1. **The setting.** A per-desk preference, `clientsMayAnswer`, false by default.
   - It is stored where the desk's other preferences live, and read when each call is made.
   - An environment variable, `HARNESSDESK_CLIENTS_MAY_ANSWER=1`, turns it on for a scripted desk. Document the variable beside the setting.
2. **The Settings row.** One row in the Permissions area: "Let command-line clients answer for me", built with the design system's `Row` and `Switch`. Its `title` says the row also covers any other local client.
   - No `hint` unless rule 9 earns one.
   - Update `docs/interface.md`, and the design catalogue if the row is new there.
3. **The door.**
   - `client/hello`'s `tiers` includes `answer` only while the setting is on.
   - A call at `answer` while it is off is refused with `tierNotGranted`, exit 4.

## Task 3. `team/intent` on the surface, per action

1. **The tiers.** `team/intent` joins with per-action tiers:
   - `abandon` is `run`;
   - `done` is `answer`, and is accepted only on a card whose role the run's flow declares `kind: person`;
   - every other action is refused with `notOnClientSurface`.
2. **First answer wins.**
   - A `done` on a person card that is already done or abandoned is refused with `alreadyAnswered`, and the card is never changed twice.
   - The resolved notification reaches every subscribed client, including the one whose answer lost.
3. **Abandon says what follows.**
   - An abandon through the door returns enough for the command to say that the rule after the card's role still fires.
   - Its answer names the role that will open next, if one will.
4. **Attribution.** A `done` through the door is recorded on the Team's channel as answered from the command line, with the client's stated name. Every call is audited with `via: 'client'`, its tier and its outcome, as today.

## Task 4. The commands

All agent text in human output goes through the CLI's existing control-character stripping.

1. **`run stop <run> --reason "…"`.**
   - A reason is required, and it is never taken from argv beyond the flag's value.
   - Asking to stop is a spend-like action. It needs a terminal confirmation or `--yes`; without either it exits 2.
   - It prints the stopped run.
2. **`card show <team> <card>`.**
   - It prints the card's role, state, outcome, note and handoff, read through `goal/read`.
   - `--json` prints the card unchanged.
3. **`card handoff <team> <card>`.** It prints only the handoff text, for a pipe. A card with no handoff exits 1 with a one-line message.
4. **`card answer <team> <card> <outcome> [--context-file F|-]`.**
   - It answers a person card at the `answer` tier.
   - It is refused, exit 4, on a card not addressed to a person, on an outcome the role does not declare, on `alreadyAnswered`, and while the desk has not granted `answer`. The desk's code is printed in each case.
5. **`card abandon <team> <card> --reason "…" [--yes]`.**
   - Before it abandons, it says that the rule after the role still fires. It names the role that opens next, and it points to `run stop` as the way to end the work.
   - It needs a confirmation or `--yes`.
6. **`waiting`.**
   - It subscribes to `waiting` and awaits `synced()`.
   - It prints everything waiting for a person: person cards, questions and approvals, each with its stable id. It is read-only.
   - `--json` prints one object.
   - `--watch` streams `waiting` and `waiting.cleared` until interrupted.

## Task 5. End-to-end and documents

1. **End-to-end test.** Use the fake-agent rig: an isolated `HARNESSDESK_HOME` and the scripted fake agents. Use the shared time limits. The test covers:
   - `run stop` on a running Flow, which exits 0. Afterwards no reviewer card opens and the run is `stopped`.
   - `run stop` without `--yes` and without a terminal, which exits 2.
   - `card answer` while `answer` is off, which exits 4 with `tierNotGranted`.
   - `card answer` with the environment switch on. It exits 0, the run moves on, and the channel shows the answer as from the command line.
   - A second `card answer` on the same card, which exits 4 with `alreadyAnswered`.
   - `card answer` on an agent's card, which exits 4.
   - `card abandon --yes`, which reports the next role.
   - `waiting --json`, which lists a person card with its id. That id matches `waiting.cleared` after it is answered.
   - `card show` and `card handoff` on a written card.
2. **Documents.**
   - In the spec, mark phase 3 done in the phasing.
   - `packages/cli/README.md` covers every new command, its flags, its `--json` shape and its exit codes.
   - `packages/client/README.md` notes the `answer` tier and the setting.
   - `docs/decisions.md` gets an entry only if the code had to choose something the spec did not decide, with the reason.

## Done when

- Every task is committed, with tests that ran.
- `pnpm layering` and the reachable-methods gate pass.
- `TMPDIR=/tmp/hdv pnpm verify`, run unpiped, prints "All checks passed."
- The built CLI, run against an isolated desk, stops a run and answers a person card.
- The window's existing tests pass unchanged, apart from the new Settings row.
- The branch is pushed and the PR opened, or the refusal is stated.
- The hand-off lists:
  - what ran;
  - what could not run here, and why;
  - every place the code differs from this brief, with the reason.
