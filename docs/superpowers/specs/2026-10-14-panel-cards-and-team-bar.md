# One bar, the card rail, and Teams and Flows

Owner decisions, 2026-10-14. The owner chose these from a drawn proposal after three rounds of review, taking every
recommendation (D1–D5). This amends `2026-10-09-app-frame-design.md`:

- Decision 4, "panels stay flat", is reversed. The rail is cards.
- Decision 11, "the panel holds one tool at a time and never splits", now applies to the tool pane only. The rail is
  separate.
- Decision 13's worded verb slot in the bar is removed.

`design/frame.ts` carries the numbers to the checks.

## Why

The owner called the Team view and the Teams page "among the ugliest screens". The Team bar held fifteen targets in six
visual styles:

- a colour chip;
- a boxed segment of tabs;
- counts, including zero;
- an outline verb;
- a greyed icon;
- the tools.

Its title was the whole brief. The right panel was one long key–value list. A Team's state was repeated in up to six
places: Needs you six times, Stop three times. The owner's notes on the drawings:

- the bar must be the same for a single session and a Team;
- no verbs in a bar ("Start a Team" does not go there);
- no back arrow;
- the rail sits under the bar;
- the browser and the tools are separate panes, not inside the rail;
- the Flow graph is the product's highlight and needs room;
- if the whole app had the drawings' spacing, it would be right.

## D1 — one bar

Every top bar has one shape. From the left:

1. the lead (the column toggle and ‹ ›, only while the left column is hidden);
2. a **state dot**, 8px, on a piece of work only (a session or a Team). It takes the state's tone and pulses while
   running. The state's words are its tooltip and accessible name;
3. the **title**, 14/500, at most `--hd-bar-title-max` (320) wide, as wide as its words (`--hd-bar-title-min` is the
   floor the fold protects, never a width). A Team's title is its brief's first sentence (`goalTitle`); the whole brief is
   the tooltip;
4. on a piece of work, the title is a ghost button with ⌄ that opens the **subject's verbs**:
   - a session: Rename, Fork, Archive;
   - a Team: Rename, Open pull request, Run again…, Wrap…, Stop run…;
5. a spacer;
6. on a piece of work, from the right edge:
   - the **rail toggle**;
   - a 1px divider;
   - the **pane doors**: Terminal, Changes, Browser and Files;
   - **⋮**.

   The doors are 28px buttons on a 32 pitch (`--hd-bar-tool-gap` 4). The open one takes the muted fill with no ring;
   pressing it again closes its pane. There is no separate panel toggle (◫);
7. on a standalone page (Settings, Teams, Flows, Agents, Library, Plugins, Dashboard, Inbox): fixed tools only, with its name in the body.

The bar holds **no tabs, no worded buttons and no back arrow**. A page's own verb (New Team, New Flow, Start a Team) is
the first control in the page's first row. A view's own choices (Thread or Side by side, Run 1 ⌄, Graph or Steps) sit in
that view: the composer row, the pane header, or a toolbar floating on a canvas.

`--hd-bar-pad` is 12, so every bar's first control sits 12 from its column edge. The content column anchors a standalone page's title at reading or wide measure; its chooser or verb shares that first body row. The title scrolls away without changing the bar. Named sessions, Teams and edited Flows keep their title menu in the bar. Canvas pages have no body title. The rail keeps its 8
(`--hd-rail-inset`).

## The regions

From left to right, in rows:

- **Left column:** full height. Its rows are 32px.
- **Bar:** across main and the rail.
- **Main:** under the bar.
- **Rail:** under the bar, beside main. It is shown or hidden by the rail toggle.
- **Pane:** full height on the right, with its **own 40px header**: its title or chooser, then ⤢ and ×. One pane is
  open at a time.

A pane holds one of:

- Terminal;
- Changes: the diff against the base, commit and pull request, and the git history (moved from Activity);
- Browser;
- Files: the tree and a file viewer, including image and HTML previews;
- for a Team, Board, Run or Findings (D2).

⤢ **swaps** the pane into main, and what was in main docks as the pane. ⇄ in the docked pane's header swaps them back.

Narrow windows:

- under 1000px, the left column floats;
- when the rail does not fit beside main, it floats under the bar as a sheet: radius 12, 8 from the window's edge, a
  large shadow;
- the pane takes main's place, with ⇄ to return.

## The rail: cards

The rail's ground is white like main (`--hd-background`, owner 2026-10-14), padded 8, with 8 between cards; the cards' 1px border sets them apart.

**A card** (`ToolSection`):

- the main ground (`--hd-background`);
- a 1px `--hd-border-strong` border;
- radius 10;
- 10 above and below;
- its rows carry their own 12 edge.

**Its header**, 20 tall:

- the label at 13/500, primary ink;
- when the card folds, a chevron 4 after the label: › folded, ⌄ open;
- the card's **value** at the end, 13, secondary ink;
- a header action, when there is one, after the value.

**The rest of the card:**

- A folded card is its header alone, 42 tall.
- A row (`ToolRow`) is 28 tall: a 16px icon in secondary ink, 8, the label, one trailing fact, and at most one small
  action. Stop uses danger ink.
- More rows sit behind one quiet line (`ToolFold`): "All facts", "Show all".

A session's cards are:

- Conversation (agent, folder, branch, context);
- Plan;
- Background tasks (from Activity).

A Team's cards are:

| Card | Value | Rows |
|---|---|---|
| Needs you (only when it does) | count | each decision with its button; Ready to wrap with Wrap |
| Run | step and elapsed ("Fix · 12m") | a **live mini graph** of the Flow (done steps filled, the current one in the accent, the rest dashed); the Flow and its round, with Stop; the pull request and its checks ("CI 8 / 21"); "All facts" |
| Seats | count | each Seat's face, name and role, and one state word; the Seat's menu stays on its row |
| Board | "N open ›" | opens the Board pane |
| Findings | "N open ›" | opens the Findings pane |
| Changes | +/− › | opens the Changes pane |

## D2 — a Team's views open beside Chat

**Chat is the Team's home** and owns main:

- The **Overview page and the tab row are removed**.
- Board, Run and Findings open **as the pane** from their cards.
- A Team someone already opened returns to the last pane it had open. A remembered Overview or a remembered tab reads
  as Chat.
- A wrapped Team opens its Receipt in the pane.

**The thread** tells the run's story:

- the person's brief is the first item, as theirs;
- each round is a quiet centred divider ("Round 2 · Review");
- pushes ("Alpha pushed 3 commits to team/x · +277 −187"), job claims and findings show as one-line events, indented to
  the message text;
- the live line closes the thread.

The rest of Chat:

- **Thread or Side by side** is a two-icon switch at the end of the composer's row.
- Repeated identical steps fold ("Waited for the next card × 12").
- Durations over 99 minutes read in hours ("34 h", not "2039m").

## The Run, in its pane and on its graph (D5)

**The Run pane:**

- The header is "Run 1 ⌄", which chooses among the Team's Runs, then the Flow's name, ⤢ and ×.
- The body has a **path strip** on top: the steps as pills joined by short lines.
  - A done step is filled, with a check.
  - The current step is the accent.
  - A step not yet reached is dashed.
  - One line under the strip says the loop ("Review and Fix repeat up to 3 rounds").
- Under the strip, the **steps**, one row each.
  - The open step expands in place: what it answers, what it is doing, and its Seat's conversation.
  - Steps not reached are short grey rows that say when they would run.
- There is no separate Run details panel.

**The graph (G1).** The Run card's mini graph, or ⤢ on the Run pane, puts **the graph in main** and docks Chat as the
pane.

- It is the existing `FlowCanvas`, live and read-only.
  - Done steps carry a check.
  - The running step glows in the accent.
  - The path taken is solid; what has not run is dashed, with its condition on the edge.
- Its own controls float on the canvas: Run 1 ⌄, Graph or Steps, Edit this Flow, and zoom (− 100% + Fit).
- Selecting a step opens that step's card on the canvas: who, what it answers, what comes next, and Stop.

## D3 — the Teams page is a board

The bar reads "Teams" and ⋮. The first row is New Team, the project filter ("All projects ⌄") and a search field.

The page has three columns, by what each Team needs from the person:

- **Needs you**;
- **Working**;
- **Ready to wrap**. Wrapped Teams fold under it ("Wrapped · 14 ›").

Each column head has a dot and a count. A card shows:

- the Team's title;
- one line for its column: the ask in warning ink, the current step, or the outcome;
- the Run's path as a segmented bar;
- the Seats' faces;
- the project and the age.

## D4 — Flows are a page

**The Flows destination:**

- It is in the left column after Teams, with its count.
- Its first row is New Flow, an origin filter (All, Built in, per project) and a search field.
- Each Flow is a card: its name, its origin chip, its **mini graph**, one line on its loop or trigger, and its Run count.
  "Just a Team" is a Flow with no steps.

**One Flow's page:**

- The bar reads the Flow's name ⌄, then the rail toggle and ⋮.
- Main is the same `FlowCanvas`, **editable**: drag, connect, "+ Add a step".
- Floating toolbars on the canvas hold "+ Step ⌄", "+ Rule", Undo, and Graph, Steps or File (top left), and Dry run and
  **Start a Team** (top right).
- The rail's cards:
  - the selected step (Role, Agent, Effort, Answers, What happens when it pushes);
  - Rules;
  - Triggers (moved here from Settings);
  - Runs (the Teams it started);
  - Source.
- Today's Build your own and Edit shape dialogs become this page.

Settings › Workspaces › a project keeps only workspace preferences. Its Flows and Triggers sections leave.

**New Team** is one dialog from every door:

1. the task;
2. a Flow picker of cards with mini graphs;
3. the agents per role;
4. Done when;
5. Dry run and Start Team.

A door only pre-fills it: Start a Team on a Flow picks that Flow.

## Built so far (foundation)

- the spacing tokens (bar pad 12, rail 8, left rows 32, page stack 16, the panel-card tokens);
- `ToolSection` as a card, with `ToolRow` and `ToolFold`;
- the panel ground;
- the quiet switcher look;
- the TopBar's state dot, title menu and title width.

The screens follow as one pull request each: the shell (D1 and the regions), the Team view (D2), the Run and the graph
(D5), the Teams page (D3), and Flows (D4).
