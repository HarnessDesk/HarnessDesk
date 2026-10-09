# One app frame

*Design, 2026-10-09. Decided with the owner section by section; each decision
below is theirs. Supersedes the 2026-09-18 decision that put Agents in its own
full-window shell.*

## The problem, measured

The app has the tokens for a consistent frame — `--hd-bar-h`, the four inset
tiers, `--hd-column` — but no contract saying which page gets which bar, which
left column and which gutter. Each screen chose, and a read of the source on
2026-10-09 found:

- **Top bars:** four heights (46, 48 on the Team bar, unfixed on the Run
  header and every page head, 92 for the sidebar's two header rows); nine
  different leading edges (8, 12, 14, 16, 17, 24, 34, 36, 37); four title
  sizes in bars (13, 14, 16, 20); four switchers on one Team page (a 26px
  filled tab track, a 30px `Segmented`, the dock's 26px pills, `PanelPill`).
- **Left columns:** the sidebar is 240 wide, the full-window rail 244 (a
  literal), the token 275 (used by nothing in the app). The rail pads 8 or 12,
  and a grouped row starts 8px further in than an ungrouped one, so Teams,
  Agents, Dashboard and Settings each start their text at a different x.
- **Pages:** the top margin is 46, 24 or 8; the content measure is 736
  centred, 736 left-aligned, uncapped or 1320.
- **Popups:** five minimum widths (128, 180, 200, 288, 300); two row
  anatomies (30px at radius 10, and the conversation ⋯'s 36px at radius 6).
- **Panels:** Run details docked on the right draws two 46px bars, the dock's
  and its own.

The fix is not more tokens. It is one frame that every page is placed in, so
that a screen chooses *what it is* and the frame answers how it is drawn.

## Decisions

1. **One shell.** Every page is shown in the main area beside the same left
   column. The full-window shell (`AppWindow`) is retired: Agents, Dashboard,
   the Teams list, Library, Plugins, Changes review and Settings become pages
   in main. Only Settings changes the left column, and only its contents.
2. **One bar height, 40px**, for every row that touches the top of a column:
   the window bar, the view bar, the panel bar, the left column's top row and
   its seat row.
3. **One top row for the left column**: window buttons, sidebar toggle and
   back/forward, then notifications and search. The wordmark row is dropped.
4. **Flat panels.** Columns meet at hairlines and every bar sits on one
   continuous 40px line across the window.
5. **Three content widths** — reading, wide, canvas — and **a page's title
   lives only in its bar**. No 20px title anywhere.
6. **Two popup kinds**: the menu (with a wide variant) and the info card.
7. **Things you browse or manage are pages; preferences are Settings.**
   Library and Plugins leave Settings and become pages with their own sidebar
   rows.

## The frame

### The shell and its destinations

The window is the left column, main, the right panel and the bottom panel, as
today. What changes is what main can hold. Today it holds one conversation or
one Team, and seven other destinations are drawn *over* the workbench by
`App.tsx` state flags (`settingsOpen`, `usageOpen`, `agentsOpen`,
`teamsOpen`). After this change main holds exactly one **destination**:

| Destination | Left column | Width | Bar |
| --- | --- | --- | --- |
| Conversation (solo, draft) | Sessions | reading | window bar |
| Team (Overview, Run, Board, Chat, Findings, Runs) | Sessions | per view | window bar + view bar |
| Teams list | Sessions | wide | window bar, filters as tabs |
| Agents list · an Agent | Sessions | wide · reading | window bar; an Agent adds `Agents ›` |
| Library | Sessions | wide | window bar, its views as tabs |
| Plugins | Sessions | wide | window bar |
| Dashboard | Sessions | wide | window bar, its views as tabs |
| Changes review | Sessions | canvas | window bar |
| Settings › a section | Settings nav | reading | window bar, `Settings ›` |

A page is a destination like a conversation: it goes through ⌘[ and ⌘], it
is restored with the project, and opening a conversation from it (an Agent's
"Start a conversation", a Team row) replaces it in main rather than closing a
window. The workbench stays mounted under every page, so a conversation's
scroll, a terminal's screen and a page's history survive a visit to Settings.
The right and bottom panels stay where they are on every destination.

Sign in keeps its own surface: it is a first-run gate, not a page.

### The left column

One container, whatever main shows.

- **Width:** `--hd-sidebar-width` 240, draggable 200–520. The 244 literal and
  the unused 275 go.
- **Top row (40):** window buttons, sidebar toggle, back and forward … then
  notifications and search. Back and forward fold away below 240 (⌘[ and ⌘]
  remain).
- **Rows:** one anatomy for every row in the column — 30 tall, 8px inset, a
  16px icon, 8px gap, 13px label, one trailing slot for a count or a dot,
  a grey selected fill. A row inside a group starts at the same x as one
  outside it.
- **Group label:** 13px/500, secondary ink, in both modes.
- **Seat row (40):** you, at the bottom, with the gear that opens Settings.
  The gear reads as pressed while Settings is open.
- **Sessions mode:** New session ⌄, then one row each for Teams, Agents,
  Library, Plugins and Dashboard, then Projects and the session tree, then the
  docked panels above the seat row.
- **Settings mode:** the top row and seat row stay; the middle becomes Back
  (where New session was), Search settings, and the settings groups.

Settings keeps only preferences: General, Appearance, Notifications,
Keyboard shortcuts; Workspaces, History, Storage, Archive; Runtimes, Models,
Skills, Extensions; Permissions, Browser.

### Bars

Three bars, one height (`--hd-bar-h` 40), one padding (`--hd-bar-pad` 8, the
leading words at `--hd-bar-ink`), one gap (`--hd-bar-gap` 6), one icon button
(28), one divider (1 × 14).

**The window bar** heads main. Its slots, left to right, each optional except
place and ⋯:

1. **lead** — sidebar toggle, back, forward; only while the left column is not
   standing beside main (the existing rule).
2. **place** — `Parent ›` in muted ink when the page is a child, then the
   title at 14/500. A crumb is a link to its parent.
3. **state** — at most one chip (Needs you, Working, Read only).
4. **tabs** — the page's sub-navigation, with counts beside their names.
5. spacer.
6. **facts** — one pill of read-only facts (branch, plan meter, the Team's
   faces). Hovering it opens its info card.
7. divider.
8. **tools** — icon buttons; a toggle reads as pressed while on.
9. **⋯** — always last; every page verb that is not a tool lives here.

No filled button in any bar. A page's one creation verb (New Team, New job,
New agent) is an outline button before ⋯. The existing fold rules (by the
bar's own width, at 520 and 400) carry over unchanged.

**The view bar** is the optional second row, used by a Team's views. It never
repeats the title — the selected tab already says it. Left: the view's
summary facts (`0 to do · 0 working · 2 need you`, `Run 1 · Stalled ·
Round 1 of 4`). Right: the view's actions and its view switch (Board | List,
Timeline | Flow). Run, Board, Findings and Runs all use it.

**The panel bar** heads the right and bottom panels: pill tabs when the stack
holds several views, the view's title when it holds one, and the panel verbs
(move, split, zoom, close) at the end behind a divider.

**One switcher.** Page tabs, filters and view switches are one component at
one size. The dock's pill tabs stay a different shape on purpose: they switch
between different tools, not views of one thing.

### Pages

A page picks one of three widths by what it holds:

| Width | Measure | Margin | Used by |
| --- | --- | --- | --- |
| reading | `--hd-column` 736, centred | 24 | conversation, Settings, an Agent, Team Overview, Run timeline |
| wide | `--hd-page-wide` 1320, centred | 24 | Teams list, Agents list, Library, Plugins, Dashboard |
| canvas | none | 8 | Board, Flow, Changes review, terminal, diff |

Below the bar, every page starts its content 24px down (8 on a canvas).
Inside, the existing rhythm holds and is now the only rhythm: label → card 8,
section → section 32, card 16, row 12, dialog 24.

**No page head.** The title is in the bar. A page that needs one sentence of
explanation opens its content with it, in secondary ink; most pages need none.
`PageHead`, `DetailHead`, their 20px title and the accent mark on a rule under
it are retired. An Agent's mark, ceiling chip and "Start a conversation" move
to its bar (mark beside the title, chip in the state slot, the button as its
outline verb).

### Panels

- One panel shell for the right and bottom panels, headed by the panel bar.
- **A view inside a panel never draws its own title bar.** One that needs a
  toolbar — search, a filter, a switch — uses the view bar.
- Panel content is sections: a group label over rows. Rows keep their own 12px
  edge; prose uses 16. No cards inside a panel and no 24px reading gutter in a
  280–460px column.
- Panels stay flat: a hairline on the edge they meet main.

### Popups

**The menu.** Minimum 200, padding 4, radius 10. Rows 30 tall at radius 6 (the
surface radius less its padding), a 16px icon, 8px gap, 13px label and one
trailing slot for a shortcut, a check or a chevron. A group label is 12/500 in
secondary ink. A separator is a 1px rule with 4px around it. **The wide menu**
is the same at up to 340: a submenu, a 28px search field on top for a long
list, a list of agents with meters, a muted footer line under a separator.
Long names wrap to a second line rather than widening it.

**The info card.** 288 wide, padding 12, facts only, opened by hover or focus
on a facts pill. It never carries actions and never stacks on top of a menu.

`PopoverOption` (the 36px row) is retired into the menu row; the vendored
dropdown, `Popover` + `Menu`, and the branch flyout all render the one menu.

### Windows that are not wide

The existing order is kept, at the new heights: the sidebar floats first, the
right panel covers main second, bars fold by their own width. The left
column's Settings mode floats the same way.

## Tokens

| Token | Today | After |
| --- | --- | --- |
| `--hd-bar-h` (and `--hd-titlebar-height`, which follows it) | 46 | 40 |
| `--hd-sidebar-width` | 275, unused | 240, used by the column and the explorer |
| `--hd-page-wide` | — (1320 literal in AppWindow) | 1320 |
| `--hd-page-gutter` | — (`PaneColumn inset="reading"`) | 24, named |
| `--hd-popover-width-wide` | 320 | 340 |
| `--hd-menu-min` | — (180, 200, 128 in three places) | 200 |
| `--hd-menu-row-radius` | — (10 or 6) | 6 |
| `--hd-info-card-width` | — (`w-72`) | 288 |
| `--hd-title-rule*` | the accent mark | removed with the page head |
| `--hd-page-row-h`, `--hd-page-row-padding` | no consumer | removed |

The desktop window's buttons move with the bar: `trafficLightPosition` in
`packages/desktop/electron/main.mjs` goes from `{ x: 14, y: 15 }` to
`{ x: 14, y: 12 }`, re-measured on the built app. `DockPanelBar`'s reference
to the nonexistent `--hd-topbar-h` is fixed in the same pass.

## Components

| Piece | Becomes |
| --- | --- |
| `Bar` | the one bar; `size="lg"` (48) is removed |
| Conversation header, Team header (`TeamRoomPane`) | the window bar, built from one `WindowBar` pattern with the nine slots |
| Run header, Board header, Findings header, Runs head | the view bar (`ViewBar`) |
| `DockPanelBar`, `ToolPaneHeader`, `PanelTools` | the panel bar; a docked inspector drops its own `PanelTools` |
| `TabsList` default, `Segmented`, `PanelPill` | one switcher; the dock keeps `DockPanelTabs` |
| `AppWindow`, `WindowNav`, `WindowPage` | retired; `WindowNav`'s groups move into the left column's Settings mode |
| `PageHead`, `DetailHead`, `BackLink` | retired; the crumb in the window bar replaces them |
| `PaneColumn` | gains `width="reading" \| "wide" \| "canvas"` as the one way a page sets its measure |
| `Popover` + `PopoverOption`, `Popover` + `Menu`, `DropdownMenuContent`, the branch flyout | the menu and the wide menu |
| `HeaderStatusGroup`'s hover card, `PopoverContent` | the info card |
| `App.tsx` window flags | one main destination in the workbench state, with history |

## Order of work

The system changes before the screens (rule 12), and each step lands on its
own with the app working:

1. **Tokens.** Bar height 40 and the window-button position; the named widths
   and menu tokens; dead tokens out. Every screen moves with it; re-record
   `metrics.json`.
2. **Bars.** `WindowBar`, `ViewBar`, the panel bar and the one switcher in
   `design/patterns`, with catalogue boards. The conversation and Team headers
   move onto `WindowBar`; Run, Board, Findings and Runs onto `ViewBar`; the
   docked inspector loses its second bar.
3. **Popups.** The menu, the wide menu and the info card; every popup in the
   app renders one of the three.
4. **The left column.** One top row; one row anatomy; the seat row's gear; the
   Settings mode (built behind the existing Settings window until step 5).
5. **Main destinations.** The destination model and its history; then pages
   move in one at a time — Settings, Dashboard, Agents, the Teams list,
   Library, Plugins, Changes review — each retiring its window flag. The page
   head and `AppWindow` are deleted with the last one.
6. **Docs.** `docs/interface.md` (Window chrome, The sidebar, Settings, the
   Teams page, A Team's Overview) and `docs/design.md` (content insets, a page)
   describe the new frame; `docs/decisions.md` records why the full-window
   shell went.

## How it is checked

- `node script/design-audit.mjs --strict` stays at zero; a bar, page or popup
  that hand-sets a height, padding or width where a token exists fails it.
- `e2e/ui-system/container-insets.spec.ts` gains the page widths and the
  panel content edge; a new check measures that every top-of-column row in a
  window is 40 and that their bottoms share one y.
- The catalogue (`design.html`) shows the window bar on every destination, the
  view bar on every Team view, the left column in both modes, and the three
  popups, from the real components; `node script/ui-catalog.mjs` passes.
- Each step is looked at in the built app in light and dark, at a wide window
  and at 720, with frames from the rig.

## Out of scope

- Inset-card panels: a possible Appearance option later, not this change.
- What Skills means in Settings versus Library: both stay where this spec puts
  them; reconciling the two is its own design.
- The transcript, the composer and the board's own geometry, beyond the bars
  and margins around them.
