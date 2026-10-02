# The Library: list, detail, tick, apply

*2026-10-01. This is the design the owner chose: Option E in
[the UX options](2026-10-01-one-library-ux-options.md). It is a developer's
package-manager view of every agent's skills, rules files and MCP servers.
It serves [the use cases](2026-10-01-skills-management-use-cases.md) under the
principles of [the one-library design](2026-09-30-one-library-design.md). The
mockups are `library-option-e` and `library-option-e-applied` on
`packages/ui/preview.html?library-options`.*

## The idea in one paragraph

There is one list you can search, and one item selected beside it. The list
says what each item is and which agents have it. The detail pane says what
the item does and where it came from. Its main control, **Installed in**, has
one checkbox per agent, and each checkbox carries that agent's honest state.
A tick is desired state. A pending-change bar collects the ticks and opens
the existing previewed plan. After apply, the same bar becomes the receipt.
Anything that needs the person is an **Issues** filter on the same list, not
a separate place.

## Where it lives

- **A Library window,** an `AppWindow` like Agents and Usage. It opens from:
  - a sidebar row beside Agents and Dashboard;
  - ⌘K: *Library*, and *Library: issues*;
  - Settings › Capabilities › Library, whose row now opens the window;
  - a conversation's context-ring menu (*What applies here*), which opens the
    window filtered to that agent and folder;
  - the startup import offer.
- **The window has no rail.** The two panes are the whole window, below a
  toolbar.
- **`resolveSection` keeps old links working:**
  - `library` opens the window;
  - `skills` opens it filtered to the active agent;
  - `extensions` opens it filtered to the active agent, on the MCP servers tab.
- **Settings › Agents › Skills and Extensions are removed** only in the phase
  that shows each of their operations working in the window.

## Anatomy

```
Library   [Skills 42 | Rules 6 | MCP servers 9]         [Check for updates] [Add ▾]
┌─ list (2/5) ─────────────────────┬─ detail (3/5) ──────────────────────────────────┐
│ 🔍 Search names, descriptions…   │ ✦ name                     [Update…] [Remove…]  │
│ [All|User|This repo] [⚠ n issues]│ what it does                                    │
│ [All agents ▾]                   │ source · version · newer available · pin       │
│ ✦ name ⚠            ◉ ◉ ◉ ○      │ Installed in                    scope · path    │
│   what it does                   │ ☑ agent  state sentence · basis · age  [verb]   │
│ …                                │ …                                               │
│                                  │ n changes · …             [Discard] [Review…]   │
│                                  │ SKILL.md · Files · Usage · History              │
└──────────────────────────────────┴─────────────────────────────────────────────────┘
```

### Toolbar

- **The kind tabs** are `Tabs` `variant="line"`: Skills, Rules, MCP servers,
  and Hooks where any agent has the `hooks` capability. Each tab carries a
  count chip, and the count equals the rows the tab shows.
- **Check for updates** fetches newer versions for items installed from a
  source (phase 3).
- **Add ▾** offers *New skill*, *Import from an agent*, *From a folder*, and,
  in phase 3, *From GitHub or a URL*.

### The list

- **Search** covers names and descriptions in phase 1, and file content in
  phase 3.
- **The filters:**
  - *Scope* (`Segmented`): All · User · This repo. *This repo* appears only
    when a workspace is open.
  - *n issues*: a toggle. When it is on, the list keeps only the rows that
    need the person (*What counts as an issue*, below).
  - *All agents ▾*: picking one agent narrows the list to it and opens that
    agent's page (*One agent*, below).
- **A row** is a `ListRow`:
  - lead: an `IconTile` for the kind;
  - title: the name, followed by an issue glyph if it has one;
  - subtitle: the description, which is earned because it varies (rule 9);
  - trail: the **presence strip**.

  A command (an ACP agent's slash command) is a row with a *command* chip. It
  is read-only and is not counted in the Skills tab.
- **The presence strip** has one `RuntimeMark` per agent, in a fixed order, followed by a short visible summary. Grey alone never has to carry the meaning:
  - **Full mark:** the agent has the item.
  - **Faint mark:** the agent does not have it.
  - **Faint mark with a dashed ring:** *not measured*. The desk cannot tell, because that agent's folders are unknown.
  - **A small corner badge** for any state that is neither has-it nor not: `DiffIcon` for *its copy differs*, a stop glyph for *refused*, `HistoryIcon` for *needs a re-check*. The badge reuses the glyphs from the state table, so the list and the detail pane speak one vocabulary.
  - **The summary** sits after the marks, in words, and names its exception: *in all 4*, *in 3 of 4*, *in 3 of 4 · 1 differs*, *in 2 of 4 · 1 not measured*. It counts only facts, and *not measured* is never counted as "in" or "not in".
  - **The tooltip:** each mark's title gives that agent's whole state sentence from the table below.

  The strip and its summary answer "who has it". The detail pane answers "how sure are we".

### Same name, different item

Two copies that share a name but are unrelated by content are **two rows**.
Each row is suffixed with its scope or folder. Copies that are related but
have drifted stay **one row**, and the drifted agent's line in *Installed in*
says *Its copy differs*.

### The detail pane

- **The header:**
  - an `IconTile`, the name and the description;
  - chips for the source and version, plus *n.n available* when a newer
    version exists;
  - the source's location and pin as meta text;
  - the verbs *Update to n.n…* and *Remove…*.
- **Installed in.** One line per agent:
  - a `Checkbox`, then the agent's `RuntimeMark` and name;
  - **the state sentence**, with its basis and age;
  - a verb where one exists.

  The section heading's meta shows the scope and the folder the write would
  use (`~/.<agent>/skills/<name>`, abbreviated by `shortPath`).
  - Ticking an empty box marks *Will install*. Unticking marks *Will remove*.
  - A disabled box carries its reason as the line's sentence:
    - *This agent's folders are not known yet*;
    - *Not installed on this Mac*;
    - *This agent has no skill support*.
  - The sentence vocabulary is defined below, and it is the only place the
    pane says how sure the desk is.
- **The pending bar** reads *n changes · install for X, remove from Y at user
  scope*, with *Discard* and **Review and apply…**. That button opens today's
  `PlanDialog`, which shows each operation, its destination and its diff, and
  lists foreign copies separately.
- **The receipt.** After apply, the bar becomes it. It shows one sentence per
  target, with these verbs:
  - *Undo*, for the whole apply, where a backup exists;
  - *Restart it now*, for an agent that re-reads only when restarted, offered
    only while it is idle;
  - *Have it look again*, for an agent that re-reads live;
  - *Retry*, on a refused target.

  A receipt with anything unresolved stays as an issue on its item.
- **The tabs:**
  - *SKILL.md* is rendered with `Markdown document`.
  - *Files* lists the bundle's files, with scripts called out.
  - *Usage* shows how often the skill was seen in conversations this desk
    stored, when, and its tokens per turn in each agent's catalogue.
  - *History* lists every write to this item, with *Restore* where a backup
    exists.

### One agent

Choosing an agent in *All agents ▾* narrows the list and adds a strip above
it.

- **The strip** shows the agent's capability chips:
  - *Reports its catalogue* or *Commands only*;
  - *Has a switch* or *No switch*;
  - *Re-reads live* or *Re-reads on restart*;
  - *Folders: asked*, *build* or *unknown*.
- **It carries the agent's own verbs:**
  - *Sign in*, when the agent is signed out;
  - *Store* (plugins, apps, search, failures), where it has `extensionStore`;
  - *Hooks*, where it has `hooks`.
- **On the MCP servers tab,** the same choice puts *Sign in* and *Reload* on
  each server's line.

This is how everything on Settings › Agents › Skills and Extensions moves in,
with nothing lost. The chips come from capabilities and measured evidence,
never from the agent's identity (rule 8).

### MCP servers and Rules

These tabs use the same list and detail.

| Tab | A row is | *Installed in* lines say | Verbs |
|---|---|---|---|
| **MCP servers** | a server | *Configured*, *Available*, *Needs sign-in* or *Failed — reason* | *Sign in*, *Reload*. Ticking adds or removes the server in that agent's config file, through the existing MCP codecs |
| **Rules** | a file at a place (home, repository root, nested folder), suffixed with its place | *Read by this agent*, *Probably read (build)* or *Not measured* | Read-only until phase 4, when *Make one source…* arrives |

On the Rules tab, the detail pane renders the file. The pane's *Applies here*
section takes one chosen folder and agent and lists the rules files that exist
at that folder and above it, with whether that agent reads each one and the
basis for that. It shows a **load order** only for an agent whose order has
been measured (phase 0, measurement 1); until then the section says *Order not
measured* and never implies one. The phase 1 read model carries presence and
reach, not order, so the order view arrives with the measurement that supplies
it.

## The state sentences and glyphs

Only an *asked* fact earns **Loads it** (rule 7). The glyph table answers the
Lead's review of the earlier frames:

- *Refused* and *Needs sign-in* get different glyphs.
- *On disk — not confirmed* and *Not measured* must be told apart at a glance.
- Glyphs are never told apart by colour alone.

| State | Sentence (detail pane) | Glyph (list, issue mark) |
|---|---|---|
| Loads it | *Loads it · asked 2 min ago* | `CheckIcon` |
| On disk, not confirmed | *On disk · this agent can't confirm until it restarts* | full mark, no glyph |
| Not measured | *Not measured · this agent's folders are unknown* | faint mark with a dashed ring |
| Copies differ | *Its copy differs from <source> · edited <when>* + *Compare…* | `DiffIcon` |
| Rejected / refused | *Refused: "<the agent's own words>"* | `CrossIcon` in a circle (a stop) |
| Needs sign-in | *Needs sign-in* + *Sign in* | a key or lock glyph from `Icons.tsx` (added if missing) |
| Written, needs a re-check | *Written · needs a re-check* + *Have it look again* | `HistoryIcon` |
| Old evidence | *Checked under <old version> · re-check* | `HistoryIcon` |
| Not installed | *Not installed* | faint mark |

**A column of nothing confirmed.** When nothing about an agent is confirmed
yet, its *Installed in* line opens with one sentence before any per-item state:
*This agent lists commands only — the desk can see its files, not what it
loads.* The *One agent* strip says the same thing once.

## What counts as an issue

This is a pure predicate in `packages/protocol`, beside `entryHasProblem`, so
the count and the list can never disagree.

**These are issues:**
- copies differ;
- edited since the desk wrote it;
- written but not yet re-checked;
- rejected;
- a receipt target that was refused or failed;
- needs sign-in;
- evidence from an old build;
- an update is available (phase 3).

**These are never issues:**
- *not measured*;
- *on disk — not confirmed* for an agent that cannot confirm;
- *unscanned*.

They are normal on every machine, and counting them would make the filter
noise.

## New capability facts

Four facts are added to `RuntimeCapabilities`, each filled by the adapter from
what it can actually do:

| Fact | Values | Means |
|---|---|---|
| `reportsCatalogue` | boolean | lists its loaded skill bundles, not just commands |
| `reportsRejections` | boolean | says which skills it refused, and why |
| `skillToggle` | boolean | has its own switch |
| `catalogueRefresh` | `'live' \| 'restart' \| 'none'` | how it re-reads |

A fact is set to `true` only on *asked* evidence.

## What the host adds

| Need | Shape | Phase |
|---|---|---|
| Evidence on every fact | `at` and `build` beside today's `basis` on `LibraryReach` | 1 |
| Agent state per column | `answered`, `could-not-ask`, `signed-out`, `not-installed` or `unknown-support` on each `library/read` agent | 1 |
| Server status | `library/read` joins `runtime/mcp/list` into server rows | 1 |
| Rules | a `rules` kind in `library/read`, with files per place | 1 (read), 4 (write) |
| Receipts | `library/apply` returns a receipt id; the host keeps receipts and their re-check state (`library/receipts`) | 2 |
| Project scope | `skillWriteRoot` and `mcpWriteTarget` take a scope | 2 |
| Sources | a structured `source` on manifest entries; `library/sources/*` | 3 |

## Phases

0. **Measure first.** The 8 measurements in the use-case doc decide how much
   of every agent's *Installed in* can say more than *on disk*. They run before
   any phase-1 UI, and their results are recorded in the location table and
   capability facts with versions. They are:
   - which rules files each agent reads;
   - how an agent's catalogue maps to the bundles on disk;
   - which copy wins when two scopes hold one;
   - what `SKILL.md` limits each agent enforces;
   - where the tier C agents keep their folders;
   - how each agent re-reads;
   - MCP status;
   - what a signed-out agent still lists.
1. **See it truly (read only).**
   - The window, the toolbar, the list with its search and filters, and the
     detail pane.
   - The *Installed in* sentences and glyphs.
   - The *Issues* filter, over today's states.
   - The *One agent* strip, with its store, sign-in and hooks.
   - The MCP tab with status joined in, and the Rules tab (read).
   - The route mapping. Settings › Skills and Extensions are removed once
     parity is shown.
2. **Change it safely.**
   - Ticking leads to a plan, apply and a receipt.
   - Persisted receipts, with *Undo*, *Retry*, *Restart it now* and *Have it
     look again*.
   - Project-scope writes, *Compare…*, and the issues those produce.
3. **Sources and updates.** Add from GitHub or a URL, pinned; *Check for
   updates*; a review of scripts before install.
4. **Collaborators, rules and servers.**
   - *This repository brings…* for a committed kit.
   - *Make one source…* for rules.
   - Server adds that need credentials.

## Testing

- **Preview frames** for every state in every phase. Every UI PR updates the
  design catalogue boards.
- **Vitest:**
  - *Loads it* never appears without an *asked* basis.
  - A column whose agent cannot answer never renders empty.
  - The issues predicate excludes the never-issues.
  - Every count equals the rows it opens.
  - Each glyph pair from the review is distinct.
- **Protocol tests** for the issues predicate and the receipt state machine.
- **Live verification** on the four-agent sandbox rig, with a real Codex
  app-server and scripted ACP agents under a temp `$HOME`. It runs before a
  phase is called done.
