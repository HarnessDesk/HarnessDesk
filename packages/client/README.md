# @harnessdesk/client

Outside clients for a desk's outside-client door. The core imports only
`@harnessdesk/protocol`; filesystem discovery and `ws` live in the Node entry.

```ts
import { connect } from '@harnessdesk/client'
import { resolveDesk, localTransport } from '@harnessdesk/client/node'

const desk = await resolveDesk()
const client = await connect({
  transport: () => localTransport(desk),
  client: { name: 'demo-client', version: '0.1.0' },
  subscribe: { topics: ['runs', 'cards', 'teams', 'seats', 'reviews', 'waiting', 'notices'] },
})
try {
  await client.synced()
  console.log(client.snapshot())
  await Promise.all([
    (async () => { for await (const event of client.events()) console.log(event) })(),
    // Drain the independent raw buffer even when only stable events are needed.
    (async () => { for await (const _ of client.notifications()) {} })(),
  ])
} finally {
  client.close()
}
```

`ClientTransport` sends parsed `WireRequest` objects and delivers parsed
`HostToClient` objects through `onMessage`. `onMessage` and `onClose` return
functions that detach their listeners. `close` closes that transport.
`connect` needs a factory, so it can open a fresh transport after a loss.

Calls have a 30-second deadline by default, overridable with
`{ deadlineMs }`. A scoped subscription uses that one deadline for both its
subscription and its follow-up execution read. Calls are never retried. A lost transport rejects its
in-flight calls with `WireCallError.code === 'disconnected'`. A method
missing from the handshake's advertised methods rejects locally with
`deskTooOld`. Wire refusals preserve their code, message, details and data;
`notOnClientSurface` is a refusal. `ClientMethodName` restricts TypeScript
callers to the protocol's client allowlist.

Subscription topics are `runs`, `cards`, `teams`, `seats`, `reviews`,
`waiting` and `notices`. The same Team, run or project scope applies to
`seats` and `reviews`; a run scope selects its Team's seats. The `runs`
baseline holds the active runs in scope; a Team scope also holds that Team's
newest run after it has ended, and a run scope holds the named run.

`events()` is the stable version-1 vocabulary: `hello`, `run.changed`,
`card.changed`, `team.changed`, `seat.changed`, `review.changed`, `waiting`,
`waiting.cleared`, `notice`, `gap` and `end`. It begins with `hello`.
After a loss, the client reconnects with backoff, repeats hello and the latest
subscription, and emits `gap` before the new whole-state baseline. Consumers
should discard their previous projection on `gap` and rebuild from the events
that follow. Scoped subscriptions also read `flow/execution` after subscribing,
so they observe runs that ended during a disconnect. A replacement
`client/subscribe` call commits only on the desk's successful acknowledgement,
then emits `gap` with `subscription-changed` and resets its projection before
the new whole baseline arrives. Refused proposals leave the acknowledged topics,
projection and reconnect selection intact, including concurrent proposals.
Unsubscribing and resubscribing replay unchanged items. An accepted subscription
remains selected even if its extra execution read exceeds the call's deadline.
An unacknowledged subscription timeout discards that uncertain connection and
reconnects the last acknowledged selection, so a late baseline cannot be mixed
into the previous scope.

`seat.changed` maps the host's `seat/activity` snapshots, deduplicated by
Team and seat over state, doing, card and role. Its `seat` is
`runtime:sessionId`. `doing` is `{ kind: 'tool', tool, target? }` or
`{ kind: 'thinking' }` while working, otherwise `null`; it carries a tool
and at most a safe path. Optional `since` comes only from the host's record.

`review.changed` reads `finding/run`'s `rounds` and emits a changed state,
reason, pull request or card list per run and round. With `reviews` selected,
the client discovers all scoped runs, including finished ones, after the
initial subscription and each new baseline. A run scope uses the exact
`flow/execution` read. Each `finding/changed` discovers that Team's new runs
and refreshes its review rounds. Reads are sequential per Team; a burst
leaves at most one running batch and one queued batch. A failed background
read emits a `notice` with the desk's message; another invalidation can
refresh it, with no automatic retry or periodic reads. The host sends no
review baseline itself. A reviewed round without a publication decision
has state `none`; the run's `publication` remains the aggregate.

`host/shutdown` emits `end` with `desk-closed` and stops reconnection. `close()`
emits `end` with `interrupted`. A fatal protocol or permission refusal during
reconnection emits `end` with `error`, then `events()` throws the original
`WireCallError` after its buffered events have been read. `notifications()` also
throws that same error after its buffered notifications. These failures stop
reconnection; `desk-closed` is reserved for an actual shutdown notification.

`notifications()` is **unstable raw wire vocabulary**. Both streams buffer
arrival order independently of calls. Consume each stream once; buffers are
unbounded. During a subscription, drain both streams, discarding the vocabulary
you do not use, and close the client when observation is finished.

The Node entry exports `DeskPointer`, `findDesks({ env? })`,
`resolveDesk({ home?, env? })`, `localTransport(desk, { env? })`, and
`canonicalProject(path)`. The project helper matches the host's identity:
filesystem realpath when available, otherwise an absolute resolved path.
Discovery only reads;
it excludes stale pointers and never deletes them. An explicit home is
authoritative, then `HARNESSDESK_HOME`, then `~/.harnessdesk`. A missing desk
raises `noDesk` and names other live desks. Unsafe ownership, modes or symlinks
raise `unsafeDirectory`, `unsafeSocket`, or `unsafePointer`. The Node entry
checks directory ownership and mode `0700`, and socket/pointer ownership and
mode `0600`, before using them. `HARNESSDESK_CLIENT_DIR` overrides the normal
`/tmp/harnessdesk-<uid>` client directory for isolated rigs.

The `views` entry imports only protocol and its own pure functions. The
window and outside clients share `teamOverview(input)`;
`teamOverviewOf(snapshot, team, { report, runtimes, sentences? })` adapts a
client snapshot to that same model. `runtimes` carries each runtime's `id`,
`name` and `metered` from `client.hello`; `report` is the `insight/goal` result
or `null`. Unread marks belong to the window and are absent from client rows.
`TeamOverviewInput.run.startedAt` stays caller-supplied as `number | null`.
The snapshot selector uses the execution’s recorded start time and leaves an
unknown start time null.

```ts
import { teamOverviewOf } from '@harnessdesk/client/views'

await client.synced()
const snapshot = client.snapshot()
for (const team of snapshot.teams) {
  const report = await client.call('insight/goal', { goal: team.goal.id })
  console.log(teamOverviewOf(snapshot, team.goal.id, { report, runtimes: client.hello.runtimes }))
}
```

`synced()` waits for the current subscription's counted baseline to arrive and
apply, including its initial review-round reads. Call it again after each
`gap`. The subscribe acknowledgement is `{ baseline: number }`; the door sends
exactly that many contiguous baseline notifications before live changes. An
older desk without that count is refused with `deskTooOld`. Later live review
refreshes do not delay initial synchronization. Failed background reads emit
`notice` and finish their bootstrap pass. A clean stream end resolves pending
waiters; a fatal end rejects them with the same error the streams throw.

`snapshot(): ClientSnapshot` returns detached plain arrays: `teams`
(`GoalView[]`), `runs` (`FlowExecution[]`), `boards` (`TeamState[]`), `seats`
(`SeatActivity[]`), open `approvals` (`{ runtime, sessionId, approval }[]`),
the current `waiting` items (with the stable ids used by `waiting.cleared`),
and `reviews` (`{ run, rounds }[]`, with `FindingRoundPublication[]` per run).
Mutating any returned value does not change the held state. A new baseline
replaces it; board and activity changes update the held Team facts.


The door grants `read` and `run` by default. `flow/catalog`, `flow/source`
and `flow/preview` are reads; `workspace/open` and `flow/start-goal` need run.
`answer` is off by default. Settings › Permissions › Local clients grants it
through `clientsMayAnswer: true`; `HARNESSDESK_CLIENTS_MAY_ANSWER=1` grants
it for scripted desks. The host checks that choice for every call, including
connections whose hello was earlier.

`flow/execution/stop` needs `run` and returns ended runs unchanged.
`team/intent` is action-tiered: `abandon` needs `run`; `done` needs `answer`
and a live card the frozen Flow addressed to a person, with one of that
role's declared outcomes. Other actions remain off the client surface.
The first answer owns the card and its handoff; another client receives
`alreadyAnswered`. Both waiting subscribers converge on the same stable
resolved id. Client answers carry the stated client's name on the Team's
channel as answered from the command line. An abandon returns
`{role, nextRole}` after the ordinary Flow continuation; either can be null
when no role was bound or no next round opened. Abandoning keeps the rules
in play; stopping the run ends them.

A Flow start redeems a single-use preview token bound
to source, inputs, per-role `seats` and `attended` (true by default). Execution
records and receipts preserve attendance and overrides. An unattended start
uses a trigger's unattended ceiling policy (asked ceilings are refused by
default), question timeout and late-answer path.

Socket ownership and modes authorize the local user; tiers restrict verbs,
not other processes owned by that user. Node `localTransport` refuses spending
when the environment carries `HARNESSDESK_GOAL_ID` or `HARNESSDESK_LANE_ID`, so
one of the desk's own Seats uses its board tools. Removable environment markers
are an accident guard, not authentication. Refusals preserve `WireCallError`
codes through the core. Caller-side `readTextFile(path)`, `repositoryRoot(cwd?)`
and `readConfirmation(question)` keep CLI filesystem and terminal dependencies
in the Node entry; they never ask the desk to read caller file paths.
