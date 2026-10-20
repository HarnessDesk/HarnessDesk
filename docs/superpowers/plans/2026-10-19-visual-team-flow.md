# Visual Team Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Turn the approved task-first draft into a compact, aligned Team launch and an inspectable, animated Flow catalogue.

**Architecture:** Keep React Flow and the existing host admission, policy materialization and preview-token lifecycle. Extend the canonical Flow presentation so launch configuration and recorded execution share one graph vocabulary. Example playback is local presentation state and never starts a Run.

**Tech Stack:** React, TypeScript, React Flow, the existing design system, Vitest, CUA visual verification.

## Global Constraints

- Use canonical design components and theme tokens; strict design audit stays at zero.
- Preserve policy semantics, required inputs, candidate refusal reasons, stale-result guards and partial-Team retry behavior.
- Runtime names come from RuntimeInfo.presentation.
- Example playback is explicitly labeled, follows actual policy edges, pauses at a person and never changes recorded execution.
- Only the current example handoff moves; respect reduced motion.
- Equal card dimensions and aligned icon, text and control baselines; graph, task and footer share content boundaries.
- Inspect light/dark and narrow/wide frames in the real application; public frames use the isolated fake-agent rig.

### Task 1: Shared graph presentation and configuration slots

**Files:** design/ui/flow-step.tsx and CSS; design/patterns/FlowGraph.tsx; FlowCanvas/StepCard.tsx and CSS; focused graph tests.

- [x] Add tests for optional per-step configuration content and accessible selection.
- [x] Extend FlowGraph with `stepContent?: ReadonlyMap<string, ReactNode>` and `cardHeight?: number`; preserve defaults and real overlays.
- [x] Compose configuration content within each measured node without nested interactive card buttons. Derive layout scaling from the requested card height.
- [x] Refine canonical surfaces with token-based spacing, aligned title/icon rows, readable body and discreet state marks.
- [x] Run focused graph tests and typecheck, inspect the diff, report exact files and evidence.

### Task 2: Inspectable catalogue and finite example playback

**Files:** new lib/flow-example.ts and tests; design/patterns/FlowExample.tsx and tests; components/FlowsWindow.tsx and tests; canonical export/catalogue/explorer registration.

- [x] Write failing tests for a bounded policy-derived path, return edge, person pause and reduced-motion-safe explicit stepping.
- [x] Build a pure example state projection, separately from flowOverlay and host state. Do not infer that unconditional edges mean approval.
- [x] Add canonical FlowExample controls: Example label, Play/Pause, Next, Reset; selected transition shows natural-language conditions.
- [x] Select catalogue entries to show their full graph with explicit Start Team and Edit Flow actions; preserve custom/broken/empty catalogue behavior.
- [x] Wire Start Team to the existing FrontDoor source selection contract; no new host authority.
- [x] Run focused tests and typecheck; report exact evidence.

### Task 3: Configure roles on the launch graph

**Files:** components/FrontDoor.tsx, FlowStart.tsx and their CSS/tests; design/patterns/FlowCards.tsx and tests if the selected summary needs graph suppression.

- [x] Add a failing launch test proving role configuration is associated with its graph step and still changes the materialized policy.
- [x] Replace the duplicated selected thumbnail plus role rows with one configuration graph; reuse TeamSeatControls and all existing admission logic.
- [x] Keep the selected Flow name and Change action; retain task-first order and full catalogue access.
- [x] Keep every seat editable, including parallel seats and optional judge, and every required check/input accessible.
- [x] Fold optional review settings into the existing details disclosure while preserving behavior.
- [x] Run focused Team launch suites, then full UI tests once integration is stable.

### Task 4: Visual evidence and publication

- [x] Independently review the changes for spec compliance and regressions; fix verified findings.
- [x] Launch the built fake-agent application and visually click through task, roles, nested configuration, examples, person pause, return paths and real launch.
- [x] Inspect both themes and narrow/wide layouts. Measure card boxes, shared edges and connector endpoints; correct clipping or overlap.
- [x] Update the experience document with observed outcomes and limits, regenerate design documentation, run selected push checks.
- [x] Commit, push to PR 1813, update its final description and safe screenshot evidence, then request the local extra-eyes review on that exact head. Do not merge.

### Task 5: Walkthrough refinements requested during implementation

- [x] Give catalogue thumbnails canonical robot, terminal and person marks, keeping labels and topology readable in the fixed preview geometry.
- [x] Reproduce the unnecessary U route between same-row adjacent nodes; use actual available clearance so ordinary handoffs stay straight while return paths still route around nodes.
- [x] Preserve nested configuration focus across temporarily disabled preview controls, including the browser modal focus guard; Escape closes the configuration before the Team dialog.
- [x] Repeat focused geometry, thumbnail and popover regressions and inspect the actual result in both themes.

### Task 6: One default Team work page

- [x] Replace the fragmented Overview / Run / Flow / Timeline navigation with Work / Tasks / Chat.
- [x] Work shows useful attention and status, the recorded Flow and recent activity together; longer history expands inline. Plain Teams retain their real overview.
- [x] Preserve historical-run selection, findings, receipts, check recovery, stopping, wrapping, seat navigation and old frame requests through explicit mappings.
- [x] Group Board and Findings within Tasks; preserve actual ledger state and mutations.
- [x] Verify behavior and shared visual boundaries in the running fake-agent desk, both themes and narrow/wide widths.

### Task 7: Flow creation entry and editor, after Task 6

- [x] Make the catalogue's New Flow entry and the editor's creation state explicit.
- [x] Simplify the fragmented editor toolbar and oversized details cards; keep Save, required configuration and Start reachable in a clear order.
- [x] Use the same plain icons, spacing, corners and aligned content edges as the approved Flow surfaces.
- [x] Preserve policy edits, validation, unsaved state and source identity; inspect and verify creation through save and launch with the isolated rig.

### Task 8: Shared record rails and conversation hierarchy

- [x] Compact Run, Conversation, Seat and selected-card records without losing unknown values, source identity, comparison evidence or lifecycle actions.
- [x] Put pending Team requests in the scrolling conversation; keep every answer and the persistent composer visible and preserve draft/audience and same-record responses.
- [x] Use compact real Agent identity, one concise queue consequence and a reduced-motion-safe Chat attention count.
- [x] Distinguish message, activity and request presentation; combine Flow additions only with recorded same-round provenance and retain exact task doors.
- [x] Verify direct human-step answers, pending requests, both conversation entry points, shared rail geometry and final light/dark frames; rerun full UI and selected push checks.
