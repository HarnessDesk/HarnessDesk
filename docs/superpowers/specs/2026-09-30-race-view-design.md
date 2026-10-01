# Race view — design

Status: **approved by the owner (2026-10-01)** — all four decisions as
recommended (Option A; one shared composer, an expanded tile brings back
its own; the person-judged fallback with the engine slice first; tile keys
⌥⌘1–⌥⌘4). Build in the slices of section 8.

## What the owner asked

A much better view for a race: two to four competitors — different models or
runtimes — side by side in the middle, each switchable between its
**conversation** (the default) and its **own browser**, any one expandable to
full and back, and **one composer in the ordinary composer's spot** whose
prompt every competitor answers. Then: *rethink how this is reused with the
team room chat, for a good experience.* The owner's sketches: a sidebar, then
two columns (2-up) or a 2×2 grid (4-up), each tile headed "Tab | Browser",
and one composer floating at the bottom centre over the splitter junction.

## 1. A race is a shape of a Room

This is settled first because the rest follows from it.

**What is already true** (confirmed with the multi-agent owner, from main):

- `/race` starts the built-in `comparison` flow through `flow/start-goal` and
  opens its Goal. **A Goal is a room**: every Seat is a room member. Starting
  a race and opening that room already land on the same room.
- A room already opens members' conversations **side by side** (up to three
  columns of at least ~420px, the least-recently-read one giving way, the
  arrangement kept in the persisted view layout).
- The room's composer already addresses **everyone, one member, or chosen
  members**: nobody chosen → `team/post { room, text }`; one →
  `team/post { …, to }`; two or more → `team/handout { recipients }`. `@`
  in the composer builds the audience as chips; the host never parses
  mentions.
- A post lands in each recipient's **own conversation as an ordinary user
  turn** (the agent keeps its own history — rule 3), and the room's Chat
  shows **one row** for it (the host stores a row per recipient; the channel
  merges them). There is no second copy and no second path.

So the race view is not a new screen, and its messaging needs **no new wire
method**. It is the room's side-by-side view, made first-class. (The one new
method in this design is the judge fallback's, section 2 — the multi-agent
owner's.)

### Options

**A — "Side by side" becomes a room destination (recommended).** The room's
rail has four destinations: **Board · Chat · Side by side · Findings**.
Side by side is the tile grid below, holding one to four members. `/race`
starts the comparison flow and opens its room on Side by side with the
competitors on the tiles; any room can open Side by side with the members
the person picks. The composer at the bottom is the room's composer.
*Pros:* one component, one composer, one record; race and room converge;
works for any room. *Cons:* more to build than it looks — the room's
columns, its composer and its browser were not made for this (section 4
lists what changes), so the slices are sized for that.

The room's member actions keep their meaning: **Open** still shows that
member's full conversation, with its own composer; **Watch** now puts the
member on a Side by side tile (or focuses it if already there) and switches
to Side by side, from any destination.

**B — Race is a mode the room switches into.** The same data, but a race
room opens a dedicated race layout (grid + judge bar) that ordinary rooms do
not get. *Pros:* a race can carry race-only chrome without explaining it in
ordinary rooms. *Cons:* two layouts of the same members to keep in step;
exactly the drift the owner asked to avoid.

**C — Split the window into conversation panes** with the panel system.
*Rejected:* it breaks the one-conversation-pane rule outside any named mode,
every pane would bring its own composer, and nothing would tie the panes to
one prompt.

**Recommendation: A** (reviewed: the direction holds; section 4 carries
what it costs). A race adds no chrome of its own to the view: the judge's
verdict and the person's decision live where any flow's do — the judge's
own conversation, the room's Chat and Board (owner, 2026-10-01: "I don't
like the judge attempt UI. Not needed.").

## 2. The view

### Layout

| Tiles | Wide window | Narrow (< ~900px of room) |
| --- | --- | --- |
| 1 | one column (same as today's member column) | same |
| 2 | two columns | one tile at a time, a tile strip to switch |
| 3 | three columns (≥ ~420px each), or 2 + 1 below when narrower | one at a time |
| 4 | 2×2 grid | one at a time |

The rail (Board · Chat · Side by side · Findings · members) stays at the
room's left as today; the app sidebar stays at the window's left. The grid
uses the room's full right side; gutters are the splitter hairlines of the
panel system, and tiles are equal (resizing a split is a later slice).

### A tile

- **Header** (one bar, the system's `Bar`): the member's mark and name, its
  model (as the runtime presents it — the UI never names a runtime), a state
  chip (working / waiting for you / done / stopped), elapsed time and cost
  when the runtime reports them, then **Conversation | Browser** (a
  segmented control), **Expand**, and a ⋯ menu (take off the grid, open in
  its own window's conversation, stop this one). The header folds as the
  tile narrows: time and cost go into the state chip's hover text first,
  then the model into the name's, then the toggle becomes two icons — the
  name, the state and the toggle always stay on the bar. The name is never
  what truncates: anything else on the bar folds first (the mock frames
  showed a chip squeezing a name to "Ga…").
- **Conversation** (default): that member's real `Conversation`, mounted in
  its own scope (pane-local session key — never the global active session),
  **without its own composer** while it is on a grid of two or more: the one
  composer is below. Approvals it raises appear in the tile as they do
  today.
- **Browser**: that seat's **own isolated browser profile** (every race seat
  already gets an isolated checkout, lane and browser profile). The browser
  pane reads a mounted browser view and its mount id, and agent navigation
  finds views by profile, so each tile **owns a profile-scoped browser view**
  registered like any other mount (its own id, its tabs persisted with the
  room's view). An agent navigating its profile lands in its tile. Before the
  seat has a page the tile says "No page yet — it opens here when this
  attempt serves one". The toggle is per tile and persisted.
- **The first prompt is the race's task.** `/race` asks for the task in its
  dialog and the comparison flow seeds each competitor's card from it; the
  grid's composer is for everything after — follow-ups, steering, a shared
  hint. The task is never sent twice. Before a competitor's first turn
  starts its tile says "Starting — setting up its checkout", not an empty
  transcript; a seat that could not start says why, with the flow's own
  reason, and offers **Replace this seat**.
- **Expand**: the tile fills the room's right side; the others stay mounted
  and hidden the way the workbench hides panes (never `display: none` — a
  webview comes back blank and a terminal measures zero columns — and a
  hidden webview is moved outside the clipped box so it cannot paint over
  the expanded tile); **Esc** or the same control returns. An expanded tile
  **shows its own composer**, so steering one competitor directly is one
  click, not a mention.
- **Approvals**: each tile shows the approvals its member raises, in the
  tile, as a conversation does today; four at once are four prompts in four
  tiles. The shared composer never claims one tile's approval.

### The composer

**It looks like the ordinary single-conversation composer** (owner,
2026-10-01: "make the composer closer to the single session") — the same
box and placeholder, the same tool row underneath, the same round send
button — in the ordinary composer's spot: centred at the bottom of the grid,
over the splitter junction, as wide as the ordinary composer. The bottom
tiles keep room under it — their scroll area ends above the composer's
measured height — so their last lines are never hidden behind it.

- **Audience is the tool row's leftmost anchor**, where a conversation's
  composer shows its agent: it reads **Everyone** by default, or the named
  members; typing `@` narrows it (the room composer's existing audience
  logic, unchanged). A stopped or unavailable member stays listed with what
  will happen ("stopped — it will read this when restarted"), never
  silently dropped. After a send, each recipient's outcome shows as the room
  composer shows it today (delivered, queued, refused with its reason).
- **One draft**: the room has one composer draft, kept across Chat and Side
  by side (today it unmounts with Chat). One tile expanded → that member's
  own composer and its own draft; the room draft waits unchanged.
- **Settings for several agents**: the composer's controls are the fixed
  slots of the composer proposal (#979); where the targets' values differ a
  slot reads **Mixed** and its menu lists each target.
- **Busy competitors**: a post to a member mid-turn is **queued** (the
  channel's existing state) and its tile shows "Queued — next after this
  turn". **Stop** in the composer stops every addressed member that is
  working; each tile's ⋯ stops one.

### The judge and the person's decision

No judge or verdict UI in this view (owner, 2026-10-01).

- The judge is a room member like any other; it is not on a tile by default
  (Watch can put it on one). Its verdict lives in its own conversation, in
  the room's Chat and on the Board, as any flow's review does.
- The merge is the comparison flow's existing person card on the Board, as
  in any flow — a person's decision, never made through the composer.
- **After the verdict the shared composer stays** for the room's ordinary
  use: the person may ask the picked attempt to polish, or ask all of them a
  question before deciding; its audience defaults to Everyone as before.
- **No independent judge available**: the judge needs a runtime that holds
  a read-only ceiling (today only one does, #1132) and a provider none of
  the competitors use. Today the flow's preview refuses such a race (its
  only errors sit at the judge role), and the flow language has no
  fallback role. So, agreed with the multi-agent owner:
  - **In the `/race` dialog** (this view): when the preview's only errors
    are at the judge, the dialog offers **Judge it myself** — it rewrites
    the judge's block to a person step (the same substitution idiom `/race`
    already uses for its seats) and previews again, so the file that runs is
    exactly the one previewed. **Name a seat** is the other offer; if that
    seat shares a provider with a competitor, the preview says in words that
    the judge is no longer independent.
  - **In the engine** (the multi-agent owner's slice, before this view's
    judge slice): a person step in the judge's place receives the same
    candidates an agent judge gets — each attempt's card, branch and check
    result — and a new wire method (`flow/review/decide`, added in the
    three-edit order) records the person's pick as the same review fact an
    agent judge records, so every later rule of the flow works unchanged.
  Nothing is silently seated.
  The person's pick, when the person judges, is made on the Board's person
  card (the multi-agent owner's slice), not in this view.
- **Every attempt fails its checks**: today no rule continues and the run
  settles waiting for the person, with its reason on the Board. This view
  adds nothing for it in the first version; each tile's state chip reads
  its attempt's own outcome. A flow-level "fix what failed" round is a later
  option for the multi-agent owner.

### More than four members

The grid holds up to four. Which members are on it is the person's choice,
kept in the view: a race puts its competitors there; in any room, clicking a
member on the rail puts it on a free tile or — when full — on the
least-recently-read tile, and the rail says which before the click (today's
column rule, kept). Pinned tiles never give way.

## 3. The one-conversation rule, relaxed on purpose

Two conversations side by side exist **only** inside a room's Side by side
destination — a named mode, entered deliberately, left by picking another
destination. The panel system's splits still refuse a second conversation;
nothing in Side by side goes through them. Tiles are mounts inside the room's
view, not workbench panes, so an accidental split cannot produce this layout.

## 4. Reliability

- **Focus and keys**: one tile is focused (a ring). The tile keys go through
  the app's one shortcut table and its settings page, not a local handler.
  ⌘1–⌘4 already select browser tabs when a browser has focus, so tile focus
  uses ⌥⌘1–⌥⌘4; ⌥⌘↵ expands the focused tile; Esc returns — after an open
  menu, dialog or approval has taken its own Esc. F6 moves between the rail,
  the tiles (in order) and the composer; Tab stays inside a tile.
- **Mounting**: tiles stay mounted across toggles and expand (`visibility`),
  so a transcript keeps its scroll and a browser keeps its page.
- **Resizing**: the grid re-flows from the room's measured width; a tile
  never drops below ~420px except in the narrow one-at-a-time layout.
  **The tiles are kept separately from how many fit**: today's column
  observer trims the stored column list when the window narrows, which
  would erase a race's tiles; the grid instead stores its chosen members and
  only the *display* adapts. In the narrow layout a tile strip above the
  composer lists the tiles in grid order, the focused one shown; the rail
  stays reachable; the composer stays at the bottom.
- **Closing a tile** takes the member off the grid; it does not stop it. Its
  ⋯ has **Stop** for that.
- **Restore**: the destination, the chosen members, each tile's
  Conversation/Browser choice, its browser tabs and the expanded tile are
  part of the room's persisted view (the room-view reader, which restores
  only its watched columns today, is extended); a tile whose member left
  the room says so and offers another member.

## 5. Engine changes (the multi-agent owner's lane)

- Four seats compile already: the seat substitution rewrites the role's
  seats and width. The judge card's title changes from "Pick the better
  attempt" to "Pick the best attempt". — multi-agent owner.
- `/race` dialog: two to four seat pickers instead of two fixed ones, the
  duplicate-seat check across all of them, and the judge line above. — this
  view's slices.
- **The person-judged review**: a person step in the judge's place gets the
  candidates, and `flow/review/decide` records the pick as the same review
  fact (section 2). — multi-agent owner, a slice before this view's judge
  slice. The dialog's "Judge it myself" / "Name a seat" rewrite is this
  view's.
- Messaging needs no new wire method: posts, hand-outs and delivery states
  already exist.

## 6. The demo

"Race four agents to build a browser game." Four competitors on four
different models; the race's task in the `/race` dialog ("Build a playable
Snake game in one HTML file"); all four tiles switch to **Browser** as each
serves its page (each tile its own attempt's transcript — the mock frames'
shared fixture is not acceptable for the demo); a follow-up in the shared composer ("add a high-score
counter") reaches all four; the person plays each in its tile, expands one,
reads the judge's verdict in Chat, and merges the pick from the Board. Frames and a short recording from
the rig (never a real desk).

## 7. Tests

- Unit: the tile model (put on grid, replace least-recently-read, pin,
  restore from layout), audience → wire call (none / one / many).
- Browser: 1–4 tiles at wide and narrow widths — tile geometry, no tile
  under ~420px on the grid, one composer only, a tile's own composer only
  when expanded; toggle Conversation ↔ Browser keeps the other mounted
  (scroll and page survive); ⌘1–⌘4, expand and Esc; restore after reload.
- Rules: the one-conversation rule still holds outside Side by side (a
  workbench split cannot hold two conversations).
- Rig: a four-seat comparison run on fake agents — one post reaches all
  four as user turns, Chat shows one row, a busy seat shows queued, and the
  no-judge case starts with the person as judge.

## 8. Slices (after approval)

1. **Side by side destination + tiles + expand** (Watch puts a member on a
   tile; grid, header, focus and keys, tile state kept apart from the column
   observer, restore; Conversation in a supported no-composer presentation;
   approvals in tiles). Conversation only.
2. **One composer + audience + four seats** (the ordinary composer's look
   with the room's audience as its leftmost anchor, in the ordinary spot,
   one draft across Chat and Side by side, per-recipient outcomes, stopped
   members listed; the dialog's four pickers). Its settings slots follow
   #979 — undecided at the time of writing; the owner decides #979, not
   this plan.
3. **Browser per tile** (a profile-scoped browser view per tile, agent
   navigation routed to it, tabs persisted, hidden webviews parked outside
   the clip).
4. **The no-judge path in the `/race` dialog** ("Judge it myself" / "Name a
   seat", after the multi-agent owner's person-review slice lands), **demo
   frames and recording.**

## For the owner to decide

1. **Option A** — Side by side as a room destination that races open on.
   Recommended.
2. **A tile on a grid has no composer of its own; expanding it brings its
   composer back.** Recommended — one place to type while comparing.
3. **When no independent judge can be seated**, the race starts with the
   person as judge (an engine change in the comparison flow), or with a
   judge the person names. Recommended.
4. **Tile keys are ⌥⌘1–⌥⌘4**, because ⌘1–⌘4 already switch browser tabs.
   Recommended.
