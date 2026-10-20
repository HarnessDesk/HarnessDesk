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

### Task 9: Close the complete conversation UI queue after development refresh

Each item is an acceptance check for the user's accumulated requests. Existing implementation is retained; only a verified remaining defect justifies another source change. Three agents own the independent Flow, conversation and Work groups.

- [x] Flow gallery: plain role glyphs, consistent corners, readable node size and generous content insets. **Verification:** focused FlowCards/FlowGraph tests and inspect the built gallery.
- [x] Flow routing: adjacent nodes align with straight handoffs; return paths stay outside nodes. **Verification:** route geometry regressions and inspect the real canvas.
- [x] All predefined Flows: inspectable complex graphs, bounded playback, pause at a person, accessible alternatives and reduced motion. **Verification:** FlowExample and policy-path tests plus catalogue playback.
- [x] Creation and launch: discoverable New Flow, compact editor, Save and Start reachable, every Seat configurable with exact policy/admission rules. **Verification:** creation/FlowStart tests and saved-source launch walkthrough.
- [x] Seat identity: actual selected runtime marks, stable duplicate-role ordinals, custom names retained, compact model line. **Verification:** SeatList/TeamRoomPane/SideBySide tests and the running Seat rail.
- [x] Composer menus: one compact member identity and one relevant current value, full options on demand, exact-session mutations and confirmations. **Verification:** RoomComposerOptions/ComposerControls tests and each of the four actual menus.
- [x] Conversations: readable sender/recipient/time, agent-to-agent and grouped messages, concise provenance-based activity and folded diagnostics. **Verification:** Channel/Items tests and light/dark/narrow synthetic chat frames.
- [x] Pending requests: gentle Chat indicator/count, same request in Team and source conversation, persistent draft/audience/composer, and a scrollback return cue. **Verification:** approval/Room tests and real fake-agent request walkthrough.
- [x] Shared rails: bounded paths and names, concise permission/context facts, no redundant empty detail towers. **Verification:** shared geometry/record tests and inspect Details beside the floating rail.
- [x] Minimal navigation: Work/Tasks/Chat, Flow first, inline full history, Findings in Tasks and secondary history/receipt entries. **Verification:** TeamRoomPane/RunView tests and current tab/keyboard contracts.
- [x] Recent activity and Run facts: consistent compact recorded rows, meaningful progress/time, unknown cost explicit without a missing-field essay. **Verification:** RunSteps/RunFacts/RunInspector tests and Work screenshot.
- [x] Human and historical actions: exact recorded answer target, preserved Run identity, comparison/lifecycle actions, manual full-record collapse survives refresh. **Verification:** human-answer walkthrough and RunView historical/StrictMode regressions.

### Task 10: Integrate and publish the refreshed branch

- [x] Save the reviewed follow-up fixes and merge latest fetched development without rewriting published history: development cd33160d2 is contained in merge eec3f7161; the subsequent CI-duration-only commit 24aa8d7fd is contained in merge 8906ecece.
- [x] Finish the three acceptance audits. Remaining fixes bound Inspector paths/revisions and omit only confirmed empty optional conversation cards; preserve loading, failures/retry, recorded events and exact actions. An independent read-only review found no verified integration defect. Shipped-policy playback tests now cover all ten predefined Agent Flows.
- [x] Rebuild and refresh the local fake-agent app. Full UI: 677 files / 8,573 tests passed with four workers; typecheck/build/design-doc/interface checks passed. Browser discovery: 266 files / 6,509 tests (discovery only). Selected push gates passed; repeat on the final committed head before pushing.
- [x] Push the refreshed PR, update its exact-head evidence and request the local extra-eyes review. Keep pending CI/browser/native coverage explicit; do not merge.

### Task 11: New screenshot queue — task list, message bubbles and every information rail

Design: own messages use the existing right-hand user bubble; Agent messages retain left identity and recipient. Task controls form one compact hierarchy with occupied-state filters. Metadata rails use the same disclosure header, concise closed summary and independent actions. Optional empty collections disappear only after a successful read. Main Run/Conversation/Seats stay initially open; technical records fold. Opening an auxiliary tool gives it priority without losing the resting rail preference. An explicit reveal stays inside main, clears the measured composer and preserves tool actions; choosing another tool gives that tool priority again. Standing rail gaps follow the canvas; a floating sheet uses actual translucent material. No model/permission/action authority changes.

- [x] Dispatch independent Tasks/navigation, Channel presentation and canonical rail owners; read source and preserve prior behavior contracts.
- [x] Inspect Claude through computer use: actual section folding, collapsed Context/Changes summaries, tool-open automatic rail hiding, tool-close restoration, and explicit rail reveal in the narrow main. Restore its original layout and draft without sending anything.
- [x] Compact Tasks toolbar, occupied-state filters, grouped rows/counts and footer; retain Findings visibly with count and current state.
- [x] Rename Chat layouts Chat / Split, retaining the actual Flow named Side by side; move stopped-Run recovery into contextual navigation with exact identity.
- [x] Reuse the canonical user Bubble for own Channel messages, retain recipients/timestamps/grouping/status, and cap readable text widths.
- [x] Add consistent folding across Work, Run/step/Seat metadata, SkillPage asides and the Flow editor inspector; preserve warnings/loading/failure/retry, full controls and explicit unknown costs.
- [x] Implement measured composer clearance and subject-local tool/rail priority; retain exact resources and restoration. Fix the requester relationship label for assistive technology.
- [x] Verify all combined changes in both themes and narrow/wide geometry, including long labels, empty/error/full rails, Details plus manual rail reveal, own/grouped/Agent-directed messages and persistent composer.
- [x] Run focused source contracts, full UI/typecheck/build/design gates and hosted visual alignment specs; do not record a browser discovery as a passed execution or loosen geometry baselines.
- [x] Publish final source and inspected synthetic frames, update PR evidence and request review without merging.

### Task 12: Exact browser alignment evidence for the new queue

- [x] Migrate alignment-census and sentence-case checks from retired role Rows to the actual team-role-seat headers and Configure controls; retain exact geometry and optional Judge disclosure requirements.
- [x] Migrate only the Chat-layout selectors in the two frame contracts; preserve the Flow-choice names.
- [x] Dispatch repeat-test.yml on the published branch with runs=1 and copies=1 for alignment-census, edge-alignment, goal-bar-alignment, reading-column-edges and sidebar-edges; inspect every run and repair confirmed failures.
- [x] Record CUA geometry measurements and CI results separately, with exact source head and any unexecuted wider suites.


### Task 13: Fresh review follow-up

- [x] Review current design-system and interaction changes independently; retain incomplete review coverage explicitly.
- [x] Correct remaining Chat / Split browser contract selectors and enter optional Judge through Details, preserving all decision and refusal assertions.
- [x] Correct the long plain-task validation reason so it identifies the visible source of the limit; cover explicit Done when separately.
- [x] Execute the four additional affected browser specs and the current Team Work contract; inspect results and repair failures.


### Task 14: Narrow title and toolbar geometry found by hosted tests

- [x] Measure the failure through CUA: 360px viewport, 328px embedded Team frame, 302px top bar and zero-width title while all tool controls remain drawn.
- [x] Preserve the title floor and button sizes by moving narrow-only secondary controls into the existing More menu, retaining navigation and exact tool actions.
- [x] Restore the canonical page-control group to the opposite gutter while preserving its shared row alignment.
- [x] Rerun strict team-tabs, team-frame, publication and full census measurements on the corrected source; never weaken the title contract.


### Task 15: Final shared-action and focus follow-up

- [x] Keep inline approvals from stealing the composer caret or scroll position; preserve actual modal autofocus and keyboard safety.
- [x] Migrate the shared wall action helper and Split destination, including direct/overflow tool and rail doors without bypassing the UI.
- [x] Replace graph-seat warning paragraphs with the shared accessible issue mark and retain direct runtime recovery.
- [x] Review canonical TopBar lifecycle independently and repair folded-to-noncompact prop changes at positive and zero width.
- [x] Finish current-source full UI/gates, selected hosted browser matrix and final evidence publication.
