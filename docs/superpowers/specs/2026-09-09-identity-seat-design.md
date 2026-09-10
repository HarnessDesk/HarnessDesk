# The seat is you; the agent is a badge

*2026-09-09. Design for the sidebar's bottom row and for what "run new
sessions as" does to the window.*

## What is wrong today

Picking a different agent in the seat menu makes the window blink, and the
row itself changes its name. Both come from one place: `selectRuntime` in
`packages/ui/src/state/store.ts` treats a preference as a navigation.

- It sets `history: []`, so the session list goes blank until five requests
  and a fresh page come back. That is the left-panel flash.
- It calls `newDraft()` whenever the focused pane is a conversation, so the
  conversation on screen is replaced by an empty draft. That is the
  main-pane flash — and a conversation the reader did not ask to leave.
- The seat prints the account's name (`Shane-VT`) and the agent's mark of the
  *focused* conversation, so it re-renders on every switch and every pane
  focus, and it says the account is who you are.

The field `activeRuntime` is carrying two jobs: *which agent starts the next
session* (a preference) and *which agent's catalogue the window is showing*
(models, options, skills, account, limits, and the history page). The first
is cheap and should stay cheap; the second is what all the blanking is for.

## Principles

1. **The desk is yours; agents are pens.** The seat is your identity —
   "HarnessDesk" today, your HarnessDesk account when there is one. Which pen
   you will pick up next is a badge on that identity, not the identity.
2. **A conversation belongs to its agent.** Changing the default pen never
   touches a conversation on screen. Its own composer already says who it is
   with and offers the hand-off.
3. **The list is the desk's, not the pen's.** History is every agent's
   sessions merged; it must not blank because the default changed.
4. **Switching is a preference write, not a navigation.** Nothing moves; only
   what "New session" will do next changes.

## Behaviour

### `selectRuntime(id)`

- Sets `activeRuntime` and persists it, as now.
- Swaps in what the window already knows about the new agent, in the same
  frame: `draftValues` from the per-runtime drafts, `health` from
  `healthByRuntime`, `account` from `accountsByRuntime`. Nothing on screen has
  to wait for the wire to stop lying.
- Clears only what the agent alone can answer, then asks for it
  (`refreshRuntime`): `models`, `runtimeOptions`, `draftOptions`, `routes`,
  `draftRouteId`, `limits`, `skills`. None of these is visible inside a
  conversation; a draft's model picker fills when the answer lands.
- **Leaves `history` and its cursor alone.** The list is paged around an
  *anchor* — the agent whose history the list was last rebuilt from — and
  paging continues along that anchor after a switch, so a reader three pages
  down stays three pages down. The anchor is re-chosen on a real reset (a
  session created, a search cleared, a sign-in, an agent coming up).
- **Never calls `newDraft()` and never parks a hand-off.** The focused pane is
  untouched. A draft on screen re-reads `useRuntime()` and becomes the new
  agent's draft — the one place a switch is visible, and it is the place the
  reader is looking at when they switch from the composer's agent chip.

### The verbs that leaned on the replacement

- **Command palette "Start with X"** promised a conversation. It now switches
  and then opens a draft explicitly, so the promise holds.
- **Hand-off** with a conversation open already opens its own draft; with
  nothing open it is just the switch, and the draft re-renders. Unchanged.
- **Settings "Make default" / "Use this agent", SetupDesk "Use this agent",
  the name card's "Run new sessions as this"** are preference writes. Settings'
  "Active" chip becomes "Default", the word its own "Use for new sessions"
  row already uses. The name card omits "Run new sessions as this" on the
  agent that already is the default — a verb that would do nothing is absent,
  not greyed.

### The seat

Left to right on one 36px row:

- **You.** The HarnessDesk mark in a 24px disc — the same drawing as the
  menu's top row — and the word "HarnessDesk". When a HarnessDesk account
  exists, its picture and name take this slot and nothing else on the row
  changes.
- **The pen.** At the trailing edge, the default agent's brand mark in a 24px
  disc wearing its account's tint ring — the same disc as the seats in the
  menu, "just like the current icon". The disc is the name card's trigger
  (the mark, never the row; out of the tab order): the card names the
  account (nickname, email, plan), the meter, the cautions, and Usage.
- **Readiness.** The dot at the row's end is the default agent's — ready,
  needs sign-in, at limit, broken — because the question this row answers is
  "will my next session start". A usage figure appears only when its tone is
  not good, as now.
- The account's *name* leaves the row. It is on the card and ticked in the
  menu. The row's tooltip reads "New sessions run as <agent · account>".
- The menu keeps its structure: You (with the Local tag) · Run new sessions
  as (every account of every agent, tick on the default) · Add an account… ·
  Settings · Dashboard · Sign out of <default agent>.

### Which surfaces follow what

| Follows the focused conversation | Follows the default |
| --- | --- |
| conversation header, its composer's agent chip | the seat badge and the menu's tick |
| header strip anchor, context ring | the draft composer, ⌘N |
| — | the app-level status banner, the palette's *Start with* |

**Rule:** a surface inside a pane speaks for the pane's agent; a surface
outside every pane speaks for the default.

## Alternatives considered

- **A. Keep replacing the conversation, only stop blanking the list.** Cheapest.
  Still a navigation nobody asked for, and the seat keeps calling an account
  "you". Rejected.
- **B. The badge follows the focused conversation.** Reads naturally inside a
  conversation, but the menu under it is "Run new sessions as" and would tick
  a different agent than the badge shows; and the row would re-render on
  every pane focus — the churn being complained about, relocated. Rejected.
- **C. You + default-agent badge; switch = preference write.** Chosen.
- **D. Badge placement.** A corner-overlap badge on the avatar puts the brand
  marks at ~9px, where Codex's and Claude's are smudges. A full-size trailing
  disc keeps them legible. Chosen.

## Later: the HarnessDesk account

The "you" slot is the account: picture or initials, and its name; the Local
tag becomes plan or tenant. The badge and the menu do not change. The
persisted `activeRuntime` becomes a per-account preference once anything
syncs.

## Tests

- store: `selectRuntime` keeps the focused conversation and the history rows
  and cursor; paging after a switch continues along the anchor, not the new
  default; drafts and health swap in the same frame; the pick persists.
- store: hand-off with a conversation open still lands its chip on a fresh
  draft on the target.
- seat: the row reads "HarnessDesk" and never the account's name or email;
  the badge wears the default agent's mark even while another agent's
  conversation is focused; the tick follows the default; choosing a seat
  calls `selectRuntime`; a signed-out default dims the badge and colours the
  dot.
- card: the default agent's own card offers no "Run new sessions as this".
- palette: "Start with X" opens a draft on X.
- real app, isolated home with fake agents: open a conversation, switch the
  default from the seat menu; the pane's session key and the history length
  are unchanged, the seat text stays "HarnessDesk", the badge wears the
  target's mark.
