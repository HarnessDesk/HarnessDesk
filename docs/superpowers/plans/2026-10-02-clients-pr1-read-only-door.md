# PR 1: the read-only client door

*2026-10-02. The first code pull request of
[the clients design](../specs/2026-10-02-clients-outside-the-window-design.md),
approved by the owner. Read the spec first. Where this plan and the spec
disagree, the spec is right and this plan is a bug: stop and say so.*

**Goal.** A person can watch a running desk from a terminal:

- `harnessdesk desks` lists the desks running for this user;
- `harnessdesk status`, `teams` and `runs` read one desk;
- `harnessdesk watch --json` streams its runs, cards, Teams, waiting items and
  notices, one line per change.

The desk serves this through a door of its own, a unix socket whose
permissions are the credential, open to the `read` tier only.

**Not in this PR.** No `run` or `answer` tier and nothing that changes
anything. Also left out:

- `seat.changed` and `review.changed` (PR 1b);
- the `views` entry (PR 1b);
- `flow preview` and `flow start` (PR 2);
- `flow/execution/stop` (PR 3);
- the in-app install item (PR 4);
- Windows (the door stays off there; see *Windows* in the spec).

## Global constraints

These bind every task:

- **AGENTS.md applies whole.** In particular:
  - rule 2: a wire method is declared in `wire.ts`, validated in
    `wire-validators.ts`, and answered in `methods/<domain>.ts`;
  - rule 13: no real account, email, handle or home path anywhere. Tests use
    `dev@example.com` and `Jane Doe`;
  - the layering gate.
- **Run what you change.**
  - A proof is only a proof if it ran. Say in your hand-off which commands
    you ran, and their exit codes.
  - If your sandbox refuses to bind a unix socket, run those proofs through
    the desk's declared check, and say which proofs ran where.
  - Never claim a test passes because it looks right.
- **Never move a test below the thing it tests,** and name any change to a
  shared test helper.
- **Socket paths in tests are short.** Make the socket directory with
  `mkdtemp('/tmp/hd-door-')`, never under `os.tmpdir()`. A long temp
  directory overruns the 104-byte unix-socket limit on macOS, and Node then
  crashes rather than refusing.
- **Public text names no other product as a reference, and describes no
  security weakness.** Public text means code comments, docs, commit
  messages and the PR body. Describe today's outside tooling neutrally, as
  scripts that call the window's own store.
- **Commits.** Small commits in the order of the tasks below, each building
  on its own. End every commit message with
  `Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>`.
- **`pnpm verify`,** unpiped, before you hand off. A piped run reports the
  pipe's exit status, not the gate's.

## Task 1: the client surface, in protocol

New file `packages/protocol/src/client-surface.ts`, exported from the
package index:

```ts
export type ClientTier = 'read' | 'run' | 'answer'
export type ClientTopic = 'runs' | 'cards' | 'teams' | 'waiting' | 'notices'

/** The only methods the client door answers, each with the tier it needs. */
export const CLIENT_METHODS = {
  'client/hello': 'read',
  'client/subscribe': 'read',
  'goal/list': 'read',
  'goal/read': 'read',
  'flow/catalog': 'read',
  'flow/execution': 'read',
  'flow/executions': 'read',
  'runtime/health': 'read',
} as const satisfies Partial<Record<HostMethodName, ClientTier>>

export type ClientMethodName = keyof typeof CLIENT_METHODS
export const CLIENT_TIERS_GRANTED_BY_DEFAULT: readonly ClientTier[] = ['read']
export const CLIENT_PROTOCOL = 1
```

Then, in `wire.ts`, declare three methods with their result types:

- **`client/hello`.**
  - Params: `{ client: { name: string; version: string }; protocol: number; pid?: number }`.
  - Result: `{ protocolVersion; hostVersion; desk: { home; pid; startedAt }; tiers: readonly ClientTier[]; runtimes: readonly { id: RuntimeId; name: string; health: RuntimeHealth }[] }`.
  - `name` comes from `RuntimeInfo.presentation`, so no brand is hard-coded anywhere.
- **`client/subscribe`.**
  - Params: `{ topics: readonly ClientTopic[]; scope?: { team?: GoalId; run?: string; project?: string } }`.
  - Result: `null`.
- **`flow/executions`.**
  - Params: `{ team?: GoalId; project?: string; active?: boolean }`.
  - Result: `readonly FlowExecutionSummary[]`, newest first, where `FlowExecutionSummary = { id; team: GoalId; flow: string /* document name */; state; round: number | null; role: string | null; reason: string | null; startedAt: number | null }`.
  - Read the stored record for a start time. If the record has none, return `null`; do not invent one from the clock.
  - `active` defaults to true: only `running` and `stalled` runs.

Validate all three in `wire-validators.ts`:

- a topic outside `ClientTopic` is refused;
- `client.name` and `client.version` are at most 64 characters.

Tests sit beside the existing validator tests.

## Task 2: listing runs, on the host

1. `FlowExecutions` (`packages/server/src/flow-execution.ts`) gains a read
   that lists its runs. `Flows` (`packages/server/src/flows.ts`) passes it
   through, filtered by Team and project, and maps each run to a
   `FlowExecutionSummary`.
2. `flow/executions` is answered in `packages/server/src/methods/flows.ts`.
3. Test it with a hand-built context, the way
   `packages/server/test/methods.test.ts` does. Cover:
   - newest first;
   - `active` filtering;
   - the Team filter;
   - the project filter;
   - a run whose record has no start time.

Another session also edits `flow-execution.ts`. Fetch `main` before you
start, and keep this change to one small read.

## Task 3: `client/*` from the window's door is refused

New module `packages/server/src/methods/client.ts`, which `satisfies
MethodsUnder<'client/'>`. It is registered in `methods/index.ts` and its
`methodDomains`.

Both handlers throw a wire error with code `clientDoorOnly`, because these two
methods only mean something on the client door, which answers them itself
(Task 5). Test that the window's door refuses them with that code.

## Task 4: the audit log learns about the client door

`AuditEntry` (`packages/server/src/audit.ts`) requires a runtime and a
session, and a client call has neither. Turn the type into a discriminated
union:

- the existing entry, unchanged;
- a client entry: `{ at; kind: 'client/connected' | 'client/call' | 'client/refused' | 'client/closed'; client: string /* name@version */; statedPid: number | null; method?: string; tier?: ClientTier; code?: string }`.

Existing readers of the audit log must keep working; find every reader and
check it. Add a test that a client entry round-trips and that the existing
per-session reading ignores it.

## Task 5: the client door

New module `packages/server/src/client-door.ts`:

```ts
export interface ClientDoorOptions {
  readonly host: Host
  readonly logger: Logger
  readonly home: string                 // the desk's state directory
  readonly directory?: string           // default /tmp/harnessdesk-<uid>; HARNESSDESK_CLIENT_DIR overrides
  readonly hostVersion: string
}
export interface ClientDoor { readonly socketPath: string; close(): Promise<void> }
export const openClientDoor = async (options: ClientDoorOptions): Promise<ClientDoor | null>
```

What it does, in order:

1. **On `win32`, it returns `null` and logs why.** This PR does not open the
   door on Windows.
2. **It works out the paths.** `h` is the first 16 hex digits of
   `sha256(realpath(home))`. The socket is `<directory>/<h>.sock` and the
   pointer is `<directory>/<h>.json`. Write this as an exported pure function
   and test it.
3. **It checks the directory.** Use `lstat`, never `stat`.
   - If the directory is absent, create it with mode `0700`.
   - If it is present, it must be a directory (not a symlink), owned by
     `process.getuid()`, and its mode must be exactly `0700`.
   - Anything else refuses: log the reason and return `null`. The desk keeps
     running without a door, and Settings will show the reason in a later PR.
     Never "fix" a directory you do not own.
   - Take the filesystem calls as an injectable parameter, so the refusals can
     be tested without a second user.
4. **It claims the socket path.** If a socket file is already at the path:
   - try to connect to it;
   - if something answers, another desk with the same home is running.
     Refuse, and leave both files alone;
   - if nothing answers, the socket is stale: remove it.
5. **It listens.** Use `http.createServer()` with a `WebSocketServer` in
   `noServer` mode, upgraded on `/client`, listening on the socket path, then
   `chmod` the socket to `0600`. The upgrade takes no token.
6. **It writes the pointer last,** mode `0600`:
   `{ home, pid, hostVersion, protocolVersion, startedAt }`. It holds nothing
   secret.
7. **On `close()`,** it closes every client with code 1001, closes the
   server, and removes the socket and the pointer, but only if the pointer
   still names this pid.

**Each connection is a small state machine:**

- **Before hello.** Every method but `client/hello` is answered
  `helloFirst`, and nothing is pushed.
- **Hello.**
  - `protocol !== CLIENT_PROTOCOL` answers `incompatible` with both numbers
    in the error's `data`, and the connection closes.
  - Otherwise, answer the hello result, with `tiers` set to the granted
    tiers (`['read']`). Audit `client/connected`.
- **Every other request.** Parse it with the same `parseClientMessage` the
  window's door uses. Then:
  - a method not in `CLIENT_METHODS` answers `notOnClientSurface`, even when
    it is valid;
  - a method whose tier was not granted answers `tierNotGranted`;
  - both refusals are audited (`client/refused`);
  - an allowed method goes to `host.call()`, exactly as on the window's
    door, and is audited as `client/call` with its outcome.
- **`client/subscribe`.**
  - It records the topics and the scope, then sends each topic's current
    state as notifications, in the same shapes later changes arrive in.
  - `runs`: `flow/execution-changed` for each active run in scope.
  - `cards`: `team/changed` for each Team board in scope.
  - `teams`: `goal/changed` for each Team in scope.
  - `waiting`: `event` with `approval/requested` for each pending approval
    whose session belongs to a member Seat of a Team in scope (the session
    pointer is in `SeatRecord.session`), plus the cards in scope addressed to
    a person. A card addressed to a person needs the `cards` baseline, so
    `waiting` implies it.
  - `notices`: nothing to replay.
  - A second `subscribe` replaces the first.
- **Broadcasts.** The door registers one broadcaster with
  `host.addBroadcaster` and filters every notification through one exported,
  tested function, `topicsOf(notification): readonly ClientTopic[]`, plus a
  scope test.
  - `event` passes only for `approval/requested` and `approval/resolved`, and
    only under `waiting`.
  - `sync`, `editor/plane`, terminal output and every other notification
    never reach an outside client.
  - `host/shutdown` always passes.
- **Scope.**
  - A Team scope matches that Goal's run executions, that Goal's board and
    that Goal's view.
  - A run scope matches that run and its Goal's board.
  - A project scope matches Goals whose root is the project.
  - Verify how a Goal's board is addressed (`GoalView.board`, `TeamState.id`)
    before you write the match, and test each kind of scope.
- **Close.** Audit `client/closed` and drop the broadcaster.

**Tests.**

Test the module over a real socket in a short `/tmp` directory, using the
host fixtures in `packages/server/test/fixtures/harness.ts`
(`start`/`stop`). Cover:

- directory refusals: not owned, wrong mode, a symlink;
- the stale socket is removed;
- a live socket refuses the second desk;
- the socket's mode is `0600`;
- the pointer is written and then removed;
- hello-first;
- `incompatible`;
- `notOnClientSurface` for a valid method that is off the surface, such as
  `terminal/create`;
- each topic's baseline and its filtering;
- scope;
- `sync` never arrives;
- `host/shutdown` arrives;
- the audit entries.

## Task 6: the desk opens its door

- **Desktop.** In `packages/desktop/electron/main.mjs`, call `openClientDoor`
  right after `serve()`, with `home` set to the shell's `stateDir`. Close it
  on quit, before the host is disposed.
- **Standalone host.** Do the same in `packages/server/src/bin.ts`.
- **A door that refuses** leaves the desk running and is logged once.
- **Docs.** Update `docs/architecture.md`:
  - The paragraph that says the renderer's socket is the only route now
    names the client door as the second, with its allowlist and tiers.
  - The package table gains `client` and `cli`, and the package count
    changes to match.

## Task 7: `@harnessdesk/client`

New package `packages/client`, modelled on `packages/transport-acp`'s
`package.json` and `tsconfig.json`, and added to the root `tsconfig.json`
references. It has two entries:

- **The core** (`.`, `src/index.ts`) imports `@harnessdesk/protocol` and
  nothing else. No `node:*` import.
  - `ClientTransport` (send, onMessage, onClose, close).
  - `connect({ transport, client, subscribe? })`, which sends hello first and
    returns a `Client` whose `hello` is the result.
  - `client.call(method, params, { deadlineMs? })`:
    - `method` is typed to `ClientMethodName`, so a method off the surface is
      a compile error.
    - The default deadline is 30 seconds.
    - A call is never retried. A call in flight when the transport closes
      rejects with `disconnected`.
    - It rejects with a `WireCallError { code, message, details, data }`.
  - `client.notifications()`: the raw notifications, as an async iterable.
    Documented as unstable.
  - `client.events()`: the stable version-1 vocabulary from the spec's event
    table, limited to the rows this PR can fill: `hello`, `run.changed`,
    `card.changed`, `team.changed`, `waiting` and `waiting.cleared`,
    `notice`, `gap` and `end`.
    - It derives them by diffing the whole-state notifications per item (a
      run's state, round and reason; a card's state and outcome). It emits
      only on a change.
    - When the transport drops, it reconnects with backoff, says hello
      again, subscribes again, yields `gap`, and then whatever differs.
  - Notifications are buffered in order, and a slow `events()` consumer
    never blocks a call.
- **The node entry** (`./node`, `src/node.ts`):
  - `findDesks()` reads the pointers in the client directory, drops every
    stale one (dead pid, or a socket that refuses), and never deletes
    anything.
  - `resolveDesk({ home, env })`:
    - An explicit home is authoritative. No desk for it is an error that
      names the desks it did find.
    - It checks ownership and modes as the host does, before connecting.
  - `localTransport(desk)` is a WebSocket over the unix socket, through
    `ws`, `ws+unix://<path>:/client`.

**Tests**, with a scripted transport:

- hello first;
- a deadline;
- `disconnected` for an in-flight call;
- no retry;
- each event derived from a notification sequence;
- no event when nothing changed;
- `gap` after a reconnect;
- the type-level refusal: a `// @ts-expect-error` call to `terminal/create`
  in a test that the build compiles.

## Task 8: `harnessdesk`

New package `packages/cli`, whose `bin` is `harnessdesk` → `dist/src/bin.js`.
It imports `@harnessdesk/client` and `@harnessdesk/protocol` only.

**The commands, and only these:**

| Command | Wire methods |
| --- | --- |
| `desks` | the pointers, then `client/hello` on each |
| `status` | `client/hello`, `goal/list`, `flow/executions` |
| `teams [--project P]` | `goal/list` |
| `runs [--team T \| --project P] [--all]` | `flow/executions` |
| `watch [--team T \| --run R \| --project P] [--until settled]` | `client/subscribe` |

**Conventions** (the spec's *Conventions* section is the full text):

- `--home <dir>` or `HARNESSDESK_HOME` picks the desk.
- `--json` prints one object, and `watch --json` prints one per line, opening
  with `hello` and closing with `end`.
- Human output strips C0/C1 control characters and terminal escape sequences
  from every string that came from an agent. Put this in one tested function.
- Nothing secret is printed. There is none, and nothing sneaks a credential in.
- **Exit codes:**
  - 0 done;
  - 1 error;
  - 2 usage;
  - 3 no desk;
  - 4 refused;
  - 6 incompatible;
  - 130 or 143 on SIGINT or SIGTERM. On either signal, `watch` writes its
    `end` line first.
- `watch --until settled` with `--run` ends when that run is settled,
  stopped or stalled.

**A gate test** in `packages/cli/test` holds the command table to the
surface:

- every method a command declares is in `CLIENT_METHODS`;
- every `CLIENT_METHODS` entry is used by some command.

The command table is one exported constant that both the code and this test
read.

**An end-to-end test** starts a host from the server's test fixtures with its
door in a short `/tmp` directory, then runs the built `bin.js` as a child
process with `HARNESSDESK_CLIENT_DIR` set. It covers:

- `desks`;
- `status --json`;
- `runs --json`;
- `watch --json` until a change, then SIGINT, which exits 130 with `end` as
  the last line;
- exit 3 for a home with no desk;
- exit 6 against a stubbed incompatible door.

## Task 9: the gates and the record

1. **The layering gate** (`script/check-layering.mjs`) gains two rules:
   - `client` may import `@harnessdesk/protocol` and, in `src/node.ts` only,
     `ws` and `node:*`;
   - `cli` may import `@harnessdesk/client` and `@harnessdesk/protocol`.

   Neither may import `server`, `ui`, `desktop`, an adapter, `codex` or
   `cordis`. Add a fixture test for each rule, the way the existing rules are
   tested.
2. **`docs/decisions.md`** gains the entry drafted at the end of the spec,
   written for what this PR actually builds: the door, the allowlist, the
   tiers, with only `read` granted so far.
3. **The third-party notices check, and every other step of `pnpm verify`,**
   stays green.

## Done when

- `pnpm verify` exits 0, run unpiped.
- The proofs above ran, and the hand-off says where.
- On a throwaway desk (its own `HARNESSDESK_HOME`, never `~/.harnessdesk` or
  a shared desk), `harnessdesk watch --json` shows a Flow run's changes as
  they happen, with no polling.
- The PR body states what was run, the exit codes, and what this PR does not
  do.
