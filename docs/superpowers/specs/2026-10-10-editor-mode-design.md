# Editor mode: reading and editing the files a conversation works on

*2026-10-10. Approved by the owner decision by decision, in the order listed
at the end. Nothing here is built yet. Refreshed 2026-10-12 against `main` at
`7851af482`, where the app frame
(`docs/superpowers/specs/2026-10-09-app-frame-design.md`, phases B–E, #1586)
has landed; Editor mode is built on that frame.*

## The problem

Today a file opens in the right panel's Changes tool (its `file` and
`preview` modes, `state/frame-tools.ts`), 400 to 640 pixels wide, beside the
conversation. That is right for a glance and wrong for work: there is no file
tree, no tabs worth the name, Markdown is read in one panel view
(`PreviewPane`) and edited in another (`FilePane`), and an agent's changes to a
file are only visible in the transcript or in the Changes tool, never in the
file itself.

The pieces of an editor are already in the app, but they are spread across
`components/`:

- `CodeEditor.tsx` is CodeMirror 6 with about thirty grammars loaded on
  demand (`lib/editor.ts`), colours from the `--hd-code-*` tokens, and the
  preferences in `lib/editor-prefs.ts`. It backs `FilePane` and the plugin
  `code` block.
- `Diff.tsx` is a unified-diff renderer of its own (not CodeMirror), used by
  transcript items, Approvals, the Git pane, Changes review, Details and the
  plugin `diff` block.
- `Markdown` renders Markdown through `lib/sanitize.ts`, and `PreviewPane`
  wraps it with HTML and PDF previews.

So a diff in the conversation, a file in the right panel and a Markdown
preview each look and behave a little differently, and nothing owns "the
editing experience" as one thing.

## What Editor mode is

A second mode of the whole window, beside the one every conversation opens in.
The window has two modes:

- **Conversation mode** is the app as it is: the Sessions list in the left
  column, the conversation in main, the four tools in the right panel.
- **Editor mode** is for the conversation's files: an Explorer in the left
  column, file tabs in main, and the conversation in the right panel.

The mode belongs to the window and is kept in the host's app state (the
renderer's own storage is wiped every launch). Opening the app returns to the
mode it was left in.

### The switch

A two-part switch, conversation and code (`</>`), at the **right end of the
left column's top row**: window buttons, sidebar toggle, search, back, forward,
then the switch at the column's right edge. The selected half is a raised
pill on a grey track, not an accent fill. ⌘G toggles it from anywhere.

The frame already made room for it: the column's default width is **256**
(drag 200 to 360), the notifications bell is in the seat row before the gear,
and the top row ends in empty space "reserved for a later switch". Editor mode
adds the switch to `LeftColumnTop` (`design/patterns/LeftColumn.tsx`) as one
more prop, and changes nothing else in the row.

In a narrow column, back and forward fold away first, as the frame spec
already says. Below a 1000-pixel window the column floats at the same width
with the same top row, so the switch is always reachable.

**Where the switch applies.** Editor mode is about a piece of work's files,
and only a conversation has one folder of its own, so:

- **On a conversation** the switch works.
- **On every other destination** (a draft, a Team, the lists, an Agent,
  Library, Plugins, Dashboard) it stays in place, greyed, with a title that
  says it opens a conversation's files. A moot control is greyed, never
  withdrawn, so the row never shifts.
- **In Settings** it is hidden with search, back and forward, which the
  frame already hides there.

A Team's branch is a natural later extension; it is not in this design.

⌘G is "find next" in the editor's search keymap and in the VS Code keymap.
The app's binding wins; find next stays on Enter in the search field and on
F3.

### Other ways in

- **Review** on a turn's "files changed" card opens Editor mode with the
  Explorer filtered to Changed and the first file open in its Changes view.
- **Pop out** on a file shown in the Changes tool (its `file` or `preview`
  mode) opens Editor mode on that file. The file view in the panel and the
  one in Editor mode are the same component, so nothing is lost on the way.
- **A file link in the transcript** opens the file in Editor mode at the
  linked line.

### What it follows

Editor mode follows **the conversation that is open**. The Explorer is rooted
at that conversation's folder, which for a worktree session is the worktree,
never the main checkout. The right panel's conversation is that conversation.

To work on another conversation's files, switch back (⌘G), pick it from the
Sessions list, and switch again. Open tabs, the active tab and each file's
chosen view are kept per conversation, so returning restores them.

## The left column: Explorer

The column keeps its container, its top row and its seat row; only the middle
changes, exactly as Settings swaps it.

- **A header** with the folder's name and an **All / Changed** switch.
  Changed is selected when the conversation has changed files, and shows
  their count.
- **A tree** read through `workspace/browse`. In a git repository, a changed
  file carries a trailing letter (M modified, A added, D deleted, R renamed)
  from `git/status`. Rows use the left column's one row anatomy.
- **Go to file** (⌘P) at the foot, using `workspace/files`, the search the
  command palette already uses.

A folder that is not a git repository has no Changed filter and no letters.

## Main: file tabs

Main's subject is still the conversation, so the frame's tools keep
following it: Details, Changes, Activity and Browser show the same
conversation in both modes. The top bar's place reads
`Conversation title › path/to/file`, and the conversation's crumb, being a
link to its parent, switches back to Conversation mode.

- **Opening.** A single click opens a *preview tab*, drawn in italics, which
  the next single click replaces. Editing it, or double-clicking, keeps it.
  Opening a file that is already open selects its tab.
- **The tab.** Name, then one trailing slot that shows the unsaved dot and
  becomes the close button on hover, so a tab never changes width.
- **The file's bar.** The path, then one toggle for the file's views:
  - a Markdown file: **Preview | Source | Changes**, opening in Preview;
  - any other text file: **Source | Changes**;
  - Changes shows only when the file differs from `HEAD`, with its
    `+12 −3` counts.
- **Preview** is `MarkdownView`: the existing renderer, through
  `lib/sanitize.ts`. **Edit** in Preview switches to Source.
- **Source** is `CodeView` with the VS Code keymap.
- **Changes** is the file against `HEAD` in CodeMirror's unified merge view
  (`@codemirror/merge`), still editable, so a change can be read and fixed in
  the same place.
- **Images** keep today's image preview; HTML and PDF keep today's previews
  and open in Preview.

### Saving

Saving is explicit: ⌘S. There is no autosave. A save goes through `file/save`
with the hash the file was read at, as it does today.

- **A conflict** (the file changed since it was read) offers **Compare**,
  **Reload** and **Keep mine**. Compare opens the disk version against the
  draft in the merge view.
- **A change on disk** to a file with no unsaved edits reloads it quietly.
  With unsaved edits, the same three choices appear as a banner over the
  file. The app's own saves are not reported as changes on disk.

## The right panel

In Editor mode the right panel gains a fifth tool, **Conversation**, first in
the row and selected by default. It is the open conversation, composer
included. Details, Changes, Activity and Browser keep their icons and their
places; the bar's tools are right-aligned, so adding one at the left of the
group moves none of them.

**This amends the frame's rule of four tools** ("The right panel's tools are a
fixed set of four icons", and "none adds a fifth icon without a decision
here"). It is that decision: a fifth tool, Conversation, present only in
Editor mode. In code, `WorkTool` (`state/frame-tools.ts`) gains
`conversation`; the frame's slot checks admit it in Editor mode only; and the
frame spec's two sentences are amended in the same change.

### Ask in chat

Selecting text in Source, Changes or Preview shows **Ask in chat** (⌘L) beside
the selection. It puts a quote, `auth.ts:14–15`, into the conversation's
composer, opening the Conversation tool if another tool is showing. The quote
is plain text in the draft — the path and line range, then the selected text
in a fenced block — so every agent reads it the same way and the person can
edit it before sending. ⌘L in the VS Code keymap (expand line selection) is
overridden by the app's binding.

## How it is built: one `editor` module

Everything above is one module, `packages/ui/src/editor/`, imported only
through its `index.ts`. A gate check refuses a file outside the module that
imports from inside it.

| Piece | Built from | Used by |
|---|---|---|
| `CodeView` | `components/CodeEditor.tsx`, `lib/editor.ts`, `lib/editor-prefs.ts` | file views, the plugin `code` block, the Appearance preview |
| `DiffView` | `components/Diff.tsx`, `lib/diff` | transcript items, Approvals, Git, Changes review, Details, the plugin `diff` block |
| `MergeView` | new, over `@codemirror/merge` | a file's Changes view, Compare on a conflict |
| `MarkdownView` | `Markdown` and `lib/sanitize.ts` | a file's Preview, the right panel's preview |
| `FileView` | `components/FilePane.tsx`, and `PreviewPane`'s Markdown part | Editor mode's tabs **and** the Changes tool's `file` and `preview` modes |
| `FileTabs` | new | Editor mode |
| `Explorer` | new | Editor mode |

`DiffView` draws a patch, which is all the transcript, Approvals and the Git
pane have. `MergeView` draws a whole file against another version, which is
what a file's Changes view has. Both take their colours from the same
`--hd-code-*` and diff tokens, so a change looks the same in both.

The module is product UI, so it is built out of the design system like any
screen: `Button`, `Row`, the switcher, `Banner` for the change-on-disk notice.
Its icons come from `components/Icons.tsx`.

### Engine: CodeMirror 6, with a VS Code feel

The engine stays CodeMirror 6. Three packages are added:

- `@replit/codemirror-vscode-keymap` (MIT): VS Code's editing keys;
- `@codemirror/merge` (MIT): the Changes view and Compare;
- `@replit/codemirror-minimap` (MIT): a minimap, as an Appearance setting,
  off by default.

All three load in the editor's lazy chunk, not the first-paint chunk.

Monaco was weighed and set aside: it would feel identical to VS Code and adds
a minimap, a diff editor and TypeScript completion, but it is several
megabytes with worker threads to configure in Electron, its colours are theme
objects that would have to be re-applied on every theme and palette change
instead of following the tokens, it is not supported on phones, and the
shipped editor, its plugin marks and its tests would all be rewritten.

### State

- The mode: per window, in the host's app state.
- Per conversation: the open tabs, the active tab, which is the preview tab,
  each file's chosen view, the Explorer's filter and its expanded folders.
- Unsaved drafts live in the renderer while the window is open. Switching
  mode or conversation keeps them; closing a tab with unsaved edits asks
  first (a `ConfirmDialog`).

### Wire

No new methods. The module uses `workspace/browse`, `workspace/files`,
`workspace/readFile`, `workspace/stat`, `file/save`, `git/status` and
`git/diff`, all of which exist.

### Plugins

Unchanged. A plugin still opens files, marks lines and applies edits through
`ctx.editor`, and its marks now show in Editor mode as well as the panel. A
plugin never draws the editor: the renderer runs no plugin code
(`docs/decisions.md`, "Writing a file belongs to the editor plane").

## Not in this design

Language servers, code completion, split editors, rich (WYSIWYG) Markdown
editing, a side-by-side Markdown preview, a terminal in Editor mode (the
terminal stays in the bottom panel), and opening another conversation's files
without switching to it.

## Testing

- **Vitest** for each piece of the module: the tab model (preview tab,
  dirty slot, restore per conversation), the view toggle per file kind, the
  save and conflict paths, and the Explorer's Changed filter.
- **A gate check** for the module's import boundary.
- **A ui-system spec** for the switch and ⌘G, the Explorer, tabs, Ask in chat
  and the Review and pop-out entries.
- **Frame-wall shots** of Editor mode at the frame's three widths, in both
  themes, checked against the approved drawing as every frame phase is.

## Decisions, in the order the owner took them (2026-10-10)

1. **Layout:** a window mode. Explorer in the left column, file tabs in main,
   the conversation in the right panel. Popping out and Review enter it.
2. **Markdown:** one toggle per file, Preview | Source | Changes, opening in
   Preview.
3. **Scope:** Editor mode follows the open conversation, worktree included.
4. **Right panel:** Conversation as a fifth tool, first and selected by
   default, in Editor mode only.
5. **The experience** as described, approved ("Looks good").
6. **The switch:** at the right end of the left column's top row; the
   column's default width becomes 256 and the bell moves to the seat row.
7. **Engine:** CodeMirror 6 with the VS Code keymap, a minimap setting and
   `@codemirror/merge`.
8. **Plugin or module:** one built-in module; plugins extend it through
   `ctx.editor` and never draw it.

Settled on the 2026-10-12 refresh, following the landed frame rather than a
new owner decision: the switch is greyed away from a conversation and hidden
in Settings; the conversation's crumb switches back; files stay the Changes
tool's modes in Conversation mode.
