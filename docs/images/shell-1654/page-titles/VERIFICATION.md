# Verification

Code: [765b4b81](https://github.com/HarnessDesk/HarnessDesk/commit/765b4b8161edfb9cf6b2e014e715b4303290abfb). Captured 2026-10-15 from the preview harness.

- `pnpm check:push --fast`: exit 0. 5,886 related UI tests in 469 files; 98 script tests passed, two existing skips; Node build, UI typecheck and selected source/design/documentation gates passed.
- `node --test script/gates.test.mjs`: 265 passed.
- `node script/design-audit.mjs --strict`: exit 0 at the unchanged 2,122-finding ratchet baseline.
- `pnpm layering`: all 12 rules hold. `node script/ui-architecture.mjs`: exit 0.
- `git diff --check`: exit 0.

The 25 focused browser files below validated 926 distinct scenarios. Each ran alone through the shared machine gate, with one browser worker. Geometry contracts used the PR theme matrix; the 40 page-title scenarios and every published frame cover both themes. Commands used `pnpm test:ui-system e2e/ui-system/<file>.spec.ts --reporter=dot`.

The title run passed 39 scenarios, then all eight collapsed/scroll scenarios passed after adding an explicit wait for sidebar layout. Dashboard passed 170 scenarios, then its staged-review case passed after updating the shared selector for title-free canvases. Owner5 passed 14 scenarios, then its terminal case passed with assertions for draft isolation and restoration. Preview coverage selected the active destination-bar registration case; frame-wall selected Library skills and staged Changes review. The native-server Agent preview's heading, Start handler and server content also passed independently and in the related unit run.

| Browser file | Verified scenarios |
| --- | ---: |
| frame-contract-page-shell.spec.ts | 11 |
| frame-contract-settings-reading.spec.ts | 57 |
| frame-contract-settings-options.spec.ts | 31 |
| frame-contract-settings-navigation.spec.ts | 13 |
| frame-contract-teams.spec.ts | 36 |
| frame-contract-library.spec.ts | 26 |
| frame-contract-agents.spec.ts | 22 |
| frame-contract-plugins.spec.ts | 24 |
| frame-contract-review.spec.ts | 16 |
| frame-contract-page-layout.spec.ts | 141 |
| container-insets.spec.ts | 30 |
| settings-1632.spec.ts | 8 |
| frame-contract-top-bar.spec.ts | 70 |
| frame-contract-nonwork-leads-wide.spec.ts | 65 |
| frame-contract-nonwork-leads-standing.spec.ts | 65 |
| frame-contract-nonwork-leads-narrow.spec.ts | 65 |
| agents-window.spec.ts | 3 |
| page-actions-repairs.spec.ts | 4 |
| frame-final-pages.spec.ts | 2 |
| sidebar-roles.spec.ts | 8 |
| preview-coverage.spec.ts | 1 |
| frame-contract-page-titles.spec.ts | 40 |
| frame-contract-dashboard.spec.ts | 171 |
| frame-owner5.spec.ts | 15 |
| frame-wall.spec.ts | 2 |

All 68 DOM records measure a 40px bar. Every fixed button keeps its horizontal position and width in the 20 before/after pairs. The eight collapsed/scroll checks preserve identical bar DOM and rectangle after scrolling. The long-title checks preserve New skill's position and width.

The full browser matrix, remaining Node-package/end-to-end checks and native smoke remain with CI. No CI result was awaited. The full local verify suite was not run.

