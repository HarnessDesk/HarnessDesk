# Seeing and steering Teams, Flows and Runs: the Run view first

*2026-10-02. Approved by the owner the same day: decisions 1 to 9 as
recommended, and decision 10 as the owner made it (listed at the end). Nothing
here is built yet. It covers how the window shows and controls a Team's work: who is doing what, one
Run's history, and what a person can do about it. It shares one stream of
facts with the clients design for the command line and Mobile (#1271). The
problems it answers were found by running real work as Teams on a desk on the
same day (#1268). Measurements are from `main` at `5cc63f509`. The frames are
rendered from the real design system with placeholder data; every one has a
light and a dark version (see "The frames" at the end).*

## The goal

**A person can see what a Team's work is doing, and act on it, without opening
a chat and without a hand step.** Three claims anyone can check:

1. **One screen answers four questions.** Who is working, who is waiting for
   me, who is stuck, and what is costing the most. For one Team, and for every
   Team on the desk.
2. **A Run keeps its story, and an ended Run always offers a way on.** Its
   rounds, outcomes, checks, findings and cost stay readable after it ends. A
   retry or an edit starts a new attempt beside the old one; nothing earlier
   is rewritten.
3. **The window, the command line and a phone read the same facts.** There is
   one stream of events and one set of views derived from it. No client has a
   private view the others cannot show.

## In short

- **Two views and a blueprint, in this order.** A Team overview (a table of
  seats, by who needs attention first). A Run view (a timeline of rounds, with
  an inspector beside it). A read-only Flow view, reached from the Run, drawn
  to be looked at: cards, labelled edges, a loop that reads as a loop. Laying
  the Run's live state over it is the later step, and the same drawing is the
  picture of the product for the site.
- **The Run is the home of everything that happened.** Today a Run is a chip
  in a header. It becomes a place with a history, a brief, a link to the Flow
  as it was when the Run started, and a way on when it ends.
- **Controls come from the host, with the reason when one is missing.** Stop a
  run (#1247), run a check again (#1245), answer or abandon a card, approve,
  open the pull request. Each one is offered only where the seat, the runtime
  and the person's own settings allow it.
- **The window needs no stream of its own.** What it draws is the #1271 event
  stream and two small additions to it, derived by the same selectors the
  command line uses.
- **Three options are compared below. The recommendation is the first: the
  Run timeline first, the canvas later.** The owner's decisions are collected
  at the end.

## What we have today (measured)

- **A Team has a pane, a rail and a chip.** The pane's header carries the
  Team's sentence, one state chip (Running, Needs you, Stopped, Settled) and
  the project. The rail lists Board, Chat, Side by side, Findings and the
  seats. The chip says "Needs you" when a person step or a question waits, the
  Team's own activity says so, or the run is stalled; one rule, read by the
  header and the chat's live line alike (`TeamRoomPane.tsx`).
- **A Team's Agents list misses the Seats its Flow opened (#1278).** The rail's
  Agents list and the sidebar's nesting read the Team's older member list
  (`team.members`, answered by `teamPeers`), while a Flow's membership is the
  Goal's Seats. A Team whose Flow wrote and reviewed reads "Agents 0", and its
  two conversations sit loose under the project.
- **A finished Seat keeps its runtime's process running.** The host stops a
  runtime that has been idle, but counts an open Seat as work, and stopping
  also needs the adapter: `stopForIdle` is optional on `AgentRuntime`, only the
  ACP adapter implements it, and it refuses while it holds any session of its
  own. On the host's side: `#runtimeIsIdle`
  in `host.ts` is false while any Seat on the runtime is not closed, and also
  while any of its conversations holds a live handle. Nothing in the engine
  closes a Seat when its card is done. Wrapping the Team (`closeSeats`) and
  deleting a conversation close a Seat; closing a conversation (`session/close`)
  only lets go of its live handle and leaves the Seat open and a member. So a Team that wrote and reviewed
  keeps both agents' processes up until it is wrapped.
- **A seat's state is in the channel, not in a list.** The rail draws a light
  on a working seat, and the chat says "Alpha is working". Nothing puts the
  seats side by side with what each holds, how long, and what it costs.
- **A Run is a record with no view.** `FlowExecution` holds its state
  (`running`, `settled`, `stopped`, `stalled`), its rounds (role, cards, seats,
  evidence), the journal of what it did (`operations`), the reason it ended,
  a kept answer, its findings and its frozen Flow document. It holds no
  identity for that document, no brief, no link to an earlier Run, and nothing
  lists a Team's Runs (the clients design finds the same gap).
- **One run-specific control exists.** *Review and run again…* is offered when
  the desk stopped in the middle of a check (`FlowRunStatus.tsx`). Nothing
  stops a Run (`flow/stop` belongs to the earlier design and does not reach one, #1247), a finished check
  cannot run again (#1245), and abandoning a card fires the next rule.
- **The board resets with every round.** Its four columns (To do, Working,
  Needs you, In review) show the cards of the moment, so the story of a Run
  is not on it.
- **The Flow graph exists, as an editor.** `ShapeGraph` draws a Flow's roles
  and rules, with an accessible list of both, and lets a person move nodes.
  Nothing shows it beside a Run.

### What running real work found

Five Teams ran on one desk on 2026-10-02 (#1268). Each of these made someone
reach outside the window:

| What happened | What had to be done by hand | Issue |
| --- | --- | --- |
| A Run settled because the landing check answered `no-pr`, and no rule followed. The check could not be run again. | Landed by hand. | #1245 |
| A reviewer's review of a pull request the Team did not open was never posted. It existed only in the card's handoff text. | Posted the text by hand. | #1265, #1248 |
| Settled Runs stayed in the list until it hid the active ones. | A skip list in a script. | #1267 |
| There was no stream of changes: a Run started seconds earlier looked missing from a 45-second poll. | A polling watcher. | #1267 |
| A long brief had nowhere to go: the only input becomes the card's title. | An untracked file in the clone, and "read it" as the task. | #1267 |
| One Run could not be stopped, and abandoning a card started the next round. | Interrupt every seat, abandon every card. | #1247 |

## The model, in words

| Word | What it is | Today |
| --- | --- | --- |
| Team | The group around one piece of work: seats, a board, a channel. | Exists. |
| Flow | The blueprint: roles, rules, checks, steps for a person. A file; a Run holds a frozen copy. | Exists. |
| Revision | A Flow as it was when a Run started, named by a short digest of its content. Two Runs of the same text share one. | **New.** A Run records the document and no identity for it. |
| Run | One execution of a Flow on a Team. | Exists. |
| Round | The cards of one role, opened together. | Exists. |
| Card | One unit of work, addressed to a role. | Exists. |
| Seat | An agent holding a role on the Team. | Exists. |
| Check | A command a Flow runs and reads an outcome from. | Exists. |
| Attempt | What a retry or an edit makes: a new execution of a check, or a new Run, linked to what it continues. | **New.** |

Five principles hold the design together. Each one is here because a problem
above broke it:

1. **History is appended, never rewritten.** A check run again adds an
   attempt under the card. Running again after a stop starts a new Run that
   names the one it continues. The earlier outcome, output and cost stay as
   they were. (The #1245 run lost its answer's meaning when the card was
   reopened and nothing ran.)
2. **The host decides what is offered, and says why not.** Every control
   arrives as `{ available, why }`, computed fresh, the way a kept answer
   already arrives with `canContinue` and `refusal`. A window, a terminal and
   a phone then draw the same answer. The interface never branches on which
   runtime a seat is (rule 8); it reads the answer, and where the answer
   depends on a runtime it reads a named capability.
3. **One precedence for state.** *Needs you*, then *Unread*, then *Working*,
   then *Idle*. A seat, a Team and a Run all use it, so a person learns it
   once.
4. **A second line is earned** (rule 9). A state is a chip on the title's
   line. A row's second line carries only a fact that varies: what a seat is
   doing, why a Team waits, the reason a Run ended.
5. **One stream.** Views are derived from the events the clients design
   already declares, plus two additions listed below. Nothing is read from a
   place only the window can see, except what is the window's own: whether
   *you* have read something.

## What a person sees

### 1. The Team overview

Two places show it, because two questions are asked: "what is every Team on
this desk doing?" and "what is this Team doing?".

**Who is in a Team is the Goal's Seats**, every one its Runs opened, not only
the ones the older member list holds. The Overview's seats table, the rail's
Agents list and its count, and the sidebar's nesting all read that one set,
once for each conversation (#1278). The owner decided on #1278 what happens to
a Seat once its work is done:

- **It stays on the list.** Every Seat a Team's Runs opened stays listed with
  its role and its state, including **Done** (plain muted text, like any
  resting state). That keeps who wrote and who reviewed traceable (a review
  posted on a pull request points back to its Seat) and lets a person ask a
  finished reviewer a follow-up in the same conversation, with its context.
- **The Overview folds the done ones.** Seats that are done and quiet collapse
  into one line, "3 done", which opens to the rows. Needs you, Unread and
  Working seats always sort first and are never inside the fold; a done seat
  that gets a question or an unread message leaves it. The rail's Agents list
  keeps every row.
- **Its process does not stay.** After a Seat hands its last card back and has
  been idle for a while, the host lets its conversation go and the runtime's
  process can stop, the same shutdown idle helpers already get. The list still
  shows it as done. Opening the conversation, or sending it a message,
  reconnects on demand. This is a host change (item 8 below); the window never
  shows a Seat without a process as missing.
- **After the Team ends** it folds into *Ready to wrap* (decision 8). **Wrap**
  turns it into a read-only record: its Seats, conversations and Run
  timelines stay viewable, and nothing more is dispatched. Wrapping closes the
  Seats, so the receipt has to remember each one's conversation for the record
  to stay openable (host change 9). Deleting is a separate action, and deleted
  items go to the Trash.

![The Teams page](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/teams-list-light.png)

**The Teams page** is a page in the left menu, built like the Agents page. It
lists Teams by project, and within a project by precedence, then by how long
they have been in that state.

- A row is the Team's sentence, its seats as a stack of faces, one state chip,
  and `time · cost`. Its one second line is a fact that varies: the round and
  who holds it ("Round 4 · Fixer · 1 of 4 seats working"), or what the Team
  waits on ("Merge it: every reviewer approved", "A review is recorded but not
  posted to the pull request").
- A dot before the sentence means something changed since you last looked.
  That dot, and the word *Unread* below, are the window's own: the host does
  not know what you have read, and the command line shows neither.
- The page opens on **Active**. **Needs you** and **Settled** are one press
  away, with their counts. A Team that is settled with nothing waiting on the
  person folds into one line, **Ready to wrap**, at the bottom of Active, and
  opens on demand. This is the answer to settled Runs piling up: they leave
  the list without leaving the desk. Hiding is never deleting.
- The sidebar lists only Teams that are active or need you, for the same
  reason.

![A Team's overview](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/team-overview-light.png)

**The Overview** is a new first item in the Team's rail, and the pane's
default once a Flow runs on it (a Team with no Flow still opens on Chat).

- **The Run strip** names the Run, its round and role, how long ago and from
  where it started, its review budget used, and its total cost. It carries
  *Open run* and *Stop run…*.
- **Needs you** lists, with their buttons, everything the person can answer
  now: a step a Flow addressed to a person, a seat's question, a tool
  approval. It is the only place these are gathered; today they are a board
  column, a docked approval and a header chip.
- **The seats table** has one row per seat: face and name, role, the card it
  holds, the round, its state, what it is doing, how long it has been in that
  state, and what it has cost. Rows sort by precedence, then card number.
  *Idle* and *Done* are quiet text, not chips: a resting state costs no colour.

State, in the words the app already uses:

| State | A seat is here when | Notes |
| --- | --- | --- |
| **Needs you** | A card addressed to a person waits, a question or a tool approval is open, or the seat has said it is blocked and given a reason. | A Run that is stalled, that ended on an outcome no rule follows, or that holds a review it could not post is also *Needs you*, on the Team and the Run (the unposted review once the publication state is read, plan PR 7). The reason is the earned line. |
| **Unread** | Something from this seat arrived since you last opened its conversation. | Window only. The command line shows three states. |
| **Working** | A turn is running, or it holds a claimed card. | |
| **Idle** | Anything else. A seat whose card waits on another (`blockedBy: graph`) is idle, and its card cell says "after #2". | |
| **Done** | Idle, and every card the seat held is done, with no question, approval, unread mark or running turn. | A resting state like Idle: quiet text, no chip, no colour. The Overview folds the done seats into one line; the rail's Agents list keeps their rows. |

**The "doing" line** is a sentence built from the seat's latest tool call by
the one lookup the interface already has for tool names. Four rules keep it
honest:

1. It is a sentence, never a command. "Running a command" is the line; the
   command is in the transcript, where agent text is sanitised (rule 5) and
   where a secret in it is not copied into a list.
2. A path may appear, because a person needs it ("Editing
   src/checkout/retry.ts"). A URL, an environment value or a command's own
   text never does.
3. It changes at most once every 2.5 seconds, so a fast seat does not flicker.
4. It is one line that gives up the start of a long path, with the whole text
   on hover. When a seat is idle it says what it waits for, or what it last
   did.

**Cost** is shown in the unit the seat's account actually meters. Where the
runtime reports a balance (`capabilities.metered`) and the rate is known, it
is money and says *est.* on hover; otherwise it is turns, and says so. A
column that mixes units is honest, and the Run strip adds both together
("$1.43 · 96 turns"). The figure is a read of the Team's recorded usage, taken
when a card closes and every minute while a Run is going, never a made-up
zero: when the sources cannot answer, the cell is a dash and its title says
why. No cost is coloured. "Expensive" is the biggest figure in a column a
person can sort; a cap is drawn only where the person set one, as a meter
that is quiet while plenty is left.

![The overview, narrow](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/overview-narrow-light.png)

At narrow widths a seat becomes one row: face, name and state on the title's
line, the doing line beneath, and the cost at the end. The *Needs you* items
keep their buttons.

### 2. The Run view

The Run view is a second new item in the Team's rail, **Run**. The Overview's
Run strip opens it too. It has a header, a timeline, and an inspector.

![A Run, running](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/run-timeline-light.png)

**The header** names the Run ("Run 1"), its state, the Flow and its
**revision** as a button that opens the Flow view, a switch between
*Timeline* and *Flow*, a link to the pull request when there is one, and
*Stop run…* while it runs. A Team with more than one Run gets a switch beside
the name.

**The timeline** is the story of the Run, oldest first, grouped by round:

| Row | What it says | Notes |
| --- | --- | --- |
| **Brief** | Where the Run started from (a person, the command line, a trigger), when, and the brief itself, two lines of it. | The brief is a first-class input (see "The brief"). |
| **A round's heading** | "Round 3 · Reviewers", how many answered, how long it took. | |
| **A card** | The seat's face, `#n · title`, the outcome word as a chip, how long. | The outcome is one word from the role's own vocabulary. It is neutral: a verdict is a fact, not a health reading. Only an outcome that ends the Run without a next step is toned. |
| **A check** | `pnpm verify`, its outcome (Passed, Failed, Timed out, or the Flow's own word), how long. | A check run more than once shows its attempts under the card. |
| **A person's step** | The step's sentence, and *Needs you* while it waits. | Its buttons are in the inspector and on the Overview. |
| **Findings and what became of them** | "2 findings" and where they went, in the desk's own words: *Posted to #128*, or *Not posted* with the reason. | The answer to a review that was never posted. A round's chip appears where the host names the round; the Run's state is shown once at Run level (see the table below the frame). |
| **The end** | Why the Run ended, in the host's words, and the doors that lead on. | Only when it has ended. |

The row for work in flight is the same row, with the doing line beneath it and
a *Working* chip. Nothing in the future is drawn: a Flow loops, and which
round comes next depends on outcomes that do not exist yet.

**The inspector** answers "what happened here" for whichever row is selected.
It is the right-hand inspector anatomy the app already has, so a selected row
is a fill and the section labels are the same words everywhere.

| Selected | Sections |
| --- | --- |
| Nothing, or the Run | The brief in full, the Flow and revision, the seats with any override, the base the Run was pinned to, who started it, the budgets (rounds used, rounds without progress), the cost. |
| A card | **Input**: what it was handed (the earlier round's handoffs, the card's detail). **Handoff**: what it left, as sanitised text. **Findings**, if it reviewed. **Review**: posted, or not, with the reason. **Cost**: turns or money for this card's seat. *Open the conversation* is the last control, because the transcript is the log and the inspector does not copy it. |
| A check | The command verbatim, where and under what limit it ran, how its exit mapped to an outcome, the last lines of its output, and **Attempts**, each with its result. *Run again…* is here. |
| A person's step | The sentence, the outcome buttons the role declares, an optional note, and what the answer will do. |

**Why a Run ended, and the doors.** An ended Run says why in a banner above its
end row, and the banner carries the doors that apply:

![A settled Run with a way on](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/run-settled-light.png)

| It ended because | The person is told | Doors |
| --- | --- | --- |
| Everything finished and the work landed. | Settled. Nothing waits. | *Wrap*. |
| A card answered an outcome no rule follows (the #1245 case). | "Ended without a next step", and what answered. The Run and the Team are *Needs you*. | *Run again…*, the board. (*Run the check again…* is offered only while a Run is running or stalled; a settled Run refuses it.) |
| The person stopped it. | Stopped, and by whom. Neutral: a stop the person asked for is not bad news. | *Run again…* |
| The desk stopped while a check ran. | The existing wording, unchanged. *Needs you*. | *Review and run again…* (exists). |
| A budget ran out (rounds, or rounds without progress). | Which one, and how many were used. *Needs you*. | *Run again…* |

**A review that was never posted** is a state on the findings, not a lost
document:

![A review that was not posted](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/review-not-posted-light.png)

The row says *Not posted* in the warning tone, because a person has to act. Its
chip follows the desk's own words, so the window invents no state of its own.
Two reads carry them, and they differ in what they cover:

- **The Run's state.** `finding/run`'s `publication` is the state of every
  posting the Run holds taken together, not of one round. It is shown once, at
  Run level: the Run strip and header, the end banner, and the Findings
  summary.
- **A round's state.** The window reads it from `FindingRunView.rounds` on
  `finding/run` (`{ round, state, reason, pr, cards }`, folded by the host from
  the publication journal with the same rule as the aggregate; landed in #1285).
  A round whose `state` is `none`, or that the list does not carry, shows no
  chip; the window never guesses a round from the Run's aggregate.
  `finding/publications` is still the read behind the doors (post again, skip,
  backfill): it names only the postings a person must look at.

| The desk says | The chip says | Tone |
| --- | --- | --- |
| `posted` (the Run's, or a round's) | Posted to #n | neutral |
| `pending` (the Run's, or a round's) | Waiting to post | neutral |
| `partial` (the Run's, or a round's) | Partly posted | warning |
| `uncertain` (the Run's, or a round's) | Not confirmed | warning |
| `local` (the Run's, or a round's), with a pull request bound and posting on | Not posted | warning |
| `local`, otherwise | Kept on the desk | neutral |
| a round with no findings, or whose `state` is `none` | no chip | |

The inspector says why in the host's words, and offers **Copy review**, which
always works, and **Post to pull request**, which the host offers only when it
can and says what it will do on hover ("Posts this review to pull request
#1259 as you. Nothing else changes."). The desk never posts a handoff's text
as a review on its own; that is the owner's call below.

**Attempts and lineage.** Two things can be tried again, and each keeps its
history:

- **A check** run again adds an attempt under its card. Its earlier outcome and
  output stay. The Run continues from the new outcome.
- **A Run** run again starts a new Run on the same Team through the existing
  preview, with the earlier Run's inputs and brief filled in and the seats
  open to change. The new Run records which Run it continues, and both stay in
  the Team's list of Runs. In the first phase this is a fresh start, not a
  resumption in the middle of a round. Resuming from a chosen round is the
  later step, because it needs the engine to replay a round's evidence.

### 3. The controls

Every control below is drawn from `{ available, why }` the host computes.
Where it is not available, the control is still there, disabled, with the
reason on screen (rule 9's refused row), unless it can never apply to this
Run, in which case it is absent.

| Control | Where | What it does | Wire | Offered when | It never |
| --- | --- | --- | --- | --- | --- |
| **Stop run…** | Run header, Overview strip | Ends the round, interrupts the seats, fires no rule. | `flow/execution/stop` (#1247, new) | The Run is running. The dialog lists each seat and says "stops now", or, for a runtime without `capabilities.interrupt`, "stops when its current turn ends". | Changes a card, a finding or a branch. |
| **Run the check again…** | A check row and its inspector | The existing consent dialog, showing the command verbatim, then a new attempt. | `flow/check/retry` (exists for an uncertain check; #1263, fixing #1245, makes it work on a finished or interrupted check, with fresh consent, and return when the check has started) | The card is a check, the Run is running or stalled, and the host says it can run. A stopped or settled Run refuses, and the dialog says to start a new Run (*Run again…*). | Overwrites the earlier attempt: its output stays in the check's durable evidence history. |
| **Run again…** | Run header, end banner | A preview with the earlier inputs and brief, then a new linked Run. | `flow/preview`, `flow/start-goal`, plus a `continues` field on the Run | The Run has ended. | Resumes mid-round (later). |
| **Answer a card** | Overview *Needs you*, the inspector | The outcome buttons the person role declares, with an optional note. | `team/intent` (`done`) | The card is addressed to a person role. From the command line, only where the person turned on the `answer` tier for this desk (#1271). | Answers a card addressed to an agent. |
| **Abandon a card** | The card's inspector | Abandons it, and says first that the rule after its role still fires. Offers *Stop the run instead*. | `team/intent` (`abandon`) | The card is open or claimed. | Ends the Run. |
| **Approve, Deny** | Overview *Needs you* | A tool approval or a question. | `approval/respond` | The seat has one open. **Window only**: no outside client answers approvals (#1271). | Appear in any other client. |
| **Open pull request** | Run header, the findings row | Opens the pull request in the browser. | None; the link comes from the forge facts the Run already carries | A pull request is bound to the Run. | Merge. Merging stays a step the Flow gives to a check or a person. |
| **Post the review** | The inspector's Review section | Posts what is waiting: an item to post again, or the rounds a backfill would release. | `finding/publish` (exists: post again, skip, backfill), read with `finding/publications`. The case with no review candidate at all needs #1265. | The host has an item awaiting a person or a backfill to offer; otherwise its `backfillRefusal` is shown as the reason. | Run without a press. |
| **Hide settled** | The Teams page | Folds a Team out of Active until it changes. | None; kept on this machine | The Team is settled with nothing waiting. | Delete anything. |

**After a Team is wrapped, no control above is offered.** Each is disabled with
the reason "This Team is wrapped"; the Overview, the Run view, the inspector
and the conversations stay readable. Hiding and deleting are the Team's own
actions, not a Run's.

**Pause and resume are not offered.** The engine has no pause, and a runtime's
own pause is not one control across vendors. Stopping and running again is the
honest pair; a checkpoint of a round is later work.

### 4. The Flow view

The Flow view is the Flow the Run started with, drawn to be looked at. It is
the *Flow* half of the Run header's switch, and the revision button opens it.
It is also the one picture that explains HarnessDesk by itself: agents handing
work to each other, a check that cannot be talked round, a person at the gate,
and a loop that has to end. So it is designed as the product's showpiece, and
the same drawing serves the site and the changelog.

![The Flow, read-only](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-blueprint-light.png)

**How it is drawn.** Every value is a token, so a palette, density or faces
change reaches it.

- **A step is a card.** A mark for what it is (an Agent, a check, a person),
  its name in a word ("Write", "Check", "Review", "Fix", "Land", "You"), and one
  earned line: what it may do ("Edit · asked"), the command a check runs, the
  words a person may answer. A step that opens several seats at once (two
  reviewers) is drawn as a fanned pair of cards, so a count reads without a
  number.
- **A rule is an edge, and says what fires it.** A line with an arrowhead, and
  above it the outcome word that takes it ("passes", "approve"). A rule with no
  guard has no word. A loop is a curved edge under the main line with a retry
  mark ("request-changes") and, in a Run, how many times it has fired ("x1").
  Steps run left to right in the order their rules reach them, loops fall
  below, and a Flow's own `layout.positions` win when it carries them.
- **The shapes keep their meaning.** In the blueprint an Agent is a *thing*, a
  square tile; once a Run seats it, the tile becomes a *face*, with the seat's
  mark. The picture teaches the system's own rule ("Shapes say what a mark is")
  and the moment a definition turns into someone at work is visible.
- **Quiet by default.** Cards on a faint dot grid, hairline borders, one soft
  shadow. Colour is for state, never decoration: the kind tints are the ones
  the rail already uses.
- **It is also a list.** The accessible list of steps and rules the editor's
  graph already has stays under the drawing and carries the same state, so a
  screen reader, a narrow window and a keyboard reach everything the lines
  show. Below a narrow width the list is the view.

**Phase 1: read-only.** The drawing above, the revision, and *Open the file*,
which opens the Flow's source (project, user or built-in). A Run holds its Flow
frozen, so this view cannot change under it; editing stays where it is, in the
Flow catalogue, for the next Run.

**Phase 2: the Run's state laid over it.**

![The Flow with the Run's state on it](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-overlay-light.png)

The overlay says where the Run is, in the order a person reads it:

- **Done.** A filled check badge, how long it took, and the route the work took
  drawn bold in the accent with a soft glow beneath it, so the path through the
  Flow is one continuous line from the start to now.
- **Now.** The current step has a ring and a halo, says *Working*, and shows
  the seat's doing line beneath it. A baton, a bright dot with a short tail,
  rides the edge that brought the work there.
- **Next.** Dashed and quieter. Nothing in the future is promised: only the
  rules that could fire are drawn, and which one will is unknown.
- **Waiting on you.** A person's step takes the warning ring and *Needs you*.
- **Counts.** A step that ran more than once says so; a loop's edge says how
  often it fired.
- **One link with the timeline.** Selecting a step selects its rows in the
  timeline, and the other way round, so the blueprint and the history are one
  view and not two.

**Motion.** The baton travels its edge and the current ring breathes; both stop
under reduced motion. Nothing moves in the blueprint.

**The poster.** The same drawing, large and alone, with the Run beneath it as
one proportional bar of where its time went: the history the timeline lists,
in a line. It is the frame for the site and the changelog, and it is not a
second drawing: the site demo renders the real component from fixture data.

![The Flow, as a poster](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-hero-dark.png)

**What it needs.** A read-only `FlowGraph` pattern in `design/patterns` that
draws a `FlowPolicy` and, in phase 2, a Run's per-step state. Its curves and
arrowheads are data geometry (as a chart's are) and are recorded as that in the
design audit, not excused. The editor's graph (`ShapeGraph`) adopts the same
drawing afterwards, so what is edited and what is run look alike.

**Considered and set aside: a track** (the owner chose the relay over it, decision 9). A drawing where steps are stations on a
line and a loop is a siding makes the prettier still for a straight Flow, and
its bold traveled line is the best idea in it, so that idea is kept. It holds
only for a Flow that is a line with a simple loop; a Flow with two branches has
no good drawing on it. The relay is a graph, so it draws any Flow, and the
real screen can be the picture of the product.

![The track, considered](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-alt-track-light.png)

The blueprint is second in the order of work because it carries the topology
and the timeline carries the record, and the questions in the goal are about
the record: what happened, who is waiting, why it ended, what to do.

## The brief

A long brief had nowhere to go. It is made a first-class input, in three
places that agree:

- **Starting.** The start dialog has a **Brief** field, a text area that takes
  paragraphs and a file, beside the title. A Flow declares whether it takes one
  (an input named `brief`, as the clients design uses); the dialog shows the
  field when it does.
- **The Run.** The brief is stored on the Run, frozen with it, and shown in the
  timeline's first row and the inspector. It is never the card's title.
- **The seats.** Seats read it through the Flow's own `{{brief}}` slot, once,
  as the order's body.

![Starting with a brief](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/start-brief-light.png)

The command line's `--brief-file` is the same input (#1271).

## The five problems, and where each is answered

| Problem | Answered by | Needs on the host |
| --- | --- | --- |
| Runs that settle with no door back | The end banner and its doors; *Run again…* on every ended Run; a check's attempts. | #1245; `continues`. |
| A review that was never posted | *Not posted* on the findings row, the reason, **Copy review** and **Post to pull request**. | #1265, #1248; `review.changed`. |
| Settled Runs piling up | Active, Needs you and Settled on the Teams page; *Ready to wrap* folded; Active-only sidebar. | None; the filter is the window's. The command line's `runs` already defaults to active (#1271). |
| No stream of changes | Every view is derived from the #1271 stream. The window and the command line see the same changes. | `client/subscribe`, `flow/executions` (#1271), and the two additions below. |
| Long briefs have nowhere to go | The brief input, stored on the Run. | A `brief` input on the Run and the `{{brief}}` slot. |

## Three options

**Option A: the Run timeline first, the canvas later. (Recommended.)** The
Overview, the Run view with its inspector, the controls, and a read-only Flow
view. The canvas overlay follows when the history is already right.

- *Answers:* all five problems, and the four questions in the goal.
- *Costs:* three new surfaces made of parts the design system already has
  (rows, chips, the inspector anatomy, a table, the existing graph). The host
  work is small and mostly named: stop, run list, a revision digest, a link
  from a Run to the one it continues, two additive events.
- *Risk:* two projections of one event stream (the table and the timeline)
  have to agree. The shared selectors are what holds them.

**Option B: the canvas first.** The Flow drawn with the Run's state on it is
the Run's home; the timeline is a secondary list.

- *Answers:* topology and loops well; what happened and why it ended less
  well, because a canvas shows where a Run is, not the sequence it took, and a
  loop that fired three times is one box with a number.
- *Costs:* a layout better than the graph's default single column for Flows
  that carry no positions, node states, zoom and pan, and a narrow-width
  story, before any control exists. The
  controls would hang off nodes, which fits a stop or a retry less well than a
  list row does.
- *Risk:* the most new drawing, for the questions that are least asked.

**Option C: the board only.** No new surface. Cards on the board gain a round
badge and an outcome chip, and the header strip gains a line.

- *Answers:* part of the "who is working" question, cheaply.
- *Costs:* almost nothing.
- *Risk:* it answers none of the five problems. The board resets with each
  round, so there is still no place for a Run's story, no door back, and no
  attempts. It is the right small step *inside* option A, and is folded into
  it: the board's cards will wear the round and outcome that the timeline
  shows.

**Why A.** The five problems are all about the record and the way on, and the
record is a sequence. The canvas is the better picture of the Flow's shape, so
it is kept, as the read-only view now and as the overlay next.

## Sharing the clients design's event stream

The clients design (#1271) declares a versioned stream, one object per line,
`hello` first and `end` last. Every view above is derived from it. Where it
already has what a view needs, nothing is added; where it does not, the
addition is **a new event type or an optional field**, which that design's own
rule makes safe ("consumers switch on `type` and ignore types they do not
know").

| The view needs | From | State |
| --- | --- | --- |
| A Team's sentence, activity | `team.changed` | Exists. |
| A Run's state, round, reason | `run.changed` | Exists. **Adds** optional `continues` (the Run it continues) and `revision` (the Flow's digest), which have landed; an optional `attempt` is added only once a record carries one. |
| A card's state, outcome, title | `card.changed` | Exists. **Adds** optional `seat` (who holds it) and `since`. |
| What waits for a person | `waiting`, `waiting.cleared` | Exists. |
| A seat's state and what it is doing | none | **New: `seat.changed`**, `{ team, seat, role, card, state: 'working' \| 'waiting' \| 'idle', doing, since }`. The **host derives it** and sends one `seat/activity` notification per seat on a `seats` topic, at most once every 2.5 seconds; the client library maps it one to one. (Deriving it in each client would mean sending every seat's whole transcript stream to the command line and, later, a phone.) `doing` is structured and null unless the seat is working (`{ kind: 'tool', tool, target? }` or `{ kind: 'thinking' }`; waiting and idle are the `state`), and the derivation of the in-flight tool, with the one tool-name lookup (`seatDoing`, `doingSentence`), moved into `packages/protocol` so the host, the command line and the window share it. Landed in #1285. |
| What became of a review | none | **New: `review.changed`**, `{ team, run, round, cards, state: 'local' \| 'pending' \| 'posted' \| 'partial' \| 'uncertain' \| 'none', reason, pr }`: the desk's own words, keyed by round with the round's cards. The host derives each round's state from the Run's publication journal, whose postings are keyed by round; `finding/run`'s `publication` is the Run's aggregate and is not per round. Read again on `finding/changed`. (`finding/publications` lists only the postings a person must look at, so a successful post is not in it.) The window maps those words to its own chips in the selector, never on the wire. Landed in #1285 as `FindingRunView.rounds` on `finding/run`, which `review.changed` reads. |
| The list of Runs; one Run's rounds and journal | `flow/executions`, `flow/execution` | In the clients design's phase 1; the Run detail exists. |
| Cost | A read of the Team's recorded usage (`insight/goal`), not an event | Exists; it joins the clients design's read tier. |
| Whether *you* have read it | Nothing | The window's own state. It never goes on the wire. |
| Stop | `flow/execution/stop` | The clients design's phase 3 (#1247). |

**One set of selectors.** Two pure functions, `teamOverview(state)` and
`runTimeline(input)` (the input is one Run's record, its cards and signals, and
the check results and findings the timeline also needs, as below), turn the held
state into exactly what the table and the timeline draw. They belong in
`@harnessdesk/client/views`: pure, no
transport, and the window imports only that entry (a layering rule holds it).
The command line's `status` and `run show` are the same selectors with a
terminal's words. The selector code and its tests were written first in
`packages/ui/src/lib` over plain data (the plan's PR 1 and PR 3); the clients
design moves the files into `client/views` when the command line needs them and
leaves a re-export behind, so nothing in the window breaks. The overview model
has moved (#1295): it lives in `packages/client/src/views/`, the window's
`packages/ui/src/lib/team-overview.ts` is a re-export, and the command line's
`status` renders it. The timeline selector is written (plan PR 3, #1292) as
`runTimeline({ execution, cards, signals?, evidence?, findings?, origin? })` in
`packages/ui/src/lib/run-timeline.ts`; check results (`evidence`) and a Team's
findings are read on demand and are not part of the held event state, so they
are explicit inputs, and it moves with plan PR 16. That move either brings along
its two small word helpers (`wordOf`, `lifecycleWords`), which are UI-only today,
or takes their words as an input, and
settles with the clients design whether `evidence/board` and `finding/list` join
the client door's read tier; if they do not, `run show` prints the rows it can
and says that check results and findings are not shown. Until the
stream feeds the window, the window feeds the selectors from its own snapshot,
provided the output has the same shape; replacing the input is then mechanical.

**What the stream must not carry.** Agent text is untrusted and stays so: a
card's handoff and a finding's text reach a client as data to be sanitised
where it is shown, as today. The doing line carries a tool and at most a path.
A command's text, a URL and an environment value are not in it.

**Who may do what from outside the window** follows the clients design's tiers
unchanged: everything in the Overview and the Run view is `read`; *Stop*,
*Abandon* and *Run again* are `run`; *Answer* is `answer`, off by default;
*Approve* is in none of them.

## Host changes this needs

Each one is a wire or record change made the usual way, in its own small
commit, and none of them ships a surface by itself:

1. `flow/execution/stop { run, reason }` (#1247), and `flow/executions` (the
   clients design's host changes 2 and 3). `flow/executions` has landed
   (#1279); `flow/execution/stop` has not.
2. `FlowExecution.revision`: a digest of the canonical document, set when the
   Run starts and never changed. And `FlowExecution.continues`: the Run this
   one continues, set at the start. And `FlowExecution.startedAt`, which the
   host stored but did not project, and `endedAt`, set when the Run leaves
   running. Landed in #1281, all optional so an older record reads as before.
3. `flow/check/retry` works on a finished or interrupted check of a running or
   stalled Run, and returns when the check has started (landed in #1263, fixing
   #1245).
   A settled or stopped Run refuses it; the way on is *Run again…*.
4. A `brief` input on a Run, frozen with it, and the `{{brief}}` slot. Landed in
   #1274 (the start field) and #1281 (frozen with the Run).
5. `seat/activity` (host-derived and throttled, mapped to `seat.changed`),
   `review.changed`, and the optional fields above. A field is present only
   where the desk's own record carries it, never filled from when a client
   noticed something. Each is declared in the clients design's event table and
   its gate test; that design added them in its second pull request. `seat/activity`
   and `FindingRunView.rounds` have landed (#1285).
6. `{ available, why }` on each control: the stop, retry and run-again
   previews already return a refusal string; this makes it one shape.
7. A Team's usage read grouped by seat, from the report's existing breakdowns.
8. A finished Seat's process rests: a Seat with every card done, no turn, no
   approval, no queued message and no running task, idle past a set time, lets
   go of its conversation's live handle, and no longer holds its runtime open
   in `#runtimeIsIdle`. Its record stays open, so it stays a member and stays
   listed. Only a runtime that can resume a conversation and can stop its
   process on idle takes part: the host releases the conversation through the
   session's own `close()`, which must also drop it from the adapter's session
   map (or `stopForIdle` refuses), and reopens it with `resumeSession`. On
   every other runtime the process keeps running and what the person sees is
   unchanged. The release follows `session/close`: the live handle is closed
   and `live` is null, while `detached` stays false, because the handle was let
   go on purpose and not lost to a restart. The Seat stays a member, and the next
   thing addressed to it (a message, opening the conversation) reopens it. It
   never closes the Seat and never changes a card. Landed in #1283.
9. The receipt remembers each Seat's conversation: `GoalReceiptMember.session`,
   written at wrap from the Seat's own record, so a wrapped Team's Seats can
   still be opened. A receipt wrapped earlier falls back to the session of a
   Seat that answered, and otherwise lists the Seat without a link.
10. A wrapped Team's Seats refuse new work: a send, a steer or a queued send
    into a conversation that is a Seat of a wrapped Goal is refused with "This
    Team is wrapped". Today `turn/send` reaches the session without asking.

## Phasing

The pull requests below are written out one by one, each as a brief a Team can
take cold, in `docs/superpowers/plans/2026-10-02-teams-runs-view.md`.

Small pull requests, each usable on its own, each with its catalogue boards
(every new state: empty, failed, pending, narrow, dark) and its entry in
`docs/design.md`, and each reviewed with at most three rounds.

**Phase 1: read, and the controls the dogfooding already needs.**

1. Host: stop and the run list (with the clients design's own PRs), the
   revision digest and `continues`.
   And, independent of the rest, a finished Seat's process resting (item 8).
2. The Overview: the Run strip, *Needs you*, the seats table with every Seat a Run opened and the done ones folded (#1278), `seat.changed`.
3. The Run view: the timeline and the inspector, read-only, and the read-only
   Flow view.
4. The controls: stop, run a check again, answer, abandon, open the pull
   request, *Run again…*, and the end banner's doors.
5. The Teams page, folding, and the brief field.
6. A wrapped Team as a read-only record: its Seats' conversations remembered by the receipt, and nothing dispatchable.

**Phase 2: the record gets richer.**

- The Run's state laid over the blueprint, with the layout it needs.
- The switch between a Team's Runs, and two Runs side by side (the race view's
  neighbour).
- *Run again from here*: resuming at a chosen round.
- Cost per seat as a meter, and a sort by cost.

**Phase 3: the phone.** The Overview, what waits for the person, and answering
a person's step, over the clients design's relay, with the same selectors.

## What this does not do

- It does not edit a Flow while it runs. A Run holds its Flow frozen, so a
  change is the next Run.
- It does not pause a Run. See the controls.
- It does not draw a model's reasoning or its tool calls. The transcript is
  the log, and the inspector links to it.
- It does not forecast cost, and it invents no threshold for "expensive".
- It does not let any outside client approve a tool request.
- It does not post anything to a pull request unasked.

## Testing, when it is built

- The selectors are tested on a scripted event stream, including a gap and a
  reconnect, and the same stream is replayed through the window and the
  command line to show they agree.
- Each state in the seats table has a catalogue case and a browser rule: the
  precedence orders the rows, and no resting state wears a health tone
  (`rules.spec.ts`).
- The doing line has a unit test that no command text, URL or environment
  value reaches it from a tool call that carried one.
- Seat faces are `data-shape="face"` and covered by the faces census.
- A control that is unavailable keeps its reason on screen, tested per control.
- The fake-agent rig runs a Flow to each ending in the table (settled,
  unrouted outcome, stopped, stalled, budget) and asserts the doors.

## Decisions for the owner

The owner decided all nine on 2026-10-02, every one as recommended. Decision 9
is the Flow view's look, which was drawn after the other eight and chosen last.
Decision 10 came from the first look at a finished Team (#1278) and is the
owner's own.

| # | Decision | Recommended |
| --- | --- | --- |
| 1 | **The structure.** The Run timeline first and the canvas later (A), the canvas first (B), or the board only (C). | **A.** |
| 2 | **Where the overview lives.** A Teams page in the left menu and an Overview inside each Team, or the Overview only. | Both, the Overview first. |
| 3 | **The word, and what counts.** "Needs you" (the app's existing word), not "Waiting for you"; and a Run that ended on an outcome no rule follows, or holds a review it could not post, counts as *Needs you*. | Yes to both. |
| 4 | **What *Run again* means at first.** A fresh Run on the same Team with the earlier inputs, linked to it, not a resumption in the middle of a round. | Yes. |
| 5 | **Posting a review the desk could not post** (#1265). An explicit **Post to pull request** button, never automatic. | Explicit only. |
| 6 | **How cost is shown.** Per seat in the seat's own unit (money where the account is metered and the rate known, turns otherwise), with its provenance on hover. | Yes. |
| 7 | **Two additions to the clients design's event stream** (`seat.changed`, `review.changed`, and optional fields). It was approved as written, so this is a change to it. | Yes; additive within version 1. |
| 8 | **Settled Teams.** They fold into *Ready to wrap* and leave the sidebar when nothing waits on the person. Hiding never deletes. | Yes. |
| 9 | **The Flow view's look.** The relay drawing (cards and labelled edges, any Flow), or the track (stations on a line, a straight Flow only). | **The relay.** Chosen by the owner, with the track's bold traveled line kept. |
| 10 | **Finished Seats.** A Seat stays on the Team's list when its work is done, folds in the Overview, and its process does not stay running; wrap makes a read-only record. | **As decided on #1278.** |

## Open questions

These do not block the design:

- **Side by side does not need a tab of its own** (owner, 2026-10-02). It sits
  in the Team's rail today and takes a big tab for what is a way of watching
  several seats. It could become a view of the Overview (pick seats, open them
  side by side) or a mode of the pane. It is not changed here and the frames
  leave it where it is; it is revisited after the Overview exists, because the
  seats table is the natural place to pick from.
- **Where the doing-line lookup lives.** Settled: it moves into
  `packages/protocol`, with a re-export left in the interface, in the pull
  request that adds `seat.changed` (see "Sharing the clients design's event
  stream").
- **The Teams page's place in the left menu**, beside Agents or under the
  project tree, is a catalogue decision for the Teams-page pull request.
- **Names in the seats table.** A table cell is content, so seat names wear
  the *member* role beside a face, as the frames show. The rail's own names
  follow the pending list-typography review (#1231).
- **A layout for the blueprint** may need a layout library; its licence must
  be compatible with Apache-2.0. Chosen in phase 2.

## The frames

Every frame is rendered from the real design system and its tokens, with
placeholder names and data, at the same widths the app uses. The light versions
are above; the dark ones are the same files with `-dark`.

| Frame | Light | Dark |
| --- | --- | --- |
| The Teams page | [teams-list-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/teams-list-light.png) | [teams-list-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/teams-list-dark.png) |
| A Team's overview | [team-overview-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/team-overview-light.png) | [team-overview-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/team-overview-dark.png) |
| The overview, narrow | [overview-narrow-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/overview-narrow-light.png) | [overview-narrow-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/overview-narrow-dark.png) |
| A Run, running | [run-timeline-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/run-timeline-light.png) | [run-timeline-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/run-timeline-dark.png) |
| A Run, settled with a way on | [run-settled-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/run-settled-light.png) | [run-settled-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/run-settled-dark.png) |
| A review that was not posted | [review-not-posted-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/review-not-posted-light.png) | [review-not-posted-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/review-not-posted-dark.png) |
| The Flow, read-only (phase 1) | [flow-blueprint-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-blueprint-light.png) | [flow-blueprint-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-blueprint-dark.png) |
| The Flow with the Run's state (phase 2) | [flow-overlay-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-overlay-light.png) | [flow-overlay-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-overlay-dark.png) |
| The Flow as a poster | [flow-hero-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-hero-light.png) | [flow-hero-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-hero-dark.png) |
| The track, considered | [flow-alt-track-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-alt-track-light.png) | [flow-alt-track-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-alt-track-dark.png) |
| Starting with a brief | [start-brief-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/start-brief-light.png) | [start-brief-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/start-brief-dark.png) |
| Stop a run | [dialog-stop-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/dialog-stop-light.png) | [dialog-stop-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/dialog-stop-dark.png) |
| Abandon a card | [dialog-abandon-light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/dialog-abandon-light.png) | [dialog-abandon-dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/dialog-abandon-dark.png) |

The two confirmations, for the controls table:

![Stopping a run](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/dialog-stop-light.png)

![Abandoning a card](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/dialog-abandon-light.png)

## Found while

Running real work as Teams on a desk, 2026-10-02 (#1268). Each problem in the
table above is a sub-issue there. This design is the next step after them, and
shares its event stream with the clients design (#1271).
The empty Agents list of a Team whose Flow had finished (#1278) was found the
same day, in the owner's first look at one.
