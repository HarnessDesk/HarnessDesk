# One UI System migration

This is the durable implementation and verification record for the
repository-wide UI migration. The architectural decision is recorded in
`docs/decisions.md`; the per-file evidence is generated in
`docs/ui-system-migration-ledger.json`.

## Checkout and baseline

- Starting commit: `9f2d6dec1d8e7534c83a4c8d23d7b7d280fb3422`
- Branch: `codex/one-ui-system`
- Verification tree: uncommitted working tree on the starting commit; no
  commit, push, merge, publication, or release was authorized or performed
- Environment: macOS arm64, Node 25.9.0, pnpm 10.4.1
- Baseline: unmodified `pnpm verify`, exit 0
- Starting design debt: 271 findings accepted by the former historical
  baseline; 410 inventoried entries with 191 unresolved production entries

No unrelated checkout was reset, and no commit, push, publication, release, or
real account/session was used by this work.

## Finished architecture

The dependency direction is now:

`foundation -> Base UI-backed ui primitives -> HarnessDesk patterns -> feature composition`

- `packages/ui/src/design/foundation/tokens.css` is the editable semantic
  contract for color, type, spacing, density, measurements, radius, focus,
  motion, elevation, and renderer bridges. Preference sheets may override that
  contract as foundations; they do not define another component tree.
- `packages/ui/src/design/ui/` owns generic controls. `@base-ui/react` 1.7 is
  the only direct headless interaction foundation.
- `packages/ui/src/design/patterns/` owns typed product presentation contracts,
  including Settings rows, menus/popovers, composer, panels, confirmations,
  consequential approvals, cards, and transcript anatomy.
- `packages/ui/src/design/adapters/` owns the narrow CodeMirror/xterm/native
  integration contracts. External web and document content remains isolated.
- `packages/ui/src/design/catalog/` registers the real implementations rendered
  by `design.html`; examples do not maintain a second component copy.
- `packages/ui/src/design/index.ts` is the product-facing vocabulary. Features
  do not import internal primitive files or another screen's stylesheet.

The Electron About window consumes
`packages/desktop/electron/assets/about-foundation.css`, generated from the
same resolved token cascade by `script/check-design-tokens.mjs`. Native menus,
traffic lights, file pickers, and OS titlebar behavior remain recorded native
boundaries rather than imitated controls.

## Canonical edit locations

| change | canonical source |
| --- | --- |
| Every button and icon-button contract | `packages/ui/src/design/ui/button.tsx` |
| Every Settings row/group/page contract | `packages/ui/src/design/patterns/Settings.tsx` and its CSS module |
| All density, spacing, typography, radius, focus, and semantic colors | `packages/ui/src/design/foundation/tokens.css` |
| Generic dialog mechanics and focus/portal behavior | `packages/ui/src/design/ui/dialog.tsx` |
| Modal, confirmation, approval, and lightbox policy | `packages/ui/src/design/patterns/ModalDialog.tsx`, `ConfirmDialog.tsx`, `ApprovalDialog.tsx`, and `Lightbox.tsx` |
| Disabled or refused actions and their focusable explanation | `packages/ui/src/design/patterns/RefusedAction.tsx` |
| Menus and popovers | `packages/ui/src/design/patterns/Menu.tsx` and `Popover.tsx`, over `design/ui` |
| CodeMirror and xterm theme integration | `packages/ui/src/design/adapters/` |
| Public imports | `packages/ui/src/design/index.ts` |
| Real component catalog and coverage | `packages/ui/src/design/catalog/` and `packages/ui/src/design/explorer/` |

Run `pnpm design` and open the Vite URL at `/design.html` (normally
`http://localhost:5273/design.html`). Foundation, primitives, patterns,
product surfaces, migration coverage, and the propagation proving surface are
all rendered from production modules.

## Migration coverage

The regenerated ledger contains 425 tracked UI-producing files and zero
unresolved entries:

| disposition | count |
| --- | ---: |
| canonical | 81 |
| migrated | 163 |
| specialized boundary | 21 |
| verified boundary | 158 |

It covers production, catalog, tests, fixtures, tooling, native assets, CSS,
HTML, embedded visual templates, and generated assets. The terminal
file list is parser-generated, while every production disposition is an
explicit checked-in decision. A new file in a familiar directory still lands
as unresolved rather than inheriting that directory's status.

Removed alternatives include the Kit component/CSS/test API, direct
`radix-ui`, feature-owned Menu and Popover implementations, the legacy Dialog
primitive, alternate confirmation behavior, raw shared style exports, and the
old token location. All production consumers now enter through the public
design API or an explicit specialized/native boundary.

The strict design audit is zero in every category. Its baseline is a complete
zero schema and `--baseline` refuses to record non-zero debt.

## Executable prevention

`node script/check-ui-system.mjs` combines three independently tested gates:

1. `ui-inventory.mjs` requires an explicit per-file terminal disposition for
   every tracked visual source and fails closed even when a new file is added
   under a previously migrated feature or canonical directory.
2. `ui-architecture.mjs` rejects legacy imports/re-exports, alternate headless
   libraries, feature bypasses of the public design entrypoint, and generic
   control styling outside the system. Canonical-control `className` values
   must be statically understood layout-only compositions; arbitrary visual
   utilities and unresolved expressions fail closed. Feature CSS is parsed as
   nested rules, with comments removed and property names normalized, so a
   visual declaration cannot hide behind casing, comments, or `&` nesting.
3. `ui-catalog.mjs` requires every canonical UI/pattern module and every
   production surface from the independent surface registry to be represented
   in the live catalog. Every module declares variants, sizes, states, examples,
   and real production consumers separately. Every axis in a detectable CVA
   contract is checked against source-declared example coverage, including
   nonstandard axes such as orientation. A declaration counts only when the
   board iterates it and stamps the current case onto the rendered component;
   a joined metadata string cannot claim an unmounted state. CVA-backed entries
   cannot claim an exemption. Non-CVA exemptions name their own reviewed board.
   Symbol-aware reachability follows only the requested export and the
   dependencies its declaration uses, so an unrelated import from the same
   barrel earns no coverage. Dangling paths, unrelated consumer claims, path
   mismatches, and stale registrations fail.

Negative fixtures prove these checks fail for a legacy Kit import, a Radix
import, a re-export escape, a missing catalog entry, a cross-screen stylesheet,
raw shared design values, and duplicate generic control styling. The aggregate
gate runs in `pnpm verify` and CI. `design-audit.mjs --strict`, layering,
generated token/doc snapshots, and gate/CI drift checks form the remaining
guardrails.

## Verification evidence

### Browser and catalog

`pnpm test:ui-system` runs four Playwright tests against the live
`design.html` production catalog:

- one test-only foundation perturbation changes actual computed height,
  spacing, radius, type, semantic color, and focus across Settings, Composer,
  Board, dialog portal, menu/popover, CodeMirror, and the xterm adapter; reload
  proves no preference persisted;
- dialog and menu open states pass axe with only Base UI's exact upstream
  focus-guard sentinels narrowly identified;
- keyboard entry, safe Enter handling, topmost Escape, and focus return are
  exercised on the real dialog and menu contracts;
- dark mode, reduced motion, and 1024x768 rendering are captured.

Artifacts:

- `output/playwright/ui-system/propagation-light.png`
- `output/playwright/ui-system/propagation-dark-1024x768.png`
- `output/playwright/ui-system/report/`

### Native Electron

`pnpm test:ui-system:native` builds an isolated fake desk with a repository
fake Codex app-server and synthetic repositories. It captured and visually
reviewed 18 privacy-audited 1440x900 frames: desk, settings, conversation,
git, CodeMirror, xterm, board, room, and an actual Electron webview in light
and dark. The run closes and relaunches the same isolated profile and verifies
appearance persistence, draggable and clickable titlebar regions, accessible
search naming, and the native window title. The relaunch uses dark mode with
the editorial palette, violet accent, round corners, and studio interface, and
proves every axis reaches both the renderer and the real Electron About
auxiliary window. About loads the generated foundation and its computed
foreground, background, and radius match the main renderer.

A second real-app run at the supported 1024x768 native minimum captured desk
and Settings in both themes. It found and fixed a notice rail that overlapped
the sidebar wordmark at that width; the recaptured frames were inspected for
clipping, overlap, scroll ownership, and disappearing labels.

Artifacts:

- `output/native-ui-system/report.json`
- `output/native-ui-system/contact-sheet.png`
- `output/native-ui-system/frames/`
- `output/native-ui-system/about-dark.png`
- `output/native-ui-system-minimum/report.json`
- `output/native-ui-system-minimum/contact-sheet.png`

No real profile, credential store, repository, account, path, or transcript is
used. Each frame is rejected before writing if the privacy audit cannot vouch
for its visible text, attributes, or accounts.

### Current command record

| command | result |
| --- | --- |
| `node script/ui-inventory.mjs` | exit 0; 425 entries, 0 unresolved |
| `node script/check-ui-system.mjs` | exit 0; architecture and catalog coverage pass; 52 UI modules and 12 patterns |
| `node script/design-audit.mjs --strict` | exit 0; 0 findings |
| `node script/check-design-tokens.mjs` | exit 0; 1,678 values plus native foundation current |
| `node script/design-doc.mjs --check` | exit 0; generated documentation current |
| `pnpm test:gates` | exit 0; 218 passed |
| `pnpm --filter @harnessdesk/ui run test` | exit 0; 214 files, 2,598 tests passed |
| `pnpm test:ui-system` | exit 0; 4 passed |
| `pnpm test:ui-system:native` | exit 0; 18 app frames plus About; relaunch persistence passed |
| `pnpm test:ui-system:native -- --width 1024 --height 768 --scene desk --scene settings` | exit 0; 4 minimum-size app frames plus About |
| `pnpm --filter @harnessdesk/ui run build:site-demo` | exit 0 |
| `pnpm --filter @harnessdesk/desktop run pack` | exit 0; arm64 `.app` assembled and signed ad hoc |
| `pnpm --filter @harnessdesk/desktop run smoke` | exit 0; every promised installed bridge present |
| `pnpm verify` | exit 0; full repository gate passed unpiped from the final tree |

### Performance comparison

Both production bundles were built on this machine with Node 25.9.0 and pnpm
10.4.1. The starting commit's initial app JavaScript was 1,246.22 kB / 367.81
kB gzip; the migrated tree is 1,181.03 kB / 346.88 kB gzip, 5.7% smaller when
compressed. The catalog is a separate 86.61 kB gzip design chunk and is not
referenced by `index.html`. CodeMirror remains a separate 124.75 kB gzip chunk
and xterm a separate 249.15 kB gzip chunk.

The same isolated native `desk` capture at 1440x900 took 128.90 seconds at the
starting commit and 127.71 seconds on the migrated tree. That end-to-end number
includes fixture startup, a real Electron launch, the deterministic wait policy,
privacy inspection, capture, and runtime shutdown; it is a regression sentinel,
not a claim about interactive latency in isolation. Streaming, board, room,
resize, focus, and overlay behavior are exercised by the UI contracts, browser
suite, and nine-scene native sweep. No unexplained regression was observed.

## Boundaries and verification limits

- CodeMirror and xterm retain their engines behind token-derived adapters;
  the propagation suite inspects both DOM styling and applied renderer options.
- Native menus, traffic lights, titlebar behavior, and file pickers remain
  OS-owned. The first-party About HTML consumes generated foundation output.
- Webview pages, arbitrary websites, and user documents do not receive
  HarnessDesk styling; only their first-party surrounding chrome does.
- axe, semantic DOM assertions, keyboard/focus contract tests, and Chromium's
  accessibility representation are automated. A human VoiceOver session is
  not automated by this repository and must not be represented as one.
