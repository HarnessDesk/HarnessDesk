# Seeing and steering Teams, Flows and Runs: the Run view first

*2026-10-02. A design for the owner to decide on; nothing here is built. It
covers how the window shows and controls a Team's work: who is doing what, one
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
  an inspector beside it). A read-only Flow blueprint, reached from the Run.
  Drawing the Run's live state on the blueprint is the later step.
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
  *Idle* is quiet text, not a chip: a resting state costs no colour.

State, in the words the app already uses:

| State | A seat is here when | Notes |
| --- | --- | --- |
| **Needs you** | A card addressed to a person waits, a question or a tool approval is open, or the seat has said it is blocked and given a reason. | A Run that is stalled, that ended on an outcome no rule follows, or that holds a review it could not post is also *Needs you*, on the Team and the Run. The reason is the earned line. |
| **Unread** | Something from this seat arrived since you last opened its conversation. | Window only. The command line shows three states. |
| **Working** | A turn is running, or it holds a claimed card. | |
| **Idle** | Anything else. A seat whose card waits on another (`blockedBy: graph`) is idle, and its card cell says "after #2". | |

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
| **Findings and what became of them** | "2 findings" and where they went: *Posted to #128*, or *Not posted* with the reason. | The answer to a review that was never posted. |
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
| A card answered an outcome no rule follows (the #1245 case). | "Ended without a next step", and what answered. The Run and the Team are *Needs you*. | *Run the check again…* when the last card is a check, *Run again…*, the board. |
| The person stopped it. | Stopped, and by whom. Neutral: a stop the person asked for is not bad news. | *Run again…* |
| The desk stopped while a check ran. | The existing wording, unchanged. *Needs you*. | *Review and run again…* (exists). |
| A budget ran out (rounds, or rounds without progress). | Which one, and how many were used. *Needs you*. | *Run again…* |

**A review that was never posted** is a state on the findings, not a lost
document:

![A review that was not posted](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/review-not-posted-light.png)

The row says *Not posted* in the warning tone, because a person has to act. The
inspector says why in the host's words, and offers **Copy review**, which
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
| **Run the check again…** | A check row, its inspector, the end banner | The existing consent dialog, showing the command verbatim, then a new attempt. | `flow/check/retry` (exists; #1245 makes it work on any finished check and return when the check has started, not when it ends) | The card is a check, and the host says it can run. | Overwrites the earlier attempt. |
| **Run again…** | Run header, end banner | A preview with the earlier inputs and brief, then a new linked Run. | `flow/preview`, `flow/start-goal`, plus a `continues` field on the Run | The Run has ended. | Resumes mid-round (later). |
| **Answer a card** | Overview *Needs you*, the inspector | The outcome buttons the person role declares, with an optional note. | `team/intent` (`done`) | The card is addressed to a person role. From the command line, only where the person turned on the `answer` tier for this desk (#1271). | Answers a card addressed to an agent. |
| **Abandon a card** | The card's inspector | Abandons it, and says first that the rule after its role still fires. Offers *Stop the run instead*. | `team/intent` (`abandon`) | The card is open or claimed. | Ends the Run. |
| **Approve, Deny** | Overview *Needs you* | A tool approval or a question. | `approval/respond` | The seat has one open. **Window only**: no outside client answers approvals (#1271). | Appear in any other client. |
| **Open pull request** | Run header, the findings row | Opens the pull request in the browser. | None; the link comes from the forge facts the Run already carries | A pull request is bound to the Run. | Merge. Merging stays a step the Flow gives to a check or a person. |
| **Post the review** | The inspector's Review section | Posts recorded findings to the pull request. | The host's own, behind #1248 and #1265 | The host says it can, and why. | Run without a press. |
| **Hide settled** | The Teams page | Folds a Team out of Active until it changes. | None; kept on this machine | The Team is settled with nothing waiting. | Delete anything. |

**Pause and resume are not offered.** The engine has no pause, and a runtime's
own pause is not one control across vendors. Stopping and running again is the
honest pair; a checkpoint of a round is later work.

### 4. The Flow blueprint

The blueprint is the Flow the Run started with, drawn as the graph the app
already has. It is the *Flow* half of the Run header's switch, and the
revision button opens it.

![The Flow, read-only](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-blueprint-light.png)

**Phase 1: read-only.** A step per role, a line per rule, the accessible list
of both (the graph already has it), the revision, and *Open the file*, which
opens the Flow's source (project, user or built-in). The graph is the existing
`ShapeGraph` in a read-only mode: no dragging, no position fields. Nothing new
is drawn. A Run holds its Flow frozen, so this view cannot change under it, and
editing stays where it is, in the Flow catalogue, for the next Run.

**Phase 2: the Run's state laid over it.**

![The Flow with the Run's state on it](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/screenshots/team-run-view/flow-overlay-light.png)

Each step says where the Run is in it: done steps carry what they answered and
how many times they ran; the current step has a ring and says *Working*; steps
not reached yet are faded. A loop's lines carry how many times they fired.
Selecting a step selects its rows in the timeline, and the other way round, so
the blueprint and the history are one view and not two. Two things are needed
first: a better layout for Flows that carry no positions (the graph draws them
as one column today), and the Run's per-step counts, which the rounds already
hold.

The blueprint is second because it carries the topology and the timeline
carries the record, and the questions in the goal are about the record: what
happened, who is waiting, why it ended, what to do.

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
| A Run's state, round, reason | `run.changed` | Exists. **Adds** optional `attempt`, `continues` (the Run it continues) and `revision` (the Flow's digest). |
| A card's state, outcome, title | `card.changed` | Exists. **Adds** optional `seat` (who holds it) and `since`. |
| What waits for a person | `waiting`, `waiting.cleared` | Exists. |
| A seat's state and what it is doing | none | **New: `seat.changed`**, `{ team, seat, role, card, state: 'working' \| 'waiting' \| 'idle', doing, since }`. `doing` is structured (`{ kind: 'tool' \| 'thinking' \| 'waiting' \| 'idle', tool?, target? }`) and each client puts it into words with the one shared lookup, so a phone and a terminal say what the window says. Sent at most once per seat every 2.5 seconds. |
| What became of a review | none | **New: `review.changed`**, `{ team, run, card, state: 'recorded' \| 'posted' \| 'not-posted' \| 'none', reason, pr? }`, from the same publication records `finding/publications` reads. |
| The list of Runs; one Run's rounds and journal | `flow/executions`, `flow/execution` | In the clients design's phase 1; the Run detail exists. |
| Cost | A read of the Team's recorded usage (`readGoalInsight`), not an event | Exists. |
| Whether *you* have read it | Nothing | The window's own state. It never goes on the wire. |
| Stop | `flow/execution/stop` | The clients design's phase 3 (#1247). |

**One set of selectors.** Two pure functions, `teamOverview(state)` and
`runTimeline(state, run)`, turn the event state into exactly what the table and
the timeline draw. They belong in `@harnessdesk/client`'s core, which already
has no Node in it, so the window, the command line and Mobile call the same
code. The command line's `status` and `run show` are the same selectors with a
terminal's words. Until that library exists, the window may compute them from
its own snapshot, provided the output has the same shape; replacing the input
is then mechanical.

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
   clients design's host changes 2 and 3).
2. `FlowExecution.revision`: a digest of the canonical document, set when the
   Run starts and never changed. And `FlowExecution.continues`: the Run this
   one continues, set at the start.
3. `flow/check/retry` works on any finished check and returns when the check
   has started (#1245).
4. A `brief` input on a Run, frozen with it, and the `{{brief}}` slot.
5. `seat.changed` and `review.changed`, and the optional fields above, each
   declared in the clients design's event table and its gate test.
6. `{ available, why }` on each control: the stop, retry and run-again
   previews already return a refusal string; this makes it one shape.
7. A Team's usage read grouped by seat, from the report's existing breakdowns.

## Phasing

Small pull requests, each usable on its own, each with its catalogue boards
(every new state: empty, failed, pending, narrow, dark) and its entry in
`docs/design.md`, and each reviewed with at most three rounds.

**Phase 1: read, and the controls the dogfooding already needs.**

1. Host: stop and the run list (with the clients design's own PRs), the
   revision digest and `continues`.
2. The Overview: the Run strip, *Needs you*, the seats table, `seat.changed`.
3. The Run view: the timeline and the inspector, read-only, and the read-only
   Flow view.
4. The controls: stop, run a check again, answer, abandon, open the pull
   request, *Run again…*, and the end banner's doors.
5. The Teams page, folding, and the brief field.

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

Each is recommended; the first is the one that changes the most.

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

## Open questions

These do not block the design:

- **Where the doing-line lookup lives.** It is in the interface today. A shared
  home (`@harnessdesk/client` or `protocol`) is settled in the pull request
  that adds `seat.changed`.
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
