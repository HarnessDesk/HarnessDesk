# Race view — design

Status: **proposal, awaiting the owner's approval.** No code before it.

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

So the race view is not a new screen and needs **no new wire method**. It is
the room's side-by-side view, made first-class.

### Options

**A — "Side by side" becomes a room destination (recommended).** The room's
rail has four destinations: **Board · Chat · Side by side · Findings**.
Side by side is the tile grid below, holding one to four members. `/race`
starts the comparison flow and opens its room on Side by side with the
competitors on the tiles; any room can open Side by side with the members
the person picks. The composer at the bottom is the room's composer.
*Pros:* one component, one composer, one record; race and room converge;
works for any room. *Cons:* the room's current "click a member opens a
column" becomes "click a member puts it on a tile" — a small change to a
shipped behaviour.

**B — Race is a mode the room switches into.** The same data, but a race
room opens a dedicated race layout (grid + judge bar) that ordinary rooms do
not get. *Pros:* a race can carry race-only chrome without explaining it in
ordinary rooms. *Cons:* two layouts of the same members to keep in step;
exactly the drift the owner asked to avoid.

**C — Split the window into conversation panes** with the panel system.
*Rejected:* it breaks the one-conversation-pane rule outside any named mode,
every pane would bring its own composer, and nothing would tie the panes to
one prompt.

**Recommendation: A.** The race-specific parts (the judge's verdict, the
person's decision) are shown only when the room runs a comparison flow, as
bands in the same view — not a second layout.

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
  its own window's conversation, stop this one).
- **Conversation** (default): that member's real `Conversation`, mounted in
  its own scope (pane-local session key — never the global active session),
  **without its own composer** while it is on a grid of two or more: the one
  composer is below. Approvals it raises appear in the tile as they do
  today.
- **Browser**: that seat's **own isolated browser profile** (every race seat
  already gets an isolated checkout, lane and browser profile) — the real
  browser pane scoped to that profile. The toggle is per tile and persisted.
- **Idle**: before its first turn a tile says what it is waiting for
  ("Waiting for the first prompt"), not an empty transcript.
- **Expand**: the tile fills the room's right side; the others stay mounted
  (hidden with `visibility`, never `display: none` — a webview comes back
  blank and a terminal measures zero columns otherwise); **Esc** or the
  same control returns. An expanded tile **shows its own composer**, so
  steering one competitor directly is one click, not a mention.

### The composer

The room's composer, in the ordinary composer's spot: centred at the bottom
of the grid, over the splitter junction, as wide as the ordinary composer.

- **Audience**: a chip row above the text reads **Everyone** by default;
  typing `@` narrows it to named members (the existing audience logic,
  unchanged). One tile expanded → its own composer instead.
- **Settings for several agents**: the composer's controls are the fixed
  slots of the composer proposal (#979); where the targets' values differ a
  slot reads **Mixed** and its menu lists each target.
- **Busy competitors**: a post to a member mid-turn is **queued** (the
  channel's existing state) and its tile shows "Queued — next after this
  turn". **Stop** in the composer stops every addressed member that is
  working; each tile's ⋯ stops one.

### The judge and the person's decision

- The judge is a room member like any other; it is not on a tile by default.
  While it works, a band above the grid reads "The judge is comparing N
  attempts".
- Its structured verdict appears as a **verdict band** above the grid (the
  pick, and a line per attempt), and the picked tile's header gets a chip.
  The band's action is the flow's person step — **Merge this attempt** —
  which stays a person's decision.
- **No independent judge available**: the judge needs a runtime that holds
  a read-only ceiling (today only one does, #1132) and a provider none of
  the competitors use. When four competitors leave no such seat, the race
  still starts; the band says why no judge was seated and offers **Choose a
  judge** (any seat, with the independence caveat stated) or **Judge it
  yourself**. Nothing is silently seated.

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

- **Focus**: one tile is focused (a ring); ⌘1–⌘4 focus a tile, ⌘⇧↵ expands
  the focused tile, Esc returns; Tab moves within a tile, never across tiles
  by surprise. The composer keeps its own focus.
- **Mounting**: tiles stay mounted across toggles and expand (`visibility`),
  so a transcript keeps its scroll and a browser keeps its page.
- **Resizing**: the grid re-flows from the room's measured width (the same
  measurement today's columns use); a tile never drops below ~420px wide
  except in the narrow one-at-a-time layout.
- **Restore**: the destination, the tiles, each tile's Conversation/Browser
  choice and the expanded tile are part of the persisted view layout and
  come back after a restart; a tile whose member left the room says so and
  offers another member.

## 5. Engine changes (the multi-agent owner's lane, agreed)

- `comparison.yml`: drop `count: 2` on the competitor role (or have the
  substitution set it) so two to four seats compile; the judge card title
  stops saying "better" of two. — multi-agent owner.
- `substituteAgentRole`: set the width from the chosen seats. — multi-agent
  owner.
- `/race` dialog: two to four seat pickers instead of two fixed ones, the
  duplicate-seat check across all of them, and the judge line above. — this
  view's slices.
- No new wire method: posts, hand-outs and delivery states already exist.

## 6. The demo

"Race four agents to build a browser game." Four competitors on four
different models; one prompt in the composer ("Build a playable Snake game
in one HTML file"); all four tiles switch to **Browser** as each serves its
page; the person plays each in its tile, expands one, the judge's verdict
band appears, the person merges the pick. Frames and a short recording from
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
  four as user turns, Chat shows one row, a busy seat shows queued, the
  verdict band and the no-judge case.

## 8. Slices (after approval)

1. **Side by side destination + tiles + expand** (grid, header, focus,
   restore; Conversation only).
2. **One composer + audience + four seats** (the room composer in the
   ordinary spot, the dialog's four pickers; engine edits by the
   multi-agent owner).
3. **Browser per tile** (each seat's profile in its tile).
4. **Judge band, no-judge case, demo frames and recording.**

## For the owner to decide

1. **Option A** — Side by side as a room destination that races open on.
   Recommended.
2. **A tile on a grid has no composer of its own; expanding it brings its
   composer back.** Recommended — one place to type while comparing.
3. **When no independent judge can be seated**, the race starts and asks the
   person to choose a judge or judge it themselves. Recommended.
