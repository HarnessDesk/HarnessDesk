# @harnessdesk/client

Read-only clients for a desk's outside-client door. The core imports only
`@harnessdesk/protocol`; filesystem discovery and `ws` live in the Node entry.

```ts
import { connect } from '@harnessdesk/client'
import { resolveDesk, localTransport } from '@harnessdesk/client/node'

const desk = await resolveDesk()
const client = await connect({
  transport: () => localTransport(desk),
  client: { name: 'demo-client', version: '0.1.0' },
  subscribe: { topics: ['runs', 'cards', 'teams', 'waiting', 'notices'] },
})
try {
  console.log(await client.call('goal/list', {}))
  for await (const event of client.events()) console.log(event)
} finally {
  client.close()
}
```

`ClientTransport` sends parsed `WireRequest` objects and delivers parsed
`HostToClient` objects through `onMessage`. `onMessage` and `onClose` return
functions that detach their listeners. `close` closes that transport.
`connect` needs a factory, so it can open a fresh transport after a loss.

Calls have a 30-second deadline by default, overridable with
`{ deadlineMs }`. Calls are never retried. A lost transport rejects its
in-flight calls with `WireCallError.code === 'disconnected'`. A method
missing from the handshake's advertised methods rejects locally with
`deskTooOld`. Wire refusals preserve their code, message, details and data;
`notOnClientSurface` is a refusal. `ClientMethodName` restricts TypeScript
callers to the protocol's client allowlist.

`events()` is the stable version-1 vocabulary. It begins with `hello`.
After a loss, the client reconnects with backoff, repeats hello and the latest
subscription, and emits `gap` before the new whole-state baseline. Consumers
should discard their previous projection on `gap` and rebuild from the events
that follow. Scoped subscriptions also read `flow/execution` after subscribing,
so they observe runs that ended during a disconnect. A replacement
`client/subscribe` call changes both event topics and the subscription replayed
on the next connection. `host/shutdown` emits `end` with `desk-closed` and stops
reconnection. `close()` emits `end` with `interrupted`.

`notifications()` is **unstable raw wire vocabulary**. Both streams buffer
arrival order independently of calls. Consume each stream once; buffers are
unbounded, so close the client when observation is finished.

The Node entry exports `DeskPointer`, `findDesks({ env? })`,
`resolveDesk({ home?, env? })`, and `localTransport(desk)`. Discovery only reads;
it excludes stale pointers and never deletes them. An explicit home is
authoritative, then `HARNESSDESK_HOME`, then `~/.harnessdesk`. A missing desk
raises `noDesk` and names other live desks. Unsafe ownership, modes or symlinks
raise `unsafeDirectory`, `unsafeSocket`, or `unsafePointer`. The Node entry
checks directory ownership and mode `0700`, and socket/pointer ownership and
mode `0600`, before using them. `HARNESSDESK_CLIENT_DIR` overrides the normal
`/tmp/harnessdesk-<uid>` client directory for isolated rigs.
