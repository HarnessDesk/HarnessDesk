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
3. **The renderer repeatedly replaces the history list.** `SessionTree` already
   uses `WindowedProjectRows` for project lists above 50 rows, including at the
   measured revision. Eight call sites run `loadHistory({ reset: true })`,
   fetching the list again and repeating grouping and row derivation. A warm
   reset still costs 1.9 s on the host. The profile does not isolate renderer
   time or establish that mounted rows are the remaining bottleneck; measure
   that work separately before changing the existing windowing.

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
    changes or ignored content.** Either kind of content keeps the worktree
    until an explicit discard confirmation names what will be lost.
    Branches are never deleted. A Storage page cleans up inactive
    conversations' worktrees on demand.
11. **The History view opens from the command palette and from Settings**, not
    from a fixed sidebar entry. It is not an everyday surface.

12. **Team runs are filed under their Team.** Their conversations remain reachable
    through that Team and do not also appear as loose sidebar conversations.

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
| `archived` | 0 or 1, or NULL while the archive authority is unresolved; for a runtime that declares `archiveHistory`, the runtime's own archive stays the authority and this mirrors its last confirmed answer |
| `removed_at` | set by Remove from HarnessDesk; a removed row is never listed and is skipped by a rescan |
| `last_opened_at` | orders the eviction of cached bodies |
| `source_path`, `source_mtime`, `source_size` | the agent's own file, when the adapter can name it; says whether our copy is behind |
| `saved_at`, `preview`, `usage` | the stored snapshot time, opening text and full `SessionUsage` JSON, preserving the current transcript's recovery and search metadata |

Indexes: `(origin, removed_at, archived, updated_at DESC, runtime, id)` for the sidebar and
`(repo_root, updated_at DESC)` for grouping and project filters.

### `turns`: durable turn metadata

One row per `(runtime, id, turn_id)`, with a conversation-local `seq` and a
versioned JSON payload for the complete `Turn` except `items`: status, error,
start and completion times, `durationMs`, diff, plan and every other turn field.
Items join through `turn_id`. Turn order and item order are stored separately.
The row also keeps the existing `TurnInsightContext` for that turn as JSON;
session usage stays on `sessions`. A cold recovery reconstructs the current
stored transcript without asking an agent, including failed-turn explanations,
original timings, usage and Insight context. This is the SQLite replacement
for the `Stored` contract in `packages/server/src/transcripts.ts`, not a thinner
message log.

### `items`: the body, one row per message or tool call

| column | meaning |
|---|---|
| `runtime`, `id`, `seq` | primary key; `seq` is assigned on first insertion and retained on updates |
| `item_id` | the `AgentItem.id`, used with the turn to identify an event's existing item occurrence; never assumed globally unique across replay |
| `turn_id`, `kind`, `role` | the turn it belongs to, what it is, who said it |
| `text` | the plain text, for search |
| `payload` | the full item as JSON, for rendering |

New items append. Deltas and completion events update the stored occurrence
identified by the reducer's `(turn_id, item_id)` match, upserting at its existing
`seq` without allocating another sequence number; the reducer already replaces
an item in place on `item/completed`. Index `(runtime, id, turn_id, item_id, seq)`
for that lookup. Replayed occurrences that reuse an id retain distinct rows;
refresh uses the reconciliation contract below rather than merging them by id.
Turn metadata
and session usage are upserted in the same transaction. Normal event writes
do not rewrite a whole conversation. Reads page backwards from the newest
item, 200 at a time, with the metadata of the turns they belong to.

### `items_fts`: full-text search

An FTS5 table over `items.text`. Desk conversations are always indexed. Tool
output is cut to about 3,000 characters for the index; `payload` keeps all of
it. Insert, update and deletion maintain the corresponding FTS row in the same
transaction, so a tool's final output replaces its running text in search.
`transcripts/search` becomes a query against this table.

### `repos`: which repository a folder belongs to

| column | meaning |
|---|---|
| `cwd` | primary key |
| `repo_root`, `origin_url` | the answer |
| `exists`, `checked_at` | whether the folder was there when last asked |
| `identity` | canonical folder and resolved Git-directory identities plus the filesystem fingerprints used to detect a changed mapping |

Repository resolution uses one `git` process with the three
`rev-parse` flags together, not three; a path containing a newline falls back
to the three separate calls. The first frame uses the cached answer. After
launch, and on a later list refresh, a bounded background pass checks every
listed folder's existence and canonical identity, including cached entries.
It also checks the recorded Git directories and configuration for changes.
A missing folder is marked gone and its repository mapping invalidated; a
recreated folder or changed identity is resolved again. If cheap filesystem
checks cannot establish that a mapping is still valid, resolve it again in
the background, at most once per folder per pass. Read errors retain the last
answer as stale and schedule a retry; they do not prove the folder is gone.
Each result updates affected session rows and is pushed to the renderer.

### `imports`: per-agent import state

`runtime`, `imported_at`, `count`, `last_scan_at`, `error`. The settings
page's count and status read from here.

### Cached bodies and backups

- **Cached bodies are evictable.** Above a cap (500 MB by default) the oldest
  `body = cached` rows by `last_opened_at` lose their items, turns, FTS rows,
  usage and Insight context together, returning to `body = none`. `full`
  bodies are never evicted.
- **A desk conversation's body may be the only copy**, for an agent that keeps
  nothing readable (Cursor) or whose file is gone. So `backup/export` includes
  the database, and the host takes a daily `VACUUM INTO` snapshot beside it,
  keeping the last three.

## The flows

### Launch

1. Open `sessions.sqlite`. On the first launch of this version, seed it (see
   "The upgrade").
2. The sidebar's first page uses `origin = 'desk' AND removed_at IS NULL AND
   archived = 0 ORDER BY updated_at DESC, runtime, id LIMIT 50`. Every subsequent
   page uses the same predicate with a cursor over that ordering. It renders
   before any agent is running. Unresolved archive rows are withheld without
   delaying rows whose state is known.
3. Resolve missing repository entries and revalidate cached ones in the
   background, four folders at a time, pushing each answer as it lands.
4. Agents start according to "Starting agents".
5. When a native archive authority becomes ready, reconcile its metadata as
   described under "The upgrade"; this never holds the first frame.

### A new conversation, and every turn after

The host already observes every turn. In one transaction it upserts the
`sessions` and `turns` rows and upserts changed `items` and their FTS rows, after
the same 800 ms settle delay the transcript writer uses today; turn completion
flushes at once. A long-running tool may be written while running and must be
updated when it completes with the same id. The renderer receives a one-row
change. The eight `loadHistory({ reset: true })` call sites become incremental
updates.

### Importing an agent's history

1. The settings page's **Import history** calls a new wire method that starts
   an import job on the host and returns at once.
2. The job pages through the runtime's own `session/list` until it ends. Here
   the ACP agents' habit of returning everything is what we want.
3. Each new row is written as `imported`. A row already `desk` keeps its origin
   and body; authoritative native archive metadata is still reconciled for it.
   A row with `removed_at` set is skipped.
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
  CLI): read it from the agent again and reconcile it with our stored copy
  using the current `TranscriptStore.enrich` contract before persisting the
  result. Retain commands and reasoning missing from lossy replay, host notices
  and publications, and recorded context authorship. Preserve turn pairing,
  replay segmentation, original stored timings and the existing usage-restoration
  rule; do not copy an item into another turn or duplicate it. An empty or
  partial replay retains the history it did not answer for. A rollback still
  removes omitted work turns: apply the current `dropTurns` contract to items,
  turns, FTS and Insight context atomically, so later reads cannot resurrect
  them. Refresh may rewrite the reconciled body, never replace it with bare
  agent replay.
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
  marked in `sessions.archived`. A native archive/unarchive updates the mirror
  only after the runtime accepts it; subsequent metadata reconciliation also
  reflects changes made in the agent's own application.
- **Remove from HarnessDesk.** The row goes back to `imported` with
  `removed_at` set. A toast says *Removed from HarnessDesk* with **Undo** for
  about eight seconds. The body (items, turns, FTS rows, usage and Insight
  context) is dropped atomically only when the toast ends, so Undo restores
  everything. The History view hides removed rows behind a switch.
- **Delete everywhere.** Uses the existing delete extension: Claude Code and
  Cursor move the files to the Trash. An agent that cannot move to the Trash
  (Codex erases the rollout) shows the item greyed, with the reason in its
  tooltip.
- **A running conversation** is stopped first, and the confirmation says so.

### Worktrees

Archive, Remove and Delete everywhere each remove the worktree HarnessDesk made
for the conversation only when it holds neither uncommitted changes nor
ignored content. Read the existing `WorktreeChanges` inventory, including
`ignored` and `ignoredCount`: a Git-clean checkout can still hold an ignored
`.env`, and `git worktree remove` deletes it without force. Either kind of
content keeps the worktree. The Archive view marks its row with a *Worktree
kept* chip, and its tooltip counts changes and ignored entries. Removed and
deleted conversations retain the worktree inventory on the Storage page even
when their body is dropped. **Discard worktree…** lists the files and ignored
directories and their counts in an explicit confirmation before removing
anything; recheck the inventory before removal and ask again if it changed.
The branch is never deleted, and resuming the conversation checks it out again.
Worktrees HarnessDesk did not make are never touched.

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
   files Team conversations under the Team's own row, and retains its existing
   keyboard-aware windowing; measure mounted rows and
   grouping cost after pagination before considering its removal.
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
     with uncommitted changes or ignored content are skipped unless a separate
     discard choice is confirmed with the same inventory and recheck as above.
     Conversations and branches stay.
   - **Clear cached previews.**

Every surface is built from the design system (`Row`, `Rows`, `Button`,
`Dialog`, `ConfirmDialog`, `Chip`); none of them adds a primitive.

## The upgrade

On the first launch of this version, the host reads `transcripts/` once for
each conversation's runtime, id, title, folder and times, writes those rows as
`desk` with `body = none`. For runtimes without native archive support, carry
the archive marks over from `archive.json`, setting unmarked rows to 0. That
file deliberately contains no marks for native-archive runtimes, and the
transcript files carry no archive field. Seed their rows with `archived = NULL`,
also using NULL while the runtime's archive capability cannot be determined.
Never infer "unarchived" from an absent local mark.

Once a native-archive runtime is ready, a background metadata job pages both
its archived and unarchived listings to completion, matching only indexed ids;
this is archive reconciliation, not adoption of the rest of its history. An
observed row receives its authoritative 0 or 1 and a one-row update. A failed
or incomplete listing leaves unobserved seeded rows unresolved and existing
mirrors at their last confirmed state, records the error and permits retry;
absence from a listing never means unarchived. Persist
confirmed states for later first frames. Run reconciliation again when that
runtime becomes ready on later launches and when its Archive view is refreshed,
so changes outside the desk reach already-`desk` rows too. Import follows the
same rule and never skips their archive metadata. Unrelated rows remain usable
throughout; unresolved rows are withheld from normal and archived lists until
the authority answers.

Opening a seeded conversation reads the body from the agent as usual.
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
- Sidebar pagination: an archived desk row and an unresolved native archive row
  appear on neither the first nor later pages; a confirmed unarchived desk row
  does. Reconciliation reveals only the row the authority confirms.
- Native archive upgrade: seed transcripts for archived and unarchived rows
  with an empty local archive file. Delay or fail the native listing and check
  that unrelated rows render immediately, unresolved rows stay withheld and
  retry resolves them correctly. A later native archive change reaches an
  existing desk row, including during import.
- Item updates: write a running tool after the settle delay, then complete the
  same item id with output. Cold recovery has one completed item at the original
  sequence; FTS finds the final output and no stale running text. Reused ids in
  replay do not collapse distinct items or update another turn's item.
- Cold recovery: persist a failed turn with error, original timestamps,
  duration, diff and plan, session usage and Insight context. Close and reopen
  the database with the agent unavailable and compare the reconstructed stored
  transcript field for field.
- Changed-source reconciliation: a thinner agent replay keeps stored command
  and reasoning items, host notices/publications and context authorship without
  duplication. Also cover replay resegmentation, empty/partial history and
  usage restoration. A deliberate rollback removes its work turns and Insight
  context permanently while preserving unrelated host notices.
- Worktree cleanup: a desk-created Git-clean worktree holding an ignored `.env`
  survives Archive, Remove, Delete and Storage cleanup; dirty and non-desk
  worktrees survive too. Only explicit discard after naming ignored content
  removes it. A changed inventory refuses removal until confirmed again.
- The `repos` cache: no agent or `git` on the first frame; unchanged folders
  use cheap background checks where those suffice. Delete, recreate or retarget
  a cached folder between launches and check updated existence and grouping;
  changed Git metadata triggers resolution, while read errors do not mark it
  gone. Ordinary resolution uses one `git` process per folder, with the
  documented newline-path fallback.
- The upgrade is also run once against a copy of a real desk home on the
  maintainer's machine. Nothing from that copy is committed. It checks that
  the seeded count matches the transcripts present, that archive marks
  survive, and the time from launch to the sidebar's first rows against the
  eleven seconds measured above.
- The agent start policy: a fake agent with a configured start delay lands on
  the right side of the 0.5 s split.

## Slices

1. `sessions.sqlite` with `sessions` and `repos`; the upgrade seed; the
   native archive reconciliation; the sidebar reads the database; the eight
   resets become incremental. This removes the measured history-listing delay;
   measure renderer work separately rather than promising every stutter is gone.
2. `turns`, `items` and `items_fts`, with stored usage and Insight context;
   desk conversations upsert their bodies there; `transcripts/search` moves
   over; cold recovery and the reconciliation/rollback rule.
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
