# Session Remove Implementation Plan

**Goal:** Implement approved sidebar index slice 3a: Remove with Undo, and Trash-only Delete everywhere.

**Architecture:** Keep Remove in the local index and transcript database, using the existing session close path before marking a row. Preserve bodies during the Undo window, then drop body tables and metadata atomically. Declare native deletion disposition at the adapter boundary; both host and UI admit only Trash for Delete everywhere.

**Constraints:** Own branch and checkout; no worktree lifecycle or Team wrap work (slice 3b); no real stores or accounts; no full local verifier; narrow tests and gates, headless synthetic frames; publish but never merge.

- [x] Write host regressions for hide/Undo, timed and launch cleanup, byte-identical agent files, stop-before-remove, atomic delete and refusal; run red through the machine gate.
- [x] Declare `deleteHistory: false | 'trash' | 'erase'`; update ACP handshakes, bridges, native adapter, fixtures and readers. Add `session/remove` in wire, validator, then context/handler. Keep pending observations from reviving removed records. Implement transactional cleanup and startup scheduling; run host and adapter tests green.
- [x] Write UI regressions for menu states and tooltip text, Remove's action toast, and Trash confirmation; run red. Implement menu, store single-row updates and ConfirmDialog; migrate Archive's shared delete affordance to the same Trash policy. Update interface and decisions.
- [x] Find named tests across packages, scripts and browser specs; run relevant files, typecheck, strict audit and layering. Capture before/after menu and dialog in both themes from the preview harness, inspect every frame.
- [x] Commit with `commit_work`, fetch and merge current main, rerun affected checks if needed, push the code and separate frames branches, create one PR with frame previews and validation, complete the card as published.

**Verification:** 724 Node tests, 332 UI tests and 266 gate-script tests passed; build, typecheck, layering, strict design audit, generated design documentation, interface drift, documented paths, reachable methods and secret scan passed. The three named browser files passed (23 tests). Twelve synthetic before/after frames were inspected in both themes.

**Timing:** The landed spec wins over the earlier brief: body retention ends at the eight-second Undo deadline.

**Published:** [PR #1538](https://github.com/HarnessDesk/HarnessDesk/pull/1538), from `sidebar-3a-remove`, with the inspected PNGs on `sidebar-3a-remove-frames`. All twelve raw image URLs returned HTTP 200 with matching hashes. The Flow owns review and landing; full verification remains with CI.
