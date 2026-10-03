# Clients outside the window: one wire client, the command line first

*2026-10-02. Approved by the owner the same day, every decision as
recommended (listed at the end); nothing here is built yet. It covers
every client that drives a desk from outside its window: the `harnessdesk`
command line now, HarnessDesk Mobile later. The first real user is #1267
(under #1268). Measurements are from the code at `a07043d8f` and the Flow pilot
of the same day.*

## The goal

**Anything a person does to a desk from a terminal or a phone goes through one
small client library, over the desk's own wire, with a stated permission per
call.** Three claims a person can check:

1. **One client, three users.** The command line, our own maintainer tooling and,
   later, Mobile all use the same library. There is no second protocol and no
   private door.
2. **A local client has no credential to print, pass in argv, or store.**
   On this machine, file permissions are the credential, so there is no
   client secret to leak. (Text the desk relays — a card's title, a handoff,
   an approval's command — is the agents' text and may contain anything; a
   client shows it as data and never interprets it.)
3. **An outside client can do less than the window, on purpose, and the desk
   says exactly what.** Each method is on an allowlist with a tier. A person
   step answered from outside is recorded as answered from outside.

## What we have today (measured)

- **The host's only door is the window's.** It listens on `127.0.0.1` at a
  random port the desktop shell does not record, with a token minted at each
  launch and carried as `?token=` on `/ws` (`packages/server/src/server.ts`).
  The token lives in the shell process and the window's URL, and nowhere on
  disk.
- **So outside tooling drives the window itself.** Every script that drives
  a desk today (the Flow pilot's launcher, its approvals keeper, its
  watchers, and the maintainer skills) calls the window's own store,
  `window.__hdStore`. That store is private to the renderer and changes
  shape with it, so these scripts break whenever the window changes.
- **The wire already has almost everything.** 27 store calls are used by that
  tooling, and every one is a thin wrapper over a declared wire method
  (`flow/preview`, `flow/start-goal`, `flow/execution`, `team/intent`,
  `goal/preview`, `goal/wrap`, `finding/publications`, `approval/respond`,
  `turn/interrupt`, `workspace/open`, …). The only exceptions are pure view
  state, such as which room is on screen.
- **What the wire lacks for #1267:**
  - No method lists a Team's runs. Executions are not replayed when a client
    connects (sessions, editor plane, boards and pending approvals are). So a
    client learns of a run only if it was connected when the run changed, or
    if it already knows the run's id. This is why "a run started seconds
    earlier looked missing".
  - No method stops one run (#1247).
  - No per-run seat or effort override.
  - No per-run choice of who must be present.
- **An outside client needs a narrower door than the window's.** The window's
  door gives the window everything it draws: on connect, `sync` with every
  conversation and its loaded turns, then every change. An outside client
  wants a few topics, scoped to a Team or a run, and its calls recorded as
  its own. The client door adds both.
- **Approvals did not need a keeper.** The pilot's approvals keeper ran
  through three desk lifetimes on 2026-10-02 and answered **zero** approvals.
  It never saw a question it could not answer either: in that pilot, no flow
  seat raised an approval or a question that reached a client.

## Principles

1. **Same wire, same envelopes.** A client sends `WireRequest` and receives
   `WireResponse` and `WireNotification`, as the window does. The library
   adds no RPC of its own. A new capability is a wire method added the usual
   way (declare in `wire.ts`, validate in `wire-validators.ts`, answer in
   `methods/<domain>.ts`) before any client can use it.
2. **A second door, never a copy of the first.** Outside clients connect
   through their own listener. That listener serves an explicit allowlist of
   methods, and each method on it has a tier. The window's door is unchanged.
   This is how "the CLI can start a flow" stays true without also meaning
   "the CLI can open a terminal".
3. **Policy lives at the desk, decided before the work starts.** Who must be
   present for a run is chosen in its preview, frozen with the run, and
   enforced by the host. A client never races a person to click an approval.
4. **A stable contract for scripts, separate from internal state.** Wire
   notifications send state whole and change shape as the product grows. A
   script reads a small, versioned event vocabulary that the library derives
   from those notifications. Raw notifications are available, and labelled
   unstable.
5. **Designed for the relay, built for the machine.** The library's core has
   no Node in it, so Mobile can reuse it unchanged over the relay. Only
   discovery and the local socket are Node-only.

## The first journey (#1267)

A maintainer, or the Lead session on the owner's behalf, wants one issue worked
by a Team. Today this takes a script that drives the window, a keeper, a hand-made
clone, a copy of the flow file with its seats edited, an untracked brief file
and a 45-second polling loop. With this design it takes:

```bash
harnessdesk flow preview write-review-fix --project ~/code/app \
  --title "Fix #1175: bound root Node test timeouts" --brief-file brief.md \
  --seat writer=codex/xhigh --seat reviewer=claude-code/high

harnessdesk flow start write-review-fix --project ~/code/app \
  --title "Fix #1175: bound root Node test timeouts" --brief-file brief.md \
  --seat writer=codex/xhigh --unattended --yes --json
# {"run":"r_8f2…","team":"g_41c…"}

harnessdesk watch --run r_8f2… --json        # one line per change, no polling
harnessdesk card handoff g_41c… 3            # what the writer left the reviewer
harnessdesk run stop r_8f2… --reason "seat rule changed"   # #1247
```

The clone is no longer needed: a flow starts from a fetched base without
moving the person's checkout (#1262). The brief is the `brief` input, not the
card title. The seats are overridden for this run, and the preview shows the
override.

## The client door

### Transport and discovery

- **A unix-domain socket, carrying the same WebSocket framing as the window's
  door.** The host's existing connection handler serves it, with the
  differences below.
- **Where it is.** The socket is `/tmp/harnessdesk-<uid>/<h>.sock`, where `<h>`
  is the first 16 hex digits of `sha256(realpath(home))`, and `home` is the
  desk's state directory (`~/.harnessdesk` unless `HARNESSDESK_HOME` says
  otherwise).
  - The path is fixed-length, so it always fits the unix-socket limit, however
    deep a test desk's home is.
  - It is computable from the home alone, so `--home X` finds its desk without
    reading anything inside `X`.
- **Who may reach it.** The directory is `0700` and the socket is `0600`. The
  host creates the directory if it is absent. If it is present, the host
  checks it: owned by this user, mode exactly `0700`, and not a symlink. If
  any check fails, the host refuses to listen and says why in its log and
  under Settings. The client makes the same checks before connecting. Another
  user who pre-creates the directory gets a refusal, not a desk.
- **A pointer beside it.** `<h>.json` (`0600`) holds `home`, `pid`,
  `hostVersion`, `protocolVersion` and `startedAt`, and nothing secret. The
  desk writes it when it starts and removes it when it quits. A pointer whose
  pid is gone, or whose socket refuses, is stale: clients ignore it and the
  next desk removes it. `harnessdesk desks` lists the pointers.
- **No fallback between desks.** An explicit `--home` that resolves to no
  running desk is an error (exit 3). The client never connects to some other
  desk that happens to be up.
- **No token for local clients.** The file permissions are the credential, as
  they already are for the tool gateway's `run/tools.sock`. A token file was
  the alternative, and it is the first decision for the owner (below).
- **Linux** uses the same path and the same checks.

### Windows: a named pipe, held to the same rules

Windows has no `0700` directory to put a socket in, so the door is a named
pipe, `\\.\pipe\harnessdesk-<user>-<h>`. `<user>` is a short hash of the
person's account SID, and `<h>` is the same hash of the desk's home. Each
rule above has a Windows counterpart:

| The rule | macOS and Linux | Windows |
| --- | --- | --- |
| Only this person can open the door | The directory is `0700` and the socket is `0600`, both owned by this user | The pipe's security descriptor grants access to this person's SID alone. Everyone, Anonymous and the network are not granted anything, not even read |
| Nobody else can claim the door's name first | A directory that already exists must be owned by this user, mode `0700`, and not a symlink, or the host refuses | The host creates the first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`. If the name already exists, someone else holds it, and the host refuses and says so |
| The door never answers over the network | A unix socket is local by nature | The pipe is created with `PIPE_REJECT_REMOTE_CLIENTS` |
| The client checks it reached the real desk | The client checks the directory's owner and mode before connecting | The client asks for the pipe server's process (`GetNamedPipeServerProcessId`), and checks that the process belongs to this person's SID and is the pid in the pointer |
| The pointer, which holds nothing secret | `<h>.json`, mode `0600`, beside the socket | `%LOCALAPPDATA%\HarnessDesk\run\<h>.json`, under the profile's own per-user ACL |

Node's own pipe server does not let a caller set every one of these. The
pull request that brings the door to Windows first measures which flags and
which security descriptor Node applies, then adds a small native step for
whatever is missing. Until every row holds, the door stays off on Windows: a
door that cannot meet one of these rules is not opened.

### Hello first, then only what was asked for

On the client door, the host sends nothing until the client calls
`client/hello`:

```ts
'client/hello': {
  params: {
    client: { name: string; version: string }      // "harnessdesk", "0.1.0"
    protocol: number                               // PROTOCOL_VERSION the client was built against
    pid?: number                                   // as stated; recorded, never trusted
  }
  result: {
    protocolVersion: number
    hostVersion: string
    desk: { home: string; pid: number; startedAt: number }
    tiers: readonly ('read' | 'run' | 'answer')[] // what this desk grants an outside client
    methods: readonly string[]
    runtimes: readonly { id: RuntimeId; name: string; health: RuntimeHealth; metered: boolean }[]
  }
}
'client/subscribe': {
  params: {
    topics: readonly ('runs' | 'cards' | 'teams' | 'seats' | 'reviews' | 'waiting' | 'notices' | 'sessions')[]
    scope?: { team?: GoalId; run?: string; project?: string }
  }
  result: { readonly baseline: number } // that many contiguous starting-state notifications follow
}
```

After `client/subscribe`, the host first sends the current state of each topic
in scope (every active run's execution, every board, and every pending
approval or person card). Changes then follow as notifications. The renderer's
`sync` and its sessions are sent only to a client that subscribed to
`sessions`. The command line never does.

### The allowlist and its tiers

The client surface is one `as const` table in `packages/protocol`: method
name → tier, plus which notifications each topic carries. The host and the
library both read it, and everything else is derived from it:

- the host's refusal: a method not in the table answers `notOnClientSurface`
  on the client door, whatever its validator says;
- the library's types: `client.call` accepts only methods in the table, so
  calling an unlisted method is a compile error in the command line, not a
  refusal at run time;
- the gate test below.

Adding a method to the surface is therefore one reviewed line in one file.

| Tier | What it may do | Default |
| --- | --- | --- |
| `read` | Read, and subscribe. Changes nothing. | On |
| `run` | Spend, or take work away: open a project, start a flow it has previewed, stop a run, abandon a card. | On |
| `answer` | Speak as the person on a step a flow addressed to a person: answer a person card with its outcome and context. | **Off**: a per-desk setting, "Let command-line clients answer for me" |

**Not on the client surface at all, in this design:**

- answering a tool approval, or a question;
- any change to seats, ceilings, Agents, flow files, triggers, accounts,
  credentials, plugins or settings;
- terminals;
- reading files;
- git write verbs;
- sending into a conversation.

Each of these is its own decision when a client needs it (see
*What Mobile adds later*).

**What the tiers are, and what they are not.** A tier is not a security
boundary against a caller that holds `run`. Starting a flow opens Seats, and
a Seat runs commands within its ceiling. So `run` is close to running code as
the person, and splitting methods into tiers could not change that. The door
is the boundary: who can open the socket. The tiers do three narrower jobs:

- they keep the desk's human checks for a human. A step a flow addressed to a
  person, and an approval, are answered only where the person allowed it;
- they give a remote device least privilege, once paired devices exist;
- they limit what a mistake can do: a script that only watches cannot start
  anything.

Every rule in this design is written with that in mind, and none of them
claims more than this.

A gate test holds the table honest:

- every entry is a declared `HostMethods` name;
- every entry is used by some command in the CLI's table;
- every method a command uses is in the table at the tier the command states.

### Answers from several clients at once

The window, a terminal and a phone can all see the same person card. The
host is the only referee:

- every item waiting for a person has a stable id, and that id is the same
  when the item is replayed after a reconnect;
- the first answer wins. A later answer to the same item is refused with
  `alreadyAnswered` (exit 4), never applied twice;
- the notification that the item was resolved is where every client
  converges, including the one whose answer lost;
- an item still waiting is replayed, with the same id, to a client that
  subscribes to `waiting` after it was raised.

### Attribution

Every call through the client door is appended to `audit.ndjson` with
`via: "client"`, the client's name and version, its stated pid (labelled as
stated), the method, the tier and the outcome. A person card answered through
the door appears on the Team's channel as answered from the command line, not
as the window.

## The library: `@harnessdesk/client`

A new package, `packages/client`.

- **Its core** imports `@harnessdesk/protocol` and nothing else, so it runs in
  Node, a browser or React Native.
- **A `node` entry** adds discovery and the local transport over `ws`.
- **Layering.** The layering gate gains a rule: `client` never imports
  `server`, `ui` or an adapter.

```ts
// core: transport-agnostic, and Mobile's too
interface ClientTransport {
  send(text: string): void
  onMessage(listener: (text: string) => void): void
  onClose(listener: (reason: string) => void): void
  close(): void
}

const client = await connect({
  transport: () => openTransport(),   // a factory: a stream that drops reconnects through it
  client: { name: 'harnessdesk', version },
  subscribe: { topics: ['runs', 'cards'], scope: { run } },
})
client.hello                                   // client/hello's result
await client.call('flow/execution', { run })   // typed by HostMethods; throws WireCallError {code, message, details, data}
for await (const event of client.events()) {}  // the stable vocabulary below
client.notifications()                         // raw WireNotification stream; unstable by contract
await client.close()

// node entry
findDesks(): Promise<DeskPointer[]>
resolveDesk({ home, env }): Promise<DeskPointer>   // explicit home is authoritative
localTransport(desk): ClientTransport
```

The library's behaviour, each rule with its reason:

- **A call is never retried by the library.** If the connection drops while a
  call is in flight, the call rejects with `disconnected`. Starting a flow
  twice would spend twice. The host already makes a preview token single-use,
  so a blind retry of a start would be refused anyway.
- **Reconnect is for streams only.** When `events()` loses the connection,
  it opens a new transport from the factory with backoff, says hello again,
  and subscribes again. It then yields `{ type: 'gap' }`, followed by the
  **whole** subscribed state, every item, changed or not. A consumer can
  rebuild from a gap without having kept anything.
  - For a run scope, it also reads that run with `flow/execution`, so a run
    that settled or stopped while the connection was down is seen, even
    though it no longer counts as active.
- **A desk that closes says so.** When a desk quits, its door sends
  `host/shutdown` to every client past hello, then closes. `events()` ends
  with `end` (`desk-closed`) and does not reconnect. A transport that drops
  without that notice is a lost connection, and is reconnected.
- **Notifications never block responses.** Notifications are buffered in
  order. A slow consumer of `events()` cannot stall a `call()`.
- **Every call has a deadline: 30 seconds unless the call says otherwise.**
  - A few methods are named as long-running; retrying a check, for example,
    blocks for the whole check. They have no deadline, but they can always be
    cancelled by the caller or by the connection closing.
  - The command line never waits on a long-running call. It subscribes and
    reports instead.
  - Streams have no deadline.
- **Two transports for tests.**
  - An in-process transport plugs straight into a host built in the test.
    The command line's tests therefore go through the real door: the
    allowlist, tiers and validation all apply, and no socket is opened.
  - A fixture transport plays a scripted desk, for Mobile's interface work.
- **A wire trace for diagnosis.** `--trace-wire` writes every envelope to
  stderr.
- **Version check at hello.** If the protocol differs, the library refuses,
  and the command line exits 6. Changes are additive within a protocol
  version: a new method or a new optional field.
  - `client/hello` lists the methods this desk's client surface answers.
  - Before a command calls anything, the library checks that list. A method
    the desk does not list means the desk is older than the command: the
    command line says so and exits 6.
  - A refusal is never read as "older desk", because `notOnClientSurface`
    also means a method is deliberately left off.
- **No `run` or `answer` call from inside a seat.** If the process's
  environment carries a seat's markers (`HARNESSDESK_GOAL_ID`,
  `HARNESSDESK_LANE_ID`), the library refuses `run`- and `answer`-tier calls
  with "this is one of the desk's own seats".
  - This stops a confused deputy: a card that tells its agent to run
    `harnessdesk card answer`.
  - It is not a defence against a hostile process, and the security model
    says so.

## The command line: `harnessdesk`

A new package, `packages/cli`, with the `harnessdesk` bin, built on the
library.

**Where it lives and how it is installed** (owner, 2026-10-02):

- **In this repository**, beside the host it talks to. The library imports
  `@harnessdesk/protocol` directly, so there is nothing to generate or
  publish between them. The gate test that keeps the allowlist, the declared
  methods and the command table in step can only hold within one build. The
  command line also ships in the same release as the desk, so the protocol
  version moves with the app that speaks it.
- **Inside the app.** The app bundle carries the command line, and an
  **Install command-line tool…** item puts a small `harnessdesk` launcher on
  the person's `PATH`.
  - The launcher runs the bundled script on the app's own runtime with
    `ELECTRON_RUN_AS_NODE=1`, the way the MCP bridge already runs. Nobody
    needs a separate Node install.
  - Where the launcher goes, and whether placing it asks for an
    administrator's password, is settled in the pull request that adds the
    item.
- **Mobile stays in its own repository** and consumes the library. Mobile
  decides at its own time whether that means publishing
  `@harnessdesk/protocol` and `@harnessdesk/client`, or a schema emitted
  from the validators.

### Conventions

- **Picking a desk.** `--home <dir>`, or `HARNESSDESK_HOME`, picks the desk. If
  neither is given, the default home is used. If no desk is found there, the
  command exits 3 and names the desks it did find.
- **Output.** Human output is the default. `--json` prints exactly one JSON
  object on stdout. Streams print one object per line. `--raw` (on `watch`)
  prints wire notifications verbatim. Errors go to stderr.
- **Long text never goes in argv.** Use `--brief-file <path>`, `-` for stdin,
  or `--input name=@path`.
- **No secret anywhere.** No command, flag or environment variable takes a
  credential, because none exists locally.
- **Agent text is untrusted.** Titles, handoffs, notes and approval summaries
  come from agents. In human output, C0/C1 control characters and terminal
  escape sequences are stripped from them, so a handoff cannot rewrite the
  terminal, set the clipboard or forge a link. JSON output escapes them by
  construction. This is the terminal's counterpart to
  `packages/ui/src/lib/sanitize.ts`.
- **Spending needs a yes.** A command that spends asks for confirmation on a
  terminal. Without a terminal it requires `--yes`; without either, it exits
  2.

### Commands

The relay column says whether the command will also be offered over the relay
when Mobile comes (see *Local only, or through the relay*).

| Command | What it does | Wire methods | Tier | Relay |
| --- | --- | --- | --- | --- |
| `harnessdesk desks` | Lists this user's running desks: home, version, since | (pointers) then `client/hello` each | — | local |
| `harnessdesk status [--team T]` | One desk: version, agents' health, Teams with runs in flight, what waits for a person | `client/hello`, `client/subscribe`, `insight/goal` | read | yes |
| `harnessdesk open <path>` | Opens a folder as a project | `workspace/open` | run | **local only** |
| `harnessdesk flows [--project P]` | The flows a project offers, each with its layer and any problem | `flow/catalog` | read | yes |
| `harnessdesk flow preview <flow> …` | What it would do, spending nothing: seats (overrides marked), checks verbatim, held or asked, problems | `flow/source`, `flow/preview` | read | catalogue flows only |
| `harnessdesk flow start <flow> … [--yes]` | Previews, confirms, and starts a Team running it; prints the run and the Team | `flow/preview`, `flow/start-goal` | run | catalogue flows only |
| `harnessdesk runs [--team T \| --project P] [--all]` | Runs, newest first; active ones unless `--all` | `flow/executions` | read | yes |
| `harnessdesk run show <run>` | One run: state, rounds, cards, and why it stopped | `flow/execution` | read | yes |
| `harnessdesk run wait <run> [--timeout S]` | Blocks until the run settles, stops, stalls or waits for a person; the exit code says which | `client/subscribe` | read | yes |
| `harnessdesk run stop <run> --reason …` | Ends the round, interrupts its seats, and fires no rule (#1247) | `flow/execution/stop` | run | yes |
| `harnessdesk teams [--project P]` | Teams, with their activity | `goal/list` | read | yes |
| `harnessdesk team show <team>` | One Team: members, board, what waits | `goal/read` | read | yes |
| `harnessdesk card show <team> <card>` | A card: role, state, outcome, note and handoff | `goal/read` | read | yes |
| `harnessdesk card handoff <team> <card>` | The handoff text alone, for a pipe | `goal/read` | read | yes |
| `harnessdesk card answer <team> <card> <outcome> [--context-file F]` | Answers a card a flow addressed to a person; refused on any other card | `team/intent` (`done`) | answer | yes |
| `harnessdesk card abandon <team> <card> --reason …` | Abandons a card. The rule that follows its role still fires, and the command says so; to end the work, stop the run | `team/intent` (`abandon`) | run | yes |
| `harnessdesk waiting` | Everything waiting for a person: person cards, questions, approvals. Read-only | `client/subscribe` (`waiting`) | read | yes |
| `harnessdesk watch [--team T \| --run R \| --project P] [--until settled]` | Streams changes until interrupted | `client/subscribe`, `flow/execution` | read | yes |

`<flow>` is a catalogue id (`review-pr`) or a file path. A file is read by the
command line and sent as text, as the window sends it. The host never opens a
path a client names. Over the relay, only catalogue ids are accepted: a phone
can start a flow that already exists in the project or for the person, never
one whose text arrived with the request.

`flow preview` and `flow start` take:

| Flag | Becomes |
| --- | --- |
| `--project <path>` | `root`; defaults to the repository containing the working directory |
| `--title "…"` | the Team's sentence, and the `title` input when the flow declares one |
| `--brief-file <path>` or `-` | the `brief` input. Refused, with the inputs the flow does declare, if it has no `brief` |
| `--input name=value`, `--input name=@path` | any other declared input |
| `--seat role=runtime[=model][/effort][+thinking]` | a seat override for this run, written as a flow writes a seat; a list (`a,b`) for a role with several cards |
| `--unattended` | who must be present (below); attended is the default |

### The event stream (`--json`, version 1)

One object per line. Each object carries `v`, `type` and `at` (ISO time).
Consumers switch on `type` and ignore types they do not know. The stream
always opens with `hello` and closes with `end`.

| `type` | Fields | From |
| --- | --- | --- |
| `hello` | `desk`, `hostVersion`, `protocolVersion`, `tiers` | `client/hello` |
| `run.changed` | `run`, `team`, `flow`, `state` (`running`/`settled`/`stopped`/`stalled`), `round`, `reason`; optional `attempt`, `continues`, `revision` | `flow/execution-changed`, when state, round, reason, revision or continues moved |
| `card.changed` | `team`, `card`, `role`, `state`, `outcome`, `title`; optional `seat` (who holds it) and `since` | `team/changed`, diffed per card |
| `seat.changed` | `team`, `seat` (`runtime:sessionId`, as in `card.changed`), `role`, `card`, `state` (`working`/`waiting`/`idle`), `doing` (`{ kind: 'tool', tool, target? }` or `{ kind: 'thinking' }`, or `null` unless working); optional `since` | `seat/activity`, at most once per seat every 2.5 seconds |
| `review.changed` | `team`, `run`, `round`, `cards`, `state`, `reason`, `pr` | `finding/run`'s `rounds`, each round folded from the run's publication journal; read again on `finding/changed` |
| `team.changed` | `team`, `activity`, `sentence` | `goal/changed`, `goal/activity` |
| `waiting` / `waiting.cleared` | `id`, `team`, `kind` (`card`/`question`/`approval`), `card` or `seat`, `summary` | person cards, questions, `approval/requested` and resolution |
| `notice` | `team`, `text` | `person/notice` |
| `gap` | `reason` (`disconnected`/`subscription-changed`) | reconnect or an acknowledged subscription change; the following baseline replaces the prior observation |
| `end` | `reason` (`interrupted`/`until`/`desk-closed`/`error`) | always the last event; an error end is followed by propagation of the original error to the stream consumer |

Four rules hold every row:

- **An optional field is present only when the desk's own record carries
  it.** It is never filled from the moment the client happened to notice
  something. A `since` the record does not hold is left out, not guessed
  from the clock.
- **A waiting item has a stable `id`,** and `waiting.cleared` carries the
  same one, so two items that read alike are never confused.
  - An approval or a question uses
    `approval:<runtime>:<session>:<approval id>`, each part
    percent-encoded, so ids that hold a `:` stay distinct.
  - A person card uses `card:<team>:<card>`.
- **A state is the desk's own word.**
  - `review.changed`'s `state` is the round's publication state as the desk
    keeps it: `local`, `pending`, `posted`, `partial` or `uncertain`, or
    `none` when the round has a review but no publication decision yet.
    Rounds are present only when they have review records or a publication
    decision; the run's `publication` remains its aggregate.
  - Publication is kept per round, not per card, so the event names the
    round and lists its cards.
- **`doing` is a tool and at most a path.** It never carries a command's
  text, a URL or an environment value. The host works it out from the
  seat's conversation, because only the host sees every seat's events
  without sending them all to every client. Each client words it with the
  one shared tool-name lookup, which therefore lives in
  `packages/protocol`, beside the derivation, rather than in the window.
- **One set of view selectors.** `teamOverview(input)` and
  `teamOverviewOf(snapshot, team, extras)` live in `@harnessdesk/client/views`:
  pure functions over plain data, with no transport. `snapshot()` supplies
  the held facts; `synced()` waits until the subscription baseline and its
  initial review reads have applied, again after every `gap`. The run timeline
  selector joins `views` when the window's PR writes it.
  - The window imports that entry and nothing else from the library; the
    layering gate holds it to that.
  - `harnessdesk status` uses the overview selectors in a terminal's words.
    `run show` will use the timeline selector when it lands.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done. For `run wait`: the run settled |
| 1 | The desk answered with an error not covered below |
| 2 | Usage: an unknown command or flag, or a spend without a terminal and without `--yes` |
| 3 | No desk: none is running for this home, or its socket failed the ownership check |
| 4 | Refused: the desk refused the request (a flow with problems, a tier this desk does not grant, a card not addressed to a person). The desk's error code is printed |
| 5 | Waiting for a person: `run wait` ended on a person card or a question |
| 6 | Incompatible: the desk speaks a protocol version this command line does not |
| 7 | `run wait`: the run ended stopped or stalled |
| 130 / 143 | Interrupted by SIGINT / SIGTERM |

## Host changes this needs

Each change is a wire change made the usual way, in its own commit:

1. **The client door** (`server.ts`, plus a module of its own):
   - the socket, its directory checks and its pointer;
   - hello-first, the allowlist, and per-connection topics and scope;
   - attribution in the audit log;
   - the desk setting for the `answer` tier.

   It also declares `client/hello` and `client/subscribe`.
2. **`flow/executions { team?, project?, active? }`** returns run summaries,
   newest first. Today nothing lists a Team's runs.
3. **`flow/execution/stop { run, reason }`** reaches `FlowExecutions.stop`. It
   ends the round, interrupts the run's seats and fires no rule. This is
   #1247, and the window can use it too.
4. **`flow/preview` gains `seats` and `attended`**, and both are bound into
   its single-use token. The preview lists each overridden seat beside the
   file's own. The run records its overrides, and its receipt freezes them, as
   it freezes everything else about a run.
5. **A run started unattended is treated exactly like a run a trigger
   started:**
   - a Seat's question waits as long as the person's own
     `unattendedQuestionWait` setting, then the run stops, and a late answer
     is still delivered;
   - a Seat whose ceiling can only be asked is refused, as this Mac's
     Permissions › Ceilings already decides for unattended work.

   Both rules already exist for trigger runs; this only lets a person choose
   them in a preview. The default stays attended: questions and approvals
   wait for a person, as they do for a run started in the window.

## Security model

**What an outside client is.** An outside client is a tool a person runs as
themselves. It is not a second window. The brief for this work said an
outside client would be as powerful as the window. This design narrows that
on purpose: an outside client gets the allowlist, and the window keeps
everything else.

**What it may do.** It may read; start what it previewed; stop and abandon;
and, only where the desk allows it, answer a person card.

**What it may not do.** Everything else in the window, and in particular:

- approving or denying a tool approval;
- widening a ceiling;
- changing seats, Agents, flows, triggers or settings;
- touching credentials;
- running a terminal;
- reading files.

**In scope:**

- **Other users and other machines.**
  - The client door is a socket in a `0700` directory owned by this user,
    checked by both ends.
  - The window's door is unchanged: loopback and a token.
  - Nothing listens on a routable interface.
- **Secrets leaving the machine.** No local credential exists, so none can be
  printed, put in argv, stored, or copied by an agent into a transcript that
  is sent to a model provider. A token file would make every one of those
  possible.
- **The desk's own seats driving the desk.** A seat is a process the desk
  started, running as the person. Three measures cover this:
  - The `answer` tier is off by default, so a person step cannot be answered
    through the door unless the person turned that on for this desk.
  - The library refuses `run` and `answer` calls from inside a seat's
    environment.
  - Every call through the door is attributed in the audit log. An answer
    to a person card is also shown on the Team's channel as answered from
    the command line. An answer that did not come from the window is
    therefore visible as such.

A browser page cannot reach a unix socket or a named pipe at all, so the
client door needs no rule about which web page a request came from.

**Out of scope, said plainly.** Any process running as this user can reach a
`0700` directory that this user owns. That includes an agent that runs
without an OS sandbox. Such a process can already read the person's files,
push with their git credentials and edit their agents' own permission files.
No local scheme can tell it apart from the person's own terminal.

**Approvals.** No outside client answers a tool approval in this design. The
evidence says the command line does not need to: the pilot's keeper answered
none. A run that must not wait on a person is started `--unattended`, which
makes questions time out under the person's own setting. Approvals are not
answered for them. Answering approvals remotely is Mobile's design, with
signatures (below), and it gets its own security review.

## Local only, or through the relay

The relay carries the same client door: hello-first, the allowlist, tiers and
topics. **It does not carry the window's whole wire.** This narrows Mobile's
earlier design note, which had the relay carry the renderer's wire verbatim.
With the narrower relay, a stolen phone or a compromised relay reaches only
the allowlist: no terminal, file or credential method at all. What the
allowlist grants still has its consequences. A device holding `run` can
start a flow from the catalogue, and that flow's Seats run commands within
their ceilings. That is why a paired device's tiers are the person's choice,
per device.

Two kinds of method stay local only:

- **Anything that names a path on the machine** (`workspace/open`), or that
  carries a flow's text. A phone picks from the desk's own recent projects,
  and starts only flows already in the catalogue.
- **Anything the allowlist leaves out**, even when a later tier is added.

## What Mobile adds later

Designed here so that nothing in the command line has to change for it.
Nothing below is built in this design.

- **A relay transport for the same library.** The desk dials out, the phone
  dials out, and after `cloud/attach` the stream is the client door's
  protocol. `cloud/login`, `cloud/desks`, `cloud/pair` and `cloud/attach` are
  the relay's only methods of its own.
- **Pairing at the desk.** The window shows a short code. Redeeming it
  registers the phone's public key in the desk's own roster, with a name and
  the tiers the person grants it. The relay cannot add a device. The desk can
  revoke a device at once.
- **An `approve` tier, for paired devices only.** Each `approval/respond` is
  signed with the device key over the approval id, the chosen option and a
  timestamp. The desk verifies the signature against its roster and refuses a
  replay or a resolved id. The phone gates consequential approvals behind
  biometrics. Denying is always one tap.
- **Push without content.** A notification says that something waits, never
  the command or the repository.
- **A security review before any of it ships.** It is held to the same rule
  as this design: the door's allowlist only grows by a reviewed entry with a
  tier.

## Moving our own tooling onto the command line

The maintainer tooling outside this repository moves as each command lands:

| Today, through the window's store | With the command line |
| --- | --- |
| Launcher: `previewFlow` then `startFlowGoal`, with a copied flow file whose seats are edited | `harnessdesk flow start … --seat … --brief-file … --yes --json` |
| Approvals keeper answering every approval with the broadest option | Retired. It answered none in the pilot; `--unattended` where a run must not wait |
| Watchers polling every 45 seconds; status snapshots | `harnessdesk watch --json`, `harnessdesk status --json` |
| Stopping a run: interrupt every seat up to three times, then abandon every card | `harnessdesk run stop` |
| Reading a run's posted rounds | A later command over `finding/publications` |
| Driving one conversation (new, set option, send, interrupt) | Conversation verbs, in a later PR with its own review, because they put words into an agent's turn |
| Scripts that reach into the window's store | Retired, once the rows above have landed |

## Phasing

Small pull requests, each one usable on its own. Each is written and reviewed
on a desk where possible, with at most three review rounds. Anything that
touches the door, tiers or attribution gets a critical review.

1. **The door, read-only.**
   - Host: the client socket with `read` only, `client/hello`,
     `client/subscribe`, `flow/executions`, and attribution.
   - `@harnessdesk/client`: the core and the Node transport.
   - Commands: `desks`, `status`, `teams`, `runs`, `watch --json`.
   - The decisions entry below: the rule holds from the first door.

   This alone replaces every polling watcher.
1b. **What a Team is doing.** Read-only, and the same tier as PR 1:
   - Host: `seat/activity` on a `seats` topic, throttled per seat. Its
     derivation and the tool-name lookup move into `packages/protocol`.
   - The `reviews` topic.
   - `seat.changed` and `review.changed`, and the optional fields where the
     records carry them.
1c. **The same views in every client — done.**
   - `@harnessdesk/client/views`, with the shared selectors.
   - Move `teamOverview` into that entry; `status` reads it.
   - The Team usage read (`insight/goal`) joins the `read` tier, so
     `status` can show cost.

   `synced()` and `snapshot()` supply the whole starting state to
   `teamOverviewOf`; text and JSON status use its output.
2. **Starting a flow.**
   - Host: `flow/preview` seats and attended; unattended runs.
   - Commands: `flow preview`, `flow start` (title, brief, inputs, seats,
     unattended), `run show`, `run wait`.

   This replaces the launcher and the keeper.
3. **Stopping and answering.**
   - Host: `flow/execution/stop` (#1247); the `answer` tier and its desk
     setting.
   - Commands: `run stop`, `card show`, `card handoff`, `card answer`,
     `card abandon`, `waiting`.
4. **For users.**
   - The command line packed into the app, and the **Install command-line
     tool…** item.
   - A user-facing command reference, generated from the command table
     source and checked for drift the way the interface doc is. It is written
     for people driving their own work, not for our tooling.
   - A changelog line.
   - The tooling migration; the scripts that reach into the window retire.

**Testing.**

- The library is tested on a scripted transport.
- The host is tested for:
  - hello-first;
  - refusal off the allowlist and at a missing tier;
  - topic filtering and scope;
  - the socket's ownership checks, including a pre-created directory and a
    symlink;
  - attribution.
- The command line's exit codes are tested end to end on the fake-agent rig:
  an isolated `HARNESSDESK_HOME` and the scripted fake agents, so no
  credentials, network or credits are needed.
- The gate test keeps the allowlist and the command table in step.

## Decisions (owner, 2026-10-02)

Every one was decided as recommended.

1. **The local credential is the socket's own permissions.** On Windows,
   the pipe's security descriptor. No secret exists to leak; a token file
   would have been a secret at rest that any process, an agent included,
   could print into a transcript.
2. **On by default:** the door, for every desk, with `read` and `run`.
   `answer` stays off until a person turns it on for that desk, with a
   Settings row, or an environment switch for scripted desks.
3. **Approval policy for a run means attended or unattended.** No outside
   client approves a tool request until Mobile's signed approvals. The keeper
   is retired, on the evidence above.
4. **Seat overrides are made in the host's preview and frozen with the
   run.** Rewriting the flow's text instead would make the preview show a
   file nobody wrote.
5. **The command line lives in this repository and ships inside the app,**
   with an **Install command-line tool…** item. See *The command line*.
6. **The relay carries the client door, not the window's wire.** This narrows
   the Mobile design note.
7. **This spec lives with the other designs,** under
   `docs/superpowers/specs/`, because `docs/` describes what ships. The
   user-facing command reference lands with the code.

## Draft entry for `docs/decisions.md`

*Lands with the first code pull request, the read-only door. `decisions.md`
states what the code does, so the entry waits for the code.*

> ## An outside client is a person's tool on an allowlist, never a second window
>
> The command line, our own tooling and, later, Mobile drive a desk through a
> door of their own: a unix socket whose file permissions are the
> credential. The door carries the window's own wire, but it serves only the
> methods on the client surface, each with a tier: `read`, `run`, or
> `answer`, which a desk grants only when a person turns it on. The window's
> door is unchanged. The door is the boundary. Because starting a flow runs
> Seats, the tiers do not pretend to be one: they keep the desk's human checks
> for a human.
>
> The alternative was to hand outside tools the window's token. That puts a
> secret on disk that any process can print into a transcript. It also makes
> "the command line can start a flow" mean "the command line can open a
> terminal".
>
> Approval policy is the run's, chosen in its preview: attended, or
> unattended under the same rules as a run a trigger started. No outside
> client answers a tool approval.
>
> **The rule:** a wire method reaches a client outside the window only through
> an entry in the client surface that names its tier, and the window's wire is
> never exposed whole through any other door.
