# Outside-edit labels Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task. The parent checkpoint precedes implementation; do not dispatch subagents. Steps use checkbox syntax.

**Goal:** Label reported turn paths outside known open roots, without losing edits or conflating them with Git's working-tree snapshot.

**Architecture:** A renderer-only lexical classifier consumes the current snapshot's workspace and session metadata and the displayed conversation cwd. The turn card and the Changes turn-diff reader use that same classifier; the generic reader receives an optional caller-supplied classification and remains unchanged for other callers. The host retains all access and undo authority.

**Tech Stack:** TypeScript, React, Vitest/jsdom, existing design-system Chip and Electron fake-agent rig.

## Global Constraints

- Approved specification: `docs/superpowers/specs/2026-10-30-outside-edits-design.md`; keep all reported edits and observed totals. Git counts remain separate.
- No host/wire method, filesystem request, generic visual primitive, settings.workspaceRoots, physical/symlink inference, or changed access/undo semantics.
- Known roots are valid absolute `workspaces[].path`, `workspace.path`, displayed session cwd and all known `sessions` cwd values. Recompute after workspace/session updates; don't cache against stale roots.
- Labels are neutral `Chip`s, “Outside” and “Location unknown”; outside tooltip is “Reported path is outside the known open workspace and conversation roots.” Do not claim the host will allow or refuse access.
- After parent explicitly continues: first `pnpm install --frozen-lockfile` in this checkout using the existing store. Every heavy build/test/native whole workflow goes through the supplied `parallel-heavy.mjs -- COMMAND ARGS` wrapper (two global slots); queue normally. No full verify, push, PR, merge, or subagents. Parent owns integration and full verify.
- Before using a focused test command, check its forwarding against `packages/ui/package.json`: `pnpm --filter @harnessdesk/ui exec vitest run src/...` invokes Vitest directly with explicit file paths; never append an extra `--` that could change filtering. Run from repository root; wrapper must enclose the whole command. Record commands, exit codes and logs.
- Native proof uses only staged fake agents and a throwaway desk/profile, a short owned TMPDIR, trusted CDP Input for person actions, durable logs and proof. Use the unchanged canonical `TILDIFY` substitutions and full `SEEN`/`reasonsFor` account/history/guest audit both before and after every frame; never retain a refused frame. Inspect every retained original and have the parent inspect it before publication. No owner's desk, credentials, real provider, remote URL, or shared worker desk.

## File map and contracts

- `packages/ui/src/lib/paths.ts`, `paths.test.ts`: lexical normalization and classification, without changing existing `isPathInside` callers. Export `type ReportedLocation = 'inside' | 'outside' | 'unknown'`, `reportedLocation(path: string, cwd: string | null | undefined, roots: readonly string[]): ReportedLocation`, and `knownOpenRoots(workspaces: readonly { readonly path: string }[], workspace: { readonly path: string } | null, sessionCwds: Iterable<string>, displayedCwd: string | null | undefined): string[]`.
- `packages/ui/src/components/TurnFiles.tsx`, `TurnFiles.test.tsx`: use current snapshot roots and the `root` prop as displayed cwd; decorate the single-file heading, summary and each visible multi-file row. Existing file selection, undo and totals remain intact.
- `packages/ui/src/components/Details.tsx`, `Details.toggles.test.tsx`: classify only `turnFiles` from `splitByFile(turn.diff)` using `session?.cwd`, not the Git fallback `root`. Pass the classifier to the diff reader. Keep existing filtered turn count and independent working-tree count.
- `packages/ui/src/editor/DiffFilesView.tsx`, `DiffView.nav.test.tsx`: optional `(path: string) => ReportedLocation` callback for navigation and every patch heading; absence means no labels. Do not alter `FileDiff` or other callers.
- `docs/interface.md`: document the labels and independent totals after implementation.

## Task 1: Lexical location and live roots

**Interfaces:** `knownOpenRoots(...)` returns only usable absolute paths; `reportedLocation(...)` returns the union above. Neither function performs I/O or mutates inputs.

- [ ] Add failing tests in `paths.test.ts`, using explicit expected outcomes. Start with:

```ts
expect(reportedLocation('../tmp/check.js', '/work/app', ['/work/app'])).toBe('outside')
expect(reportedLocation('src/../a.ts', '/work/app', ['/work/app'])).toBe('inside')
expect(reportedLocation('/work/app-2/a.ts', '/work/app', ['/work/app'])).toBe('outside')
expect(reportedLocation('/work/other/a.ts', '/work/app', ['/work/app', '/work/other'])).toBe('inside')
expect(reportedLocation('file.ts', null, ['/work/app'])).toBe('unknown')
expect(reportedLocation('', '/work/app', ['/work/app'])).toBe('unknown')
expect(reportedLocation('C:\\Repo\\src\\a.ts', 'C:\\Repo', ['c:/repo'])).toBe('inside')
expect(reportedLocation('C:relative.ts', 'C:\\Repo', ['C:\\Repo'])).toBe('unknown')
```

Also test root equality, `/` and drive roots, dot segments that climb above root, mixed separators/case on drives, POSIX case sensitivity, an absolute path with no usable known roots (unknown, not outside), NUL/control or whitespace-only input, unsupported ambiguous UNC/device forms, invalid relative cwd, and exclusion of relative roots. Verify an added/removed workspace or session cwd changes the result; permission-only roots never enter the input. Define malformed strings conservatively as unknown rather than guessing. Include `knownOpenRoots` test that displayed cwd is included even when the session is absent from the map.

- [ ] Run the explicit path test through the heavy wrapper: `pnpm --filter @harnessdesk/ui exec vitest run src/lib/paths.test.ts`. Expect failure because the exports do not exist; record it.
- [ ] Implement the exports. Normalize `\\` to `/`, parse POSIX absolute `/...` and drive absolute `X:/...` separately, reduce `.` and `..` component-wise without allowing traversal above the lexical root, reject control characters and ambiguous drive-relative/UNC/device inputs. Only resolve a relative path when cwd is valid absolute; a POSIX absolute path is not silently reinterpreted as drive-rooted. Compare normalized absolute paths with existing `isPathInside` boundary/case conventions. Return unknown if path/cwd is invalid or no valid roots exist; otherwise inside on any matching root and outside on none. A valid absolute reported path does not require cwd. Roots on another drive are valid nonmatches. Do not rewrite the existing helpers or claim symlink knowledge.
- [ ] Re-run that exact command and expect all path tests green.

## Task 2: Turn card preserves edits and actions

**Interfaces:** `TurnFiles` retains `{ turn: Turn; changes: readonly FileChange[]; root: string }`; consume `snapshot.workspaces`, `snapshot.workspace`, and `snapshot.sessions` through subscriptions and call the Task 1 functions on every relevant change. Use existing `Chip` with `tone="neutral" size="sm"`; place each label where it remains visible without nesting interactive controls. Title/tooltip carries the approved explanation for outside; unknown title explains that the reported path cannot be located relative to a known conversation folder.

- [ ] Add red tests in `TurnFiles.test.tsx` using its `rig` and `refresh`: one outside single file displays `Outside` beside its name; four mixed files still say `Edited 4 files`, show `1 outside`, preserve `ChangeStats`, and after clicking `1 more` label the fourth outside file. An unknown relative file shows `Location unknown`, never `Outside`. Change workspace/session roots with `refresh` and assert labels update without remounting; a root supplied only through settings does not suppress outside. Assert clicking Undo still calls `revertTurn(TURN.id, KEY, {})` once with the complete turn, including outside files, and Review/open use original paths. Do not equate undo with successful host access.
- [ ] Run `pnpm --filter @harnessdesk/ui exec vitest run src/components/TurnFiles.test.tsx` through the wrapper; expect the new assertions to fail.
- [ ] Compute location from `totalsByFile(changes)` without filtering or changing paths; count only `outside` for the summary chip, not unknown. For one file put its location chip in the heading; for many, put the count in the heading and a per-file chip on each shown row. Existing collapsed rows remain collapsed until expanded. Preserve all existing controls, counts and request arguments. Update layout with existing tokens only if required; do not introduce new `--hd-*` values.
- [ ] Re-run the same test command through the wrapper; expect green including existing refusal/redo cases.

## Task 3: Changes pane and diff reader

**Interfaces:** Extend `DiffFilesView` props with `locationForPath?: (path: string) => ReportedLocation`; unspecified callback draws no location chips. `Details` passes `path => reportedLocation(path, session?.cwd, roots)` only for the runtime turn diff. `FileDiff.path` is the parser's reported path, not an absolute filesystem claim.

- [ ] Write red tests in `Details.toggles.test.tsx` or a focused `Details.outside-edits.test.tsx` with a subscribed store and active `PaneProvider` session: aggregated diff with relative `src/a.ts` and absolute `/tmp/check.js` yields inside and outside; a separate headerless turn diff yields unknown. Seed `git/status` with two repository files independently and assert the turn total and working-tree total differ without one changing the other. Filter to `check.js`, assert the existing filtered `This turn · 1 file` and outside label, clear filter and recover both files; separately assert the headerless turn remains one unknown entry. Refresh workspace and session maps and verify labels change. With session cwd absent, a relative diff path is unknown even if `snapshot.workspace` is set.
- [ ] Add red `DiffView.nav.test.tsx` tests for a supplied callback: outside in navigation and patch heading, unknown in heading, `showFiles: false` retains heading labels, grouped/collapsed/expanded and single-file views remain labeled; with no callback existing generic diff output contains neither label. Assert counts and original path text are unchanged.
- [ ] Run through wrapper: `pnpm --filter @harnessdesk/ui exec vitest run src/components/Details.toggles.test.tsx src/components/Details.outside-edits.test.tsx src/editor/DiffView.nav.test.tsx` (omit the new filename only if the new tests were placed in the existing file). Expect new assertions red.
- [ ] In `Details.tsx`, keep `root = session?.cwd ?? snapshot.workspace?.path` for Git requests only. `splitByFile` strips Git `a/` and `b/` prefixes, reads new path or old path for deletion, and returns `''` for a headerless patch; classify those resulting strings lexically against the displayed session cwd, not against the selected workspace fallback or Git root. Relative headers are interpreted relative to the displayed session cwd; do not infer a repository root or correlate a headerless patch to a FileChange by position. Empty/unreadable paths are unknown. Preserve current query filter and its filtered count; don't change Git status/diff requests.
- [ ] In `DiffFilesView.tsx`, render a neutral Chip in both the nav entry and `PatchHeader` for non-inside results, with the approved outside tooltip. Keep navigation buttons, grouping, collapse and scrolling behavior, counts, and generic callers unchanged. Avoid a nested interactive control.
- [ ] Re-run the exact focused command through the wrapper. Expect green. Run Task 1 and 2 focused files together as a final regression, not the broad UI suite.

## Task 4: Documentation and native evidence

- [ ] Update `docs/interface.md` under Reading changes: the turn card and turn-diff reader label reported paths outside known open roots or whose location is unknown; counts are observed turn files and Git counts are the current working tree; labels are lexical and do not decide access. State that the existing Changes filter narrows its displayed turn count.
- [ ] Through the wrapper run `pnpm --filter @harnessdesk/ui run typecheck`, `pnpm layering`, and `node script/design-audit.mjs --strict` (and any targeted design gate demanded by the actual diff). Save output and report failures rather than claiming verification. Build the staged fake-agent desktop only through the same wrapper, after the locked install.
- [ ] In a unique owned short temporary directory stage a fake-agent profile and synthetic project with a mixed inside/outside turn and a separate unknown/headerless turn. Use the repository's fake-agent fixture and `script/shots` rig; no actual provider or personal desk. Record ownership, processes, port, launch command, fixture paths and teardown; retain durable proof in the designated task folder. Use trusted CDP Input for navigation, expansion and filter actions, not DOM click shortcuts.
- [ ] At narrow and regular widths inspect the native turn card (including expanded rows and single-file case) and Changes (navigation visible and hidden, filtered and unfiltered). Record visible labels, observed totals, separate Git count, no clipping, and undo request behavior; do not perform destructive undo against real data. Take only rig frames. Apply canonical `TILDIFY` exactly as `script/shots/shoot.mjs` specifies for home, staged person/work parent, and staged desk home, then full unchanged `SEEN`/`reasonsFor` audit immediately before and after each frame. On refusal retain the reason/log, not the frame; do not narrow the audit. Inspect each safe original, record dimensions and SHA-256, and ask parent to inspect originals before any publication. Shut down only owned processes and report teardown independently.
- [ ] Review `git diff --check`, actual diff, test results and proof against the specification. Check no unrelated files, paths identifying a real home, real identities, or credentials enter added content. Commit only implementation and documentation files after parent continuation, and return SHA, focused red/green evidence, native proof, limitations and remaining parent-owned checks.
