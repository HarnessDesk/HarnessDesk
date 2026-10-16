# Flows page implementation plan

> **For agentic workers:** Use the approved D4 specification and execute the independent component slices with the parallel-agent workflow; integrate and review in this checkout.

**Goal:** Build, edit, save and start Flows from a dedicated destination, with one New Team dialog.

**Architecture:** Keep the host's Flow policy, authoring and preview APIs authoritative. Reuse ShapeEditor and ShapeGraph for editing, FrontDoor for Team creation, and shared design patterns for Flow cards and canvas controls.

**Tech Stack:** React, TypeScript, Vitest, shared FlowCanvas, preview harness and Playwright.

## Global constraints

- Work on `team/flows-page`; publish a draft PR, never merge.
- Follow D4 in `2026-10-14-panel-cards-and-team-bar.md` and the approved drawing.
- Preserve shell and Teams ownership fences from `.lead-brief.md`.
- Use public design exports, existing tokens and placeholder identities.
- Root agent owns integration and board commits; workers do not commit or push.

## Task 1: Shared Flow presentation

- [x] Add failing tests for a Flow card's origin, mini graph, empty Team and selection, and the floating toolbar's accessible groups.
- [x] Implement `FlowCard`, `FlowMiniGraph`, `FlowCardGrid`, and `FlowCanvasToolbar` in `design/patterns`, export them and register catalog contracts.
- [x] Run focused Vitest tests and inspect the catalog in both themes.

## Task 2: Editable Flow page

- [x] Add failing tests that exercise adding, connecting, editing, undoing and saving a Flow on a page.
- [x] Extend the existing ShapeEditor with a page presentation and ShapeGraph with connections, retaining source/preview freshness checks.
- [x] Compose the selected step, Rules, Triggers, Runs and Source cards with existing rail APIs. Start opens FrontDoor with the current Flow prefilled.
- [x] Keep the title menu, page rail toggle, floating tools and Graph/Steps/File views outside the bar.
- [x] Run ShapeEditor, ShapeGraph and page tests.

## Task 3: Shared New Team dialog

- [x] Add failing tests for choosing Just a Team or a Flow without leaving New Team, prefilled doors and dry run/start behavior.
- [x] Consolidate FrontDoor, GoalCreate and NewSessionChoice entry variants around the same dialog; retain role assignments, Done when and preview consent.
- [x] Use shared Flow cards with mini graphs and route Build your own to the Flow page.
- [x] Run focused front-door, creation and entry tests.

## Task 4: Destination and Settings integration

- [x] Add failing destination persistence, sidebar and Flow catalogue tests.
- [x] Add the Flows destination after Teams, load catalogues by project with origin/search filters and Run counts, and open a Flow or new draft on its page.
- [x] Remove Flow and Trigger sections from Settings; reuse Trigger controls on the Flow page.
- [x] Add preview fixtures for the Flows page, selected-step page and New Team dialog; update interface docs and changelog.

## Task 5: Review and publication

- [x] Run focused tests, UI typecheck and design gates, then unpiped `pnpm check:push`.
- [x] Inspect light/dark preview frames and added text for personal data.
- [ ] Commit with `commit_work`, push code and the separate `team/flows-page-frames` branch, and create a draft PR carrying the frame table.
- [ ] Record any unverified CI results, finish the card with `published`, and hand over without merging.

## Verification notes

- Added regression coverage before implementing catalogue/page/dialog and host removal behavior.
- Final review expanded coverage for inactive preview ownership, post-save readback conflicts, first-match rule order and overlapping/exact-source Undo.
- Public before/after frames use the preview harness with placeholder data.
- Publication follows a green `pnpm check:push --fast`; the full planner also runs, with broad CI-owned suites reported separately.

## Browser integration follow-up

- Updated the existing dialog, keyboard, footer and race contracts for one persistent New Team dialog.
- The new page workflow builds and edits a draft, saves the previewed bytes, then starts its current unsaved source in both themes against the synthetic backend.
- Fixed an effect-replay initialization bug exposed by that browser workflow; retired previews cannot replace the current token.
- Kept machine trigger preferences in a direct Flows specimen and added the new pages and pattern boards to the full preview inventory.
- The standard local push planner timed out only its unchanged 110-second retention child under server-suite concurrency; the isolated four-test retention file passed. The repository-supported fast push gate is used for publication, with CI results reported separately.
