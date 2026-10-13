# Editor mode: implementation plan

*2026-10-12. Builds `docs/superpowers/specs/2026-10-10-editor-mode-design.md`
(the spec) on `main` after the app frame (#1586). The spec is the contract;
where this plan and the spec disagree, the spec wins and the plan is wrong.
The owner approved the spec and a clickable prototype of it.*

One pull request, built task by task, one commit (or a few) per task. Each
task ends green on its own narrow checks before the next starts.

## The look, in words (from the approved prototype)

- **Switch:** right end of the left column's top row, after back and forward.
  A grey track (`--hd-` muted fill) holding two 26×22 icon buttons, a speech
  bubble (Conversation) and `</>` (Editor). The selected one is a raised pill
  (surface fill and the small shadow), never an accent fill. Greyed as a whole
  on a destination that is not a conversation; absent in Settings.
- **Explorer (left column middle):** a header row with the folder's name
  (bold 13, truncates, `title` = full path) and a segmented `All | Changed 4`.
  Then the tree in the left column's one row anatomy: chevron, folder or file
  icon, name, and a trailing git letter (M amber, A green, D red, R) in the
  code font. A changed file's name takes its letter's colour. A foot button
  "Go to file ⌘P" styled as a quiet input.
- **Main:** a tab strip (36 high) on the left column's fill; the active tab is
  on the editor's fill with a 2px accent line on top; a preview tab's name is
  italic; one 20px trailing slot per tab shows the unsaved dot and turns into
  the close button on hover (a tab never changes width). Under it the file's
  bar (38 high): the path in the code font, an "Unsaved · Save ⌘S" button
  only when dirty, then the view toggle (`Preview | Source | Changes +11 −3`).
  Then the file: Source with line numbers; Changes as a unified view with
  green added lines and red removed chunks and a `+`/`−` column; Preview as
  the Markdown document (max 720 wide, centred) with an **Edit** button at
  its top right.
- **Ask in chat:** a small floating button above a selection, "Ask in chat
  ⌘L", on the editor's surface with the popover shadow.
- **Change on disk with unsaved edits:** a `Banner` across the file, "README.md
  changed on disk while you had unsaved edits.", with Compare, Reload, and
  Keep mine (primary).
- **Right panel in Editor mode:** the tool icons gain a speech bubble first;
  selected by default, it shows the conversation, composer at the foot, in the
  panel's width. The top bar's place reads `Conversation title › path`; the
  title is a link back to Conversation mode.

## Ground rules for the build

- **The frame hold is released** (the frame landed as `7851af482`): this work
  may edit `app/App.tsx`, `panels/*`, `state/*`, the sidebar, `design/patterns`
  and the frame spec where a task says so. Keep each such edit to what the
  task needs.
- Build with the design system (AGENTS.md rules 9–12). New shared UI goes in
  `design/patterns` with its catalogue entry; icons in `components/Icons.tsx`;
  type from the scale; no raw literals where a token exists.
- The UI never names a runtime (rule 8). Agent output stays sanitized (rule 5).
- No new wire methods. Use `workspace/browse`, `workspace/files`,
  `workspace/readFile`, `workspace/stat`, `file/save`, `git/status`,
  `git/diff`, and `app/state/get|set` for what persists.
- New npm packages: `@codemirror/merge`, `@replit/codemirror-vscode-keymap`,
  `@replit/codemirror-minimap`, all MIT, in `packages/ui`. Update the
  lockfile and the third-party notices (`pnpm verify` checks them), and keep
  all three in the editor's lazy chunk (check the build's chunk list: none of
  them may land in the entry chunk).

## Task 1. The `editor` module and its boundary

- Create `packages/ui/src/editor/index.ts`, the module's only entry.
- Add a gate (extend `script/ui-architecture.mjs`, or a new
  `script/check-editor-boundary.mjs` wired into `pnpm verify`, the CI
  workflow and `script/check-verify-drift.mjs`'s expectations) that refuses
  any import of `src/editor/<anything but index>` from outside `src/editor/`.
  Test it in `script/*.test.mjs` with one passing and one refused fixture.

## Task 2. `CodeView` (from `CodeEditor`)

- Move `components/CodeEditor.tsx`, `lib/editor.ts` and `lib/editor-prefs.ts`
  into `editor/` (`CodeView.tsx`, `languages.ts`, `prefs.ts`), keeping the lazy
  loading and the `--hd-code-*` theme exactly as they are. Export `CodeView`
  (and whatever the current consumers need) from `index.ts`. Update every
  consumer: `slots/PanelBlocks.tsx`, `components/AppearancePreview.tsx`,
  `design/showcase/PropagationPage.tsx`, `components/FilePane.tsx`, and the
  tests that import them (move the tests beside the module).
- Add `@replit/codemirror-vscode-keymap` as the keymap. The app's bindings
  win: ⌘G (mode switch) and ⌘L (Ask in chat) must not be consumed by the
  editor; find-next stays on Enter in the search field and on F3. Test both.
- Plugin marks (`@codemirror/lint`, `ctx.editor`) behave as before; their
  existing tests stay green.

## Task 3. `DiffView` (from `Diff`)

- Move `components/Diff.tsx` and `lib/diff.ts` into `editor/` as `DiffView`
  (and its patch helpers). Update all consumers (`rg -l "Diff'"` lists about
  nineteen: Items, Approvals, GitPane, ChangesReview, Details, WorkToolContents,
  PanelBlocks, the design explorer boards, GitComparisonDialogs and the rest)
  and move `Diff.*.test.tsx` and `lib/diff.test.ts` with it. No visual change.

## Task 4. `MergeView` and `MarkdownView`

- `MergeView`: a new component over `@codemirror/merge`'s unified merge view,
  editable, original = the file at `HEAD` (from `git/diff`/`workspace/readFile`
  as the existing Changes code does), current = the draft. Colours from the
  same `--hd-code-*` and diff tokens `DiffView` uses, so a change looks the
  same in both. Exposes `+added −removed` counts for the toggle.
- `MarkdownView`: the file Preview, a thin wrapper over the existing
  `components/Markdown` renderer (through `lib/sanitize.ts`). `Markdown`
  itself stays in `components/` because the transcript renders with it;
  `MarkdownView` is the editor's one way to show a Markdown file.
- Vitest for both: MergeView counts and its read of HEAD; MarkdownView
  sanitizes (a `<script>` in the file never renders).

## Task 5. `FileView`

- One component for a file, used by Editor mode's tabs **and** the right
  panel's Changes tool `file` and `preview` modes (replace the bodies of
  `FilePane` and the Markdown part of `PreviewPane`; images, HTML and PDF keep
  today's previews).
- The view toggle: a Markdown file gets `Preview | Source | Changes`, opening
  in Preview; another text file `Source | Changes`; **Changes appears only
  when the file differs from `HEAD`**, labelled with its `+N −M`.
- Saving is explicit ⌘S through `file/save` with the read hash (as today).
  A conflict offers Compare (MergeView of disk vs draft), Reload, Keep mine.
  A change on disk reloads quietly when clean; with unsaved edits it shows the
  three choices in a `Banner`. The app's own saves are never reported as a
  change on disk.
- In the Changes tool's file/preview mode, add a **Pop out** icon button
  (title "Pop out to Editor mode") that opens the same file, same view, as a
  kept tab in Editor mode.
- Vitest: toggle per file kind, Changes hidden for an unchanged file, save,
  conflict paths, quiet reload, own-save suppression.

## Task 6. Window mode and per-conversation editor state

- Store: a window `mode: 'conversation' | 'editor'`, persisted with
  `app/state/set` (key `windowMode`) and restored on launch. Editor mode is
  only valid while the main destination is a conversation; elsewhere the
  window shows Conversation mode and keeps the stored value for when a
  conversation opens again.
- Per conversation (keyed by the conversation's subject): open tabs, active
  tab, which tab is the preview tab, each file's chosen view, the Explorer's
  filter and its expanded folders. Persist these with `app/state` too (key
  `editorState`, bounded to the 50 most recently used conversations). Unsaved
  drafts live in the renderer only and survive mode and conversation switches.
- Pure state helpers in `editor/state.ts` with Vitest: preview-tab
  replacement, keep on edit or double-click, select an already-open file,
  close and choose the neighbour, restore per conversation, the bound.

## Task 7. The switch and ⌘G

- `LeftColumnTop` (`design/patterns/LeftColumn.tsx`) gains one prop, the mode
  switch (value, onChange, disabled, disabledTitle); it renders at the right
  end of the top row, in the space the frame reserved. A new pattern needs its
  catalogue entry (`node script/ui-catalog.mjs`, `node script/ui-architecture.mjs`).
- `Sidebar.tsx` passes it: active on a conversation; greyed with the title
  "Editor mode opens a conversation's files" on a draft, a Team, the lists,
  an Agent, Library, Plugins and Dashboard; not rendered in Settings.
- ⌘G toggles from anywhere (the app's keyboard map, where ⌘K and friends
  live), a no-op where the switch is greyed. Check the narrow-column fold:
  back and forward fold first, the switch stays; below 1000 the floating
  column carries the same row.

## Task 8. Explorer

- Editor mode swaps the left column's middle for the Explorer, the way
  Settings swaps it; the top row and the seat row stay.
- Rooted at the conversation's folder (a worktree session's worktree, never
  the main checkout). Folders load lazily through `workspace/browse`; letters
  from `git/status`. Changed is the default when the conversation has changed
  files; a folder that is not a git repository has no Changed filter and no
  letters.
- Single click opens a preview tab; double click keeps it. ⌘P and the foot
  button open Go to file, the `workspace/files` search the command palette
  already uses; choosing keeps the tab.
- Vitest for the tree model (filter, letters, lazy expand); the component
  renders through the left column's row anatomy.

## Task 9. Main: tabs, file, top bar

- In Editor mode main shows `FileTabs` over `FileView` for the active tab, or
  an empty state ("No file open. Pick one in the Explorer, or press ⌘P.").
- Closing a tab with unsaved edits asks with a `ConfirmDialog` (Save,
  Don't save, Cancel).
- The top bar's place reads `Conversation title › path`; the title is a link
  that switches back to Conversation mode. The frame's tools keep following
  the conversation in both modes (main's subject is still the conversation).

## Task 10. Right panel: the Conversation tool

- `WorkTool` (`state/frame-tools.ts`) gains `'conversation'`; the fixed-tool
  admission accepts it **only in Editor mode**, places it first, and selects
  it on entering Editor mode. It renders the open conversation, composer
  included, at the panel's width. Leaving Editor mode drops it and returns the
  panel to the tool it showed before.
- Amend the frame spec (`docs/superpowers/specs/2026-10-09-app-frame-design.md`):
  the two sentences on the fixed set of four tools say a fifth, Conversation,
  exists in Editor mode only, by the Editor mode decision.
- Update `frame-tools` tests and any frame-contract case that counts tools.

## Task 11. Ask in chat (⌘L)

- Selecting text in Source, Changes or Preview shows the floating **Ask in
  chat ⌘L** button. It inserts into the conversation's composer draft, as
  plain text: the path and line range (`src/auth.ts:14–15`), then the
  selection in a fenced block with the file's language; it opens the
  Conversation tool if another tool is showing, and focuses the composer.
- Vitest for the quote text (lines, language, a Preview selection maps to
  source lines or falls back to the path alone).

## Task 12. Ways in

- **Review** on a turn's "files changed" card: opens Editor mode with the
  Changed filter and the first file in its Changes view.
- **A transcript file link** (`path:line`): opens the file in Editor mode,
  Source view, scrolled to and marking that line.
- **Pop out** from Task 5.

## Task 13. Minimap setting

- Settings › Appearance gains, under the editor's settings, a Minimap switch
  (off by default), persisted where editor preferences already live; when on,
  `CodeView` and `MergeView` load `@replit/codemirror-minimap`.

## Task 14. Browser spec, preview frames, final look

- A new preview destination (`preview/`, a new file) that renders Editor mode
  on stubbed data: a conversation with four changed files, two tabs open, one
  dirty, Source view with a selection showing Ask in chat. Add the
  destinations the frame wall needs.
- A new ui-system spec file `e2e/ui-system/editor-mode.spec.ts`: the switch
  and ⌘G, greyed off a conversation and absent in Settings, the Explorer
  filter, preview tab vs kept tab, dirty close confirm, the view toggle,
  Changes only for a changed file, Ask in chat inserting the quote, Review and
  pop-out entries, the Conversation tool first and selected.
- Run `e2e/ui-system/preview-coverage.spec.ts`, `alignment-census.spec.ts`
  and `metrics.spec.ts` alone for the new components and pattern.
- **Visual check, once, at the end:** shoot frames headless from the preview
  harness, light and dark, at the frame's three widths (wide, below 1280,
  below 1000): Conversation mode with the switch; Editor mode on Source,
  Changes and Preview; the Ask in chat button; the change-on-disk banner;
  Settings (no switch); a Team (greyed switch). Read every frame against
  "The look, in words" above and fix what does not match before the PR.

## Not in this build

Everything under the spec's "Not in this design".
