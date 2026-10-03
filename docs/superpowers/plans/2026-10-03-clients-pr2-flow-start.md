# PR 2 of the clients design: starting a Flow from the command line

This brief is the plan. Your **first commit** adds it unchanged as `docs/superpowers/plans/2026-10-03-clients-pr2-flow-start.md`, so the reviewers can read the code against it.

## Read first

- **The spec,** `docs/superpowers/specs/2026-10-02-clients-outside-the-window-design.md`, these parts:
  - "The first journey";
  - "The allowlist and its tiers";
  - "Conventions";
  - "Commands", including the `flow preview`/`flow start` flag table;
  - "Exit codes";
  - "Host changes this needs", items 4 and 5;
  - "Security model";
  - "Decisions" 2, 3 and 4;
  - "Phasing" 2.
- **The earlier PRs' plans,** for the house style of this lane:
  - `docs/superpowers/plans/2026-10-03-clients-pr1b-team-activity.md`;
  - `docs/superpowers/plans/2026-10-03-clients-pr1c-views.md`.
- **The client door and the CLI as they stand:**
  - `packages/protocol/src/client-surface.ts`;
  - `packages/server/src/client-door.ts`;
  - `packages/client/src/index.ts`;
  - `packages/cli/src/cli.ts`;
  - `packages/cli/README.md`.
- **The host's preview and start path:**
  - `packages/server/src/flow-preview.ts` (`freeze`, `#build`, and the `unattended` option a trigger already uses);
  - `packages/server/src/flows.ts`;
  - `packages/server/src/flow-execution.ts` (the unattended question deadline and `unattended(...)`);
  - `FlowStartRequest` and `FlowPreview` in `packages/protocol/src/flow-policy.ts`;
  - the methods `flow/preview`, `flow/start-goal`, `flow/catalog`, `flow/source` and `workspace/open`.
- **How a trigger starts an unattended run today.** Find its caller of `freeze(..., { unattended: true })`. That path is the behaviour `--unattended` must match exactly.

## What this PR adds

**On the host:**
- `flow/preview` takes two new parameters:
  - `seats`: per-role seat overrides for this run;
  - `attended`: true by default.
- Both are bound into the preview's single-use token.
- The preview result lists each overridden role's seats beside the file's own.
- A run started from that token records its overrides and its attendance, and its receipt freezes them like every other fact about the run.
- A run started unattended is treated exactly like a run a trigger started:
  - a Seat's question waits as long as `unattendedQuestionWait`, then the run stops, and a late answer is still delivered;
  - a Seat whose ceiling could only be asked for is refused.

**On the door:**
- The `run` tier is granted by default, as Decision 2 says.
- These methods join the surface:
  - `flow/catalog` and `flow/source` at `read`;
  - `flow/preview` at `read`;
  - `flow/start-goal` and `workspace/open` at `run`.
- Each `run` call is audited with `via: 'client'` and its outcome, like the existing calls.

**On the command line:**
- `open <path>`;
- `flows [--project P]`;
- `flow preview <flow> …`;
- `flow start <flow> … [--yes]`;
- `run show <run>`;
- `run wait <run> [--timeout S]`.

**Not in this PR:**
- `flow/execution/stop`, the `answer` tier and the `card …`/`waiting` commands (PR 3);
- installing the command line and the generated reference (PR 4);
- any change the window shows. The window keeps calling `flow/preview` without the new parameters, and must behave exactly as before.

## Global constraints

These are the same as PR 1, 1b and 1c.

- **Wire methods.** A wire method is three edits, in this order: `wire.ts`, then `wire-validators.ts`, then `methods/<domain>.ts`. New parameters on an existing method get validators too.
- **Tests and running.** Write tests first where a test makes sense. Run what you change for real: `TMPDIR=/tmp/hdv pnpm verify`, unpiped, must print "All checks passed." before you push.
- **Short socket directories:** use `/tmp/hd-door-*`.
- **Rule 13:** test identities are `Jane Doe` and `dev@example.com`; no home paths and no real accounts anywhere.
- **Wording:** describe no existing surface as weak. Put no runtime name in UI text.
- **Commits:** every commit message ends with `Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>`. Make one commit per task. Never merge.
- **Branch:** work on `client-flow-start` from a fresh `origin/main`. Push it, then open the pull request with `pr_create`. If that refuses or reads the wrong checkout, say so in the hand-off and stop.
- **This PR changes tiers and spends money.** Its review is the critical one, so state every security decision plainly in code comments and in the PR body.
- **`flow-execution.ts` is also edited by the Teams and Runs view plan.** Keep your edits there small and well named, and rebase on a fresh `origin/main` before pushing.

## Task 1. Seat overrides and attendance in the preview

1. **The parameters.** `flow/preview`'s params gain:
   - `seats?: Readonly<Record<string, readonly FlowSeat[]>>`: role id → the seats for this run, each written as a flow writes a seat;
   - `attended?: boolean`, true by default.
2. **Validation.**
   - An unknown role is a problem in the preview, never a silent drop.
   - Overriding a person role is a problem.
   - A seat string that does not parse is a problem.
   - A role with several cards takes a list.
   - Reuse the flow parser's own seat grammar; never write a second one.
3. **The plan uses them.**
   - The preview's seat plan for an overridden role is computed from the override, through the same `previewAgent` path, with the same grant and ceiling checks.
   - `attended: false` gives the same result as `freeze(..., { unattended: true })`, so an unattended preview shows the trigger rules: a ceiling that could only be asked for is refused.
4. **The token binds them.**
   - The single-use token covers `seats` and `attended` along with what it covers today.
   - `flow/start-goal` with a token minted for different overrides or a different attendance is refused.
   - Tests cover both the overrides and the attendance.
5. **The result shows them.** `FlowPreview` gains, per overridden role, the file's seats and the run's seats, so a client can mark the override. Keep the field optional so the window's existing reads are unchanged.

## Task 2. A run records and obeys what its preview froze

1. **The record.** The started run records `overrides` (role → seats) and `attended`. The run file and `flow/execution` carry them; add them as optional fields of `FlowExecution`.
   - A run started before this PR reads as attended, with no overrides.
2. **The cards.** The cards of an overridden role are seated from the override, not from the file.
3. **Unattended.** An unattended run behaves exactly like a trigger's run.
   - Reuse the trigger path's switch. Do not copy it.
   - Test: a question from an unattended run's Seat stops the run after the person's wait.
   - Test: a late answer is still delivered.
   - Test: an attended run's question waits indefinitely, as today.

## Task 3. The surface and the `run` tier

1. **The methods.** Add to `CLIENT_METHODS`:
   - `flow/catalog`, `flow/source` and `flow/preview` at `read`;
   - `flow/start-goal` and `workspace/open` at `run`.
2. **The default tiers.** `CLIENT_TIERS_GRANTED_BY_DEFAULT` becomes `['read', 'run']`. `answer` stays off; PR 3 adds it with its setting.
3. **The door's tests.**
   - A `run` method answers.
   - Each call is audited with its tier.
   - A method off the surface is still refused with `notOnClientSurface`, whatever its tier.
   - The reachable-methods gate and the CLI's command table stay in step.
4. **Paths stay the caller's.** The host never opens a path a client names, except the root a person asked to open.
   - `flow/source` reads only catalogue entries by id.
   - A file-path flow is read by the CLI and sent as text, as the window sends it.

## Task 4. `open`, `flows`, `flow preview` and `flow start`

1. **`open <path>`.** Calls `workspace/open` with the canonical path and prints the project.
2. **`flows [--project P]`.** Calls `flow/catalog` and prints each flow's id, layer and any problem.
3. **`flow preview <flow> …`.** Takes the spec's flags:
   - `--project`, defaulting to the repository that contains the working directory;
   - `--title`;
   - `--brief-file <path>|-`;
   - `--input name=value|name=@path`;
   - `--seat role=runtime[=model][/effort][+thinking]`, repeatable, with a list for several cards;
   - `--unattended`.

   It works as follows:
   - `<flow>` is a catalogue id, or a file path the CLI reads itself.
   - `--brief-file` fills the `brief` input. It is refused, with exit 2 and the inputs the flow does declare, if the flow has no `brief`.
   - Long text never goes in argv.
   - `--title` is the Team's sentence, and also the `title` input when the flow declares one.

   It prints, spending nothing:
   - the seats, with overrides marked beside the file's;
   - the checks, verbatim;
   - held or asked;
   - attended or unattended;
   - every problem.

   A preview with problems exits 4.
4. **`flow start <flow> … [--yes]`.** Previews first.
   - On a terminal, it shows the preview and asks for confirmation.
   - Without a terminal, it needs `--yes`; with neither, it exits 2.
   - It then calls `flow/start-goal` with that preview's token and prints the run and the Team. `--json` prints `{"run": …, "team": …}` and nothing else.
5. **Human output.** All agent and flow text in human output goes through the CLI's existing control-character stripping.

## Task 5. `run show` and `run wait`

1. **`run show <run>`.**
   - Reads `flow/execution`.
   - Prints the state, each round with its role and cards, why the run stopped (`reason`), and the new `attended`/`overrides`.
   - `--json` prints the execution unchanged.
2. **`run wait <run> [--timeout S]`.**
   - Subscribes once with scope `{ run }`, awaits `synced()`, then waits on events. It never polls.
   - Exit codes come from the spec:
     - 0: the run settled;
     - 5: it is waiting for a person (a person card, or a question);
     - 7: it stopped or stalled.
   - `--timeout` ends it with a new code, **8: the timeout passed first**. Add 8 to the spec's exit-code table and to the CLI README.
   - A run that has already ended answers immediately with its code.

## Task 6. End-to-end and documents

1. **End-to-end test.** Use the fake-agent rig: an isolated `HARNESSDESK_HOME` and scripted fake agents, so no credentials, network or credits are needed. The test does this, in order:
   - `open` a project;
   - `flows`;
   - `flow preview` with a `--seat` override and `--brief-file`, which shows the override and spends nothing;
   - `flow start --yes --json`, which prints the run and the Team;
   - checks that the run's cards are seated from the override;
   - `run show`;
   - `run wait`, which exits 0 when the run settles;
   - a second, unattended run whose Seat asks a question, where `run wait` exits 7 after the wait;
   - `flow start` without `--yes` and with no terminal, which exits 2;
   - a token reused across different overrides, which is refused.

   The wire trace shows no polling.
2. **Documents.**
   - In the spec, mark phase 2 done in the phasing, and add exit code 8.
   - `packages/cli/README.md` covers every new command, its flags, its `--json` shape and its exit codes.
   - `packages/client/README.md` notes the `run` tier.
   - Add a `docs/decisions.md` entry only if the code had to choose something the spec did not decide. State the choice and the reason.

## Done when

- Every task is committed, with tests that ran.
- `pnpm layering` and the reachable-methods gate pass.
- `TMPDIR=/tmp/hdv pnpm verify`, run unpiped, prints "All checks passed."
- The built CLI, run against an isolated desk, takes a flow from preview to settled, and also through an unattended stop.
- The window's existing preview and start tests pass unchanged.
- The branch is pushed and the PR opened, or the refusal is stated.
- The hand-off lists:
  - what ran;
  - what could not run here, and why;
  - every place the code differs from this brief, with the reason.
