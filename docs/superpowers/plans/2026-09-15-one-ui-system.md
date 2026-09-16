# One UI System Implementation Plan

> **For agentic workers:** Execute this plan inline and keep
> `docs/ui-system-migration.md` and `docs/ui-system-migration-ledger.json`
> current after every slice. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace HarnessDesk's parallel Kit/shadcn and screen-owned generic UI
with one Base UI-backed public vocabulary, one generated foundation, one live
catalog, and structural gates that require every production surface to use it.

**Architecture:** `packages/ui/src/design/foundation` owns all design values and
generated theme output; `design/ui` owns generic interactive primitives;
`design/patterns` owns typed HarnessDesk compositions; `design/adapters` bridges
specialized renderers; and `design/catalog` renders those exact implementations.
Features retain state and product composition only. A checked-in generated
ledger and parser-backed gates make bypasses and missing catalog coverage fail.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind 4, shadcn/ui registry source,
Base UI 1.7.x, CSS Modules, Vitest/jsdom, Node test, Playwright/Electron CDP.

## Global constraints

- Preserve product behavior, runtime capability checks, host authority, and the
  repository's security/privacy boundaries.
- Use Base UI as the only headless generic interaction foundation.
- Keep CodeMirror, xterm, syntax highlighting, and external document content
  behind explicit design adapters.
- Do not push, publish, merge, release, or expose real accounts or paths.
- Run `pnpm verify` unpiped after the final code change.

---

### Task 1: Baseline, inventory, and continuation state

- [x] Record `9f2d6dec1d8e7534c83a4c8d23d7b7d280fb3422` as the starting commit.
- [x] Run the unmodified full verification gate and record exit 0.
- [x] Add a tracked-source inventory generator with red/green tests.
- [x] Finish classifying every inventory entry with a terminal disposition.
- [x] Record deterministic baseline screenshots and performance measurements.

### Task 2: Canonical foundation and Base UI primitives

- [x] Move every editable visual decision under `design/foundation` and generate
  CSS/metadata/snapshots/docs from that source.
- [x] Port all Radix-backed `design/ui` primitives to Base UI and remove the
  direct `radix-ui` dependency.
- [x] Add contract tests for controlled/uncontrolled state, refs, forms,
  keyboard behavior, state attributes, focus entry/return, and portal scope.
- [x] Extend structural gates with negative fixtures for alternate headless
  imports, raw design values, legacy imports, and missing catalog entries.

### Task 3: One catalog and proving slice

- [x] Replace explorer/showcase duplication with a typed catalog manifest and
  Foundation, Primitives, Patterns, Product Surfaces, and Coverage views.
- [x] Register every public visual export and every production surface or exact
  specialized/native verification entry.
- [x] Migrate Settings, Composer, one consequential dialog, and one dock panel.
- [x] Add the token-perturbation propagation test across app/catalog, a portal,
  and a specialized renderer adapter.

### Task 4: Production consumer migration

- [x] Migrate shell/layout and all panel families.
- [x] Migrate conversation/composition, rooms/boards/tasks, and shared actions.
- [x] Migrate Settings/account/library/plugin surfaces.
- [x] Migrate source-control, usage, editor, terminal, browser, and preview
  surfaces through canonical components or documented adapters.
- [x] Migrate desktop auxiliary HTML and first-party plugin blocks.

### Task 5: Remove alternatives and zero the gates

- [x] Remove Kit, legacy Dialog/Menu/Popover implementations, raw style exports,
  obsolete theme sources, duplicate mock layouts, and unused dependencies.
- [x] Resolve every design-audit finding without raising a baseline.
- [x] Require zero unresolved standardization findings and zero generic-control
  migration exceptions in `pnpm verify` and CI.
- [x] Regenerate documentation and update contributor guidance.

### Task 6: Product-level verification

- [x] Run unit, contract, typecheck, build, site-demo, layering, design, and full
  repository gates from the final tree.
- [x] Run catalog coverage, browser interaction, visual, responsive, and
  accessibility suites with deterministic fixtures in light/dark and densities.
- [x] Build and exercise the real Electron app with an isolated profile and fake
  runtimes, including relaunch persistence and native/auxiliary windows.
- [x] Compare bundle/performance measurements and inspect every captured frame.

### Task 7: Final handoff

- [x] Reconcile the ledger to zero unresolved production entries.
- [x] Record exact commands, commit, environment, exit codes, and artifact paths.
- [x] Answer the canonical edit-location questions and document any truly
  unavailable acceptance gate as BLOCKED rather than passed.
