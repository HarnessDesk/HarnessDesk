# Background tasks: work that outlives the turn

*Designed and built 2026-08-26; made a panel, with the output, 2026-09-05.*

## What it is

An agent can start work and walk away from it — a build in a watcher, a long
test run, a server it wants logs from later. That work does not end when the
turn ends, which means it is not a transcript row: by the time it finishes,
the row that started it has scrolled off the top of the conversation.

So HarnessDesk keeps it beside the conversation rather than inside it. It is
a **panel** — the fifth inspector, summoned from the conversation's ⋯ menu,
⌘K (*Show background tasks*), or `/tasks`, and docked to the right like
Changes — with one card per task: the sentence the agent named it with, the
kind and state in words, a clock, a stop button while it runs, and then the
command under a prompt mark (`$`) and **what it printed**, scrollable, staying
there after the turn. Running work is listed first; **Clear** forgets the
finished. While anything is listed the conversation's header wears a chip —
green with a turning mark while something runs, a quiet count once everything
has ended — and pressing it opens the panel.

The first build put this in a strip above the composer, beside the queue and
the goal. A strip has room for a label, a clock and a stop button, and none for
the one thing a person opens the registry for: the output. Claude Code's own
desktop app draws it as a panel holding the command and its output, and that is
the shape a comparison on the same turn showed to be right — see "Why a panel"
below.

Two of the four agents have this concept, they implement it completely
differently, and the other two do not have it at all. All three of those are
first-class outcomes here.

## Expected behaviour

| You do | What happens |
| --- | --- |
| The agent backgrounds a command | A green chip appears in the conversation header; the panel, if open, gains a card with the description, the command, and a running clock ✓ |
| Something is running and the panel is not in front | A green dot appears on the ⋯ menu's *Background tasks* item, on the dock's tab, and on the conversation's row in the sidebar — every door to the panel, from one `live` predicate the view declares ✓ |
| You press the chip, choose ⋯ → Background tasks, press ⌘K, or type `/tasks` | The panel opens beside the conversation ✓ |
| You open a conversation with a job already running | The list is read on open, not waited for ✓ |
| A task ends while you are doing nothing | The card moves to *Completed* when it ends, not when you next type, and its output appears beneath the command ✓ |
| The task printed more than 64 KB | The card shows the tail, and notes that it is showing the end of a longer log ✓ |
| The output file lands a moment after completion | The card says *Fetching what it printed…*, then displays the text ✓ |
| The output file never appears | After about sixteen seconds the card says *Its output was never found.*, and the runtime stops looking ✓ |
| Press **Stop** on a running task | The runtime kills it; the card says *Stopped* with an amber alert mark, not *Completed* ✓ |
| Press Stop on a task that already ended | An info notice says *"That task had already finished."* and the list refreshes — no error ✓ |
| Press **Clear** | Finished cards are removed. **Running work keeps running** ✓ |
| Reload the window | Running work is restored from the host's sync state ✓ |
| Use an agent without the concept | No header chip appears; the panel opens to an honest empty state saying the agent keeps no such list ✓ |

✓ marks what has been driven end to end against the real binaries, or against
the repository's fake Claude Code playing the observed wire shapes.

## The panel and its cards

The panel holds one card per task, ordered with running tasks first and finished
tasks newest first.

Each card carries:
- **A status mark**: an animated turning spinner while the task runs, a muted
  check mark when completed, and an amber alert mark if it was stopped or
  failed. Amber, not red: a task that failed or was stopped is news, not an
  error in the application.
- **A label and metadata**: the description the agent gave the task, followed
  by the kind as a noun (*Shell*, *Agent*, or *Task*), the state (*Running*,
  *Completed*, *Failed*, or *Stopped*), and elapsed run time.
- **A stop button**: appears in the card header for running tasks that can be
  stopped. It disappears when the task ends.
- **The command**: displayed under a `$` prompt mark in monospace when the task
  executed a command line.
- **The output**: scrollable in a box capped at 360 pixels. While the task is
  running, the box notes *Nothing printed yet.* Once finished, it shows what the
  process printed, or *(no output)* if nothing was emitted. If the output file
  is still being retrieved from disk, it reads *Fetching what it printed…*; if
  retrieval timed out, it reads *Its output was never found.* If the output was
  truncated at 64 KB, a note confirms it is *Showing the end of a longer log.*
- **Hover details**: hovering over a card displays a tooltip with the label,
  command line, working directory, summary, OS process ID, CPU percentage, and
  resident memory when known.

Above the cards, the panel toolbar displays the summary count (such as
*1 running · 2 finished*) and a **Clear** button. **Clear** appears only when
finished work exists. Clicking it removes completed, failed, and stopped cards;
running work is never cleared or stopped by it.

## What each agent actually does

### Claude Code

Claude Code keeps a registry of background tasks (background shells, async
agents, and remote sessions). When a background command starts, Claude Code
assigns an ID and writes output to a file on disk. The command text is captured
from the tool call.

- **The output is on disk, not on the stream.** Claude Code names the output
  file when the task finishes and does not stream output text over the wire.
  The bridge reads the file from disk when the task ends — taking the last
  64 KB, cut cleanly at the first whole line — attaches it to the task, and
  publishes the updated list.
- **Handling output races.** The completion notification and the final file
  write can race. If the file is not yet on disk when the notification arrives,
  the bridge retries on a doubling schedule (250 ms, 500 ms, 1 s, 2 s, 4 s, 8 s
  — six attempts over roughly sixteen seconds). Opening the panel triggers an
  immediate eager read. If all retries expire without finding the file, the task
  is marked missing so the card can state *Its output was never found.* rather
  than waiting forever.
- **Continuous stream draining.** The standard ACP bridge drains the event
  stream only while a turn is active. If a background task finished while the
  user was idle, its completion would sit unread until the next message was sent.
  HarnessDesk's Claude Code bridge takes ownership of the generator, continuously
  pumping and buffering it between turns so background completions are announced
  the moment they happen.

Both the original wire (2.1.240, which sent dedicated start and updated
notifications) and the newer wire (2.1.258, which announces starts via the
tool result and relies on output status tags) are handled.

### Codex

Codex tracks live background terminal processes in its app-server.

- **The poll reports liveness.** Codex returns the live running set with OS
  process ID, CPU share, and resident memory. However, it forgets a process the
  instant it exits, carries no start time, and provides no history of completed
  tasks.
- **The item stream reports history.** Command execution items emitted during a
  turn record when a shell session starts, the command line, the working
  directory, and initial aggregated output.
- **Joining the two.** The Codex adapter watches item stream events for
  lifecycle and polls the background terminal list every four seconds while work
  is running. A remembered session still in the poll is running; one dropped from
  the poll has completed; one found in the poll without prior history (such as a
  resumed session) is preserved and displayed. The poll runs only while work is
  live, so an idle application consumes no background CPU.
- **Local clearing.** Codex provides a clean endpoint, but does not document
  whether it reaps dead sessions or kills live ones. To ensure running processes
  are never killed, clearing is performed entirely within the adapter without
  calling the backend endpoint.

### Cursor and DeepSeek Harness

Neither Cursor nor DeepSeek Harness keeps a registry of work that outlives a
turn.

Both report the capability as false, and neither shows a header chip. When you
open the panel on one of their conversations, it displays an honest empty
state: *Nothing to list — [Agent] keeps no list of work that outlives a turn.*
It does not draw an empty list or say "0 running", which would falsely imply that
background tasks were kept but lost.

### Other ACP agents

Any ACP agent that implements HarnessDesk's background tasks extension channel
receives full panel support. If an agent emits background tasks dynamically
without having declared the capability upfront, HarnessDesk honours the list
immediately and updates the window.

## Why a panel

The dock above the composer used to stack three things that all describe work
in flight — the jobs strip, this registry, the queue — and the first build drew
them in one vocabulary: a spinner, a terminal glyph, a command in mono, a clock
on the right. Side by side they were one picture, and a whole section of this
document went into separating them by wording and colour: each strip said in
words *when its contents happen*, and this one was green because green was the
one hue the palette had left.

That was treating a symptom of the placement. The three things have three
lifetimes, and the one that outlives the turn does not belong in a strip whose
whole reason is to sit against the composer with the turn's own narration.
Worse, a strip had no room for the output — a growing list would push the
composer off the screen, so finished work hid behind a count, and what a
finished task printed had nowhere to go but a notice in the transcript.

Recorded against Claude Code's desktop app on the same scripted turn, the
difference was plain: its Background tasks is a side panel, one card per task
with "Bash · Completed", the command, and the output scrollable beneath, and it
stays after the turn. So the registry moved to where the other inspectors
already live. The dock keeps two strips — the jobs strip, bare text that
leaves with the turn, and the queue, a card of your own words — and they no
longer need a paragraph to tell apart. What the panel kept from the strip: the
stop on every running row, the clock, **Clear** that never touches running
work, and the green, now on the header chip and the card's turning mark, for a
process that is up.

The panel says the kind as a noun — *Shell*, *Agent* — and never as the wire
name Claude's app prints (*Bash*), because this app's rule is that a tool's
wire name appears only where a rule is written against it.

## Where the code is

- `packages/protocol/src/tasks.ts` — `BackgroundTask`, `BackgroundTaskState`,
  `BackgroundTaskKind`, `orderTasks`, `isFinishedTask`.
- `packages/protocol/src/runtime.ts` — `RuntimeTasks` (`list`, `stop`, `clear`)
  and capability declaration.
- `packages/adapter-codex/src/tasks.ts` — `CodexTasks`: joins background
  terminal polling with startup item stream history.
- `packages/claude-acp/src/tasks.ts` — `TaskRegistry`: folds SDK messages, joins
  tool calls, and tracks output retrieval.
- `packages/claude-acp/src/bridge.ts` — continuous generator stream pumping and
  exponential output retry schedule.
- `packages/adapter-acp/src/tasks.ts` — `AcpTasks`: ACP extension channel client
  for background tasks.
- `packages/transport-acp/src/index.ts` — ACP extension types and method names.
- `packages/server/src/methods/turns.ts` — host handlers for listing, stopping,
  and clearing tasks.
- `packages/server/src/host.ts` and `packages/server/src/registry.ts` — held
  session tasks and sync state across window reloads.
- `packages/ui/src/components/BackgroundTasks.tsx` — the inspector panel,
  `TaskCard`, output notes, and empty states.
- `packages/ui/src/lib/tasks.ts` — task formatting, kind and state words,
  duration formatting, and tooltip assembly.
- `packages/ui/src/components/Conversation.tsx` — header chip (`TasksChip`) and
  menu integration.
- `packages/ui/src/panels/builtins.tsx` — view registration and `live`
  indicator predicate.

## What was verified, and what was not

Against real agents, through the headless host and the real renderer, on
2026-08-26:

- **Claude Code 2.1.240** — two real backgrounded shells started from a real
  turn, listed, ticking; one killed with the panel's stop button (`ps` agreed
  the process was gone); the other survived **Clear** and a full window reload
  and was still running (`ps` agreed again) before being stopped.
- **Codex 0.149.0** — the three methods answer on the real app-server through
  this repository's own client, in the shape the adapter reads. With the wire
  teed to a file, the adapter's `list` and `stop` were seen going out and
  being answered.
- **Cursor 2026.08.25** and **DeepSeek Harness** — capability false, no
  registry, no header chip; panel verified rendering the honest empty state.

On 2026-09-05, the panel: the same scripted turn recorded before and after
the change on the real desktop app — the strip above the composer with its
label and clock, then the panel with the command and the test run's output
landing on the card when the task ended between turns — and once more against
the real Claude Code on `sonnet`, whose output file the bridge read.

Traced on the real wire on 2026-09-05 against **Claude Code 2.1.258**: confirmed
that newer builds omit start notifications and rely on tool result IDs and
status tags, verified end to end in the test suite against the modern fake.

**Not verified: a populated Codex list.** A background terminal only comes
from unified exec inside a model turn, and the Codex account on this machine
is out of credits (`401` from the responses socket). `thread/shellCommand`
was probed as a way in and does not register one. The adapter's handling of a
populated list is covered against a fake app-server playing the observed
shapes (`packages/adapter-codex/test/tasks.test.ts`), and the wire contract
is covered against the real binary — but the two have not been joined on a
live thread.
