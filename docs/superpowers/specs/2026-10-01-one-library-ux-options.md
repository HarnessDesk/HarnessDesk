# One Library: three UX options

*2026-10-01. A draft for the owner to choose from. Nothing here is approved.
Built on [the use cases](2026-10-01-skills-management-use-cases.md) and
[the one-library design](2026-09-30-one-library-design.md). The owner chose
the hero journey: **keep my kit right**. The first screen is the inventory —
every agent, skill and scope with honest reach — and the options differ in how
a person gets from "something is off" to "fixed and confirmed".*

## What every option shares

These parts are fixed whichever option is chosen.

- **Kinds:** Skills · Rules · Servers, plus Hooks where an agent has the
  `hooks` capability. An ACP agent's slash commands appear as *command* rows,
  never counted as skills.
- **Place:** a switch between *This Mac* and *this repository*, with nested
  folders reachable through *What applies here*.
- **Reach facts per kind** (one-library design, *Principles*). Each fact
  carries its basis (asked, build, table) and its age. A fact recorded under an
  old agent build reads *needs a re-check*.
- **Writes are plans.** Every write is previewed in a `PlanDialog`. The result
  comes back as a per-agent **receipt**: changed, refused and why, or *needs a
  re-check*. Each target on it has *Retry* and *Restore*.
- **The sheet:** Overview · Reach · Content · Usage · History.
- **What disappears from Settings:** Agents › Skills and Agents › Extensions.
  Nothing an agent could do on those pages is lost: its store, search, failures,
  server sign-in and reload all move into the Library.
- **Rule 8:** no text names a runtime. Agent names come from
  `RuntimeInfo.presentation`, and controls are gated on capabilities.

## Option A — One page in Settings

The smallest change.

*Library stays at Settings › Capabilities › Library and grows to hold all of
it.*

```
Settings rail      │ Library
 …                 │ Where [This Mac · repo]   Agents [All ▾]    🔍   [Add ▾]
 Agents            │ Skills 42 · Rules 6 · Servers 9 · Hooks 3   [List|Matrix]
  Runtimes         │ ⚠ 3 differ · 2 not confirmed · 1 update        Review
  Models           │ ─────────────────────────────────────────────────────
 Capabilities      │ brainstorming   this Mac · source@4.2   ●●●○  3 of 4  ›
  Library  ◀       │ AGENTS.md       repo                    ●◐●–  …       ›
  Plugins          │ github (server) repo · needs sign-in    ●○●–          ›
```

- Choosing one agent under **Agents** turns the page into that agent's view.
  The agent's capabilities become chips (*reports its catalogue · has a switch
  · re-reads live*), and its store appears as a Store tab.
- *Review* filters the list to the rows that need attention. Fixing happens in
  each row's sheet.
- **For:** smallest move, fits today's IA, ships first.
- **Against:** a 100 × 10 matrix with diffs, a three-way merge and receipts in
  a settings pane; the per-agent view is a filter state, not a place.

## Option B — A Library window, by agent

*A Library window of its own, opened from the sidebar and ⌘K, in the same
AppWindow shell as Agents and Usage.*

```
Library window
 Overview          │ Overview                          Where [This Mac · repo]
 This repository   │ ┌ matrix: rows = skills/rules/servers, cols = agents ┐
 ─ Agents ─        │ │ basis on every cell, attention strip on top       │
  ● <agent 1>  42  │ └──────────────────────────────────────────────────┘
  ● <agent 2>  40  │
  ◐ <agent 3>  12  │ <agent 3> page: capability chips · its Skills · Rules ·
  ○ <agent 4>   —  │ Servers · Hooks · Store · "what applies here" for it
```

- **The rail** is the roster. Each agent's mark shows its health: in step,
  something to fix, or not measured.
- **An agent's page** absorbs that agent's Skills and Extensions pages whole.
- **The Overview** is the cross-agent matrix with the attention strip.
- **For:** answers "what does *this* agent have?" in one click, and the
  per-agent store, sign-in and hooks have an obvious home. It mirrors the
  Agents window.
- **Against:** "keep my kit right" is a cross-agent job. Fixing a skill that
  differs in three agents starts from the Overview, not from the rail, so the
  rail is mostly for reading.

## Option C — A Library window, by kind, with a fix queue

*A Library window of its own, like B, but the rail is laid out by what you do,
not by whose it is.*

```
Library window
 Needs you      5  │ Needs you
 ─ Kit ─           │ ┌ brainstorming — copies differ in 2 agents ┐ [Resolve…]
  Skills       42  │ ├ code-review — written, 1 agent can't confirm ┤ [Ask again]
  Rules         6  │ ├ github — configured, needs sign-in in 1 ┤ [Sign in]
  Servers       9  │ ├ 3 updates from sources ┤ [Review updates…]
  Hooks         3  │ └ last install: 1 of 4 refused (read-only) ┘ [Retry]
 ─ Places ─        │
  This Mac         │ Skills: rows with per-agent reach dots, filter by agent
  <repo>           │ (choosing one agent shows its capability chips + Store)
  What applies here│
```

- **Needs you** is a queue. Each card holds one decision and one verb, and the
  queue empties to *Your kit is in step*.
  - **What feeds it:** differs, not confirmed, rejected, updates, partial
    receipts, and evidence that needs a re-check.
  - **What stays out:** states that are normal on every machine, which is the
    `unscanned` lesson.
- **Kit** is the inventory by kind. **Places** is the scope view, and *What
  applies here* is one row of it.
- Choosing one agent in a kind's filter shows its capability chips and its
  Store tab.
- **For:** the default screen *is* "keep my kit right" — a list that goes to
  zero — and it is the most direct home for receipts, retries and re-checks.
  Rules and servers fit the same rail without a second design.
- **Against:** the biggest change. A queue is only as good as its predicates,
  and a noisy one is worse than none. The per-agent view is a filter, not a
  place.

## The comparison

| | A · Settings page | B · Window by agent | C · Window with fix queue |
|---|---|---|---|
| Default screen | Inventory list | Cross-agent matrix | What needs you |
| "Keep my kit right" | A filter (*Review*) | From the Overview | **The home screen** |
| An agent's own things (store, sign-in, hooks) | A filter state | **A page per agent** | A filter state |
| Fits today's IA | **Best** (same page) | Mirrors Agents | Mirrors Agents |
| Room for a matrix, diffs, receipts | Tight | **Wide** | **Wide** |
| Cost to build | **Lowest** | Medium | Highest (queue predicates) |

## Option D — recommended: B's inventory with C's queue

This option came from a second-vendor design review. It scored each option
against the `must` use cases:

| Use case group | A | B | C |
|---|---|---|---|
| First look | 4 | 5 | 2 |
| Understanding | 3 | 4 | 3 |
| Getting in | 3 | 4 | 4 |
| Keeping right | 2 | 3 | 5 |
| Off/undo | 3 | 4 | 4 |
| Collaborators | 2 | 3 | 4 |
| Edge states | 3 | 5 | 3 |
| Rules/Servers | 3 | 3 | 4 |

B wins at seeing the kit, and C wins at fixing it. Opening on the queue hides
the healthy inventory and the ordinary *unknown* states, so the queue must not
be the home screen.

**Shape.** A Library window, opened from the sidebar and ⌘K, using the
AppWindow shell. The rail, top to bottom:

- **Overview** — the default screen.
- **Needs you** — with a count.
- **Kit** — Skills, Rules, Servers, and Hooks where an agent has them.
- **Places** — This Mac, the repository, What applies here.
- **Agents** — one page per agent.

```
Library window
 Overview  ◀       │ Overview                 Where [This Mac · repo]  [Add ▾]
 Needs you      5  │ 5 need you →   (opens exactly those 5 rows)
 ─ Kit ─           │ ┌ inventory: rows = skills/rules/servers, cols = agents ┐
  Skills       42  │ │ basis + age on every cell; same-name copies as rows │
  Rules         6  │ └──────────────────────────────────────────────────────┘
  Servers       9  │
 ─ Places ─        │ row › sheet › PlanDialog › per-agent receipt › re-check
  This Mac / repo  │ unresolved targets land in Needs you
  What applies here│
 ─ Agents ─        │ <agent> page: capability chips · Store · commands ·
  ● <agent 1> …    │ hooks · server sign-in and reload
```

- **Overview** is the wide cross-agent inventory. It has the place switch, a
  basis and age on every cell, and same-name copies shown as separate rows.
  Its count of what needs attention opens exactly the rows it counted.
- **Needs you** holds what is still unresolved: partial receipts, managed
  copies that someone edited, copies that differ, writes no agent has
  confirmed, updates, and evidence that needs a re-check.
- **Agent pages** take over everything that was on Agents › Skills and Agents ›
  Extensions: the store, slash commands, hooks, server sign-in and reload.
- **A repository someone else equipped** (T2) gets a way in, so that the
  scripts it commits and their trust status are shown before the first
  conversation in it. Every option needs this.

**What is cut:**

- the queue as the home screen;
- the expanded Settings pane from Option A;
- the separate Skills and Extensions pages.

**Recommendation:** Option E, which supersedes D after the owner saw D's mockup.

## Option E — the developer's view: list, detail, tick, apply

*Added after the owner looked at D: "D doesn't look good — redesign as a
developer would want it." D drew the inventory as a grid of identical marks.
It did not say what a skill does, put no verb on screen, and asked people to
learn five groups of jargon in the rail. E borrows the shape developers already
know from package managers and editor extension views.*

```
Library    [Skills 42 | Rules 6 | MCP servers 9]      [Check for updates] [Add skill]
┌─ list ───────────────────────────┬─ detail ─────────────────────────────────────┐
│ 🔍 Search skills, descriptions…   │ ✦ brainstorming      [Update to 4.3.0…] [Remove…]│
│ [All|User|This repo] ⚠2 issues   │ Shape an idea into a reviewable design…      │
│ ✦ brainstorming ⚠    ◉ ◉ ◉ ○     │ community-kit · 4.2.1 · 4.3.0 available      │
│   Shape an idea into a design…   │ Installed in                     user scope  │
│ ✦ code-review        ◉ ◉ ◉ ◉     │ ☑ agent 1  ✓ Loads it · asked 2 min ago      │
│ ✦ deploy-check ⚠     ◉ ◉ ◉ ○     │ ☑ agent 2  On disk · can't confirm until restart│
│ …                                │ ☑ agent 3  Its copy differs · edited  [Compare…]│
│                                  │ ☑ agent 4  Not installed          Will install│
│                                  │ 1 change · install for agent 4   [Review and apply…]│
│                                  │ SKILL.md · Files · Usage · History           │
└──────────────────────────────────┴──────────────────────────────────────────────┘
```

- **One screen, two panes.**
  - **The list** shows each item's name and what it does. On the right of each
    row is a strip of agent marks: solid for the agents that have it, faint for
    the ones that do not. A warning glyph appears only on an item with an issue.
  - **The detail pane** is the selected item, so nobody has to learn a separate
    page per agent.
- **"Installed in" is the main control.** It has one checkbox per agent, and
  each checkbox carries that agent's honest status: *Loads it · asked*, *On
  disk · can't confirm until it restarts*, *Its copy differs* with *Compare…*,
  or *Not installed*.
  - A tick is the desired state. A pending-change bar collects the ticks and
    offers *Review and apply…*, which opens today's `PlanDialog`.
  - After apply, the same bar becomes the receipt: *Written for X · it will
    pick it up on its next restart*, with *Undo* and *Restart it now*.
- **Kinds are tabs and scope is a segmented filter.** Issues are a toggle with
  a count. Each of these is a filter on one list rather than a destination.
  *What applies here* and the *Needs you* queue become filters on that list,
  plus a link from the conversation.
- **An agent's own things** — its store, sign-in, reload and hooks — are
  reached through *All agents ▾* by picking one agent. Its capability chips
  then sit above the list. MCP servers use the same list and pane, and their
  *Installed in* rows show *Configured*, *Available* or *Needs sign-in*, with
  *Sign in* and *Reload* beside them.
- **Where it lives:** a window of its own, opened from the sidebar and ⌘K, or
  the Settings › Library page. The layout works in either place, because it
  needs no rail of its own.
- **For:**
  - the shape is familiar to every developer;
  - every row says what the skill is;
  - the core verb ("put this in that agent") is one tick, followed by a
    reviewed plan;
  - honest evidence sits beside each tick, where it is read at the moment of
    deciding.
- **Against:**
  - comparing 40 skills across agents at a glance is weaker than a matrix. The
    presence strip covers most of that, and a Grid view toggle can come later
    if it is missed;
  - partial receipts across many items need the Issues filter to find them
    again.

## The mockups

Each option is drawn on `packages/ui/preview.html`, under "Library — UX
options", from the real design system with fixture data:

| Frame id | Option |
|---|---|
| `library-option-a` | A |
| `library-option-b` | B |
| `library-option-c` | C |
| `library-option-d` | D |
| `library-option-e`, `library-option-e-applied` | E (`frames-library-dev.tsx`) |

The frames live in `src/preview/frames-library-options.tsx` and
`library-options-fixture.ts`. They are mockups only, with no store or wire
behind them.

Every reach word in them follows the evidence rule:

- **Loads it** only where the agent was asked.
- **On disk — not confirmed** where the evidence is a build or the table.
- **Not measured** for every rules file, because no agent's rules files have
  been measured yet.

In option C's receipt, *Retry* is offered only on a target that was refused,
and *Restore* only on a target that changed and kept a backup.
