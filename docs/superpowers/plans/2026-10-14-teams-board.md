# Teams board implementation plan

**Goal:** Implement issue #1657's approved D3 drawing from main.

**Architecture:** Keep the existing plain Team/Overview facts and bounded Run,
review and usage readers. Derive board placement in `lib/teams-board.ts`.
Compose a store-free `design/patterns/TeamsBoard.tsx` contract in TeamsWindow.

**Constraints:** No dependencies or protocol changes. Tokens and public design
exports only. The page bar holds Teams and More; New Team, project scope and
search live in the body. Wrapped Teams fold below Ready to wrap. Use the
preview harness for public frames, on a separate frames branch. Never merge.

1. Add `teams-board.test.ts`: attention, running, idle with work, ready, wrapped,
   stopping, stopped and failed checks; unique placement; truthful Flow segments;
   first-sentence titles. Run Vitest and observe the missing board contract.
2. Implement `teamBoardColumn(row)` and `teamBoardItem(input, prefs)`, reusing
   `teamListRow`, `flowModel` and `flowOverlay`. Stopped work needs the person;
   stopping and unfinished idle work stay Working. Wrapped is a subgroup of Ready.
3. Add pattern tests for semantic column names/counts, keyboard card opening,
   full brief hover text, complete attention text, segments and folded content.
   Implement the pattern, export it and register its production preview.
4. Update TeamsWindow tests for all three visible columns, project and text
   filtering, New Team, read/open marks and wrapped loading. Preserve bounded
   retry, inactive-page and minute-clock assertions. Compose the pattern and
   extend the fixture with a wrapped Team.
5. Update browser contracts to assert the approved board, body controls,
   stacking, history and opening. Update interface/decision/changelog text and
   regenerate the design reference. Capture before/after light/dark and narrow.
6. Run focused Vitest, UI typecheck, strict design/architecture gates and
   `pnpm check:push` unpiped. Inspect every public frame and added line for
   personal data. Commit with `commit_work`, push code and frames branches,
   then open a draft PR with the frame table and validation results.
