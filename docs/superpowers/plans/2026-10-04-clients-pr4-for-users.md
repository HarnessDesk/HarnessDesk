# PR 4 of the clients design: the command line for users

This brief is the plan. Your **first commit** adds it unchanged as `docs/superpowers/plans/2026-10-04-clients-pr4-for-users.md`, so the reviewers read the code against it.

#1315 (PR 3: stop and answer) has merged (merge commit 7460504). Start from a fresh `origin/main`. The generated reference below reads the command table, and #1315 added commands to it.

## Read first

- `docs/superpowers/specs/2026-10-02-clients-outside-the-window-design.md`. Read these parts:
  - "The command line: `harnessdesk`", in particular "Where it lives and how it is installed";
  - "Conventions";
  - "Commands";
  - "Exit codes";
  - "Decisions" 5 and 7;
  - "Phasing" 4.
- The earlier plans in this lane: `docs/superpowers/plans/2026-10-03-clients-pr*.md`.
- `packages/cli/src/cli.ts`: its command table (`name`, `methods`, `flags`, `execute`), and `packages/cli/README.md`.
- How the app runs a bundled script on its own runtime with `ELECTRON_RUN_AS_NODE=1`. The MCP bridge does it; see `packages/server/src/bootstrap.ts` and `agent-registry.ts`.
- The desktop shell, `packages/desktop/electron/main.mjs` and its menus, and how the packaged app lays out its resources (`packages/desktop/package.json`, the build config).
- How generated docs are held to their source:
  - `script/design-doc.mjs`, which builds `docs/design-system.md` from source;
  - the gate step that fails when the generated file drifts.

## What this PR adds

**The command line inside the app.** The packaged app carries the built CLI and the library it needs. Running the bundled `bin` with the app's own runtime and `ELECTRON_RUN_AS_NODE=1` works without any separate Node install.

**An Install command-line tool… item.** It lives in the app menu (the HarnessDesk menu on macOS). It puts a small `harnessdesk` launcher on the person's `PATH`. The launcher runs the bundled script on the app's runtime.
- **Where the launcher goes is settled in this PR.** Prefer a folder the person owns that is already on a login shell's `PATH`, such as `~/.local/bin` when it is on `PATH`. Never ask for an administrator's password silently. If no owned folder on `PATH` exists, say exactly where the launcher was put and the one line that adds that folder to `PATH`, rather than editing shell files.
- **Record the choice** and the reason in `docs/decisions.md`.
- **Never overwrite** a `harnessdesk` that is not ours. Recognise our own launcher by a marker line and replace only that.
- **Uninstall:** a second run of the item, once the launcher exists, offers to remove it.
- **Upgrades:** the launcher resolves the app's current location at run time, so an app upgrade or move does not strand it.

**A user-facing command reference**, `docs/cli.md`.
- It is generated from the command table and its descriptions by a script, `script/cli-doc.mjs`. Add the descriptions to the table if they are not there yet.
- It is held to the source by a gate step, in `pnpm verify` and in CI, like the design-system doc. Add the step to both docs paragraphs that list the gate's steps (AGENTS.md and CONTRIBUTING.md); `script/check-verify-steps.mjs` checks them.
- It is written for people driving their own work, not for our tooling. For each command it gives: what it does, its flags, its `--json` shape, its exit codes, and the tier it needs.
- Keep `packages/cli/README.md` for contributors, and link it to `docs/cli.md`.

**One changelog line** under the unreleased section of `CHANGELOG.md`.

**Not in this PR:**
- conversation verbs;
- a `finding/publications` command;
- Windows install (the named pipe is decided, but the installer is a later PR);
- moving the maintainers' own scripts, which live outside this repository.

## Constraints

- **Agent output is untrusted.** The launcher passes arguments through unchanged and never interpolates them into a shell string. Test it with arguments that contain spaces, quotes, `$` and newlines.
- **No secret anywhere:** no flag, environment variable or file carries a credential.
- **Rule 8: the UI never names a runtime.** The menu item's text is "Install command-line tool…", and the result dialog uses `Dialog` or the native message box that the app already uses for menu results.
- **Tests:**
  - the launcher's content and its own-marker rule;
  - install, reinstall over our own launcher, refusal over a foreign file, uninstall, and the `PATH` advice, all on a temporary home;
  - the generator's output against a sample table;
  - the gate step failing on a stale `docs/cli.md`.
- **Run it for real.** Build the app, run the item on a temporary home, then run the installed `harnessdesk status --json` against an isolated desk. Put the transcript in the PR body.
- **Gate 2: the menu item and its result dialog are UI.** Take frames from the rig (`script/shots/`), never from a real desk. Push them to `<your branch>-frames` under `docs/images/clients-cli/`, never to the PR branch, and link them in the body. Look at every frame before you push it.
- **Checks before pushing:**
  - `TMPDIR=/tmp/hdv pnpm verify`, run unpiped, prints "All checks passed."
  - Rule 13: identities are `Jane Doe` and `dev@example.com`, with no home paths in anything pushed.
- **Commits:** every commit message ends with `Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>`. Make one commit per part: bundle, item, reference, changelog.

## Done when

- The packaged app runs its bundled CLI, and the item installs a working `harnessdesk` launcher on a temporary home.
- `docs/cli.md` is generated and held by the gate.
- The decision about where the launcher goes is recorded.
- Verify is green, and the frames are linked.
- The hand-off lists:
  - what ran;
  - what could not run here, and why;
  - every place the code differs from this brief, with the reason.
