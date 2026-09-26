# Changelog

User-facing changes, newest first — the view for someone deciding whether to
update. If a change does not alter what the app does, shows, or refuses, it
does not earn a line here: a refactor, a build-config tidy or a documentation
move is real work and is not news to a person weighing an upgrade.

## Unreleased

- **Wrapping a Goal right after stopping its run now waits for the stopped
  Seat's answer to finish saving.** That answer is written to disk a beat
  after the turn ends, and wrapping right away could catch it mid-write: the
  receipt could then say a Seat that had answered "has no recorded answer",
  or the wrap could refuse with "This Goal changed while you reviewed its
  receipt. Review it again." A read now waits for that write first, so the
  receipt always carries what the Seat actually said.

- **The Dashboard shows when the work ran.** A new "When it ran" band draws a
  year as a calendar heatmap — Year or By agent, Tokens or Cost — with the
  active days, the current and best streak, and the busiest day beside it. A
  day before the ledger has scanned that far reads as unknown, not empty.

- **A flow Seat's question waits for you.** On a run you started, a Seat's
  question is no longer cut off after twenty seconds: it waits for your
  answer. In a Goal a trigger opened, it waits as long as **Settings ›
  Permissions › When nobody is here, an agent's question waits** says — five
  minutes by default, from stopping right away to waiting until you are back
  — and then its run stops for you. Answering it after that, on the room's
  question card, now carries on the work: the Seat is handed your answer in a
  turn of its own and the run goes with it, where before the answer went
  nowhere. While a run is stopped like that, its board draws the Seat's card
  in **Needs you**, as the header already said. A Goal started in a project
  opened through a link is no longer listed a second time under **Other
  projects**.
- **A sign-in that wants a pasted code asks for it.** When an agent's browser
  sign-in cannot finish by itself, the page shows a code to paste back into
  the agent's sign-in command — which the desk runs in the background, so the
  sign-in used to wait forever. Sign in now shows a password field for that
  code beside the page and Cancel, and hands the code to the command. The
  code is never logged, kept or repeated in an error.
- **Secondary text is its own level again, and a segmented control shows its
  choice.** Secondary and tertiary ink measured a hair apart — the app read
  as two greys doing the work of three — so secondary moved to the grey
  ramp's own darker step, easier to tell from a count or a timestamp at a
  glance. A segmented control's chosen answer (Settings › Appearance's
  dials, a Dashboard pivot) is lifted on the card again, with a hairline
  shadow and primary ink, instead of blending into the track it sits on.

- **A signed-out agent's mark looks empty.** The seat's badge and the menu's
  mark for an agent with no one signed in were meant to read as an empty seat
  and never did; they now draw a dashed ring with no plate and a quieter
  glyph, so an agent that cannot start a turn no longer looks like one that
  can.

- **The account menu says less.** Every account is one line — its name and
  what is left — with the address and plan on hover rather than under every
  name. An agent with several accounts shows its mark once, as a heading with
  its accounts under it. Agents still waiting for a sign-in step behind **Add
  an account…** instead of filling the list, the **Local** tag on your profile
  is gone (every profile is local), and **Usage remaining** no longer takes a
  row to say "—" when nothing is metered. The current account is marked by its
  filled row rather than a tick, so every figure ends at the same edge, and
  Dashboard — already in the sidebar's nav — is no longer repeated here.

- **Old DeepSeek bridge removed.** If your `agents.json` runs
  `@harnessdesk/dsh-acp`, change that row to `{ "id": "dsh", "template": "dsh" }`
  — DeepSeek now runs on DSH's own ACP server.

- **DeepSeek seats finish their cards.** A DeepSeek conversation's board
  calls — finishing a card, claiming one — were refused as unattributed,
  because the only way it reached HarnessDesk's tools was one tool server
  shared by every DeepSeek conversation, which cannot say which one is
  calling. DeepSeek is now in the agent catalogue, on DeepSeek Harness's own
  ACP server (`dsh --profile acp`), which takes HarnessDesk's tools per
  conversation, so each seat's calls are its own. Its model picker names each
  model rather than printing its route, a reopened conversation resumes
  instead of failing, and its steps read as sentences — "Read README.md",
  "Updated the plan", the command it ran — with the matching glyph and no raw
  tool name under them. An agent upgraded to take the tools is offered them
  on its next restart, not only after the app restarts.

- **A standing notice stays in its own pane.** The floating banner stack (a
  Library import offer, an account warning) used to span the whole workbench,
  so it could sit squarely over a room's Board row, cut through the top of
  Chat, or spill into a docked browser pane's own toolbar and catch a click
  meant for its reload button — all unclickable until the notice was
  dismissed. A room now leaves room for whatever notice is showing, its rail
  and reading side moving together. The notice itself rides the pane being
  read — a panel zoomed to fill the window, or laid over a narrow one, takes
  it along — never narrower than a card can be read at, and always below
  that pane's toolbars rather than over them.

- **An Agent can be started at a higher ceiling, and its MCP servers load.**
  An Agent whose ceiling is publish or merge was always seated at edit from
  the app, so an MCP server it declared — which needs a Seat that may merge
  — never loaded. Its page now offers **Start at a higher ceiling…**: the
  levels up to its own ceiling, each saying whether the runtime taking the
  seat holds it or can only be asked to, with merge saying it loads the
  Agent's servers. The plain Start still seats at edit. Approving a server whose
  review shows a value only as set now asks you to confirm you know what
  that value is, since a value that changes what the server does can hide
  behind a name that looks like a credential. A Seat that falls back to
  another agent says its content was approved for the first one, a server
  that ignores being asked to stop no longer outlives a quick quit, and a
  Seat the agent still held when it was reopened keeps its servers.

- **Goal boards save whole, and a stuck Goal clears without a restart.** A
  board change that rode along with an assignment could be reported saved
  before its name, messaging and plans were written; they now land in the
  same write. A Goal whose failed assignment could not be set aside
  retries that once the next board save lands, instead of waiting for a
  relaunch. A legacy flow's member roles survive a Goal being read back.

- **A Goal's work survives a relaunch.** Quitting while a Goal's agent was
  working, or waiting for you to approve a command, used to leave the Goal
  reading "Running" after the next launch while nothing ran and the approval
  was gone. Now the desk reopens that agent's conversation and hands it its
  card again, so it picks the work back up and asks again; one that cannot
  be reopened stops the run and says why. A Goal's Findings pane now shows
  the run that is going on, not an older stopped one that shares its Goal.

- **A Goal or room now has one header, and it says what it should.** A Goal's
  page used to stack two headers naming it — its own, then the room's, one
  of them running its full folder path across two lines — and named the
  person as a card's author when a trigger's own run had opened it
  unattended. Now there is one row: the Goal or room's name, its state as a
  chip, the project's short name (its full path a hover away, never the raw
  folder), who is here, and — for a Goal a trigger opened — where it came
  from. Messaging is a plain icon toggle instead of the words "board-only"
  or "messaging on". The sidebar names every Goal by its own sentence
  instead of leaving it bare beside a status chip, gives each "Needs you"
  row a reason so two conversations under the same agent's name no longer
  read as one row twice, and a project reached through a macOS symlink
  (temporary folders behind `/var` → `/private/var`) is one row, not two.
  Every Agent's ceiling chip now reads in the same neutral tone; "asked" is
  the ordinary state for a runtime with no control that holds one, not a
  warning.

- **Starting a team is two clicks, from files you can edit or write yourself** —
  New session gains **Start with a team**, alongside the solo and room
  choices: a catalogue of shapes — Fan out, Review, Compare, Relay,
  Investigate, Align, and a seventh, unordered custom starting point — each an
  ordinary file, none of them a special case in the app itself. Choosing one
  reads its populated dry run before anything opens: every Seat it would
  take, every command verbatim, the rules a round moves through, and whether
  independence from the author is known. Every Seat a front-door run opens
  must actually hold its ceiling — a runtime that can only be asked shows an
  honest refusal and its fix rather than starting under a weaker policy, so a
  fresh install with one ready runtime still gets exactly what it asked for.
  The same door opens from a branch's own menu, a pull request's row, ⌘K, and
  an empty Goal's board, prefilled with what that place already knows. A
  **Review…** of a branch, a pull request or a diff runs three read-only
  specialists at the commit it resolved — each in a checkout of its own cut
  from that commit, whatever you have checked out — and never offers a shape
  that starts by editing.
  **Your own shape…**, the catalogue's last row, is an ordered editor for
  Agents, checks and person steps and the rules between them — no YAML to
  write — with the exact file shown and updated as you go, a graph view of
  the same steps and rules for a shape that branches or loops, and a save to
  the project or to yourself, previewed first; starting needs no save at all.
  **Every time…**, on a shape or on an Agent's own page, composes a disarmed
  trigger — a pull request, an issue or a schedule — and saves it to the
  working tree; it is never itself consent; the existing Triggers preview and
  an explicit Arm, bound to what is actually committed, are what let it run
  unattended.
- **The Agent page is now an editor, and Agents can be made from nothing** —
  a name, description, answers and produces are each edited in place, with
  the exact line the change would write shown before Save; a hand-written
  comment and the rest of the file survive untouched, and a value that spans
  lines refuses with a route to the file rather than being flattened. **New
  Agent** starts from a shipped Agent or from a blank draft — nothing is
  written while typing, and only an explicit Create or Save writes anything.
  An interrupted save is listed with Resume or Discard, never resumed on its
  own.
- **A project can open bounded work on its own, and you decide exactly what that means before it ever runs** —
  a project's own `.harnessdesk/triggers.yml` declares what opens work: a
  pull request, an issue, or a schedule. A project's page now has a Triggers
  section listing each one as a sentence — "When a pull request opens or is
  pushed, open review-pr, at most 4 at once" — with what last happened,
  including a skipped firing and why. Turning one on opens the exact arming
  review before anything is armed: the committed file it reads, every Seat it
  would open and every candidate passed over, each trusted command verbatim
  with its folder and timeout, how firings group into one Goal, what a later
  push does, whether a fork is ever run, the total budget, and the daily
  reservation it would take — closable only by an explicit Arm or Cancel,
  never by a stray click or a held Return. History pages every firing, newest
  first, and always names an exact duplicate rather than a second round.
  An issue trigger that reads comments fires only on the armed account's own
  comments unless it says `from: collaborators` or `from: anyone` (which the
  review warns about), and nothing the desk posts itself ever fires one. A
  runtime that is down or a sign-in that blinks never consumes a firing: it
  waits and starts once it can. Settings › Workspaces adds "Triggers on this
  Mac": pause every trigger on this machine at once — which stops watching
  and holds the work triggers started, and resuming continues it — and a
  daily cap in USD, shown against what is reserved and charged today; zero
  means no new paid work, and an unreadable charge reads as unknown, never
  zero. Permissions › Ceilings adds a second policy,
  answering what a Goal a trigger opened does when a runtime cannot hold a
  ceiling — refuse by default, or an explicit choice to seat it and say so —
  kept apart from the existing choice for a conversation you are watching. A
  Goal a trigger opened now says where it came from ("from PR #12", "from
  issue #7", "from a schedule") in its own header and in the sidebar's room
  row, and every wait on it — a held message or action, a question nobody
  answered, a person's card, a stopped run, an unreadable source — shows
  plainly as Needs you, named and with a working way to resolve it; a Goal's
  receipt keeps that same origin and stop reason once it wraps. macOS
  notifications gain two kinds of their own: unattended work that needs you,
  and a trigger that was skipped, each individually silenceable the same way
  every other kind already is. Nothing about this is a promise of an exact
  invoice — arming and Settings both say so — and nothing runs unattended
  until a person on that machine has explicitly armed it.
- **An Agent can carry skills, MCP servers and its own notes.** Its file
  declares them by name — `skills:`/`mcp:`, editable from the Agent page,
  with an empty list read as "Runtime defaults" rather than "None" — and a
  Seat freezes exactly what loaded at open, never picking up a later edit or
  approval. Agent-local content (a `skills/` folder beside the Agent's file)
  is untrusted until a person reviews the exact bytes and approves them, once
  per repository, Agent, runtime build and effective ceiling; loading an
  unapproved bundle is refused rather than substituting a different runtime
  or silently skipping it. An external MCP server is classified `merge` by
  default and reached only through the desk's own gateway, never a direct
  unmediated connection, and runs only when a Seat that may merge lists or
  calls its tools. The bundled Claude Code bridge, and any ACP peer that
  negotiates the extension, honor a scoped filter; Codex reports it
  unsupported. The host stages exactly what was approved and hands a runtime
  that copy, and a Seat's filter is re-applied when its conversation is
  resumed or its agent restarts (forking such a conversation is refused).
  `NOTES.md` beside an Agent's file is private working context the Agent page
  reads and clears, never system instructions, and is not loaded onto a Seat
  in this release.
- **A Seat's name card and the Library show what actually loaded** — an
  Agent's page, its name card and a project's Library page each show
  declared skills and servers next to what a Seat's runtime build actually
  reported back, with "declared, not loaded" distinguished from "not
  recorded" (an Agent with nothing declared, or a Seat opened before this
  shipped) so neither reads as a fabricated success. The Library's Agent
  filter narrows to what one Agent declares without changing the measured
  reach every other row already showed.
- **A Goal can cite committed project memory that outlives the Goal that
  made it.** A person picks a wrapped source Goal and one of its project's
  committed `.harnessdesk/memory/*.md` files, at an exact revision, and
  confirms "Cite in this Goal" — the exact bytes, the source Goal's receipt
  and the Seats that were there are retained immediately, before the
  citation is saved, so a later reader still sees the original text even
  after the source Goal, its Git history or the whole desk that made it is
  gone. Every honest gap says so: "Source Goal unavailable; retained copy",
  "Original revision unavailable", or, for a citation made before this
  shipped, "The original source was not retained" — never a guess dressed up
  as the real thing. Opening a citation only ever displays it; it starts no
  turn and grants nothing.
- **Backup and restore now carry this history too** — every retained
  citation and every Seat's attachment record round-trip through the same
  backup file, restored as history a person can read, never as a live grant:
  an imported Seat attachment epoch is always marked restored, and an
  imported citation can satisfy only the one dependency edge it created, never
  authorize new work. One damaged entry in an otherwise-good backup is
  refused and counted; it does not stop the rest of that history from coming
  back.
- **A paused or uncertain finding posting is yours to settle, and nothing is
  posted twice** — the Goal's Findings pane lists each closed-round posting
  that needs you with the reason: *Post again* reads the pull request back
  before anything is sent, *Skip* asks why and puts that on the receipt, and
  rounds kept on the desk before a pull request was bound are posted only
  after you preview and confirm them. A wrapped Goal's receipt opens each
  finding's history and carries unresolved ones into another open Goal, and a
  finding's history lets you withdraw it or accept or reject a claimed repair
  yourself, with a reason. Fixed along the way: wrapping could hang while a
  flow seated a card; a decision made while a round was closing could be
  lost; a reviewer in a blind round could read a sibling's verdict or reach it
  through a new card; two submissions of one decision could both apply;
  *Merge anyway* was greyed whenever nothing had been posted; and `review-pr`
  stopped before its referee after one repair.
- **The findings ledger has a home in the Goal rail, and a stopped run asks you directly** —
  Findings joins Board and Chat on a Goal's own rail: filter All, Open or
  Blocking; a row shows a claimed repair honestly ("Repair claimed · awaiting
  review", never "Verified") and whether it is currently blocking or
  advisory; opening one shows its full history — the original claim, every
  later repair and verdict with who recorded it, and where it was actually
  posted — and the raising Agent's own historical record, even if that
  session has since moved on. A run that stopped for you — its round budget
  reached, too many rounds without progress, or a repair rejected twice —
  says so on the Goal, with the choice to authorise one more round, merge
  anyway with the exact unresolved findings on record, or drop it; none of
  these edits a check, review or finding to passing, and merging still goes
  through the existing confirmation. A wrapped Goal's receipt now shows the
  findings it owned when it wrapped and any such override, and you can carry
  an unresolved one into a later open Goal by reference — the same id, the
  same original Agent, the wrapped receipt untouched. Starting a review flow
  now shows its effective round budget up front, and that a review round's
  reviewers cannot message or post anything — not each other, not the pull
  request — until every reviewer has finished and the round closes together.
  A new shipped flow, `review-pr`, is the ordinary example: a fixer, two
  independent reviewers, a mechanical check, and a person referee gated on
  the pull request still being the one that was reviewed.
- **Review findings are recorded once and followed to the end** — a reviewer
  raises each finding as its own record, a repair is a claim until the
  reviewer that raised it confirms it in a later round, and a finding keeps
  its identity when a person carries it into a later Goal. A flow run now
  stops for you after its round budget (three by default), after two rounds
  that brought no new evidence, or when a finding's repair is rejected twice;
  several reviewers judging at once no longer see each other's findings or
  messages until the round closes, and a later review is handed the exact
  change since the last one. When the round closes, its findings and reviews
  are posted to the Goal's pull request together, each saying which Agent
  made the claim and at which revision; a repair lands on its finding's own
  comment or thread. Nothing is posted twice: a comment whose answer was lost
  is read back from the pull request, and one the desk cannot confirm waits
  for you, and is written into the receipt as a gap only when you say so.
  A reviewer can no longer post to the pull request itself while its round
  is blind. Without a bound pull request, or with posting off, rounds stay
  on the desk.
- **A reviewer's finished card no longer goes back to "claimed".** If
  another Seat opened on the same Goal while a reviewer was completing its
  card, the reviewer was told the card was done, but the board kept it
  claimed. The flow then sent the reviewer the same card again, or waited on
  it indefinitely. A completion is now saved. A completion whose card was
  released or reassigned while its review was being checked is now refused.
- **Assigning a card just after adding it no longer leaves the Goal stuck.**
  If the card's save was still queued, the assignment used to be refused and
  stayed half-done, so the Goal then refused every later save. Relaunching
  didn't help, because the desk failed to start while it tried to finish the
  assignment. An assignment or release that can't finish is now set aside:
  the Seat it opened is closed, and the Goal says what happened. A patch
  applied with `git am`, or a cherry-pick committed after a conflict, now
  counts as a step's own work. A wrap receipt lists any card that recovery
  set aside, with the reason. A change refused because its save failed no
  longer leaves its line in the Goal's channel.
- **A project's Flows are visible, previewable and updatable** — a project
  page now lists the flows it can start, layered from the project's own
  files down to the ones that ship, with what a nearer file shadows called
  out rather than hidden. Starting one previews the honest dry run first:
  every round, seat and evidence guard it would open, before anything runs.
  *Update…* converts an old project flow file to the current format as one
  reviewable diff, covering every Agent file it would also write, resumable
  if interrupted partway. Starting a flow from a new session now offers a
  single Goal the same way an ordinary conversation does.
- **`/race` is now an ordinary flow, not a second execution path** — racing
  two seats substitutes them into a shipped flow's own designated role and
  runs it exactly like any other flow, so its progress, checks and evidence
  show up the same way. A run's status is visible on its Goal, including a
  failed check's retry.
- **Evidence guards are satisfied by the facts the desk records** — a check,
  a structured review, an observed diff, CI or pull request now speaks for
  the revision it names wherever in the run's dependency chain it was filed,
  and every new fact re-reads a waiting rule, so a guarded step no longer
  waits forever. A diff counts what a step committed since it began, straight
  onto the default branch included, and a run waiting on evidence says what
  for. The comparison flow's merge card names the exact revision the judge
  picked.
- **An independent step is judged on the vendor an agent really calls** —
  each runtime now reports which vendor's models it reaches, read from the
  agent's own configuration, and says it cannot tell whenever a provider or
  base URL is overridden or the account pays through a gateway. A step that
  must be independent of an earlier one is refused rather than seated on a
  runtime whose vendor is unknown, whatever that runtime is called.
- **A check without an explicit checkout now runs once per predecessor
  subject** — each competitor's own isolated work is checked on its own,
  rather than one command picking a single subject to stand in for all of
  them. Naming a checkout explicitly keeps the old single-command behaviour.
- Fix the whole app quitting on the first line it logged after the terminal
  or script that started it had gone away — usually a refused Wrap, Seat or
  check run. The refusal is now shown, and the host log says its console went
  away.
- Add source-qualified, read-only Insight transport for historical usage,
  receipt cost summaries, project usage, and local Agent-seat ordering review.

## 0.2.4 — 2026-09-18

- **Projects can now hold finite Goals** — create a Goal without changing the
  ordinary conversation path, seat an Agent or assign a loose conversation,
  track dependency/activity state, and keep wrapped work in a collapsed history
  group.
- **Isolated Seats keep their own lane** — each receives a retained worktree,
  disjoint port block and optional persistent browser profile, with machine-wide
  defaults and explicit port release under Workspaces › Lanes.
- **Wrapping produces a reviewable, immutable receipt** — cards, answers,
  evidence, revisions, citations and retained lanes are captured before the
  final action and survive restart. Backups restore these facts as read-only
  history without reviving agents, ports or browser authority.

Usage now reflects what each agent actually keeps and reports, so balances and
spend no longer disappear behind a generic unsupported state or get described
as public-price estimates when they came from the agent itself.

- **Usage cards now cover five more agents** — Amp's credit balance, Cline's
  account balance and billed session spend, Gemini CLI and Qwen Code's
  transcript-derived spend, and OpenCode's recorded session cost now appear in
  the Dashboard and account surfaces.
- **Usage provenance is visible and honest** — totals distinguish public list
  prices from agent-recorded costs, spent balances explain whether they need a
  top-up or reset, and free models remain visibly free instead of being treated
  as unpriced.
- **Foreign usage databases are read safely** — HarnessDesk reads another
  agent's records without writing beside, locking, or modifying the agent's
  own files, including when a database is using WAL mode.

Conversations now keep more of the history the agents expose, while the desk
gets clearer about which folder and build it is actually using. Alongside it,
the catalogue, usage views and interaction details gained the last pieces
needed for the next agent-focused release.

- **Codex conversations can be read, forked and undone through the desk** —
  history now follows Codex's own conversation model, side-thread reviews no
  longer rely on deprecated detached delivery, and the interface can keep a
  review's held state visible while it runs.
- **Codex conversations can start from one of your CLI profiles** — a profile
  chosen under an agent's new-session defaults contributes its model and
  context settings without changing the base configuration. The context ring
  still waits for Codex to report the window it actually applied.
- **A folder only opens when the desk has its full path** — relative roots and
  folders that are not present are refused explicitly instead of being
  interpreted against the host's working directory or mistaken for an empty
  folder.
- **The desk's update notice follows the build it measured** — an update
  prompt no longer points at a release whose version can change underneath
  the check.
- **Menus and motion behave consistently with keyboard and accessibility
  input** — flyouts stay open while the pointer travels to them, menu focus
  leaves through the real next target, Escape closes row menus, reduced motion
  avoids transitions that were never declared, and the approval surface stays
  above its own backdrop.
- **Usage and catalogue state are more truthful** — Antigravity usage comes
  from its own usage endpoint, spent model groups are skipped, every catalogue
  tab represents a shipped module, and the Codex protocol is refreshed for
  0.155.0.
- **Agents and goals have a documented foundation** — the reusable agent
  definition and seating model establish the next way to configure who can
  work in a room and what each seat is allowed to do.

One canonical UI system replaces the parallel implementations that had begun
to disagree with each other — a shared type scale, a neutral grey ramp, one
row height per column, one measure for a reading page, and a map of the
transcript itself for finding your way back through a long conversation.
Alongside it: the ACP protocol driven properly for signing in and out, a
profile picture that becomes the face HarnessDesk wears in the Dock, and a
pass over usage limits, search and room ordering.

- **HarnessDesk's interface now draws from one design system, not several
  that had drifted apart** — the sidebar, window bars, composer, settings
  pages and every dialog were rebuilt on one set of canonical controls. The
  type scale settles on a handful of named sizes instead of scattered pixel
  values; the neutral ramp that carried a faint blue tint across every grey
  surface reads as grey now; every row in every column — navigation,
  sessions, a settings list — stands the height it should always have; and
  the reading column widens from 736px to 768px (48rem), room enough for a
  line of code that used to wrap. The sidebar's rows line up on one inset,
  the composer is sized to a line of text rather than a paragraph, and the
  window's bars share one padding instead of three different rhythms.
- **A map of the transcript runs down the left edge of a long conversation**
  — each turn's ask and its answer gets a mark on a rail beside the
  scrollbar. Moving along it magnifies the marks near your pointer and shows
  the first words of what's there, and pressing one jumps straight to it —
  turning "the bit about the retries" into a place you can see instead of a
  scroll you have to remember. The rail only appears once a conversation is
  long enough to need it.
- **UI migration regressions repaired** — menus show their contents again,
  Settings rows grow around descriptions, avatar artwork keeps its size, and
  selected, current, running, failed and drop-target states retain their
  cues. The hand-off dialog no longer runs its choices off the edge of the
  screen, and opening a folded tool call no longer paints a grey band over
  content that was already visible underneath it.
- **Antigravity's Sign in and Sign out actually work now** — both were
  driving `agy`, the Antigravity IDE's own CLI, and neither command it
  offered could do the job: Sign out was refused every time, and Sign in
  could report success while touching nothing. The desk now drives the ACP
  protocol the agent's own server supports for both. Auditing every other
  agent with declared account commands found the same class of bug in
  OpenCode — its status read a provider listing as a session state, so a
  conversation could open onto a sign-in wall while OpenCode was signed in
  and running; it now reads OpenCode's own session file instead. The sign-in
  sheet itself, which had been rendering at under half its intended width
  with every method's name and description running off the edge, now opens
  at full size.
- **Your profile picture becomes your Dock icon** — HarnessDesk's icon in
  the Dock and app switcher now follows whichever avatar you've set as your
  profile picture, so the running app matches the seat you're signed in as.
- **The app's own face is one of the faces you can wear** — Settings › You now
  offers the icon in six colourways before the whales: on white, on near-black,
  in silver, on Blueprint blue, blue on white, and the mark with no plate at
  all. Whichever you pick is your seat and your Dock icon, and it arrives at the
  size the Dock draws rather than the size a 44px tile needs, in the same
  rounded container macOS gives every other icon in the row.
- **Clearing your profile picture puts the app's own face back on the Dock** —
  picking a picture changed the Dock icon, but picking the default again left
  that face there: the icon it went back to was in a format the app cannot
  read, so nothing happened at all.
- **Choose which usage window an agent leads with** — an account tracking
  more than one quota (a five-hour window and a weekly one, say) now lets you
  set which one the header, tray, Dashboard, Settings and sidebar show
  first; a window that's actually spent still takes precedence over your
  preference.
- **A room no longer prints an answer twice** — two prompts landing in the
  same conversation within the same second spliced the first one's answer to
  itself end-to-end with no separator. The ACP adapter now refuses a second
  prompt while one is still in flight rather than silently overwriting it
  mid-turn.
- **Opening a search result reveals it in the sidebar** — jumping to a
  session from search now scrolls to and highlights that row, even when its
  project group is collapsed, far down the list, or folded into an overflow
  menu.
- **Rooms and sessions in the sidebar sort by when you last used them**,
  rather than an order that didn't track use — pinned sessions still lead
  the list.
- **Antigravity session names use the opening prompt** — ACP no longer lets the
  agent's `Session <id>` placeholder hide the first ask in the session tree.
- **Cline ACP auto-approval is honored** — Cline's auto-approve setting now
  appears in the permissions control and automatically accepts covered tool
  calls, with its Claude/MCP dependencies refreshed and cross-agent ACP
  regression coverage added. The Claude ACP bridge itself moved onto
  Anthropic's official Claude Agent ACP package, in place of the deprecated
  third-party one it shipped on, carrying over HarnessDesk's own controls and
  compatibility extensions.

## 0.2.0 — 2026-09-14

Flows: a room can be handed its policy instead of you performing it card by
card. Around them, the work a room needs — a worktree you can start a
conversation in and bring back when it is done, pull requests published
through the desk itself, a profile of your own on the seat, and a layout that
holds at a phone's width. Then a long pass over what the desk reads, writes
and hands out.

- **Flows: a room can be handed the policy instead of you performing it** — a
  room is a shared board with a human referee, and somebody has to decide who
  does what, move work between agents, read the results and take the
  irreversible steps. A flow declares that up front: named roles, the seeding
  prompt each one is handed, and the rules that move work between them. Start a
  room, pick a flow, and a loop runs — one agent fixes, three review, a mixed
  round sends it back, a unanimous one hands you the merge — with the steps you
  keep marked `kind: person` and nothing else able to take them. Flows are files
  in the repository they serve (`.harnessdesk/flows/*.yml`), so they are
  versioned with the code they govern and can be proposed in a pull request. Dry
  run first: it spends nothing and prints every seat it would open, every
  command a check would run, and a trace of the loop — and refuses a flow that
  names a role which does not exist or loops with no way out. See
  [docs/flows.md](docs/flows.md).
- **A draft pointed at the main checkout no longer calls it a worktree when that
  checkout is on a detached HEAD** — the word beside the *Work in* glyph read
  which place was chosen, while the badge beside it read whether that place was
  the main checkout. With a branch to name, the two could never be caught
  disagreeing; with none, the word fell through to its worktree fallback, so the
  chip wore the laptop and said "Starts in the main checkout" on hover next to
  the word *Worktree*. It reads *Local* there now — what this same place is
  called under this same glyph when it is the folder that is open.
- **From a worktree, the composer can start the next conversation in the main
  checkout** — *Work in* listed the open folder, a new worktree, and HarnessDesk's
  own worktrees of the project, and the main checkout is none of those: it is not
  a checkout HarnessDesk cut, so the list the menu is drawn from never held it.
  From a worktree that left the one move this control exists to offer — worktree
  to main checkout — as the one it could not make, short of opening the main
  checkout as the project first. It is a row of its own there now, under the same
  laptop the header gives it, and a draft pointed at it says so instead of wearing
  a worktree badge and a branch glyph. A place whose folder the app has proof is
  gone is greyed in that menu with the agent's own words rather than quietly
  dropped, and a send is refused there as it already was for the open folder.
- **A conversation whose folder is gone is a state now, not a toast per open** —
  opening one (every conversation that ran in a worktree that has since been
  deleted) painted its transcript and then threw an error toast, which stayed
  until its × was pressed. Four such conversations were four toasts, three of
  them word-for-word identical because a review room's three members had shared
  one worktree, and the sentence arrived with the agent introduced twice:
  "Cursor could not reopen this conversation: Cursor cannot open this
  conversation: …". Now the refusal is named on the wire, so the app can tell it
  from every other reason a conversation will not reopen: the pane says the
  folder is gone and the transcript is read-only, where the composer would be
  and in the agent's own words; the sidebar row wears a mark, so a folder that
  took several conversations only has to be discovered once; and the way
  forward — **Open a copy in another folder** — carries the conversation over
  as a hand-off packet, the same verb a worktree brought home uses, and starts
  the copy in a folder that still exists. A hand-off carries its source's
  folder by default, which here is the deleted one, so the button had been
  promising *another* folder and handing back the same one. No toast
  for this case at all. Every other reopen failure still toasts as it did.
- **The "Default" chip says the same thing wherever you find it** — the agent
  marked as the one new sessions run as read "needs sign-in" in the agent list
  and green on its own page and its account's page, because the list asked
  whether a turn would start and the two pages only asked whether the agent had
  crashed. A default that is signed out, or whose plan window is spent, now says
  so on all three.
- **A seat in the sidebar menu offers Usage, like the seat below it** — the card
  on the badge at the end of the seat row opened the dashboard scoped to that
  account; the cards on the seats inside the menu, for the same accounts, had no
  such verb. They do now.
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
- **Devin joins the agents the desk installs, runs and signs in** — Cognition's
  Devin CLI speaks ACP directly, so it needs no bridge. It has a row in the
  install table with its own install and update commands, the desk recognises a
  copy it installed under `~/.devin/bin` as its own rather than as some binary
  found on PATH, `devin auth login` opens the browser sign-in from the account
  menu, and that menu reads who it is signed in as from Devin's own credentials
  file.
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
- **A registry agent whose download nothing can check says so before you install
  it** — an entry in the ACP registry that ships a binary carries a checksum for
  it, and some publish none. Those wear an **Unverified** badge in Settings →
  Agents and in the sign-in list, saying in as many words that the registry
  publishes no checksum for this build, rather than installing as quietly as the
  ones that can be verified.
- **A diagnostics bundle no longer carries the secrets it was collected to
  explain** — Settings → Diagnostics gathers logs to send somebody, and a
  credential in one of them went along: an `Authorization: Bearer` header, a
  fine-grained or underscore-prefixed GitHub token, a secret spread over several
  lines of a JSON field, the password inside an `scp`-style git remote or a
  package specifier, and the staging folder a plugin's credentialed URL had been
  named after. Each is redacted now, and the folder is named after the package
  rather than the URL that fetched it.
- **The desk's own writes stop where the path leads, not where it points** — the
  ACP registry cache, the agent registry, the shell PATH cache and the library
  manifest each wrote to a file by name, so a symbolic link left in its place
  sent the write somewhere else entirely. Each resolves the real destination
  first and refuses one that leaves the folder it was given. The same question is
  now asked of a skill bundle's files, of an account's home under the managed
  accounts folder, and of a session id on its way into a filename.
- **A file on disk that has gone wrong no longer stops the desk opening** — the
  workspace list, a room's cards, saved credentials, model routes, the permission
  policy, a stored flow run, the library manifest and a conversation transcript
  were each read back trusting their shape. A truncated write or a hand-edit —
  `null` where a list belonged, a record that is not a record — threw where
  nothing was watching. Every one of them is checked as it loads now: what is
  well-formed is kept, what is not is dropped, and the desk starts.
- **Pressing a thing twice does it once** — Commit in the commit dialog, a branch
  in the branch switcher and a session being resumed each started a second copy
  of the work while the first was still running, and a prompt sent to Cursor
  before its previous turn had begun could interleave the two through one shared
  config directory. Each is held until the first finishes, and every Cursor
  session now has a config directory of its own.

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
