# App frame integration execution

Base: `07104b664` (B Tasks 1–7a). Only this integration worktree is written.

## Sequence

- Frozen-lockfile install: exit 0.
- Node build and UI production build: exit 0.
- Merge A repairs, then D Tasks 1–5 and fixes, then C Tasks 1–2.
- Run requested gates and one full browser suite; fix defects with separate commits.
- Capture INT1 and review every changed frame against B7a, D7labels, C and the approved drawings.

## Conflict resolutions

All three branches merged below.

## Owner questions

None pending. The owner approved keeping the small Browser tab-close repair and the passing census. All twelve changed Browser frames are intended changes and are listed in REVIEW-INT.md.

### A repairs

- `docs/design-system.md`: regenerated from the resolved source; no hand merge. Token snapshot/native output regenerated and unchanged.
- `TeamBoardPane.tsx`: retained B's TopBar slots and body SummaryList; A's dense canvas gutter is already present in B.
- `ViewBar.tsx` / stylesheet: retained B's deletion. A's table-alignment intent survives in the Board summary and the unchanged rendered equality assertion in `team-board-list.spec.ts`. The retired-component unit checks were migrated to `BoardSummary.test.tsx`, checking the replacement summary and absence of a second title/action bar.
- `team-board-list.spec.ts`: kept B's summary selector and click target, while preserving A's summary-to-first-cell edge check and all geometry/action assertions.
- `key-value.tsx`: retained B's flat panel SummaryList surface and panel numeric alignment; removed mixed-card numeric overrides per A, with both branches' tests intact.
- `tool-pane.tsx`: retained B's tool inset and flat section spacing, plus A's canvas inset semantics.
- Audit measured unchanged: singleAreaPrimitive 12, retiredComponent 86, pageMeasureInScreen 21, screenLayout 3063; all charged categories 0.

### D left column

- `docs/design-system.md`: regenerated after resolving source and measuring the audit. Token snapshot/native outputs regenerated.
- `audit-baseline.json`: discarded conflict text and measured resolved code. Ceilings decreased to singleAreaPrimitive 11 and screenLayout 2955; retiredComponent 86 and pageMeasureInScreen 21 remain B's lower values.
- `frame-contract.spec.ts`: retained B's entire contract and appended every D-specific loop/test; common inherited A tests remain once. Both helpers/import sets retained.
- `frame-wall-destinations.ts`: union of all B and D destinations with typed D action fields.
- `frame-wall.spec.ts`: retained B's tab/View dispatcher and all lazy-tool readiness checks, then applied D left-column and Settings-search actions. No retired tab click path restored.
- `Sidebar.tsx`: adopted D's one-row header, ordered page doors, list body and seat; retained B's existing store/callback/menu/slot behavior.
- `design/index.ts`: retained both branches' public exports.
- `frames-frame-wall.tsx`: retained B's recorded Run/tool fixtures and D's left-work store/destination.
- `preview/main.tsx`: retained B's frame adapters and D's new probe routes/imports.

### C menu row and plate

- `docs/design-system.md` / `audit-baseline.json`: measured resolved source and regenerated docs; generated token/native outputs also refreshed rather than hand merged.
- `frame-contract.spec.ts`: preserved the complete B+D file and appended every C menu/Composer probe and geometry helper.
- `frame-wall-destinations.ts`: retained all B+D descriptors and appended all C popup descriptors; typed the combined actions.
- `frame-wall.spec.ts`: kept B+D dispatch/readiness and added C popup/Composer actions afterwards.
- `catalog/manifest.ts`: union of LeftColumn and menu-row registrations for both variants and states.
- `explorer/boards-compositions.tsx`: both LeftColumn and popup board entries, imports, definitions and appended Settings/work boards retained.
- `design/index.ts`: all B+D exports plus C popup stylesheet and row exports retained.
- `frames-frame-wall.tsx`: retained B's tool fixtures and D's work store, adding C's PopupWall import/rendering.
- Composer/Menu/Popover auto merges retain existing B wiring plus C's canonical row/plate implementation; no consumer was retired beyond C's committed subset.

## Initial gates and repair evidence

All three merge commits complete: A `a6550b205`, D `225ddbcdb`, C `cdb82bbb7`.

- Initial strict audit, UI tsc, UI-system architecture/catalogue, tokens (2198 values plus native), generated doc, interface drift and alignment census: exit 0.
- Initial full units: 525 files, 6656 passed / 21 failed (6677 tests). Failure details are local in INT-unit-failures.log.
- C replaced menu CSS classes with stable row data attributes. Updated WorkspaceMenu and SessionTree test selectors only, retaining exact labels, refusal reasons, clipboard/move/rename/filter callbacks and counts. WorkspaceMenu trailing values similarly moved to the canonical trailing slot.
- WorkspaceMenu's inherited reset-vs-move glyph assertion exposed C's new default no-icon presentation. Declared the existing complete icon policy on the parent and Move submenu (all rows already supplied icons), preserving distinct icons.
- C lost public MenuLabel compact behavior: restored data-size and its existing token-based normal weight under the shared popup sheet; retained its test with canonical selectors.
- B moved the conversation's state chip to TopBar slots and the Board filter to Tabs: corresponding source/selected-state checks now target the real replacements, with their existing expected state and spinner/motion checks.
- D moved Sidebar's corner Bar to LeftColumnTop: the lights check follows both the Sidebar composition and the shared pattern's corner Bar, retaining the same clearance token assertion.
- B's fixed tool state supersedes a raw legacy right dock: Notices narrow-overlay fixture now declares the real per-subject open Activity tool, retaining the same covered-composer/strip/dismissal assertions.
- Initial contract discovery included standalone D pattern probes in B's work-shell loop. Classified standalone patterns explicitly; all original B work destinations and every D-specific numeric check remain covered. No product value, limit or test assertion was loosened.

The A notes path contains images and changed-frames.txt, but no EXECUTION/REVIEW files; source commits and rendered checks provide its integration evidence.

### Repair validation checkpoint

- All UI units: 525 files / 6677 tests passed, 0 failed; exit 0 (INT-units-final.log).
- Focused repaired files before final unit sweep: 301 passed / 3 failed; the three remaining failures were canonical trailing-slot selectors and Workspace Move icon policy. Final Workspace focused run: 11 passed / 0 failed.
- Production UI build: exit 0; bundle-size warning only. Node build passed before merging.
- Final repair typecheck: exit 0 after adding the required Activity mode to the Notices fixture. All seven structural/script gates pass with ceilings unchanged.
- Initial frame-contract run was interrupted after repeated misclassification failures: 69 passed / 10 failed / 1 interrupted / 52 not run, exit 130. The mixed source-edit/HMR window also emitted a transient TopBarProvider error; a fresh-server rerun is required rather than treating it as proven product failure.
- No approved snapshot was written. B7a copied read-only from the supplied notes checkout.

### Shared navigation inset repair

Fresh contract run: 120 passed / 12 failed, all D7 group-label cases. B migrated NavigationGroupHeader spacing into GroupLabel's navigation surface; D's Projects header also carried its own inset. Their combined start padding moved Projects to x24 while the row icons remained x16. Added a named row inset to the shared GroupLabel/NavigationGroupHeader contract and selected it for LeftColumnProjectsHead. Existing bar/nav defaults remain. D7 rerun: all 12 passed across 1440/1100/720, light/dark and Desk/Studio, including x, type and exact 16px following-group gaps.

The earlier compact menu-label normal-weight repair was incorrect against FRAME's 12/500 menu-group contract. Kept the legacy size metadata, removed its normal-weight exception and strengthened the account-menu test to require the canonical medium weight and reject an override. Fail-first focused run: 1 failed / 3 passed; corrected focused run: 10 passed across the menu, navigation and left-column unit files. An accidentally expanded unit invocation was interrupted; its loaded-machine fixed-shell timing failure passed on a focused rerun (34/34).

Strict audit, typecheck and all five remaining script gates pass; ceilings remain 11/81/21/2955. No owner decision was needed.

### Full browser suite and canonical probe repairs

The one full browser run ended exit 1: 1172 passed, 114 failed, 113 skipped (1399 total). Exactly 16 failures are the supplied baseline focus-ring failures: 14 in focus-ring.spec.ts and 2 in focus-ring-frames.spec.ts. The other 98 failures are tracked in INT-browser-failure-queue.json; their original contexts are preserved in INT-full-results. All 132 frame-contract cases passed within this run.

Repairs preserve the prior behaviors and their negative/mutation proofs, with selectors and fixtures on the replacement surface: D left rows, icon-edge project labels and flat Teams; B folded destinations, Details Seats, canonical filters and fixed tool intents; C canonical menu row slots. The retained HeaderStatusGroup and PlanMeters APIs now have real isolated specimens rather than depending on a product header that B deliberately retired. No approved snapshot was re-recorded.

Actual defects repaired: wide footer popup cannot fall back laterally; popup fill reads the shared floating-surface token; keyboard panel/terminal close restores the saved main target; isolated approval fixture mutates its own approvals. Composer notice dismissal now accounts for the 32px track’s 30px coin clearance, retaining the existing <=1 trailing-column check and preserving B7a composer geometry. The send size has a named foundation token with the unchanged 30px parity assertion. Studio destination rows now use FRAME's same 30px token, retaining the strict global row agreement check rather than expanding the allowed range.

The census no longer mistakes GroupLabel's semantic variant for a painted surface. Frame titles declare their own bar inset (8px plus lead/parent slots), separately from the reading gutter; a new translated-title mutation check preserves detection. Three obsolete B header findings are removed and Browser tool controls now edge-pull their final close glyph, removing the old tool-tab trailing debt: ceilings 1/3/5 -> 1/2/2, never increased.

The metrics table migrates exactly the intended B geometry, not arbitrary observed numbers: SummaryList paints its border inset, so the three-row card loses the two external border pixels (280 -> 278); all three Team bar cases remain measured on their replacement Bar (48px ToolPaneHeader -> FRAME 40px Bar, padding 8px). Text, weight, line and radius expectations are retained. This is an explicit contract migration; UPDATE_METRICS is not used.

### Final focused repairs

Focused repair 1: 410 passed / 16 failed (426 tests); repair 2: 136 passed / 3 failed (139 tests). Both ran only previously failing files; a first unanchored faces file pattern also selected surfaces.spec.ts, which passed. Later patterns use exact anchored file paths.

The remaining placement findings came from real inset ownership: ToolBodyControls declares its existing transparent 12px inset as a surface; Activity’s legacy secondary pane title uses the same tool inset through DockPanelBar, without the old extra text margin. No exclusions or tolerances changed. Reduced-motion row geometry is measured after scrolling into view, before synchronous focus; stable-slot/visibility/no-transition checks remain. The template journey establishes the intended two visible conversations through current Chat layout controls.

Full unit sweeps exposed timing-dependent jsdom zero-width TopBar folds in routing fixtures. Their title geometry now states FRAME’s unchanged 180px floor; browser fold and geometry contracts remain real. No duration/timeout/assertion was relaxed.

Final full units after explicit routing-fixture geometry: 525 files / 6677 tests passed, 0 failed, exit 0 (INT-units-complete-3.log). UI tsc exit 0 (INT-tsc-final-3.log). Six script gates exit 0; token snapshot contains 2202 values, native foundation unchanged in git. Audit baseline remeasured at 11/81/21/2955 (all other categories zero), below each input branch. Added-line privacy scan found only analyst@example.com and no local-user paths.

Template journey: canonical Side by side initializes every roster member, including the Judge. Through the visible Judge tile menu, Take off the grid removes only that comparison-unrelated tile; the exact two-tile assertion remains, with explicit Picked and Not kept checks added.

Focused repair 3: 27 passed / 1 failed, exit 1. All census placement/mutation, reduced-motion and notice layout checks pass. Template journey failed earlier than the new grid action: the synthetic judge completed at the base revision while its picked review identified an attempt revision; the person merge card was not created. Investigating the scripted peer ordering/fixture evidence before rerunning only that file.

Repair commits (same required co-author trailer):
- 637dadbc1: canonical inset owners, pane/title/glyph alignment, token ownership, explicit metrics contract migration.
- 8c8c479c3: panel focus restoration, measured mounted Browser chrome, isolated retained API specimens and approval/coverage fixtures.
- c3650eee5: browser probes follow integrated rows and navigation while retaining behavior, boundaries and mutation assertions.

Wall capture uses the exact requested INT1 command, one worker/run. No approved snapshots are updated.

### Visual review and account-menu resolution

INT1 initial capture: 112 browser cases passed, 336 frames / 56 destinations, exit 0. Wall generated with --before ../B7a. All 336 frames opened: root 60, panel 84, header 96, row 96, with B7a/D7labels/C2/drawing references. Initial diff: 150 changed / 90 identical B7a frames plus 96 new D/C frames. The copied B7a is not re-recorded.

Six left-account frames exposed a D/C merge defect: canonical C label wraps D’s rich profile/account children in block flow. The shared Menu pattern now supplies one flex line for its existing profile/account layouts inside the canonical label, retaining Base UI menu behavior and all plain-row contracts. Only those wall cases will be recaptured and inspected.

Non-left changes: twelve Browser/draft-Browser frames contain the census-driven tab-close edge adjustment. Four other frames have only 4/5/6/12 glyph-edge pixels with unchanged text/geometry; those are recorded as rasterization anomalies, not claimed pixel-identical. Settings720 changes are in D’s retained navigation column, which remains standing on that separate Settings surface.


### Approved Browser edge and account recapture

The temporary Browser rollback was rejected by the unchanged census in focused repair 4. The owner chose the recommended edge repair; restored the committed code without changing a check or ceiling. Repair 4 also completed the whole comparison template journey; the earlier person-merge failure did not recur. Fix-and-review then exposed an exact-text selector resolving the hidden accessible branch-name span, rather than its visible head/tail.

Account recapture: 2 cases passed / 0 failed, six frames. All six opened after repair; profile face/name and account mark/name/usage now share one canonical row. Commit a553819b7 contains only Menu.tsx and Menu.module.css. It uses the repository configured identity with no identity overrides; earlier commits remain unchanged.


### Final brief gates (after account repair)

Generated doc, token/native snapshots and measured audit baseline regenerated from final product source; no resulting git changes. Each command is unpiped and its actual exit status is read. Final completed checks:

| Command | Result |
|---|---|
| node script/design-audit.mjs --strict | exit 0; 0 new charged violations; grandfathered ceilings 11/81/21/2955 |
| pnpm --filter @harnessdesk/ui exec tsc --noEmit -p tsconfig.json | exit 0 |
| pnpm --filter @harnessdesk/ui test | exit 0; 525 files, 6677 passed, 0 failed |
| node script/check-ui-system.mjs | exit 0; 60 canonical UI / 42 pattern modules covered |
| node script/check-design-tokens.mjs | exit 0; 2202 values plus native snapshot match |
| node script/design-doc.mjs --check | exit 0; 2238 generated lines current |
| node script/check-interface-drift.mjs | exit 0; 7 deliberate Desk declarations, 9 Studio-only tokens with Desk fallback |
| node script/check-alignment-census.mjs | exit 0; 1/2/2, monotonic against gate ancestor 1/3/6 |

UI unit log: INT-final-units.log; other final gate logs: INT-final-{audit,tsc,ui-system,tokens,doc,interface,census}.log. The interface gate's unpaired Menu rewrite note was read by eye; the rich-row adapter composes C's canonical label with D's account children and does not alter tokens.

Audit input ceilings, in order singleAreaPrimitive / retiredComponent / pageMeasureInScreen / screenLayout:

| Input | Before |
|---|---|
| B base 07104b664 | 12 / 86 / 21 / 3063 |
| A 0949d61d9 | 12 / 115 / 22 / 3273 |
| D 8d85d6c00 | 12 / 115 / 22 / 3165 |
| C c13e4b6d8 | 12 / 110 / 22 / 3273 |
| Lowest input ceiling | 12 / 86 / 21 / 3063 |
| Final integration | 11 / 81 / 21 / 2955 |

All other categories remain zero. Every final ceiling is at or below the lowest input; no ceiling was raised.

REVIEW-INT.md readback: 336 unique actual frame rows with all ten checklist columns, no F codes, 150 changed / 90 identical B7a frames plus 96 new D/C frames. All 240 copied B7a SHA-256 hashes are unchanged. Six account recaptures reviewed; approved Browser source restored to its original passing repaired state. Drawing differences are recorded as inherited/pending, not claimed complete.


### Template navigation cause, not a relaxed assertion

Focused template rerun reached and completed comparison, then completed fix-and-review writer/reviewer handoff. The visible/full branch proof passed. Next failure showed Repository history in the fixed right tool while a new migration probe incorrectly expected it in main. Source proves git defaults right (`panels/builtins.tsx`, `Store.openGitHistory`, `state/frame-tools.ts`); B's spec explicitly removes right-tool zoom at lines 101/159/460. The retired “Give this panel the whole area” action is moot under this deliberate B contract, not restored. Its replacement must verify the actual 400px fixed tool and real graph/checkout/merge behavior. The canonical Activity toggle closes this retained Git mode; global Back would navigate main unnecessarily. Original exact revision, ancestry, card count, Ready count, no renderer errors and visible journey assertions remain.

Failure-only diagnostics are local and retained; no pre-existing failure on an input branch is claimed. The earlier comparison person-handoff delay did not recur on the next two runs. An initial anchored file regex selected no tests (exit 1); corrected filename-suffix selection runs only template-journeys.spec.ts.


The supported repository replacement first asserts the default fixed panel is exactly FRAME.rightPanel.width (400), then uses the keyboard End on its real resize separator to assert FRAME.rightPanel.max (640). GitPane's branch rail is available at that canonical maximum. This is a renderer action, not a store mutation or a larger timeout; the existing exact main double-click/current marker and publish-head ancestry proof remain. The retired zoom button is explicitly asserted absent. Closing Activity preserves the active Team Board and verifies the tool is hidden.

Known baseline failures in the one full browser run are exactly 16, unchanged files:

- focus-ring-frames.spec.ts: focus frames in light and dark (2).
- focus-ring.spec.ts: in each theme, palette caret; sidebar Tab/arrow vs click; pointer-opened vs keyboard-opened row-menu focus return; Open focus menu return; Open dialog return; Input/Search Desk border; Input/Search Studio border (7 per theme, 14).

The other 98 failures belong to 30 files; focused rerun evidence, rather than a second full suite, is used to close them. The full-run counts remain 1172 passed / 114 failed / 113 skipped. No claim is made that a second full run finished with only 16 failures.


Final frame-contract gate: exit 0, 132 passed / 0 failed (INT-final-contract.log). All nine brief gates are now green. The final focused run selects only the two previously failing files: restored Browser census and template journeys.


### Proven input-branch resize-bound discrepancy

Final focused run: alignment census 14 passed / 0 failed. Template reached actual repository resizing and failed the new exact640 assertion after End: observed 900, expected 640. All four pinned input copies of `packages/ui/src/state/workbench.ts` prove right min280/max900: B07104b664, A0949d61d9, D8d85d6c00, Cc13e4b6d8 (full pins/lines in INT-input-resize-proof.json). B alone starts at FRAME 400; the older inputs start460. ResizeHandle End chooses its supplied maximum; Workbench's seam and model use these same inherited limits. No merge changed this bound. This proves the discrepancy predates integration; it is not claimed to originate here.

The spec/FRAME declare right drag320–640. Changing the product clamp would also migrate existing floor280/geometry/window-limit contracts. This integration preserves those input tests and records the inherited discrepancy. The template's purpose is real repository checkout/merge, so the renderer now receives a measured pointer drag to exactly640 (same exact640 assertion retained), rather than asking End to choose a legacy maximum. No numeric assertion, count, timeout or tolerance was loosened; no store state is set directly. Current fixed-width400 wall images are unaffected.

The earlier note that End commits FRAME max 640 was an incorrect source assumption, corrected by the fail-first900 evidence above. The actual desired-width pointer gesture replaces that action. The input-bound mismatch remains known future framing work, with no product decision requested or merge-side test discarded.


### Synthetic repository author isolation

Next focused template run passed exact400/default, exact640/pointer resize and the original main checkout/current marker. The privacy assertion refused the selected setup commit's Author field at 10-person-repository. The seed already configures a local placeholder author; inherited author/committer Name/Email environment variables overrode it in the test process. The fixture now saves and removes those inherited keys inside its own isolated subprocess and restores them after Host/extension shutdown or setup failure. It assigns/passes no placeholder author environment and changes no integration repository or parent-shell identity. Ordinary local fixture config supplies synthetic commit content. The privacy gate remains unchanged and fail-first evidence is preserved in INT-template-privacy-failure.log; no private account text or diagnostic image is committed.

All integration commits from a553819b7 onwards use ordinary git commit and match git var GIT_AUTHOR_IDENT. No author flag, user-name/email -c setting or author/committer environment override is supplied for them. Earlier commits are left unchanged, as instructed.


### Final template and browser closure

Final template rerun: exit 0, 1 passed / 0 failed (INT-template-final.log), both shipped journeys complete, 68 frames pass the unchanged privacy audit. Comparison retains two distinct committed attempts, exact two comparison tiles/Picked/Not kept, actual person merge and six Ready cards. Fix-and-review retains initial full branch proof, default400/exact640 width, exact main checkout/current marker, actual published-head merge ancestry and three Ready cards. Both finish Overview/Run/Board/Chat with settled Sidebar and no uncaught renderer errors.

The latest focused result for all 30 non-baseline files is 411 passed / 0 failed across their last runs. These close all 98 original non-baseline failures; per-file status is local in INT-focused-status.json. This is combined focused evidence, not a repeated full run. The restored census's 14 cases pass; the mixed census/template run had one template failure before author isolation, now resolved by the single-file rerun.

Template repair commit: adf5f9a60. Only script/shots/templates.mjs and script/shots/template-rig.mjs staged, with ordinary configured identity and required co-author trailer. No product resize bound or existing bound test changed.

## Final handoff

All requested merges complete in the required order and as separate merge commits. All nine brief gates pass; all original non-baseline browser failures pass focused verification. Full suite remains its one recorded run: 1172 passed / 114 failed / 113 skipped, of which the supplied 16 focus-ring failures are unchanged baseline files. Wall and account capture pass, every frame is reviewed, B7a hashes unchanged, and the 12 Browser changes have owner approval.

Owner questions: none pending. Known inherited limitation: right drag bounds remain280–900 vs spec320–640, proven on every input branch and disclosed in REVIEW-INT.md; default frames and the requested640 journey remain canonical. B8–11/final drawing work is not integrated and other worktrees/root checkout are not written. A's stated EXECUTION/REVIEW files were absent. No approved snapshot was re-recorded; no push, PR, rebase or stash was performed. Only the two textual evidence files are committed from output; images, logs, diagnostics and helper files remain local.

## Integration commit ledger

- `a6550b205`: Merge the phase A browser-check repairs
- `225ddbcdb`: Merge the left column (phase D Tasks 1–5)
- `cdb82bbb7`: Merge one menu row and plate (phase C Tasks 1–2)
- `e3c3dbfc3`: Preserve menu contracts across canonical row integration
- `113bd708e`: Keep frame checks on their integrated shell and row targets
- `1e5d8dd95`: Keep integrated group labels on their canonical edge and weight
- `637dadbc1`: Align integrated frame controls with their canonical insets
- `8c8c479c3`: Keep integrated panel focus and preview fixtures on canonical hosts
- `c3650eee5`: Exercise integrated frame navigation and rows in browser probes
- `a553819b7`: Keep account menu details on one canonical row
- `adf5f9a60`: Keep template journeys on canonical navigation and isolated authors
