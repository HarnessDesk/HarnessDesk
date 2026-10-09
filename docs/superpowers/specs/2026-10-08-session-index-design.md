# The session index: a sidebar that opens at once

*2026-10-08. Approved by the owner the same day, decision by decision, in the
order listed at the end. Nothing here is built yet. Measurements are from
`main` at `786d3561e`, run against a desk with eleven agents registered and
large agent histories (about 10 GB of Claude Code projects, 10 GB of Codex
sessions and 28 GB of Cursor chats).*

## The problem

At launch the sidebar is empty for about eleven seconds. Then rows appear, and
the window stutters for a long time afterwards.

What the launch does today:

1. **Every agent is asked for its whole history.** `loadHistory`
   (`packages/ui/src/state/store.ts`) sends `session/list` to every runtime
   that declares `listHistory`, and waits on `Promise.all`. It asks for 40 rows
   from the active runtime and 20 from each of the others. Only the Codex
   adapter honours `pageSize`. The ACP agents return everything: 499 Claude
   Code rows, 1327 Cursor, 877 dsh, 2178 Antigravity and 100 OpenCode. That is
   about 5,000 rows over 456 distinct folders.
2. **Every folder is asked which repository it belongs to, by spawning `git`.**
   `#withRepos` (`packages/server/src/host.ts`) calls `repositoryOf` once per
   folder. Its `shellCheckoutIdentity` (`packages/server/src/worktree.ts`) runs
   three `git rev-parse` processes, and `originOf` and `mainCheckoutOf` run
   more. A CPU profile of the first listing shows 5.2 s inside synchronous
   `child_process.spawn`, 4.1 s of it on this path. Spawning blocks the host's
   event loop, so every runtime's listing returns at the same moment, about
   6.2 s in.
3. **The renderer draws every row.** Nothing in `packages/ui` is virtualised,
   and eight call sites run `loadHistory({ reset: true })`, each of which
   fetches and redraws the whole list again. A warm reset still costs 1.9 s on
   the host.

| step | time |
|---|---|
| host start, eleven agents | 3.4–3.6 s |
| first full listing (cold) | 7.2–7.6 s |
| the same listing again (warm) | 1.9 s |
| the same listing filtered to one project (`cwd`) | 0.5 s |

The probes that produced these numbers start the real host in-process from
`packages/server/dist`, against an isolated `HARNESSDESK_HOME` that holds a
copy of the desk's `agents.json`. They sit outside the repository; rerunning
them is a ten-line script around `createDefaultHost` and `host.call`.

## The goal

**The sidebar shows the person's own work at once, and nothing else waits on
an agent.** Three claims anyone can check:

1. **The first frame of the sidebar costs no agent and no `git`.** It is one
   indexed query against a local database.
2. **Another agent's history is something you go and find, not something every
   launch pays for.** It is imported on request, per agent, and browsed in its
   own view.
3. **Taking a conversation off the sidebar never destroys the agent's own
   record unless the person asked for exactly that,** and never silently
   discards uncommitted work.

## Decisions

1. **The sidebar lists only conversations started or continued in
   HarnessDesk** (`origin = desk`). Other agents' histories do not appear there.
2. **Importing an agent's history is a button on that agent's settings page.**
   It imports metadata only: id, title, folder and times. Full-text search over
   imported conversations is a second-phase, per-agent switch.
3. **"Remove from HarnessDesk" is the sidebar's default destructive verb.** It
   forgets HarnessDesk's record and leaves the agent's own files alone.
   "Delete everywhere" is a secondary item that also moves the agent's files to
   the Trash.
4. **HarnessDesk stores the bodies of its own conversations in SQLite**,
   replacing the per-conversation JSON files under `transcripts/`.
5. **Opening an imported conversation is a preview.** Its body is cached so it
   can render, but it joins the sidebar only when the person sends a message in
   it.
6. **No migration of bodies.** An upgrade carries the list over from
   `transcripts/` and `archive.json` and nothing else. The old files are left
   where they are, unread and undeleted.
7. **Agents start by measured cost.** The default agent starts in the
   background at launch. Fast agents start when first used. Slow agents start
   as soon as the person shows intent to use them. Models and account state
   are cached and shown stale until a live read replaces them.
8. **Rows carry no second line.** Reasons and consequences go in the hover
   tooltip (`title`), including why a row is greyed.
9. **Archive and Remove both stay.** Archive keeps the body and its search;
   Remove drops them.
10. **Archive, Remove and Delete everywhere also remove the worktree
    HarnessDesk made for the conversation, unless it holds uncommitted
    changes.** A worktree with changes is kept and can be discarded later.
    Branches are never deleted. A Storage page cleans up inactive
    conversations' worktrees on demand.
11. **The History view opens from the command palette and from Settings**, not
    from a fixed sidebar entry. It is not an everyday surface.

## The data

One file, `<HARNESSDESK_HOME>/sessions.sqlite`, opened with `node:sqlite` in
WAL mode, the way `ledger/store.ts` opens `usage.sqlite`. It is its own file so
that losing it never touches usage records, and so that the rebuildable part
can be rebuilt by deleting it.

### `sessions`: one row per known conversation

| column | meaning |
|---|---|
| `runtime`, `id` | primary key |
| `origin` | `desk` or `imported`; an imported row becomes `desk` when a message is sent in it |
| `title`, `cwd`, `repo_root`, `created_at`, `updated_at` | what a list row shows |
| `body` | `none`, `cached` (filled by a preview) or `full` (a desk conversation) |
| `archived` | 0 or 1; for a runtime that declares `archiveHistory`, the runtime's own archive stays the authority and this mirrors it |
| `removed_at` | set by Remove from HarnessDesk; a removed row is never listed and is skipped by a rescan |
| `last_opened_at` | orders the eviction of cached bodies |
| `source_path`, `source_mtime`, `source_size` | the agent's own file, when the adapter can name it; says whether our copy is behind |

Indexes: `(origin, removed_at, updated_at DESC)` for the sidebar and
`(repo_root, updated_at DESC)` for grouping and project filters.

### `items`: the body, one row per message or tool call

| column | meaning |
|---|---|
| `runtime`, `id`, `seq` | primary key; `seq` orders items within a conversation |
| `turn_id`, `kind`, `role` | the turn it belongs to, what it is, who said it |
| `text` | the plain text, for search |
| `payload` | the full item as JSON, for rendering |

Writes append; nothing rewrites a whole conversation. Reads page backwards
from the newest item, 200 at a time.

### `items_fts`: full-text search

An FTS5 table over `items.text`. Desk conversations are always indexed. Tool
output is cut to about 3,000 characters for the index; `payload` keeps all of
it. `transcripts/search` becomes a query against this table.

### `repos`: which repository a folder belongs to

| column | meaning |
|---|---|
| `cwd` | primary key |
| `repo_root`, `origin_url` | the answer |
| `exists`, `checked_at` | whether the folder was there when last asked |

Each folder is asked once. The answer is one `git` process with the three
`rev-parse` flags together, not three; a path containing a newline falls back
to the three separate calls.

### `imports`: per-agent import state

`runtime`, `imported_at`, `count`, `last_scan_at`, `error`. The settings
page's count and status read from here.

### Cached bodies and backups

- **Cached bodies are evictable.** Above a cap (500 MB by default) the oldest
  `body = cached` rows by `last_opened_at` lose their items. `full` bodies are
  never evicted.
- **A desk conversation's body may be the only copy**, for an agent that keeps
  nothing readable (Cursor) or whose file is gone. So `backup/export` includes
  the database, and the host takes a daily `VACUUM INTO` snapshot beside it,
  keeping the last three.

## The flows

### Launch

1. Open `sessions.sqlite`. On the first launch of this version, seed it (see
   "The upgrade").
2. The sidebar's first page is `origin = desk AND removed_at IS NULL ORDER BY
   updated_at DESC LIMIT 50`. It renders before any agent is running.
3. Rows whose folder has no `repos` entry are resolved in the background, four
   at a time, and each answer is pushed to the renderer as it lands.
4. Agents start according to "Starting agents".

### A new conversation, and every turn after

The host already observes every turn. In one transaction it upserts the
`sessions` row and appends the new `items`, after the same settle delay the
transcript writer uses today. The renderer receives a one-row change. The
eight `loadHistory({ reset: true })` call sites become incremental updates.

### Importing an agent's history

1. The settings page's **Import history** calls a new wire method that starts
   an import job on the host and returns at once.
2. The job pages through the runtime's own `session/list` until it ends. Here
   the ACP agents' habit of returning everything is what we want.
3. Each row is written as `imported`. A row already `desk` is left alone, and
   a row with `removed_at` set is skipped.
4. Progress and the final count are written to `imports` and pushed to the
   settings page. A failure records its reason there; the rows already written
   stay.

### Keeping the imported list fresh

There are no file watchers. Opening the History view, or the window regaining
focus while it is open, rescans the imported agents, at most once a minute,
and compares by `updated_at`.

### Opening an imported conversation

1. The body is read from the agent as today (`session/load` or `thread/read`),
   written to `items` with `body = cached`, and shown.
2. Sending a message makes the row `desk`, and it joins the sidebar.

### Reopening a desk conversation

- **The agent's file is unchanged** (same mtime and size): read from the
  database.
- **The agent's file changed** (the person continued it in the agent's own
  CLI): read it from the agent again and replace our items. A later version
  may append only the difference.
- **The agent's file is gone**, or the agent keeps none: show our copy, with a
  line at the top of the conversation saying it is HarnessDesk's copy.

The agent's file is the authority while it exists; ours is the fallback.

## Starting agents

Measured cold, one agent per isolated home, two runs each. "Ready" is the
extra host start time plus the first listing plus the first models read, since
the composer needs the models. A bare host with no agent starts in 0.17 s,
which is already subtracted.

| agent | process up | first listing | models | ready |
|---|---|---|---|---|
| Amp | 0.06 s | – | 0.05 s | 0.1 s |
| Codex | 0.17 s | 0.04 s | – | 0.2 s |
| Devin | 0.09 s | – | 0.14 s | 0.2 s |
| dsh | 0.57 s | 0.48 s | – | 1.0 s |
| Claude Code | 0.29 s | 0.17 s | 0.72 s | 1.2 s |
| OpenCode | 0.87 s | 0.32 s | 0.05 s | 1.2 s |
| Cline | 1.4 s | – | 1.4–1.7 s | 3.0 s |
| Cursor | 0.34 s | 0.11 s | 2.9 s | 3.3 s |
| Gemini | 2.8 s | – | 1.1 s | 3.9 s |
| Qwen Code | 1.9 s | – | 2.0 s | 3.9 s |
| Antigravity | 1.3 s | 0.13 s | 3.0–5.7 s | 4.5–7 s |

("–" is under 10 ms.) The slow part is usually the models read, not the
process.

The policy:

1. **The default agent starts in the background at launch.** It does not hold
   the sidebar.
2. **An agent measured under 0.5 s starts when first used.**
3. **An agent measured at 0.5 s or more starts on intent:** the pointer resting
   on one of its conversations, choosing it in the agent picker, or opening its
   settings page.
4. **Models, account state and options are cached in the database** and shown
   stale until the live read replaces them.
5. **Idle agents still stop**, as they do today.

Each agent's start time is measured on every start and stored, so the split
is per machine rather than a list written into the code.

## Archive, Remove and Delete everywhere

| state | sidebar | our body | the agent's files | the way back |
|---|---|---|---|---|
| normal | listed | kept | untouched | – |
| **archived** | hidden; in the Archive view | kept, searchable | untouched | Unarchive in the Archive view |
| **removed** | gone | dropped | untouched | Undo at once, or open it again from History |
| **deleted everywhere** | gone | dropped | moved to the Trash | the Trash |

- **Archive.** A runtime with its own archive keeps using it; others are
  marked in `sessions.archived`.
- **Remove from HarnessDesk.** The row goes back to `imported` with
  `removed_at` set. A toast says *Removed from HarnessDesk* with **Undo** for
  about eight seconds. The items are dropped only when the toast ends, so Undo
  restores everything. The History view hides removed rows behind a switch.
- **Delete everywhere.** Uses the existing delete extension: Claude Code and
  Cursor move the files to the Trash. An agent that cannot move to the Trash
  (Codex erases the rollout) shows the item greyed, with the reason in its
  tooltip.
- **A running conversation** is stopped first, and the confirmation says so.

### Worktrees

Archive, Remove and Delete everywhere each remove the worktree HarnessDesk made
for the conversation when it holds no uncommitted changes. A worktree with
changes is kept: the Archive view marks the row with a *Worktree kept* chip,
its tooltip counts the changes, and its menu offers **Discard worktree…**,
which names what will be lost before it does anything. The branch is never
deleted, and resuming the conversation checks it out again. Worktrees
HarnessDesk did not make are never touched.

### Words

All strings name the agent through `RuntimeInfo.presentation`.

| where | text | tooltip |
|---|---|---|
| menu | `Archive` | Hide it from the sidebar; find it in Archive |
| menu | `Remove from HarnessDesk` | `{agent}` keeps its own copy · or, when ours is the only one: HarnessDesk's copy is the only record |
| submenu | `Delete everywhere…` | when greyed: `{agent}` erases it for good, so delete it there |
| dialog title | `Delete "{title}" everywhere?` | |
| dialog body | It moves to the Trash, and `{agent}` can no longer resume it. | |
| dialog button | `Move to Trash` (danger) | |
| toast | `Removed from HarnessDesk` · `Undo` | |
| toast | `Moved to the Trash` | |

## The interface

1. **Sidebar.** Desk conversations only, 50 at a time, more on reaching the
   end. Each project shows its first ten with a **Show more** below; which
   projects are folded is remembered locally. With these limits the sidebar
   needs no virtualisation in this version.
2. **An agent's settings page gains a History section.** Before import: one
   line and **Import history**. During: the running count, and **Cancel**.
   After: the count, the last scan, **Rescan**, and **Remove imported** (the
   index only; the agent's files stay).
3. **The History view** lists imported conversations, filterable by agent and
   project and ordered by time. It can hold thousands of rows, so it is
   virtualised. A row opens a preview; sending a message moves it to the
   sidebar. Row menu: **Hide from HarnessDesk** and **Delete everywhere…**. A
   switch shows hidden rows. It opens from the command palette and from the
   agent's History section.
4. **The Archive view** reads the database, and shows kept worktrees as above.
5. **Settings › Storage** (new) shows the size of `sessions.sqlite`, of cached
   bodies, and of HarnessDesk's worktrees.
   - **Clean up inactive conversations:** 30, 60 or 90 days. It lists the
     worktrees it would remove and the space freed, and removes nothing until
     confirmed. Running and open conversations are never included. Worktrees
     with uncommitted changes are skipped unless a separate box is ticked and
     confirmed. Conversations and branches stay.
   - **Clear cached previews.**

Every surface is built from the design system (`Row`, `Rows`, `Button`,
`Dialog`, `ConfirmDialog`, `Chip`); none of them adds a primitive.

## The upgrade

On the first launch of this version, the host reads `transcripts/` once for
each conversation's runtime, id, title, folder and times, writes those rows as
`desk` with `body = none`, and carries the archive marks over from
`archive.json`. Opening one of them reads the body from the agent as usual.
The old files are not read again and are not deleted.

What an upgrading person loses: the bodies of old Cursor conversations, which
only `transcripts/` held. Those rows keep their titles.

## Phase two: full-text search over imported history

A per-agent switch on the settings page, **Make history searchable**. It needs
a reader per agent that parses the agent's own files directly (Claude Code's
JSONL, Codex rollouts and so on), because opening each conversation through
the agent would be far too slow. Progress is kept per file in a
`source_files` table (`path`, `inode`, `byte_offset`, `mtime`, `size`,
`state`), so a file that only grew is read from where the last pass stopped.
Rows are dropped only when a file is proven gone, never on a read error. It
is designed when phase one has shipped.

## Testing

- Unit tests use synthesised fixtures only: the seed from a fake
  `transcripts/` and `archive.json`, the sidebar query, Remove and Undo, the
  rescan skipping removed rows, eviction, and the reopen rule for an unchanged,
  changed and missing source file.
- The `repos` cache: one `git` process per folder, and none on the second
  launch.
- The upgrade is also run once against a copy of a real desk home on the
  maintainer's machine. Nothing from that copy is committed. It checks that
  the seeded count matches the transcripts present, that archive marks
  survive, and the time from launch to the sidebar's first rows against the
  eleven seconds measured above.
- The agent start policy: a fake agent with a configured start delay lands on
  the right side of the 0.5 s split.

## Slices

1. `sessions.sqlite` with `sessions` and `repos`; the upgrade seed; the
   sidebar reads the database; the eight resets become incremental. This alone
   removes the empty sidebar and the stutter.
2. `items` and `items_fts`; desk conversations write their bodies there;
   `transcripts/search` moves over; the reopen rule.
3. Remove from HarnessDesk, Undo, and the worktree rule for Archive, Remove and
   Delete everywhere.
4. Import on the settings page; the History view; preview and adoption.
5. The agent start policy and the cached models and account state.
6. Settings › Storage.

## Decision log

Made by the owner on 2026-10-08, in this order: the sidebar shows desk
conversations only (1); import is per agent, metadata by default with full
text as a switch (2); Remove is the default (3); bodies in SQLite (4); preview
until a message is sent (5); no body migration, list-only seed, and the
owner's own desk as the upgrade test (6); start agents by measured cost after
measuring them (7); tooltips, never a second line (8); keep both Archive and
Remove (9); worktrees removed unless dirty, plus a Storage clean-up (10); the
History view from the palette and Settings only (11).
