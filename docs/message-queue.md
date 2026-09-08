# The message queue: typing while the agent works

*Designed and built 2026-08-24.*

## What it is

While a turn is running you can keep typing. Enter **queues** the message: the
host holds it and sends it when the turn ends, one message per turn, in the
order you typed them. What is waiting shows in a strip above the composer,
where you can reorder it, edit it, or throw it away before it goes.

Before this, pressing Enter mid-turn attempted to steer into the running turn.
Only Codex supports steering; agents connected over ACP — the Agent Client
Protocol (Claude Code, Cursor, and DeepSeek Harness) — refuse input while
working and reject steering. Because the composer had already cleared its text
and chips by then, a message typed while the agent worked was **destroyed**
and replaced by an error toast.

## Expected behaviour

This is the contract. Every row is a thing you do and what follows; ✓ marks
what has been seen in the macOS app on both Codex and Claude Code, driven by
real keystrokes and mouse clicks.

### Sending

| You do | What happens |
| --- | --- |
| Enter, nothing running | Sent now, exactly as before ✓ |
| Enter **while a turn runs** | Queued. The strip appears, the composer clears ✓ |
| Enter while the queue is **held** | Joins the back of the queue. The composer says *"Adds to the 1 message already waiting"* (or *N messages*) — never a silent no-op ✓ |
| **⌘↵** / **Ctrl+↵** where the agent can steer | Steers into the running turn: no new turn, nothing queued ✓ (Codex) |
| **⌘↵** / **Ctrl+↵** where it cannot | Queues, exactly like Enter. The placeholder never offers what the runtime refuses ✓ |
| Queueing beyond the cap (25 messages, or 100k characters total) | Refused out loud; your draft stays in the composer |

### Delivery

| Then | What happens |
| --- | --- |
| The turn finishes **cleanly** | The head of the queue goes out as **its own turn**, and is answered ✓ |
| Several are waiting | One per turn, in the order typed — never merged ✓ |
| The turn is **stopped** | The queue **holds**. Nothing sent, nothing lost ✓ |
| The turn **fails** — a limit, a crash | The same hold, carrying the backend's own reason |
| The agent goes down | Held, not dropped |

### While it waits

| You do | What happens |
| --- | --- |
| **Drag** on a row's grip handle | Reorders, dropping anywhere in the line ✓ |
| Hover and click **↑** / **↓** on a row | Moves one step earlier or later ✓ |
| Click **✎** (Edit) on a row | Returns to the composer, text, attachments, and note chips intact. Enter re-queues at the back ✓ |
| Click **✕** (Remove) on a row | That one is gone; the rest keep their order and the queue keeps its status ✓ |
| Click **✕** on the last row | The strip disappears, and nothing is ever sent ✓ |
| **Send now** on a held queue | The head goes out; the queue resumes ✓ |
| **Discard** / **Discard all** | The whole queue is thrown away ✓ |
| ⌘R, or the window reopened | The queue comes back, its hold and reason intact ✓ |

A held queue puts its conversation in the sidebar's **Needs you** band, because
that is exactly what it is.

## Why it is built this way

### The queue is the host's

No backend has the concept, so something above them has to. A queue in the
renderer would die on ⌘R and could not fire for a window nobody has open, and
the host already folds every event — it is the one place that knows a turn has
ended, for every agent. It also becomes the machinery inter-agent delivery
needs ([multi-agent.md](multi-agent.md): *"held and delivered at the turn's
end"*).

It sits **beside** the conversation rather than inside it — the way approvals
do — because agent adapters re-emit whole sessions on a resume or a re-read,
and one of those must never be able to erase what you have waiting.

It lives in memory, not on disk. A session is not live after a host restart, so
a persisted queue could not deliver anyway, and a message that fires the next
day is worse than a lost draft.

### One message, one turn

Merging two of your messages into a single turn would put words in your mouth.
Each was written as its own instruction and each gets its own turn and its own
answer.

### Delivery only on a clean finish

A turn that was stopped or that failed **pauses** the queue and says why in the
turn's own words. This is the one place the design refuses to guess.

Consider what the two mistakes cost. If the queue fires when it should not, a
turn runs that you did not want — spending money, possibly editing files, from
instructions you wrote before you knew what you know now. If it holds when it
could have gone, you click **Send now**. So it holds, visibly, with the reason
on screen.

Pressing Stop is the sharpest case. You might mean *"stop and do this instead"*
— but you might mean *"stop everything"*, and the two look identical from here.
The strip shows exactly what is waiting and offers both answers.

### The composer says what Enter will do

The placeholder changes with the state, and the wording comes from the
runtime's declared capability rather than its name:

| State | Placeholder |
| --- | --- |
| Idle | *Describe a task — / for commands, @ for files* |
| Busy, agent can steer | *Type the next message — ↵ queues it, ⌘↵ adds it to this turn* |
| Busy, agent cannot | *Type the next message — it is sent when this turn ends* |
| Messages waiting (queue held or idle) | *Adds to the 1 message already waiting* / *Adds to the N messages already waiting* |

**Stop and Queue sit side by side** while a turn runs: Stop takes the corner
position where Send was, and the Queue button appears inboard of it as soon as
you start typing. Neither replaces the other while you type, so the control
under your pointer never shifts meaning. The queue button appears only when
there is something to queue.

### A send that fails puts the draft back

The whole feature exists so that a typed message is never lost. The one path
that can fail — the host refusing a full queue — returns your text and chips
to the composer rather than swallowing them.

## The strip

Above the composer, with the goal and the running jobs — ambient state about
the conversation, always on screen, never in the way when empty. Not at the
tail of the transcript: the queue is the *draft's* future, not the
conversation's past, and a strip that scrolls away is one that gets forgotten
with three messages in it.

```
┌────────────────────────────────────────────────────────────────────────┐
│ ≡+ 3 messages waiting — sent when this turn ends           Discard all │
│ ⋮⋮  1  Reply with exactly: SECOND                1 file     next       │
│ ⋮⋮  2  Reply with exactly: THIRD                1 context   then  ^v✎✕ │
│ ⋮⋮  3  Reply with exactly: FOURTH                                      │
└────────────────────────────────────────────────────────────────────────┘
```

Each row carries a grip handle for dragging, its position number (or a spinner
while being handed to the agent), what was typed, counts for any attached
files, images or context blocks, and a timing badge: **next** on the first row,
**then** on the second (rows beyond the second rely on their number), and
**held** on every row when the queue is paused.

Row controls appear on hover — four buttons on every row would read as more
chrome than the message. A row being delivered shows a spinner and loses its
controls, so there is nothing to fight over. Held, the header turns amber,
names the reason, and gains **Send now**.

Every control is a *request* to the host, and the rows redraw from the queue
event that answers it. That is what keeps two windows on the same conversation
from disagreeing.

## What travels

A queued message carries the same content that would have gone to the agent:
text, images, `@` file mentions, skills, and any resolved context blocks (from
plugin context chips or page annotations).

Two limits apply before queueing:
- **Action commands bypass the queue.** An inline slash command with arguments
  (`/open src/a.ts`) runs locally on the workbench immediately on Enter; it is
  never sent to the agent and does not queue.
- **Images require agent support.** If an agent's runtime declares no image
  capability, attaching an image is refused with a warning notice rather than
  queued.

Editing returns the text to the composer and restores attachments as chips.
Resolved context blocks return as **note chips** holding exactly what was
queued. The provider is not asked to resolve again — its chip was already
consumed — and the text is not dumped into the text box for you to scroll past
or edit around. What the message promised to carry stays attached.

## Where the code is

- `packages/protocol/src/session.ts` — `QueuedMessage`, `SessionQueue`,
  `QueueStatus`, `emptyQueue`.
- `packages/protocol/src/events.ts` — `session/queue`, the whole list replacing
  the previous one.
- `packages/protocol/src/wire.ts` — `turn/queue`, `turn/queue/cancel`,
  `turn/queue/move`, `turn/queue/flush`, `turn/queue/clear`, and `queues` on the
  `sync` notification.
- `packages/server/src/registry.ts` — `SessionRecord.queue` and its mutators;
  `QUEUE_LIMIT` (25), `QUEUE_CHAR_LIMIT` (100,000).
- `packages/server/src/methods/turns.ts` — handlers for `turn/queue`,
  `turn/queue/cancel`, `turn/queue/move`, `turn/queue/flush`,
  `turn/queue/clear`.
- `packages/server/src/host.ts` — `#drain`, `#queueBusy`, `#sendNow`, holding
  on uncompleted turns, and holding on runtime detach.
- `packages/ui/src/lib/queue.ts` — `describeQueued`, `queuedLabel`.
- `packages/ui/src/components/MessageQueue.tsx` — the strip (drag-and-drop,
  arrow buttons, editing into note chips, discard, flush).
- `packages/ui/src/components/Composer.tsx` — Enter and ⌘↵ / Ctrl+↵ dispatch,
  placeholder text, Stop and Queue buttons.

## Decisions recorded

- **Enter queues; it does not steer.** Steering is a real feature and it kept
  its shortcut (⌘↵ / Ctrl+↵), but it cannot be what the *default* key does
  when three of the four agents refuse it. Offered by capability, never by
  brand.
- **The composer uses one path for sending**, idle or busy. The host decides
  whether it waits — it sends at once on an idle conversation — so the
  renderer and the host cannot disagree about the state at the moment Enter was
  pressed.
- **A full queue is an error, not a drop.** A cap that silently swallowed the
  message would be the original bug wearing a different hat.
- **An agent going down holds rather than clears.** A runtime that went down
  came back once already; your words are the part worth keeping. **Send now**
  then means it: the drain reopens the conversation itself where the agent can
  be resumed, rather than finding no handle and holding again with the same
  sentence.
- **No persistence across a host restart.** See above — a dead session cannot
  deliver, and a stale message firing later is worse than a lost draft.
- **Action commands bypass the queue.** Inline workbench commands (`/open`)
  execute locally upon pressing Enter; they never wait behind an agent turn.
- **Context chips return as note chips on edit.** An edited message preserves
  resolved context blocks without re-querying consumed providers or dumping
  raw text into the draft.
