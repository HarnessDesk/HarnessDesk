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

### Why a drawing and the app never matched

The owner's question on reviewing the first sketches was why the app never
looks like the drawing — the type thinner, the padding different on every
screen. Five causes, each checked in the source:

1. **The type is rendered thinner than drawn.** `app.css` sets
   `-webkit-font-smoothing: antialiased` on `body` (since 0.1.0). On macOS
   that switches off the stroke thickening the system applies by default, and
   Geist at 400 is already a light face at 13–14px. The sketches were drawn in
   a different face altogether, so what was approved was never the app.
2. **A page with no width.** A Team's Findings view at a wide window: content
   12px from the sidebar and running to the window's edge, a key 1,600px from
   its value, a button stretched across the page, a switch stopped mid-page,
   and four different left edges (342, 332, 332, 350). Nothing told the page
   what width it was, so it took all of it.
3. **One role, several components.** A menu row is `PopoverOption` (14px,
   about 36 tall, 12 uses), `MenuItem` (13px, 30 tall, 171 uses) and
   `DropdownMenuItem` (25 uses). Each uses only tokens, so the strict audit
   reads zero: it refuses a literal, not two different tokens for one role, and
   it never measures what renders.
4. **The sketch left content out.** The real ⋯ menu carries earned second
   lines, long names and CJK titles; a sketch of four short words is cleaner
   because it is emptier.
5. **No page layer, and numbers only in prose.** The system has tokens,
   components and patterns, but no page template, so every screen lays out its
   own page. And a number written in a spec reaches code only through someone
   reading it; when it does not, nothing fails.

## Decisions

1. **One shell.** Every page is shown in the main area beside the same left
   column. The full-window shell (`AppWindow`) is retired: Agents, Dashboard,
   the Teams list, Library, Plugins, Changes review and Settings become pages
   in main. Only Settings changes the left column, and only its contents.
2. **One bar height, 40px**: the top bar (one row across main and the right
   panel), the left column's top row and its seat row. A panel has no bar of
   its own.
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
8. **Type renders with the system's default smoothing.** The `antialiased`
   line goes; no size or weight changes with it.
9. **The frame is a measured contract, not prose** — step 0 below, before any
   screen moves:
   - a **page template** is the only way a page sets its width and margins;
   - **one component per role** (one menu row, one facts card, one settings
     row), and the audit refuses a second;
   - the numbers in this spec live in code, and a **rendered check** fails when
     the app differs from them;
   - drawings for this work are **rendered from the real components** in the
     catalogue, in Geist, with real content; a chat sketch only picks a
     direction.
10. **The left column is a list.** A row is a thing you open; a Team is one
    row and its views are tabs in the top bar.
11. **Nothing in the top bar moves between views (option B).** A view's
    layout and filter live in one View icon; its verb is in words, placed
    before View so the words grow into the spacer; ⋯ is last at the window's
    right edge on every page. Tabs and verbs keep their words; only tools are
    icons.
12. **The right panel belongs to a piece of work** — a conversation, a draft,
    a Team — and has no bar of its own: no tabs, no split, no move, no zoom.
    Lists, an Agent's page and Settings have none.

## The frame

### The fixed shell

The owner's rule, after walking a new session, a Team's Run with Run
details docked, and Settings: **the sidebar, the top bar, the panels and the
bottom bar are fixed.** Every destination had drawn its own header, so a
draft's bar, a conversation's and a Team's were three different rows, and a
docked inspector drew its own titled cards under the panel's strip. So:

- **Six regions, always in the same places, each drawn by one shell
  component:** the left column, the top bar, main, the right panel, the
  bottom panel (the terminal), and the status bar along the window's foot.
- **A page draws none of them.** It declares what goes in their slots — the
  top bar's place, state, tabs, verb, View options and ⋯ items through one
  hook; a tool's body only; its status facts — and the shell renders them. The
  conversation header, the Team bar and the draft's header stop being
  components of their own.
- **The top bar is one component on every destination** — a draft, a
  conversation, a Team, a list page, an Agent, Settings — with its slots in
  the same places and the panel toggle and ⋯ always where they were.
- **The status bar holds what is true of the whole app, not of the page:**
  plan usage, the other agents, background tasks, sync and updates. Those
  leave the top bar. A page's own facts (a conversation's branch, ceiling and
  context; a Team's seats, trigger and pull request) leave it too, for the
  right panel's Details tool: the top bar carries no facts pill.
- **A panel is one frame with no bar.** The tool icons in the top bar row
  choose what it shows, and its quiet footer line is the shell's; a tool
  supplies a body of sections — never a titled card or a header of its own.

### The frame's fixed rules

Approved by the owner: the frame is fixed rather than freely arranged.

| Region | Size | Limits | Holds |
| --- | --- | --- | --- |
| Left column | 240 | drag 200–360 | the session tree and its pages, or Settings' nav |
| Top bar | 40 | — | one row across main and the right panel |
| Main | the rest | keeps at least 480 beside a standing panel | one destination |
| Right panel | 400 | drag 320–640 | one tool at a time, chosen by its icon in the top bar row |
| Bottom panel | 240 | drag 120 to half the window | the terminal only |
| Status bar | 28 | — | app-wide facts and the terminal's toggle |

- **The right panel's tools are a fixed set of four icons** — Details,
  Changes, Activity, Browser — then the panel toggle, then ⋯, at the end of
  the top bar, standing over the panel's column while it is open. Pressing one
  opens the panel on that tool; pressing the lit one closes it. No tool opens
  anywhere else.
- **A right panel belongs to a piece of work.** A conversation, a draft and a
  Team have one; the Teams list, Agents, an Agent's page, Library, Plugins,
  Dashboard and Settings have none — no tool icons, and their bar ends at ⋯.
  The panel comes back as it was when work is in main again. A draft's
  Changes and Activity are greyed until it is sent.
- **The panel has no bar and no arrangement of its own.** No tabs, no split
  (side by side or one above the other), no move to the bottom panel or the
  left column, no zoom, no collapse chevron. The lit tool is its title; the
  lit tool or the panel toggle closes it; its seam widens it to 640; and
  anything that needs the whole width opens as a page in main (Changes
  review).
- **Only seams drag.** A view is never dragged between regions, and nothing
  docks in the left column. Double-clicking a seam restores its default.
- **The frame folds on its own:** at 1280 and wider every region stands;
  from 1000 to 1279 an opened right panel floats over the right of main
  instead of narrowing it; below 1000 the left column also floats, opened from
  the top bar's lead slot.

### The shell and its destinations

The window is the left column, main, the right panel and the bottom panel, as
today. What changes is what main can hold. Today it holds one conversation or
one Team, and seven other destinations are drawn *over* the workbench by
`App.tsx` state flags (`settingsOpen`, `usageOpen`, `agentsOpen`,
`teamsOpen`). After this change main holds exactly one **destination**:

| Destination | Left column | Width | Bar | Right panel |
| --- | --- | --- | --- | --- |
| Conversation (solo, draft) | Sessions | reading | top bar | the four tools |
| Team (Overview, Run, Board, Chat, Findings, Runs) | Sessions | per view | top bar, its views as tabs | the four tools |
| Teams list | Sessions | wide | top bar, filters as tabs | none |
| Agents list · an Agent | Sessions | wide · reading | top bar; an Agent adds `Agents ›` | none |
| Library | Sessions | wide | top bar, its views as tabs | none |
| Plugins | Sessions | wide | top bar | none |
| Dashboard | Sessions | wide | top bar, its views as tabs | none |
| Changes review | Sessions | canvas | top bar | none |
| Settings › a section | Settings nav | reading | top bar, `Settings ›` | none |

A page is a destination like a conversation: it goes through ⌘[ and ⌘], it
is restored with the project, and opening a conversation from it (an Agent's
"Start a conversation", a Team row) replaces it in main rather than closing a
window. The workbench stays mounted under every page, so a conversation's
scroll, a terminal's screen and a page's history survive a visit to Settings.
The bottom panel stays on every destination; the right panel shows on a piece
of work only.

Sign in keeps its own surface: it is a first-run gate, not a page.

### The left column

One container, whatever main shows.

- **Width:** `--hd-sidebar-width` 240, draggable 200–360. The 244 literal and
  the unused 275 go.
- **Top row (40):** window buttons, sidebar toggle, back and forward … then
  notifications and search. Back and forward fold away below 240 (⌘[ and ⌘]
  remain).
- **Rows:** one anatomy for every row in the column — 30 tall, 8px inset, a
  16px icon, 8px gap, 13px label, one trailing slot for a count or a dot,
  a grey selected fill. A row inside a group starts at the same x as one
  outside it.
- **A list, never a tree of views.** Every row is a thing you open — a
  session, a Team, a page — and opening it fills main. A Team is one row; its
  views (Overview, Run, Board, Chat, Findings, Runs) are tabs in the window
  bar, and its seats are in its Overview and the Details tool, not rows under
  it. Opening the Team returns to the view it was last on.
- **Group label:** 13px/500, secondary ink, in both modes.
- **Seat row (40):** you, at the bottom, with the gear that opens Settings.
  The gear reads as pressed while Settings is open.
- **Sessions mode:** New session ⌄, then one row each for Teams, Agents,
  Library, Plugins and Dashboard, then Projects and the session tree. Nothing
  docks in the column.
- **Settings mode:** the top row and seat row stay; the middle becomes Back
  (where New session was), Search settings, and the settings groups.

Settings keeps only preferences: General, Appearance, Notifications,
Keyboard shortcuts; Workspaces, History, Storage, Archive; Runtimes, Models,
Skills, Extensions; Permissions, Browser.

### Bars

One top bar, one height (`--hd-bar-h` 40), one padding (`--hd-bar-pad` 8,
the leading words at `--hd-bar-ink`), one gap (`--hd-bar-gap` 6), one icon
button (28), one divider (1 × 14).

**The top bar** runs across main and the right panel's column. Its slots,
left to right, each optional except place and ⋯:

1. **lead** — sidebar toggle, back, forward; only while the left column is not
   standing beside main (the existing rule).
2. **place** — `Parent ›` in muted ink when the page is a child, then the
   title at 14/500. A crumb is a link to its parent.
3. **state** — at most one chip (Needs you, Working, Idle, Built in).
4. **tabs** — the page's sub-navigation, in words, with counts beside their
   names: a Team's views, a list's filters, a page's sections.
5. spacer.
6. **verb** — the page's or view's one verb, in words, as an outline button:
   New Team, New job, Start a conversation, Decide this run, Stop run….
7. **View** — on a Team view only: one icon whose menu holds the view's
   layout (Board | List, Timeline | Flow, Thread | Side by side) and its
   filter (All | Open | Blocking). A dot on it says a filter is narrowing the
   view. Greyed on a view with nothing to choose (Overview).
8. **tools** — on a piece of work only: Details, Changes, Activity, Browser,
   then the panel toggle. They stand over the panel's column while it is open.
9. **⋯** — always last, at the window's right edge, on every destination;
   every verb on the subject that is not slot 6 lives here.

**Why this order: nothing moves.** Icons have one width and words do not.
The worded verb comes before the View icon, so its words grow leftwards into
the spacer, and every icon keeps its place: View is at one x on every Team
view, the tools and the panel toggle at one x on every piece of work, and ⋯
at one x on every page. The tabs sit after the title and change only when
the title does. Tabs and verbs keep their words — "Findings", "Run" and
"Decide this run" have no icon anyone reads without hovering; only tools,
which are used over and over, are icons.

No filled button in any bar, and no facts pill: a page's facts are in Details
(on a piece of work) or in its own content (on a page).

**No second row.** There is no view bar and no toolbar across the top of the
content. A view's summary (`12 open · 8 blocking`, `Round 2 of 4`) is the first
card of its content or a row in Details, never a strip of its own.

**The bar folds to keep its title readable.** When the title would be
narrower than 180px, the bar first drops the state chip and the words of any
verb that has an icon (the icon stays, the words become its title), then
folds its tabs into one button naming the current tab, whose menu lists them
all. A verb without an icon keeps its words.

**One switcher.** Page tabs and list filters are one component at one size.

### Where things go

Today each destination decided for itself what sits in main and what in a
panel, and what its bar's right side holds — a worded button here, an icon
there, a menu elsewhere, controls that come and go. One rule each:

**Main or a panel.**
- **Main** holds the subject you are working on: one conversation, one Team
  view, one page. Exactly one.
- **The right panel** holds what you consult *about* the subject in main, in
  four tools, and follows main's subject:
  - **Details** — the subject's facts, then the list that belongs to it. A
    conversation: its Agent, ceiling, folder, branch and context, then its
    Plan. A draft: where it will start. A Team: its Run (Flow and Flow file,
    budget, rounds without progress, what started it, the commit and branch,
    the pull request), then its Seats.
  - **Changes** — the subject's diff: a conversation's uncommitted work, a
    Team's branch against its base.
  - **Activity** — what the subject did, newest first.
  - **Browser** — the page it is building.
- **The bottom panel** holds what runs beside it — the terminal.
- A page never opens in a panel and a tool never becomes a page. The one
  recorded pair is Changes (the tool: what just happened) and Changes review
  (the page: reading a day's work).

Today's panel views fold into those four: Run details into a Team's Details;
Changes into Changes; Activity, Trajectory and Background tasks into
Activity; a conversation's subagents into its Details list. **Steps** is not a
panel at all: it is the Run tab's Timeline in main — steps taken, then not
reached, with identical rounds folded into one row — and the View menu's Flow
layout draws the same steps as a graph. A file, an image preview, the
repository's history and plugin panels are placed by step 2's inventory, each
into a tool or a page; none adds a fifth icon without a decision here.

**What the Team bar held, and where it went:**

| Today | After |
| --- | --- |
| The faces and the members popover | Details › Seats: a row per seat (name; Agent, model and ceiling; a state chip), + to seat an Agent; a row's menu opens its conversation, watches it beside, messages it, sets its messages to Accept, Hold or Refuse, or takes it out of the Team |
| Side by side, both a tab and a toggle | Chat's View menu, one place |
| Hold messages | the Chat composer's Send to menu, with a Holding messages chip in the composer while it is on |
| The pull request button | Details' Pull request row, and ⋯ › Open pull request |
| The trigger chips, "at a1b2c3d on main" | Details (Started by, At) |
| Wrap…, Fill the window | ⋯ |
| The goal strip and notices under the bar | the page's first card, or a banner at the top of its content |

**The bar per destination.** ⋯ ends every row.

| Destination | Tabs | Verb | View | Tools |
| --- | --- | --- | --- | --- |
| New session | — | — | — | four; Changes and Activity greyed until sent |
| Conversation | — | — | — | four |
| Team · Overview | its views | — | greyed | four |
| Team · Run | its views | Stop run… | Timeline, Flow | four |
| Team · Board | its views | New job | Board, List | four |
| Team · Chat | its views | — | Thread, Side by side | four |
| Team · Findings | its views | Decide this run | All, Open, Blocking | four |
| Teams | Active, Needs you, Settled | New Team | — | — |
| Agents · Plugins | — | New agent · Install | — | — |
| An Agent | — | Start a conversation | — | — |
| Library · Dashboard | their sections | Add (Library) | — | — |
| Settings › a section | — | — | — | — |

**Controls do not come and go.** A destination's slots are fixed by its
kind. A control that does not apply now is greyed with its reason as its
title, never removed — the View icon on Overview, Changes and Activity on a
draft. The only time a control moves is the bar's fold.

### Pages

A page picks one of three widths by what it holds:

| Width | Measure | Margin | Used by |
| --- | --- | --- | --- |
| reading | `--hd-column` 736, centred | 24 | conversation, Settings, an Agent, Team Overview, Run timeline, Findings |
| wide | `--hd-page-wide` 1320, centred | 24 | Teams list, Agents list, Library, Plugins, Dashboard |
| canvas | none | 8 | Board, Flow, Changes review, terminal, diff |

Below the bar, every page starts its content 24px down (8 on a canvas).
Inside, the existing rhythm holds and is now the only rhythm: label → card 8,
section → section 32, card 16, row 12, dialog 24.

**The page template is the only way in.** A page renders
`<Page width="reading" | "wide" | "canvas">` and composes blocks inside it —
`Section`, `SummaryList`, `Rows`, `Table`, `EmptyState`. A
screen writes no page-level `max-width`, padding or outer margin of its own,
and the audit refuses one. Inside a page:

- **One left edge.** Every block starts at the column's edge; a block that
  needs an icon hangs it before the edge rather than moving its text.
- **Facts are one card.** Several facts about one thing are a `SummaryList`:
  key and value side by side within the column, never a key at one edge of
  the window and its value at the other.
- **Buttons are as wide as their words.** A view's own verb ("Decide this
  run") is an outline button in the top bar, not a bar across the page.
- **A switch is a settings row.** Its control keeps the row's end, inside the
  column.

A Team's Findings is the first acceptance example: the top bar holds the
Team, its tabs with Findings selected, Decide this run and the View icon
(its menu: All, Open, Blocking; its dot on while Open is chosen); the
reading column holds the round's facts as one card (`12 open · 8 blocking`
among them), the post-to-PR switch as a row, and the findings as one list.

**No page head.** The title is in the bar. A page that needs one sentence of
explanation opens its content with it, in secondary ink; most pages need none.
`PageHead`, `DetailHead`, their 20px title and the accent mark on a rule under
it are retired. An Agent's mark, ceiling chip and "Start a conversation" move
to its bar (mark beside the title, chip in the state slot, the button as its
outline verb).

### Panels

- **The right panel has no bar.** The tool icons in the top bar row are its
  tabs; the panel starts with its body.
- **A tool never draws a title bar or a titled card.** Search or a filter it
  needs is the first row of its body, inside its content edge.
- Panel content is sections: a group label over rows. Rows keep their own 12px
  edge; prose uses 16. No cards inside a panel and no 24px reading gutter in a
  320–640px column. Every Details body is the same two sections: the
  subject's facts, then its list (Seats, Plan).
- **The bottom panel** is the terminal; several terminals are its own tabs.
- Panels stay flat: a hairline on the edge they meet main.

### Popups

**The menu.** Minimum 200, padding 4, radius 10. Rows 30 tall at radius 6 (the
surface radius less its padding), a 16px icon, 8px gap, 13px label and one
trailing slot for a shortcut, a check or a chevron. A row that earns a second
line (rule 9: a consequence, a varying fact) keeps the same label and adds the
line at 12/16 in secondary ink; it grows by that line and 6px of padding above
and below, its icon centred on the label's line. That is the only menu row:
`PopoverOption` and the vendored dropdown item render through it. A group label is 12/500 in
secondary ink. A separator is a 1px rule with 4px around it. **The wide menu**
is the same at up to 340: a submenu, a 28px search field on top for a long
list, a list of agents with meters, a muted footer line under a separator.
Long names wrap to a second line rather than widening it.

**The info card.** 288 wide, padding 12, facts only, opened by hover or focus
on a fact in the status bar or on a name. It never carries actions and never
stacks on top of a menu.

`PopoverOption` (the 36px row) is retired into the menu row; the vendored
dropdown, `Popover` + `Menu`, and the branch flyout all render the one menu.

### Windows that are not wide

As the frame's fixed rules say: below 1280 an opened right panel floats over
main; below 1000 the left column floats too; the top bar folds by its title's
room. The left column's Settings mode floats the same way.

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
| Conversation header, Team header (`TeamRoomPane`), draft header | the top bar, built from one `TopBar` pattern with the nine slots |
| Run header, Board header, Findings header, Runs head | the top bar's verb and View slots; `ViewBar` from step 0 is retired when the shell lands |
| `DockPanelBar`, `ToolPaneHeader`, `PanelTools`, `PanelActions` (split, move, zoom), `DockPanelTabs`, `PanelPill` | retired: the right panel has no bar; its tabs are the top bar's tool icons |
| Run details, Changes, Activity, Trajectory, Background tasks, Agents (subagents) views | the four tools (Details, Changes, Activity, Browser); Steps becomes the Run tab's Timeline |
| `TabsList` default, `Segmented` | one switcher |
| `AppWindow`, `WindowNav`, `WindowPage` | retired; `WindowNav`'s groups move into the left column's Settings mode |
| `PageHead`, `DetailHead`, `BackLink` | retired; the crumb in the top bar replaces them |
| `Page` (new, in `design/patterns`) | the page template: `width="reading" \| "wide" \| "canvas"`, built on `PaneColumn`; the one way a page sets its measure and margins |
| `Popover` + `PopoverOption`, `Popover` + `Menu`, `DropdownMenuContent`, the branch flyout | the menu and the wide menu |
| `HeaderStatusGroup`'s hover card, `PopoverContent` | the info card |
| the frame contract (new, in `design/`) | the numbers in this spec, read by the components and by the rendered check |
| `app.css` `body` | loses `-webkit-font-smoothing: antialiased` |
| `App.tsx` window flags | one main destination in the workbench state, with history |

## Order of work

The system changes before the screens (rule 12), and each step lands on its
own with the app working:

0. **The contract.** Default font smoothing. The frame's numbers in one
   module in `design/` (bar, rail row, menu row, info card, page widths and
   margins, type role per slot), read by the components and by the check. The
   `Page` template. The rendered check (below), starting with the menus, the
   bars and the Findings page, the rest joining as each step lands. The audit
   rules: no page-level width or padding in a screen; one component per role;
   the ceiling on layout written in screens.
1. **Tokens.** Bar height 40 and the window-button position; the named widths
   and menu tokens; dead tokens out. Every screen moves with it; re-record
   `metrics.json`.
2. **The fixed shell.** The shell renders the top bar, the panel frame and
   the status bar; destinations register their slots instead of drawing
   headers (`useTopBar`, tool bodies, status facts). It starts with an
   inventory of every panel view, each placed in one of the four tools or a
   page. The conversation, Team and draft headers are deleted as they move;
   Run, Board, Findings and Runs register their verb and View menu, and step
   0's `ViewBar` goes; the panel bar, its split/move/zoom menu and the docked
   inspectors' own bars and titled cards go; page facts move to Details and
   app-wide facts to the status bar; the right-panel toggle leaves the
   window-buttons row for its place before ⋯.
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

## Blocks, and who owns layout

**Why a token system still produces a patchwork.** The design system is built
from the bottom: values (tokens), then parts (Button, Row, Chip), then
patterns. It answers what a button looks like, never where it goes, how wide
a page is, or where a card's head, rows and footer start. Those are
relationships, and no component owns them, so every screen decides them. On
2026-10-09 the 172 screen files in `components/` carried 319 inline class
lists with layout in them (flex, grid, gap, justify, padding, margin, width)
and their 62 stylesheets 867 layout declarations. Every piece on the Findings
page was a token-clean component; the page was wrong because the screen
assembled them — a column of `flex flex-col` that stretched a button, a
`Note` used as a settings row, a key/value list with no card and no width.

**Layout belongs to the frame, the templates and the blocks.** A screen
chooses a destination and a template and passes content into blocks; it does
not position anything. The audit counts layout in screens (inline layout
classes and layout declarations in screen stylesheets) under a ceiling that
only goes down, as the existing burn-down gate does; a screen moved in step 5
reaches zero, and new layout in a screen is refused at once.

**Blocks take data, not style.** The reason sessions built at different
times each produced their own style is that a block accepted markup and a
`className`: a screen that needed a table, a label or a menu could drop in
its own, styled on the spot. A block now takes content as data — a menu
takes `items` (label, icon, earned line, shortcut, tone), a `SummaryList`
takes `rows`, a `Chip` takes a `tone` — and renders it one way. Screens may
not pass `className` or layout to a block; the audit refuses it. A screen
that cannot say what it needs in the block's data has found a missing case,
and the case is added to the block for every screen.

**A menu decides once.** Every row in a menu has an icon or none does; the
check refuses a mix. Its width is its content between 200 and 340, never
wider — long names truncate or wrap. Its padding is the menu's, never the
caller's. A second line is an earned line or nothing.

**One edge per surface.** In every surface — page column, card, menu, panel,
info card — the head, the rows and the footer start their text at one x: the
surface's content edge (a menu: its 4px padding plus the row's 8px; a card:
16; an info card: 12). An icon hangs before the edge; it never moves the text.

**Columns line up.** A list whose rows carry the same facts is a table in all
but name: each fact has its column, and a row missing one says so *in that
column* ("No usage reported" under the meter, not after the name).

### The blocks

Each kind of content has one block, drawn one way everywhere:

| Content | Block | How it is drawn |
| --- | --- | --- |
| Facts about one thing | `SummaryList` | one card; key and value on one baseline at the same size, the key in secondary ink in a fixed column (132 on a page, 92 in a panel, 96 in an info card), one line; numbers sit beside their key, never at the far edge; a value is a word or a phrase — a sentence becomes a short value plus one earned line; paths, branches and accounts truncate in the middle and never break mid-word |
| A setting | `Row` | in a card; title, optional earned line, the control at the row's end |
| An item in a list (finding, Team, Agent, job) | `ListRow` in `Rows` | title 14/500; one meta line 12 in secondary ink (kind, short id in mono); one status chip; a chevron when it opens something |
| An event (chat, activity, timeline) | `Event` | face 20, who and what in one sentence, the time at the end; a body of at most two lines with Show all; hashes shortened in mono, links by name (`#1559`), never a raw URL; a feed sits on the composer, not at the top of an empty page |
| State | `Chip` | one shape, 22 tall, a tone per state, three words at most; the longer reason is its title |
| A choice of action | menu row | as in Popups |
| A page's or view's verb | outline button in the top bar's verb slot | as wide as its words, never a full-width bar |
| Nothing yet | `EmptyState` | one sentence and at most one action, centred in the column |
| What sending or a run will do | the composer tail line | one paragraph per line; names and sentence flow as text |

The acceptance examples are the four surfaces the owner pointed at: a Team's
Findings, a Team's Chat, the conversation status card and the plan usage
popup. Each is redrawn from these blocks in the catalogue and must pass the
rendered check before the step that moves it lands.

## How it stays one app

A screen feels built by a different person when it was: each screen laid out
its own page, picked its own close-enough component and was checked alone.
Four things stop that here.

1. **Screens compose; they do not lay out.** The template sets the width and
   margins, the bars set the top, the blocks set the inside. A screen that
   needs layout CSS of its own is a sign the system lacks a block, and the
   block is added to the system first (rule 12).
2. **One hand moves the pages.** Step 5 is done by one writer, in order,
   against this spec and the check — not spread across parallel lanes that
   each interpret it.
3. **Every page is judged on one wall.** The catalogue gains a page wall:
   every destination rendered from the real code at the same width, side by
   side, light and dark. A review looks at the wall, where a different gutter
   or a heavier title is visible at once, not at one screen alone.
4. **Drift fails a check.** The rendered check below measures the result, not
   the source, so a token-clean screen that still differs is caught.

## How it is checked

- `node script/design-audit.mjs --strict` stays at zero; a bar, page or popup
  that hand-sets a height, padding or width where a token exists fails it, and
  so does a page-level width or padding in a screen or a second component for
  a role that has one.
- **The rendered check** (`e2e/ui-system/frame-contract.spec.ts`) opens every
  destination, bar, rail and popup in `preview.html`, in both themes, at a wide
  window and at 720, and compares computed values with the contract module:
  font family and smoothing, size, weight and line height per slot; bar, row
  and control heights; padding, gap and radius; content width; that every
  block on a page shares the column's left edge; that every surface's head,
  rows and footer start at its one content edge; and that a list's facts sit
  in their columns.
- `e2e/ui-system/container-insets.spec.ts` gains the page widths and the
  panel content edge; a new check measures that every top-of-column row in a
  window is 40 and that their bottoms share one y, and that ⋯ lands at one x
  on every destination, the View icon at one x on every Team view, and the
  tools at one x on every piece of work.
- The catalogue (`design.html`) shows the top bar on every destination and
  every Team view, folded and unfolded, the left column in both modes, the three
  popups and the page wall, from the real components with real-length content
  (second lines, long names, CJK titles); `node script/ui-catalog.mjs` passes.
- Each step is looked at in the built app in light and dark, at a wide window
  and at 720, with frames from the rig.

## Out of scope

- Inset-card panels: a possible Appearance option later, not this change.
- What Skills means in Settings versus Library: both stay where this spec puts
  them; reconciling the two is its own design.
- The transcript, the composer and the board's own geometry, beyond the bars
  and margins around them.
