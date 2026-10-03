# Library Roadmap

> **For agentic workers:** this is the index. Each phase has its own plan,
> which is executed with superpowers:subagent-driven-development, task by
> task. Do not start a phase before the previous phase's exit check holds.

**Goal:** Build the Library the owner chose. It is a package-manager view of
every agent's skills, rules files and MCP servers: a list, a detail pane, one
*Installed in* checkbox per agent, then review, apply and a receipt. It must
never claim more than an agent said.

**Spec:** [2026-10-01-library-design.md](../specs/2026-10-01-library-design.md).
The use cases are in
[2026-10-01-skills-management-use-cases.md](../specs/2026-10-01-skills-management-use-cases.md).
The approved mockup is `library-option-e` on `packages/ui/preview.html?library-options`.

## Who does what

- **Codex, through `hd-subagent`, on one desk** (`~/.harnessdesk-subagents-skills`):
  - measurement and investigation: `codex=gpt-6-luna/medium`;
  - writing tasks: `codex=gpt-6-luna/high`;
  - task and phase reviews: `codex=gpt-6-luna/xhigh`;
  - design calls: `codex=gpt-6-sol/high`.
- **Every `--continue` repeats `--seat`.** Without it the conversation is
  reseated on the skill's default.
- **Claude integrates and makes the final call.** That covers commits (the
  Codex sandbox cannot write `.git`), `pnpm verify` outside the sandbox, and
  the final review.
- **Landing** runs through a Codex loop: `hd-land-pr` and `loop.mjs merge`.
  A merge happens only when every check-run on the final head is green.

## Phases

| Phase | Plan | Use cases | Exit check |
|---|---|---|---|
| **0 · Measure** | [phase 0](2026-10-01-library-phase-0-measure.md) | measurements 1–8 owed in the use-case doc | A result file exists in `docs/verification/library-measurements/` for every installed agent. The location table and the four new capability facts carry `evidence`. No fact reads *asked* without a result file. |
| **1 · See it truly** | [phase 1](2026-10-01-library-phase-1-window.md) | F1–F4, U1–U6, U9, R1, R3, E1, E2, E4, E5 | The Library window opens from the sidebar, ⌘K and Settings, and shows the list, detail, Issues, One agent, MCP and Rules tabs. *Installed in* is read-only. Every operation from Settings › Skills and Extensions is reachable in the window, and those two nav rows are gone. The four-agent rig is verified. |
| **2 · Change it safely** | written after phase 1 | I3, I6–I9, K2, K3, K6, O1–O5, E6 | Ticking and unticking leads to a plan, apply and a persisted receipt, with *Undo*, *Retry*, *Restart it now* and *Have it look again*. Project-scope installs work. *Compare…* resolves differing copies. |
| **3 · Sources and updates** | written after phase 2 | I1, I2, I4, I5, K4, E3 | *Add from GitHub or a URL* installs pinned. *Check for updates* shows a diff. Scripts are reviewed before install or update. |
| **4 · Collaborators, rules, servers** | written after phase 3 | T1–T6, R2, R4, A1, U7, U8, K7 | *This repository brings…* appears for a committed kit. *Make one source…* is available for rules, opt-in per place. Servers that need credentials are handled. Agent allowlists are picked from the Library. |

**Why phases 2–4 have no plan yet.** Phase 0's results decide what they build:
- which agents' writes can be confirmed;
- which rules files are read;
- where tier C agents keep their files.

Writing those plans now would mean writing code against guesses. Each one is
written, with `writing-plans`, when the phase before it exits.

## Definition of done, for every PR

- **A changed component means a changed design.** Every new or changed Library component has all its real states on the `design.html` catalogue boards and as `preview.html` frames, drawn from the shipped component, not a copy. That covers:
  - the list row and its presence strip, summary and badges;
  - the detail pane;
  - the *Installed in* lines and checkboxes;
  - the pending bar and the receipt;
  - every state glyph.
- **The phase 1 PR deletes the mockups.** These are `frames-library-dev.tsx`, `frames-library-options.tsx` and `library-options-fixture.ts`. They are replaced by frames of the real components, so no second copy of the design survives.
- `pnpm verify` is green, unpiped.
- The design audit adds no findings beyond main's accounted baseline (the single-area primitives it already reports).
- Every check-run on the final head is green before merge.

## Running each task

For every task in a phase plan:
1. **Writer:** `hd-subagent run --mode write --seat "codex=gpt-6-luna/high"`,
   with that task's text as the brief.
2. **Claude:** runs the task's proofs outside the sandbox and commits through
   `commit_work` on a board card; the tool adds the desk's co-author credit.
3. **Reviewer:** `hd-subagent run --mode read --seat "codex=gpt-6-luna/xhigh"`,
   given the task, its diff and the spec. A finding goes back to the writer
   (`--continue`, with `--seat` repeated), and the fix is reviewed again.
4. **When the phase's last task is done:**
   - Claude does a whole-phase review;
   - `pnpm verify` is run unpiped;
   - the PR is opened and handed to the Codex landing loop.
