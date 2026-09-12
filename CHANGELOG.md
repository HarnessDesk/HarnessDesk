# Changelog

User-facing changes, newest first — the view for someone deciding whether to
update. If a change does not alter what the app does, shows, or refuses, it
does not earn a line here: a refactor, a build-config tidy or a documentation
move is real work and is not news to a person weighing an upgrade.

## Unreleased

- **Back and forward have keys, and commands** — ⌘[ and ⌘] step back and
  forward through what the middle has shown, and `/back` and `/forward` do the
  same from the palette and the composer. The header's two arrows were the only
  way to either, and a header narrower than 520px folds them — which an
  ordinary wide window reaches as soon as a panel is docked and the sidebar is
  away, leaving history two presses and a layout change out of reach. The
  arrows are unchanged; this is a second way in, and it does not depend on how
  much room the header has. While a browser pane is the one you are working in,
  the same two keys step that page's history instead, as its other browser keys
  already do, and in a file editor they outdent and indent as they always have:
  a key the surface you are working in has already answered no longer also
  moves the desk out from under it.
- **A plugin's Access list says what the plugin may actually do** — the list on
  a plugin's page wrote its own sentences rather than the ones the install
  dialog had already shown, and had drifted from them. A plugin allowed to
  reach the whole network was described as "Reach *", which reads as a hostname
  with a typo. Worse, five of the grants a plugin can hold had no sentence on
  that page at all, so the Browser, Android and iOS Simulator plugins — each of
  which declares exactly one of them — said they could do "nothing beyond
  reading what the agent sends it". Both surfaces read from one list now, so
  what you agreed to at install is what the page keeps saying.
- **A conversation docked to a panel no longer takes the screen when the app
  reopens** — a layout saved with one conversation in front and a second docked
  to the side came back with the docked one in the middle as well, over the one
  you had been reading, which was then nowhere on screen. Each conversation is
  brought back where the layout has it: the one in front in front, the docked
  one docked, both of them loaded.
- **Undoing a turn clears it from every window at once** — after "Undo the last
  turn" the conversation kept drawing the turn it had just dropped, in the pane
  that asked and in any other window open on it, until something happened to
  read the conversation again. Every view is told, and drops it together.
- **A name can no longer reorder the text around it or hide inside itself** —
  a profile name carrying a bidirectional override or a zero-width space drew
  one way in the sidebar seat and another in the settings rail, and could hold
  characters nothing on screen accounted for. Those controls come out now
  wherever a name is read. A family emoji and a Persian name spelled with a
  zero-width non-joiner are untouched: those characters are spelling, and a
  name that needs them keeps them.
- **One Escape closes one thing in Settings and in the dashboard** — with a
  menu open inside either window, one Escape closed the menu *and* the window,
  so the thing you were looking at went along with the thing you meant to
  dismiss. The menu closes now and the window stays; a second Escape closes the
  window.
- **A card menu on the board no longer hangs over the window that opened** —
  opening Settings, the dashboard, or the sidebar in a narrow window while a
  card's menu was open left the menu drawn on top of them, holding the keyboard,
  over a surface it could not be clicked through. It closes now with everything
  else that floats.
- **A panel collapsed on its own can be opened again** — a dock holding a single
  view that draws its own header — a file, a terminal, the repository — drew no
  tab strip, so "collapse to the tabs" left an empty band with nothing in it to
  press. A collapsed panel always draws its strip now, and the control that
  brings it back is on it.
- **A second finger on a panel divider no longer stops the window animating** —
  beginning a second resize on a divider before the first had ended left the
  window marked as resizing for the rest of the session: no transitions
  anywhere, the resize cursor stuck, nothing selectable and every embedded page
  inert. A divider ignores a second pointer while it is being dragged, and a
  suppression nothing is holding is given back.
- **A context chip with nothing to say no longer refuses the message** —
  attaching *Last test run* to a brand-new draft stopped the send with an error,
  because a draft has run nothing of its own and the provider treated that as a
  failure. A provider with nothing to add now leaves the chip off the message
  and says which one it left off; a chip whose plugin has gone — switched off,
  uninstalled, or not back yet after a restart — comes off the draft itself,
  instead of refusing every send until somebody notices it. A provider that
  genuinely fails still stops the send, which is what that rule was written for.
- **A plugin's chip, command, panel or row is offered only where it applies** —
  a contribution can be narrowed to one project, one agent or one conversation,
  and the window offered all of them everywhere: the composer's Add context
  list, the slash palette, a contributed panel and a contributed row each asked
  what *kind* a contribution was and never where it applied, so a command that
  the host would then refuse to run was still listed. They ask both now, and the
  extension kernel refuses to resolve a chip from outside its scope even if
  something asks.
- **A worktree that goes names what git ignores in it first** — removing a
  worktree, or bringing one back to the main checkout, deletes the folder and
  everything git ignores inside it: an `.env`, a `.venv`, `node_modules`. Git
  counts none of that as a change, so the checkout read as clean and the
  removal dialog said "only the checkout goes" — then took an `.env` that was
  in no commit and no backup. Both dialogs now list those entries before
  anything moves, and say which kind each one is: a folder that can be built
  again, or a file that is in git nowhere and cannot be got back.
- **An undo that cannot go whole can now go as far as it goes** — a turn that
  deleted several files, one of which the agent recorded no content for, could
  not be undone at all. Refusing is right — writing that file back as an empty
  one is the loss an undo exists to prevent — but the updates and the recorded
  deletions beside it were recoverable and there was no way to ask for them.
  The refusal now offers *Undo the rest*, which puts back everything it can and
  names what it left exactly as it was.
- **A throwaway browser profile goes before the desk does** — when pages are
  set to open in a separate window and the profile is not kept, quitting asked
  Chrome to stop and removed the profile only once Chrome had gone. Nothing
  waited for that, and the desk exits a moment after, so the profile — cookies
  and logins of whatever the agent signed into — could be left on disk. The
  quit now waits for the browser to exit, still bounded so it cannot hang on
  one.
- **A saved PDF's folder does not outlive the desk that made it** — a page
  saved as a PDF goes in a folder under the system temp directory that is
  removed when the plugin stops or the desk quits. A crash or a force quit runs
  neither, and the folder stayed until the operating system got round to it.
  Each folder now carries the process that made it, and a desk starting up
  removes only the folders whose process is gone — never a folder another
  running desk is still using.
- **A plugin's workspace grant stops at the workspace, symlinks included** — a
  link inside the open folder pointing anywhere else was treated as part of the
  folder, so a plugin granted workspace access could read and write through it
  to the rest of the disk. Containment is now decided by where a path really
  leads rather than by how it is spelled, and a path that does not exist yet is
  answered by the nearest folder that does, so creating a file is judged before
  it is created. A link that points back inside the workspace is still inside it.
- **An agent HarnessDesk installed is offered its update again** — when the
  folder HarnessDesk downloads into was configured with a doubled or trailing
  separator, or a `.` in the middle, the copy inside it was not recognised as
  the desk's own. It was listed as an ordinary binary found on PATH, with no
  package name and no update available, and nothing said why.

- **The audit answers with what just happened** — Activity and the Library's
  change history read the audit log, and an entry recorded a moment earlier
  could be missing from the answer: a command a policy rule had just denied,
  or a library write just applied, was absent until something asked again.
  A read now waits for what was recorded before it was asked.


- **Plugin settings are still there tomorrow** — a setting typed into a
  plugin's page in Settings is kept and put back at the next launch. Until
  now the host held them in memory only and wrote none of them down, so the
  Workspace files *Read limit, in bytes* was back at 64,000 every morning,
  and so was every other plugin's setting. Working together's rules were
  written down but read back too early to be applied, which meant a board
  left holding inbound messages came back accepting them; that, and where an
  agent opens a page, are restored now too.
- **A setting that cannot be saved says so** — preferences are applied as
  soon as you change them and written to disk behind you, and when that write
  is refused or the connection drops, the window now tells you the next
  launch will not have it. It used to show the new value and keep the old one
  on disk, with nothing said until a relaunch quietly put it back.


- **`read_file` stops at the byte limit its setting names** — it counted
  characters, so a file of three-byte characters ran to three times the limit.
  Chinese or Japanese text now comes back about a third as long as before; the
  Workspace files plugin's *Read limit, in bytes* setting raises it.

- **Local or a new worktree, said where you type** — a new conversation's
  composer now leads with where it will run: **Local** (the folder as it is),
  a worktree the project already has, or **New worktree**, which is made when
  the first message goes — so a draft abandoned after choosing one leaves no
  branch and no folder behind. A folder that is itself a worktree is never
  called Local, and the header tags any worktree, not only HarnessDesk's own.
  Each place has its own glyph, so a narrow window that folds the words away
  still says which.
- **Bring a worktree back** — a conversation in a HarnessDesk worktree can
  bring its branch back to the main checkout from the header's branch menu.
  The worktree's folder goes, and with it anything git ignores there, such as
  an `.env` file; the dialog says so before anything moves, and it waits while
  a conversation in the worktree is still working. Uncommitted work
  stops it (the dialog lists the files and can ask the agent to commit them); a
  main checkout that will not take the switch says why in git's own words, and
  the worktree is put back from its branch, the message naming what git ignored
  there — or, if git will not allow even that, saying so. The conversation
  carries on in the main checkout through a hand-off.
- **Your name and face on the desk** — the seat at the foot of the sidebar is
  you, and now it can look like you: pick one of twenty-three HarnessDesk
  whales and give yourself a name in Settings → Profile, which heads the
  settings rail and is one press from the seat's menu. The same face marks
  what you say in a room. “HarnessDesk” and the house mark stay the default,
  and Reset to default puts them back. Kept on this Mac; nothing syncs.
- **A phone's width has a layout** — in a window narrower than 720px (a
  browser, or the desktop app zoomed in), the sidebar floats over the
  conversation instead of leaving it 135px. The header's sidebar button, ⌘B
  and the palette open it; Escape, a press on the dimmed conversation or
  choosing somewhere to go puts it away. A panel on the right takes the
  conversation's width while it is open. Headers fold by their own width —
  in a narrow pane of a wide window too — so a title keeps room: about 165px
  at 375px, where it had one. The composer's model control folds its name
  with the other controls' words instead of clipping it, a banner's actions
  move under its words, and an approval's answers wrap rather than running
  off the card. A room's top row now carries the sidebar button and the
  back and forward arrows when the sidebar is away, and a conversation
  docked beside the middle no longer draws a second set; a sidebar that is
  put away can no longer be reached with Tab.
- **Gemini CLI and Antigravity show the context ring** — Gemini CLI counts a
  turn's tokens in its own slot on the prompt response rather than ACP's
  `usage` field, and Antigravity's server puts none on the wire at all but
  records every model call in its own conversation store; the desk now reads
  both. Neither says how big its context window is, so theirs is the dashed
  ring, with the last turn's and the session's tokens beneath it.
- **The account menu says who an agent is signed in as** — Gemini CLI shows
  the Google account it signed in with (or “Gemini API key”), Cline its Cline
  account, each read from the agent's own files. Antigravity shows how it
  signed in, “Google account”: its server keeps the address in the keychain
  and nowhere the desk may read.
- **Google Antigravity is now Antigravity**, wherever the desk names it —
  rows already added under the registry's longer name included.
- **Pull requests are published through the desk** — the Git plugin gains
  `pr_create`, `pr_update`, `pr_review`, `pr_comment`, `pr_view`, `pr_checks`,
  `issue_view` and `issue_comment`, reaching GitHub with your own `gh`. A pull
  request an agent opens or edits with them ends with “🤖 Generated with
  [HarnessDesk](https://harnessdesk.app) (agent model · effort)”, in the
  agent's own labels, and a review opens with “Review by … · via
  HarnessDesk”; both lines are templates under Settings → Plugins → Git, and a
  blank one signs nothing. What was published appears in the conversation as
  a row — the pull request as a chip with its state, a card with GitHub's own
  text behind it — and under the turn's summary. Every agent is told, in one
  sentence through its own instruction layer, to use the tools; nothing is
  added to your messages. This replaces the “Context added” envelope and the
  General → Sign pull requests switch.
- **An agent the desk cannot ask is no longer “Needs sign-in”** — an ACP
  agent with no status command and no stored key (Gemini CLI, Antigravity,
  Cline) read as signed out while it was opening pull requests.
  Its state is now what its own answers showed: a conversation that opened
  reads “Signed in”, a refusal for want of a sign-in offers the agent's
  declared methods in its own words, and until either has happened the desk
  claims nothing.
- **Every open conversation has a row in the sidebar** — one whose agent
  lists no history (Gemini CLI has no `session/list`) had no row anywhere,
  and the active row is now scrolled into view when a long list would have
  hidden it.

## 0.1.0 — 2026-09-07

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

### Late changes

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
