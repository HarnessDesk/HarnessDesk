# Changelog

User-facing changes, newest first — the view for someone deciding whether to
update. If a change does not alter what the app does, shows, or refuses, it
does not earn a line here: a refactor, a build-config tidy or a documentation
move is real work and is not news to a person weighing an upgrade.

## Unreleased

- **The audit log keeps the last thing that happened before you quit.** Its
  entries are queued and written behind the event stream, so the fan-out never
  waits on a disk — but the quit did not wait for that queue either, and both
  the app and the CLI host exit the moment shutting down returns. The tail of a
  session could therefore be missing from `audit.ndjson`, and from the
  diagnostics bundle built out of it, which is the half either one is collected
  for. Shutting down now drains it.
- **"Add another account" signs the new account in.** It used to make the
  account and stop there: the host answered the moment the row existed, while
  the agent behind it was still starting, and Codex will answer neither
  "how do I sign in" nor "start a sign-in" until its app-server is up. The
  one-click *Add account* in Settings therefore started nothing at all, with
  no error to say so, and the sign-in page — asked the same question at the
  same moment — showed the new account as one that *needs no account here*,
  the only pane in the app with nothing to press. Adding now waits for the
  new account to be able to answer before it hands back the id, a sign-in
  asks the host how rather than reading an empty list, and an account that
  has not answered yet says it is starting instead of claiming it needs
  nothing.
- **The sign-in card was redesigned.** The credential's path sat in a code
  chip inside a paragraph, and any path longer than `~/.codex` ran out of the
  column and was clipped mid-word; it now has a line of its own, wraps where
  paths wrap, and is set as metadata rather than as the loudest thing on the
  card. A connected account no longer prints the same email twice, its two
  actions share one row with the one you came for first, and the way in that
  HarnessDesk cannot drive is set apart instead of shouting in bold.
- **A second sign-in says which account the browser will use — before it
  opens.** The sign-in page uses whichever account the browser is already
  signed in to, so "add another account" repeatedly landed on the account you
  already had, and HarnessDesk would fold the duplicate away afterwards. The
  pane now names the account this agent already holds while the sign-in is
  still in flight, and the notice afterwards says where the choice is made.
- **A room says when a member stops.** An agent whose usage window ran out
  mid-turn used to vanish from the conversation without a word: the answer it
  owed the room was written off in silence, and nothing on screen separated
  "still reading" from "stopped forty minutes ago". The room now carries a row
  about it — the runtime's own sentence, attributed to that member, chipped
  *usage limit*, *signed out* or *stopped*. It is not a message and is not
  gated by "Show answers in the channel", because a member disappearing is not
  an answer. A turn that answered before it failed is still shown as its
  answer, and a turn the runtime is retrying says nothing at all.
- **The library says the truth about what it just did.** Installing a skill
  into an agent's own directory used to leave the cell beside it reading
  *installed where this agent does not look* — about a file written a second
  earlier into the one directory that agent does look at. The state now has
  its own name: the copy is there, and the agent lists what it read when it
  started. The sheet offers the last step rather than describing it — one
  press asks the agent to look again, and it restarts only when idle, so a
  turn in flight is never interrupted.
- **A definition an agent refuses is refused, not "not loaded yet".** From
  disk the two are the same bundle — a `SKILL.md` is there and the agent did
  not name it — and they need opposite responses, because looking again will
  never help the second. Agents are now asked for their *rejections* as well
  as their skills: Codex answers `skills/list` with an errors array beside the
  skills, naming the file and the fault, and the library shows that reason
  verbatim rather than inventing one. The library also says a word before you
  copy a definition one agent has already refused into another.
- **A refresh that did not happen says so.** `refreshCatalog` used to resolve
  whether or not it re-read anything — an agent that refreshes by restarting
  declines, politely, while a turn is in flight — so every caller read the
  call returning as the work being done. It now answers what happened and
  why, the wire carries it, and the library's "have it look again" names the
  agent and its reason instead of reporting a refusal as a success. When an
  agent re-reads and *still* does not list the skill, the page says that too:
  at that point the definition is one the agent will not accept, and "it has
  not looked since" is no longer an explanation.
- **The import direction can be reversed.** Each picker greyed out whatever
  the other held, which locked a two-agent machine into whichever direction
  it opened with. Choosing the agent the other side holds now swaps the pair.
- **Codex reads `~/.agents/skills`.** Measured by asking a real app-server
  rather than by reading its binary for the string, which is what the table
  had been built on. Until now the page could show Codex loading a skill and,
  underneath it, "no agent reads this directory" about the same copy.
- **Counts count what pressing them shows.** With something typed in the
  search box, the chips above the list went on describing the whole library,
  so pressing "2 reach none" could leave an empty page. An empty list also
  now names whichever of the two narrowings actually emptied it, instead of
  always blaming the search.
- **Library craft.** Paths print with the tilde, the way they are written
  everywhere else — in the sheet, in the history, and in the diff's own file
  header; a planned change carries its destination on the row you read before
  confirming, and the preview is wide enough for the diff it exists to show
  and wraps rather than hiding the ends of lines; the matrix has a visible key
  for its marks, above the table rather than under a screenful of rows; a skill is
  *installed* and a server *added*, in every place that offers it; the agent
  pickers in Import and New skill are the app's own switcher — they were bare
  text with a four-percent-black border, invisible until pressed — and the
  lists you pick from use checkboxes rather than switches, because nothing
  there takes effect until the preview is confirmed.
- **Two messages in the same breath.** Sending to an idle conversation now
  counts as busy until the agent has accepted the message, so a second
  message typed in that moment waits behind the first instead of going out
  beside it and being refused by the agent. The wait has a deadline: an agent
  that never accepts stops counting after 30 seconds, so nothing is held
  behind a silence forever.
- **The transcript folds by information, not by count.** A step the agent
  described in its own words — every Claude Code shell call — stands in the
  conversation as that sentence, one line each, never batched, and a turn of
  them reads back open; steps the app could only template still fold to a
  count. The fold's receipt is the sentences, then the tally, and the tally
  now says "ran 3 commands, read 2 files" rather than "called 5 tools".
  Opening a shell step shows the command under a prompt mark, then its
  output; the command is no longer glued to the sentence.
- **Background tasks are a panel.** Summoned from the conversation's ⋯ menu
  or ⌘K, docked beside the conversation like Changes: one card per task with
  the command it ran and, once it ends, what it printed. A chip in the
  conversation header says how many are running, and while anything runs a
  green dot marks every door to the panel — the ⋯ menu item, the panel's
  tab, the conversation's sidebar row. Replaces the strip above the
  composer.

## 0.1.0 — 2026-08-28 · developer preview

The first packaged build: signed and notarized for Apple Silicon and Intel,
with a background updater that installs on quit. macOS 13+.

- **Four agents, one window** — Codex natively; Claude Code, Cursor and
  DeepSeek Harness over ACP, through bridges written for this app. Any other
  ACP agent registers from Settings → Agents.
- **Your real history** — sessions started in the agents' own CLIs appear
  with full transcripts, read from each agent's own store.
- **One approval surface, one permission policy, one audit log** — whichever
  agent asked.
- **Parallel conversations** in panes, each optionally in its own git
  worktree, so two agents can edit the same files without seeing each other.
- **Hand-off between agents** — goal, state, files changed, branch and
  commit, carried as a packet no vendor could adopt from another.
- **Plugins** — twelve built in; installed ones run isolated in a supervised
  child process, and a plugin's tools reach every agent.
- **The workbench** — sandboxed terminal, editor with conflict-refusing
  saves, diffs hunk by hunk, previews, a browser with per-agent tools.
- **The Library** — every skill and MCP server on the machine, which agents
  actually load each one, what its catalogue line costs per turn, and whether
  it ever fired.
- **Usage and context** — every plan's limits on one screen; a context ring
  fed by the agent's own numbers, never derived.
- **Local only** — no account, no telemetry; credentials in a broker that
  returns references, never values.

What it does not do yet is part of the README, stated just as plainly.
