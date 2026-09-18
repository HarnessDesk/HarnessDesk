# Agents and Goals: the roadmap

*2026-09-17. The phases that build
[the design](../specs/2026-09-17-agents-and-goals-design.md), and for each one
the configuration it adds, the settings that change it, and the interface that
shows it. Phase 1 has a task-by-task plan of its own,
[agents-foundation](2026-09-17-agents-foundation.md); every later phase gets
one, written from its section here when it starts. Where this document and the
spec disagree, the spec is right and this is a bug.*

## How to read it

- **Numbered in the order recommended; the Needs line is the real
  constraint.** Phase 4 needs only phase 1, so it can go before 2 and 3;
  provenance can run beside flows, findings and intake; 11 and 12 need only
  what their lines name.
- **Every phase ships something a person can reach.** Its configuration, the
  settings that change it, and a surface that shows its noun truthfully are
  part of the phase, not a later one — the roster lands with the Agent, the
  evidence chip with the ledger, the Goal row with the Goal. `docs/` describes
  what ships, and a noun nobody can see can be neither documented nor checked
  by the person it is for. `script/check-reachable.mjs` may pin a new verb as
  unreached while its phase is being built, never after the phase lands.
- **The front door is different in kind.** Phases 2–9 show each noun and let a
  person use it; phase 10 is where the common shapes become startable without
  writing a file. Composing the nouns is what gets rewritten when one of them
  moves, so it waits until the last of them has landed.

Each phase lists what it **builds**; the **configuration** it adds, where each
file lives and who writes it; what changes in **Settings** and on a project's
own page; the **interface** a person sees and uses; the scenario in the running
app that means it is **done**; and what it **needs**.

## At a glance

| # | Phase | Configuration | Settings | Interface | Needs |
| --- | --- | --- | --- | --- | --- |
| 1 | **Agents foundation** — [#770](https://github.com/HarnessDesk/HarnessDesk/pull/770) | `AGENT.md` in a project and in `~/.harnessdesk/agents/` | — | — (the verbs are pinned unreached) | — |
| 2 | **Agents in the app** | Agents that ship with the app; `seating.json` | **Agents** (new: the roster); **Runtimes** (today's Agents page); a page per project | Start as an Agent; the refusal sheet; Save as Agent; Agents in a room | 1 |
| 3 | **Ceilings that hold** | `read · edit · publish · merge` | Permissions › Ceilings; what to do when one cannot be held | *held* or *asked* on every seat; refusals as sentences | 2 |
| 4 | **The evidence ledger** | `checks.yml` | A project's checks; Backup carries the records | Evidence on cards, stale drawn; columns from facts; the Seat record | 1 |
| 5 | **Goal** | Lanes | Workspaces › Lanes; Goal notifications | Goals in the sidebar; starting one; wrap and its receipt | 4 |
| 6 | **Flows on the new nouns** | `uses`, `grant`, `evidence:`; the flow migration | A project's flows | A dry run by Agent, seat and ceiling; *Update…* with the diff | 3, 4, 5 |
| 7 | **The findings ledger** | `budget.rounds`, `without-progress`; posting to the pull request | — | Findings in the Goal; the repair delta; the embargo; the person at the ceiling | 6 |
| 8 | **Intake** | `triggers.yml`; arming per machine | A project's triggers; pause and cap; skipped-trigger notices | Goals that opened themselves; named stop reasons | 3, 5, 6, 7 |
| 9 | **Provenance** | Capture, per project | A project's provenance | The Seat on a commit; ambiguity shown | 4 |
| 10 | **The front door** | Writes the same files | The Agent page becomes an editor; *New Agent* | Start with a team; *Review with…*; the flow it wrote; the first run | 2–8 |
| 11 | **Insight** | — | — | What a Goal cost, by Agent, seat, load and delegation | 4, 5 |
| 12 | **Shared memory, skills and MCP** | `mcp:`; `NOTES.md`; `.harnessdesk/memory/` | The Library by Agent; an Agent's skills and servers | What an Agent carries, and what did not load | 2 |

## Where configuration lives

| Where | What it says | Committed | Written by | Phase |
| --- | --- | --- | --- | --- |
| `.harnessdesk/agents/<id>/AGENT.md` | A project's Agent: brief, ceiling, seats | Yes | A person; the Agent page from 10 | 1 |
| `~/.harnessdesk/agents/<id>/AGENT.md` | Your Agents, on this machine | No | A person; *Save as an Agent* (2); the Agent page (10) | 1 |
| Inside the app | The Agents that ship with it | — | Us, reviewed like code | 2 |
| `~/.harnessdesk/seating.json` | Which seats an Agent takes on this machine | No | The Agent page's *On this Mac* | 2 |
| `.harnessdesk/checks.yml` | Commands the desk may run to earn evidence | Yes | A person | 4 |
| `.harnessdesk/flows/<name>.yml` | Rounds, and the rules between them | Yes | A person; *Save to project* (10) | Exists; reshaped in 6 |
| `.harnessdesk/triggers.yml` | What opens a Goal by itself | Yes | A person; *Every time…* (10) | 8 |
| `NOTES.md` beside an `AGENT.md` | What one Agent keeps for itself | As its folder is | That Agent | 12 |
| `.harnessdesk/memory/` | What several Agents share | Yes | Agents and people, cited by revision | 12 |
| `~/.harnessdesk/state.json`, `preferences` | This machine's choices: unheld ceilings, lanes, commands seen, armed triggers, capture | No | Settings | 3, 4, 5, 8, 9 |
| Evidence and Seat records, under `~/.harnessdesk/` | What the desk observed | No | The desk, only | 4 |
| `~/.harnessdesk/agents.json` | The ACP registry of runtimes | No | Settings › Runtimes | Unchanged |

Three rules every row follows:

- **Committed is shared; machine-local is yours.** A repository can declare an
  Agent, a flow, a check or a trigger. It cannot choose the model your account
  runs, run its commands before you have seen them, or arm its triggers — each
  of those is a machine-local act by a person.
- **One fact, one file.** No credential and no transcript is copied into any of
  these; each already has a plane, and two planes holding one fact will
  disagree.
- **A file that fails to parse is listed, not hidden.** Its row says what is
  wrong and where, the way the roster already lists a shadowed Agent.

## Settings, when every phase has landed

The window keeps its groups. The roster is new, today's Agents page becomes
Runtimes, six more pages each gain a section, and each project gains a page of
its own.

| Group | Page | What changes | Phase |
| --- | --- | --- | --- |
| Agents | **Agents** | New: the roster of who — this project's, yours, built in — and a page per Agent | 2; an editor in 10; skills and servers in 12 |
| Agents | **Runtimes** | Today's Agents page, renamed: installed CLIs, accounts, sign-in, the registry | 2 |
| Agents | Models | Presets stay a runtime's controls under a name; the save dialog stops suggesting a role | 2 |
| Access | Permissions | **Ceilings**: what each runtime can hold, and what to do when it cannot — watched, and in a Goal a trigger opened | 3, 8 |
| General | General › Backup | Carries your Agents, `seating.json`, evidence and Seat records | 2, 4 |
| General | Notifications | *A Goal needs you*, *ready to wrap*, *a trigger was skipped* | 5, 8 |
| Conversations | Workspaces | **Lanes**; **Triggers on this Mac** — pause them all, and a daily cap | 5, 8 |
| Conversations | Workspaces › a project | New: its Agents, checks, flows, triggers and provenance, each beside the file it comes from | 2, then 4, 6, 8, 9 |
| Capabilities | Library | Which Agents carry each skill and server | 12 |

Two things about the renames are easy to get wrong:

- **The route id `agents` is reused.** It names the roster from phase 2, so
  every caller that means the installed CLIs — the sign-in banners, the
  composer's menus, ⌘K — moves to `runtimes` in the same change. `MOVED` in
  `Settings.tsx` cannot cover an id that still exists, so a test asserts that
  nothing opens the roster to ask for a sign-in.
- **Presets are not Agents.** A preset is one runtime's session controls under a
  name; an Agent is a who that can sit on any runtime. Both stay. The only
  change to presets is that their save dialog stops offering *Careful reviewer*
  as its example, because that is now an Agent's name.

Usage keeps its own window; phase 11 adds views to it rather than a settings
page.

## Rules every surface follows

1. **A refusal is a list with a fix on every line.** Every candidate, the reason
   it failed, and the action that removes the reason — *Sign in to Cursor*,
   *Install Codex*, *Add a seat for this Mac*. A refusal a person cannot act on
   is a dead end with better manners.
2. **Stale is drawn, unknown is not zero, asked is not held.** One visual
   vocabulary for the three, added to the design system the first time each
   appears — *asked* in 3, *stale* in 4, *unknown* wherever a runtime cannot
   report — and reused everywhere after.
3. **Greyed, never withdrawn.** An Agent that cannot be seated here stays in
   every menu that lists Agents, greyed, with its reason.
4. **Sentences, not wire.** No verb names (`agent/seat`), no seat specs as
   labels (`claude=opus-5/high` reads *Claude · Opus 5 · High*), no digests (a
   brief that moved on says *changed since*). The runtime's brand mark stays the
   runtime's; an Agent is its name.
5. **The file is the truth, and the surface says which file.** A row that reads
   a file carries its path; a surface that writes a committed file leaves an
   ordinary change in the git pane, never a silent one.
6. **Verified from a rig, never from a desk.** Each phase is run in the real
   renderer on an isolated home with fake runtimes, gets a fixture in the
   preview harness (`packages/ui/preview.html`), and every frame shown anywhere
   comes from that rig.

## The phases

### 1. Agents foundation — built, in review as [#770](https://github.com/HarnessDesk/HarnessDesk/pull/770)

**Builds.** An Agent is a directory holding an `AGENT.md`. The roster finds
them project → user → built-in and lists what it shadowed; `agent/seat` opens a
conversation as one, reads back what the runtime actually runs, and when nothing
fits refuses with every candidate's reason. The ACP registry verbs moved to
`acp/*` to free `agent/*`.

**Configuration.** `.harnessdesk/agents/<id>/AGENT.md` and
`~/.harnessdesk/agents/<id>/AGENT.md`: front matter `name`, `description`,
`permission`, `answers`, `produces`, `skills` and `prefer`, and the brief as the
body. The built-in root exists and is empty.

**Settings and interface.** None. `agent/list`, `agent/read` and `agent/seat`
are pinned as unreached until phase 2 gives them a caller.

### 2. Agents in the app

**Builds.**

- The roster as a Settings page, a page per Agent, and a page per project.
- Agents that ship with the app: `code-reviewer`, `security-reviewer`,
  `performance-reviewer`, `api-reviewer`, `test-reviewer`, `implementer`,
  `judge`, `researcher` and `requirements-analyst` — enough for every one of the
  spec's eight shapes to start without writing an Agent. A worked flow that
  needs a specialist, such as a game player or an integrator, defines it in its
  project. Each brief is reviewed like code, and each has a test that it parses
  with no problems and seats on the fake runtimes.
- This machine's seating override, `seating.json`, at the place in the
  precedence the spec gives it.
- A dry run of `agent/seat`: which candidate would win here and why the others
  would not, opening nothing. Every menu that lists Agents is drawn from it.
- The roster re-reads when a file under any of its three roots changes.
- The two fixes owed before any surface: a passed-over candidate leaves no
  conversation behind; and the reads a seating makes before it chooses have a
  deadline, so a runtime that never answers is passed over with that reason
  instead of hanging every seating.

**Configuration.**

- `~/.harnessdesk/seating.json`: Agent id → ordered seat specs, replacing that
  Agent's `prefer` on this machine. Validated on the way in; an entry that
  fails is shown on its Agent's page, never dropped silently.
- The shipped Agents name runtimes, not models (`prefer: [claude, codex,
  cursor]`).

**Settings.**

- **Agents** (new). Titled *Agents*, with the blurb *Who does the work: a brief,
  the most it may do, and the seats it prefers.* Three sections — *In
  <project>* (the active conversation's project, by name), *Yours* and *Built
  in* — each footnoted with the folder it reads. A row is the Agent's name and
  description, with its ceiling and the seat it would take here at the right, or
  *Can't seat here* and the first reason. A shadowed row is muted and says what
  shadows it; a file that failed to parse is a row whose note says why. The nav
  row counts the Agents in force and carries a dot only when one fails to
  parse.
- **An Agent's page** — a drill, not a dialog. The file it comes from, with
  *Open file* and *Reveal*; **Ceiling**; **Seats**, the `prefer` list, each
  candidate with its state on this Mac and the fix for any that fails; **On
  this Mac**, the override, added to, reordered or cleared here and footnoted
  `seating.json`; **Answers**, **Produces** and **Skills**, read-only for now,
  with Skills linking to the Library; **Brief**, its first paragraph and *Open
  in editor*. Its actions: *Start a conversation as <name>*; *Customize…* on a
  built-in or user Agent, which copies it to the project or to you, where the
  copy shadows the original; *Remove…* on a project or user Agent, to the
  Trash.
- **Runtimes** — today's Agents page (`AgentsSection` in `SettingsAgents.tsx`),
  renamed, with *Add a runtime* for what the ACP registry calls a custom agent.
- **Workspaces › a project** (new). The sidebar's project menu opens it, and so
  does each repository row on Workspaces. It starts with the project's own
  Agents; later phases add its checks, flows, triggers and provenance.
- Models › Presets: only the example in the save dialog changes.

**Interface.**

- **Starting as an Agent.** The new-session dialog's *one agent* choice
  (`NewSessionChoice.tsx`) lists Agents above runtimes, each with the runtime
  mark it would sit on here. ⌘K gains *Start as <Agent>* and *Open <Agent> in
  Settings*. ⌘N is unchanged, because a shortcut is for what is already decided.
- **A conversation seated as an Agent** leads its pane header and its sidebar
  row with the Agent's name, and the composer shows the seat actually taken, as
  read back. Its name card (`AgentCards.tsx`) adds the description, the ceiling,
  where the Agent came from, the seat and the candidates passed over, and *The
  brief has changed since this started* once the file has moved on.
- **The refusal sheet.** Nothing is opened. It lists every candidate, its reason
  and its fix, with *Edit seats for this Mac* beneath.
- **Save as an Agent.** A conversation's menu offers *Save as an Agent…*: a
  name, a description and a ceiling, with the seat the conversation is on as
  the first `prefer` entry. It writes to you or to the project, then opens the
  brief in the editor.
- **Rooms.** The roster's **+** (`AddMember.tsx`) seats an Agent first and a bare
  runtime second; a member seated as an Agent goes by its name on the rail and
  on its cards.
- Until phase 3 lands, every ceiling on these surfaces is labelled *asked*,
  because that is what it is.

**Done when.** On a fresh home with fake runtimes, Settings › Agents lists the
shipped Agents and a project Agent shadowing one of them; *Start as Code
reviewer* opens a conversation headed *Code reviewer*; with one runtime signed
out, its candidate shows as passed over with *Sign in*; and when no runtime can
seat an Agent, the sheet lists every candidate and nothing has opened.

**Needs.** 1.

### 3. Ceilings that hold

**Builds.**

- The ladder `read < edit < publish < merge`. `read` changes nothing; `edit` is
  today's `read` — write and commit in its own checkout, never push.
- Each ceiling mapped onto what each runtime enforces, negotiated per
  capability: a sandbox and an approval policy where a runtime has them, a
  permission mode and deny rules where it has those. Where a runtime has
  neither, the seat is *asked*, and says so.
- The desk's own tools refuse beyond a seat's ceiling — the forge's
  pull-request tools first, because the desk owns them outright. The refusal
  holds for a runtime's delegated children too, because they reach the same
  tools; it is the one place a ceiling survives delegation without the runtime's
  help.
- The standing order's permission paragraph shrinks to one line of role
  guidance.
- Each seat's effective ceiling, and whether it is held, recorded beside its
  Agent and brief — in memory until phase 4 makes the record durable.

**Configuration.**

- `permission` in `AGENT.md` and in flow files accepts the four words. A flow
  file's `read` keeps its old meaning — it is read as `edit`, and its dry run
  says so — until phase 6 rewrites it.
- A machine preference for when a runtime cannot hold a ceiling: seat it and
  say so, or refuse. It has two values because it has two situations: a
  conversation someone is watching defaults to the first, and a Goal a trigger
  opened — phase 8 adds that value — to the second.

**Settings.**

- Permissions gains **Ceilings**: the four ceilings against each installed
  runtime, each cell *Held* or *Asked*, and on hover how — *read-only sandbox*,
  *deny rule on push*. Under it, one row: *If a runtime cannot hold a ceiling* —
  *Seat it and say so* or *Refuse to seat it*, each with its hint. Phase 8 adds
  the same row for Goals a trigger opened, set to refuse.
- The page's *Approvals* and *Rules* stay, and its blurb says which layer
  answers what.

**Interface.**

- Every seat carries its effective ceiling as a badge — *Read · held*, *Edit ·
  asked* — on the pane header, the name card, a room's rail, a card's holder and
  the flow dry run. *Asked* takes the warning tone.
- A refused action reads as a sentence in the transcript — *Merge refused: this
  seat may publish, not merge* — never as a raw tool error.
- The roster marks an Agent whose ceiling the seat it would take here cannot
  hold.

**Done when.** A `read` Agent on a runtime with a read-only sandbox tries to
write and is visibly stopped by the runtime; a `publish` seat that asks the desk
to merge is refused by the desk; and on a runtime with no enforcement, the same
Agent shows *asked* everywhere it appears.

**Needs.** 2. It must land before 8 and 10, because a Goal nobody is watching
and a team started in two clicks both need ceilings that hold.

### 4. The evidence ledger

**Builds.**

- The `Evidence` type and its store, staleness at a revision, and the
  producers: check, diff, pr, ci.
- The immutable Seat record — Agent, brief hash, seat, effective ceiling,
  checkout, session pointer, opened, closed — replacing the in-memory copy
  phases 1–3 kept.
- Board columns derived from facts — working, needs you, in review, ready —
  rather than dragged.
- The code calls the store `evidence`, never `ledger`:
  `packages/server/src/ledger/` is already the usage ledger.

**Configuration.**

- `.harnessdesk/checks.yml`: named commands the desk may run to earn `check`
  evidence outside a flow.
- A command a repository names runs only after a person has seen it on this
  machine, and a changed command asks again. The commands seen are a machine
  preference.
- The records live under `~/.harnessdesk/`, one store per project, append-only,
  and never in the repository.

**Settings.**

- A project's page lists its checks, each with its command verbatim and whether
  this machine has seen it.
- General › Backup carries evidence and Seat records.

**Interface.**

- A card carries its evidence as chips — *verify ✓ @a1b2c3*, *CI ✓*, *PR #12
  open*, *+120 −30 in 6 files*. A stale chip says how far behind it is — *2
  commits since* — and is never green. A chip opens what was observed, when, at
  which revision and by which Seat.
- A card offers *Run <check>* for each named check; the first run of a command
  this machine has not seen shows it verbatim and asks.
- A drag into a column the facts contradict is refused on the column while the
  card is in the air, naming the fact.
- A conversation's details (`Details.tsx`) show its Seat record, read-only,
  because it is.

**Done when.** A card's *verify ✓* goes stale when a commit lands on its branch
and fresh again when the check re-runs; and a closed conversation's Seat record
is still there after a restart.

**Needs.** 1. It records whatever 2 and 3 know, if they have landed.

### 5. Goal

**Builds.**

- Room and `Plan` merged into a Goal that finishes: membership derived from
  Seats, wrap and its receipt, and `dependsOn` between Goals.
- Lanes: a Seat that asks for isolation gets a checkout, a block of ports and a
  browser profile of its own.
- The migration of existing rooms.

**Configuration.**

- Goals are the desk's state, as rooms are; nothing is committed.
- Lanes: where port blocks start and how wide each is are machine preferences.
  A lane's Seat receives its block through environment variables, and its own
  profile in the browser pane.
- The migration: each room becomes a Goal with the same id, board, channel and
  members, each member a Seat with no Agent, and the room's plan sentence the
  Goal's. A room that never ended becomes an open Goal, which phase 10 can turn
  into a trigger.

**Settings.**

- Workspaces gains **Lanes**: where port blocks start, how wide each is, and
  whether each lane gets a browser profile of its own.
- Notifications gains *A Goal needs you* and *A Goal is ready to wrap*.

**Interface.**

- **The sidebar.** Under each project, Goals replace rooms. A Goal's row is its
  sentence and its state — *needs you*, *working*, *ready to wrap* — and it
  expands to its Seats. Wrapped Goals fold into *Wrapped · N* at the end of the
  project.
- **Starting one.** The new-session dialog's *A room* becomes *A Goal*. The
  sentence is the one required field — *What finishes this?* — then, if wanted,
  a flow (`FlowStart.tsx`) and Agents to seat.
- **The Goal's pane** keeps Board, Chat and Members. Its header carries the
  sentence, the state, *Waiting on …* for each unfinished Goal it depends on,
  and *Wrap…*.
- **Wrap** shows the receipt before committing to it: what finished; what is
  still open, each item finished or dropped with a reason; the evidence; what
  each Seat answered. A wrapped Goal is read-only and keeps its receipt.
- **Members.** *Take out of the room* becomes *Release*: the conversation
  returns to the project, and its Seat record stays. Adopting a loose
  conversation becomes handing it a card — *Give this to…* on a card lists the
  project's loose conversations — because the spec has no verb for putting a
  conversation into a Goal: the assignment opens its Seat, and the Seat is what
  makes it a member.
- **Once, after the migration,** a notice says rooms are Goals now and what that
  changes.

**Done when.** A room made before the upgrade opens as a Goal with its board,
chat and members intact; a Goal wraps into a receipt and leaves the project's
open list; and two isolated Seats run the same dev server at once, on different
ports.

**Needs.** 4.

### 6. Flows on the new nouns

**Builds.**

- `uses` (one Agent, or a list with one card each), `grant`, evidence guards and
  one level of evidence templating; `seats` narrowed to seating only; `isolate`
  asks for a lane.
- `/race` restated as one Agent on two seats.
- The migration of committed flow files.

**Configuration.**

- A role keeps `uses`, `count`, `seats`, `isolate` and `grant`, and `kind` for
  `check` and `person`. A rule's `when` gains `evidence:`, and its templates
  gain `{{evidence.<kind>.<field>}}`.
- The migration: each old agent role — `seat`, `order`, `permission`,
  `outcomes` — becomes an Agent written beside the flow, at
  `.harnessdesk/agents/<flow>-<role>/AGENT.md`, with the order as its brief, the
  permission as its ceiling, the outcomes as its answers and the seats as its
  `prefer`. The role then `uses` it, with `grant` set to that permission, and a
  `read` becomes `edit`, which is what it always meant. A role that listed
  several seats keeps them as its round's `seats`, one card each, because that
  was a race rather than a preference.
- The old shape keeps running, marked, until a person updates it. Nothing
  rewrites a committed file without the person seeing the diff first.

**Settings.** A project's page lists its flows, marking any in the old shape.

**Interface.**

- **The dry run** (`FlowStart.tsx`) shows, round by round, the Agents it seats,
  the seat each would take here and the candidates passed over, and each seat's
  ceiling as held or asked; and, rule by rule, the evidence that must hold. A
  guard that reads only answers is marked *unevidenced*; a merge step without
  evidence is an error, not a warning.
- **An old flow** opens with *This flow uses the old format* and *Update…*,
  which shows the whole diff — the flow and every Agent file it would create —
  and writes it only when asked. The git pane then shows the change.
- `/race` asks for an Agent and two seats.

**Done when.** UC2 runs from its file: two isolated competitors, a judge, and a
merge card naming the winner's revision.

**Needs.** 3, 4, 5.

### 7. The findings ledger

**Builds.**

- Findings with ids the host assigns; the repair delta; a blocking set that only
  shrinks; rounds that are bounded and end at a person.
- The round as the unit of publication: a round's findings reach the pull
  request, and each other, when the round closes.
- Where each finding was posted, so a reply threads under it.

**Configuration.**

- On a flow: `budget.rounds` and `budget.without-progress`, the two keys of the
  spec's budget that bound a loop. Phase 8 adds its money and time keys and
  puts a budget on a trigger.
- On a Goal with a pull request: whether findings are posted to it — on by
  default.

**Settings.** None.

**Interface.**

- **Findings** joins Board, Chat and Members in the Goal's rail: each finding's
  id, whether it blocks, its state — open, repaired, withdrawn — the revision it
  was raised at, its round and where it was posted, filterable to open or
  blocking.
- From round 2, a reviewer's card leads with the repair delta: which findings
  the fix claims to close, and which are still open.
- While a blind round runs, the Goal says *2 of 3 reviewers finished —
  published when the round closes*, and nothing reaches the pull request or a
  sibling before then.
- At the ceiling, a card for the person — *Round 3 ended with 2 open findings* —
  offering *Another round*, *Merge anyway* (recorded as an override) and
  *Drop*. A finding repaired twice and still open says *this is a design
  problem, not a patch problem*.
- A wrapped Goal's receipt carries its findings ledger.

**Done when.** UC3, by hand on a local branch: three blind reviews published
together; a fix; a second round that reads only the delta and the open
findings; and a merge card once the blocking set is empty.

**Needs.** 6.

### 8. Intake

**Builds.**

- Triggers on the Project: `pull-request` first, then `issue` and `schedule`, all
  one shape. The desk watches the forge itself, polling as the person signed in
  rather than waiting on a listener.
- The dedupe key, concurrency, the budget and named stop reasons.

**Configuration.**

- `.harnessdesk/triggers.yml`, as the spec gives it: an `id` per trigger, and
  `forks: never` unless it says otherwise.
- `budget:` on a trigger — `usd`, `rounds`, `hours`, `without-progress` — bounds
  each Goal it opens.
- Arming is per machine. A trigger does nothing on a machine until a person arms
  it there, and one whose text has changed waits to be armed again. What is
  armed is a machine preference.
- A machine-wide pause, and a daily cap across every trigger.
- Seats in a Goal a trigger opened follow the second value of phase 3's
  setting, which refuses a ceiling that cannot be held unless a person changes
  it.

**Settings.**

- A project's page gains **Triggers**. Each reads as a sentence — *When a pull
  request opens or is pushed, open review-pr, at most 4 at once* — with its arm
  switch, its budget, its fork rule, and what it last did: fired, or skipped and
  why.
- Workspaces gains **Triggers on this Mac**: *Pause every trigger*, and *Stop
  for the day after* a sum.
- Notifications gains *A trigger was skipped* — over budget, at its limit, a
  fork, not armed.
- Permissions gains the second *If a runtime cannot hold a ceiling* row, for
  Goals a trigger opened, set to *Refuse to seat it*.

**Interface.**

- A Goal a trigger opened says so on its row and in its header — *from PR #123*
  — and names why it stopped: *answered*, *crashed*, *timed out*, *lease
  expired*, *cancelled*, *out of budget*.
- A skipped firing is a line under its trigger, not a silent gap.

**Done when.** UC3 unattended, on a test repository: a new pull request opens
one Goal, and a force-push does not open a second; three blind reviews publish
together as one pull-request review; and a budget stop is named on the Goal.

**Needs.** 3, 5, 6, 7.

### 9. Provenance

**Builds.** The ref observer, independent of turns; patch-id reconciliation
through amend, rebase and squash; capture health per project.

**Configuration.** Capture on or off per project, a machine preference, on by
default for a project with Goals.

**Settings.** A project's page gains **Provenance**: *healthy*, *degraded* or
*stopped*, with the reason and the next step.

**Interface.**

- In the history pane (`GitPane.tsx`, `GitGraph.tsx`), an attributed commit
  carries its Seat — the Agent's name beside the runtime's mark — and opens the
  Seat record and its session. A squash lists every Seat whose patches it
  contains; a link that cannot be decided reads *unattributed*, and says why.
- A project whose capture has stopped says so on its sidebar row.

**Done when.** A commit a Seat made, then amended and squash-merged, still
resolves to that Seat and its session.

**Needs.** 4. It can run beside 6, 7 and 8.

### 10. The front door

**Builds.**

- The common shapes, startable without writing a file, and the file they wrote
  shown afterwards.
- A first run with nothing to configure.
- The Agent page, turned into an editor.
- The canvas: rounds as nodes and rules as edges, with positions kept in the
  flow file's reserved `layout:` key. It is big enough to be a plan of its own,
  and it belongs here because it edits what the shapes start.

**Configuration.** Nothing new: every surface here writes files that phases 1–8
defined. A shape runs from text; *Save to project* writes
`.harnessdesk/flows/<name>.yml`, and any Agent it created, as an ordinary change
in the git pane. *Every time…* writes `triggers.yml` the same way.

**Settings.** The Agent page edits in place. Each row changes one key and
rewrites only that line, so comments and the brief survive; the brief opens in
the editor beside it. *New Agent* starts from a shipped Agent or from nothing.

**Interface.**

- **Start with a team**, in the new-session dialog and in ⌘K: the shapes as
  choices — *Fan out*, *Review*, *Compare*, *Relay*, *Investigate*, *Align* —
  and *Every time…*, which makes any of them a trigger. Each asks only what it
  needs. *Review* asks which Agents (the three reviewers are preselected), what
  to review (this branch, a pull request, a diff) and whether they are blind;
  then comes the dry run, then *Start*. Three reviewers on this branch is two
  clicks.
- **From where the work is.** The history pane's branch and a pull request both
  offer *Review with…*, and an empty Goal board offers the shapes.
- **After starting,** *The flow this wrote* shows its YAML, with *Save to
  project*.
- **The first run.** Once a runtime is ready (`SetupDesk.tsx`), the empty window
  offers the shapes, using the shipped Agents.

**Done when.** From a fresh install with one runtime signed in, a person gets
three blind reviews of a branch without opening a file, then saves the flow that
did it and sees it in the git pane.

**Needs.** 2 to 8.

### 11. Insight

**Builds.** What a Goal cost, broken down by Agent, by seat, by what was loaded
and by delegation. What the desk cannot attribute is shown as unattributed,
never spread.

**Configuration.** None.

**Settings.** None; the Usage window gains views instead.

**Interface.**

- The receipt gains **Cost**: by Agent, by seat, by the skills and servers
  loaded and by delegation, with *unattributed* as a slice of its own.
- The Usage window gains *By Goal* and *By Agent*, and a comparison: two Agents,
  or two seats of one Agent, on the same kind of Goal.
- An Agent's page shows what each of its seats has cost it on this machine.
  *Order by cost* rewrites the machine's override, never the committed `prefer`.

**Done when.** UC2's receipt shows each competitor's tokens beside its diff, and
the loser's seat can be moved down this machine's order from the Agent's page.

**Needs.** 4, 5.

### 12. Shared memory, skills and MCP

**Builds.** Per-Agent allowlists driving each runtime's own loading, negotiated
per capability; an Agent's own notes; and knowledge the Project shares, cited by
revision.

**Configuration.** `skills:` in `AGENT.md` (it exists already) and `mcp:` (new);
an Agent's own `skills/` folder and `NOTES.md` beside its `AGENT.md`, as the spec
allows; `.harnessdesk/memory/` in the Project.

**Settings.**

- The Library gains an Agent filter: which Agents carry each skill and server,
  and which runtimes can honour it.
- On an Agent's page, **Skills** and **Servers** become editable allowlists, and
  **Notes** can be read and cleared.

**Interface.** A seated conversation's name card lists what its Agent carries
and what its runtime could not load — *declared, not loaded on <runtime>* —
never a silent omission.

**Done when.** A reviewer Agent carrying one skill has it on two runtimes that
can load it and shows it as not loaded on one that cannot; and a fact one Goal
wrote to the project's memory is cited by revision in the next.

**Needs.** 2. It is best after 11, which measures what carrying each skill and
server costs.

## When each use case first runs

| Use case | From a file | Unattended | Without a file |
| --- | --- | --- | --- |
| UC1 — research, debate, requirement, build, test, acceptance | 6; converges from 7 | 8 (`schedule`) | 10 |
| UC2 — two competitors and a judge | 6; feedback ids from 7 | — | 10 |
| UC3 — every pull request, three blind reviewers | 7, on a branch | 8; an @mention needs the cloud lane | 10 |
| UC4 — issues, five implementers, three reviewers, a loop | 7 | 8 (`issue`) | 10 |
| UC5 — two developers who agree the split first | 6 | — | 10 |
| UC6 — one agent builds a game, two play it | 6 | — | 10 |
| UC7 — two agents compete in a web game | 6 | — | 10 |

## Decisions this roadmap takes where the spec was silent

Each one that changes what the desk does is written into the spec as well.

- **This machine's override is `~/.harnessdesk/seating.json`**, and it replaces
  an Agent's `prefer` on that machine rather than merging with it. *(Spec:
  Seating.)*
- **Shipped Agents name runtimes, not models.** *(Spec: Seating.)*
- **`read` is split: `read` changes nothing, and `edit` takes today's
  meaning.** A flow file's `read` keeps its old meaning until phase 6 rewrites
  it. *(Spec: Permission.)*
- **What happens when a runtime cannot hold a ceiling is a machine setting**,
  and it refuses by default for a Goal nobody is watching. *(Spec: Permission.)*
- **Named checks live in `.harnessdesk/checks.yml`, and a command a repository
  names runs only after a person has seen it.** *(Spec: Evidence.)*
- **A trigger has an `id`, does nothing until it is armed on a machine, and
  never runs for a fork unless it says so.** *(Spec: Triggers.)*
- ***Binding* is now *trigger***, because the usage dashboard's *binding lane*
  already uses the word, and `docs/flows.md` already calls this ladder
  Triggers. *(Spec: throughout.)*
- **Each phase ships the surface that shows its noun; the front door is the
  phase that composes them.** *(Spec: The YAML in this document is the model.)*
- **The Settings route id `agents` is reused for the roster**, so the callers
  that meant the installed CLIs move to `runtimes` in the same change.
- **Presets and Agents both stay**: a preset is one runtime's controls, and an
  Agent is a who.

## Documentation each phase owes

`docs/` describes what ships. So no page below is touched before its phase
lands, and none is left behind after it does — a page that describes the
previous noun model is worse than no page, because a reader cannot tell which
parts still hold.

| Phase | Page | What changes |
| --- | --- | --- |
| 1 | `docs/agents.md` → `docs/runtimes.md`, `docs/README.md` | The installed CLI is a *runtime* throughout; ACP-facing mentions and `agents.json` keep the word *agent*. Done in #770 |
| 2 | New `docs/agents.md` | The Agent, reintroduced now that a person can reach it: the folder, the three layers, seating and this machine's override, the shipped Agents, starting as one |
| 2 | `docs/interface.md`, `docs/runtimes.md` | Settings › Agents, Settings › Runtimes and a project's page; starting as an Agent; *Save as an Agent* |
| 2 | `docs/multi-agent.md` | Seating an Agent in a room |
| 3 | `docs/flows.md`, `docs/agents.md` | The four ceilings, held and asked; what an old flow file's `read` means |
| 3 | `docs/agent-capabilities.md`, `docs/interface.md` | Which runtime holds which ceiling, and how; Permissions › Ceilings |
| 4 | `docs/interface.md`, `docs/multi-agent.md` | Evidence on cards, staleness, columns derived from facts, the Seat record |
| 4 | `docs/data-boundaries.md` | What the evidence store keeps and where; that a repository's commands wait to be seen |
| 5 | `docs/multi-agent.md`, `docs/interface.md`, `docs/README.md`, `docs/getting-started.md` | Room and `Plan` become Goal; membership derived; lanes; the receipt a wrap leaves |
| 6 | `docs/flows.md` | `uses`, `grant`, evidence guards, one level of evidence templating; `seats` narrowed to seating only; the migration |
| 6 | `docs/multi-agent.md` | `/race` restated as one Agent on two seats |
| 7 | `docs/flows.md` | The findings ledger, and how a review round converges |
| 8 | `docs/multi-agent.md`, `docs/data-boundaries.md`, `docs/flows.md` | Triggers, arming, the dedupe key, concurrency and budget; what a forge watch reads; which rungs of the Triggers ladder have landed |
| 9 | `docs/architecture.md`, `docs/decisions.md`, `docs/interface.md` | The ref observer, patch-id reconciliation, capture health; the Seat on a commit |
| 10 | `docs/interface.md`, `docs/getting-started.md` | Starting the common shapes without writing a file |
| 11 | `docs/usage-dashboard.md` | Cost by Goal, by Agent and by seat |
| 12 | `docs/agents.md`, `docs/agent-capabilities.md` | Skills and servers per Agent, what each runtime can load, notes and shared memory |

Two pages need no change at any phase, and the reason is worth stating so nobody
"tidies" them: `docs/multi-agent.md`'s delegation section and
`docs/context-usage.md`'s account of what a session delegated are already right.
The desk observes and measures a runtime's own subagents and does not execute
them, and this design does not alter that — it only says where a delegation sits
in the noun model, which is inside a Seat.
