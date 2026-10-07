# Probes

Empirical harnesses for questions about `codex app-server` that would otherwise
be answered by guessing. **None of them needs credits, a network, or an account**
— which matters, because this machine's Codex workspace is out of credits.

They are the evidence behind [the gateway decision](../../docs/decisions.md#other-models-reach-codex-through-a-gateway-never-a-fork)
and the mechanism the plugin gateway is built on. Re-run them rather
than trusting the recorded output: Codex ships several releases a day.

## `responses-capture.mjs`

A fake OpenAI Responses endpoint. Captures each request to `out/req-N.json` and
answers with a synthetic `response.*` SSE stream.

```bash
node script/probe/responses-capture.mjs --port 8791
```

Point Codex at it with a provider block, then run any turn:

```toml
[model_providers.gw]
name = "Probe Gateway"
base_url = "http://127.0.0.1:8791/v1"
env_key = "PROBE_API_KEY"
wire_api = "responses"
```

```bash
CODEX_HOME=/tmp/probe-home PROBE_API_KEY=x \
  codex exec --skip-git-repo-check "say hi" < /dev/null
```

Codex prints the synthetic text and counts usage. **`< /dev/null` is required** —
`codex exec` blocks reading extra input from stdin otherwise.

What the capture answers: exactly what a translating gateway has to accept.
As of 0.135.0 that is `instructions` (21 KB), `input`, `tools` (21 KB — eight
plain `function` entries plus a `namespace` and a `web_search` that are
Responses-native), `tool_choice`, `parallel_tool_calls`, `store: false`,
`stream`, `include`, `prompt_cache_key`, and a bearer token from `env_key`.

## `gateway-account.mjs`

A **gateway account** end to end: the loopback credential child, the
`config.toml` such an account is pointed with, and a real `codex exec` in front
of a fake provider that records what arrives.

```bash
pnpm build:node && node script/probe/gateway-account.mjs
```

Expect `codex exit: 0`, the agent's own text rendered from the synthetic
stream, and three lines at the end:

```
key reached provider : true
key in codex config  : false
namespace tool sent  : true
```

The first two are the credential bargain — the provider is paid, the agent
never holds the key. The third is why these accounts keep the agent's own
models: `namespace` is HarnessDesk's plugin projection, Responses-native, and
the first thing a translating gateway drops. Same model means the payload
reaches a Responses endpoint unchanged, so it survives.

Verified on codex-cli 0.149.0, which also settles that Codex will run a custom
provider with **no credential at all** — no `auth.json`, no `env_key` — when the
authorisation rides in the base URL.

## `appserver-inject.mjs`

Drives `codex app-server` over stdio and starts a thread on a model provider
**defined nowhere in any config file**, using `thread/start`'s dotted `config`
overrides.

```bash
node script/probe/responses-capture.mjs &
node script/probe/appserver-inject.mjs --codex-home /tmp/probe-home
```

Expect `turn/completed` in the notification list and a request at the gateway
carrying the injected `env_key` as its bearer token. That is what lets
HarnessDesk route a conversation to another model without ever writing to the
user's `~/.codex/config.toml`.

## `review-side-thread.mjs`

A review on a side thread without Codex's `"detached"` delivery, which 0.155.0
deprecates: `thread/start` with the reviewed conversation's settings, then
`review/start` with `delivery: "inline"` on the new thread. It serves its own
fake Responses endpoint, so it needs nothing but a `codex` binary.

```bash
node script/probe/review-side-thread.mjs --codex <path to codex>
```

Every check is a call the Codex adapter makes, or something it relies on, so
running it against the oldest supported Codex (`MINIMUM_CODEX_VERSION`, 0.145.0)
and the newest says whether both take the route. Expect `21/21 checks passed`.
Measured on 0.145.0 and 0.155.0:

- the review's items and its `turn/completed` carry the turn `review/start`
  answered with, and Codex never announces that turn: the only `turn/started`
  is the reviewer sub-agent's, under another id, after the review's first
  item — which is why the adapter opens a review's turn itself
  (`packages/adapter-codex/src/review-turns.ts`);
- `turn/interrupt` naming the review's own turn is refused, and the refusal
  names the reviewer's ("expected active turn id … but found …", the words
  Codex's own terminal client reads to try again); naming the reviewer's stops
  the review. Before the reviewer has started, naming the review's turn is
  refused with "no active turn to interrupt", and a stop naming no turn at
  all (`turnId: ""`, Codex's "startup interrupt", which its terminal client
  sends when it knows no turn) stops it. Either way the review ends under its
  own turn, `interrupted`;
- a thread with no turn is not listed, named or not;
- a thread whose sandbox came from `config.toml`, with no profile active, is
  reproduced by starting another on that `sandbox` mode — network access and
  writable roots included — and not by the profile named after the mode,
  which drops both (the adapter's `ThreadState.sandbox`);
- a workspace sandbox the configuration does not give is reproduced exactly by
  its mode and `config.toml`'s `sandbox_workspace_write.*` keys in the start's
  `config`, beside a route's provider keys too; `thread/settings/update` is no
  way to it, since it adds the configuration's writable roots to the ones it
  is given. What no start can say — a read-only sandbox's network access, an
  external sandbox — `thread/settings/update` sets as given.

The last lines are the control, a detached review on the same app-server:
0.145.0 takes it silently; 0.155.0 sends the `deprecationNotice` and then
refuses it — "paginated threads do not support detached review" — because
every thread 0.155.0 starts has paginated history. `--shapes` prints the
review's notifications whole, the shapes the Codex fixture copies.

## Re-checking the wire constraint

```bash
codex exec -c model_providers.x.wire_api=chat ...
# Error loading config.toml: `wire_api = "chat"` is no longer supported.
```

If that ever stops erroring, [the gateway decision](../../docs/decisions.md#other-models-reach-codex-through-a-gateway-never-a-fork)
should be revisited.

## `paginated-history.mjs`

How a conversation's history is read, forked and undone against a real
`codex app-server`, the way the Codex adapter does each
(`packages/adapter-codex/src/history.ts`), and whether Codex says anything
about it. It serves its own fake Responses endpoint, so it needs nothing but a
`codex` binary.

```bash
node script/probe/paginated-history.mjs --codex <path to codex>
```

Since 0.151.0 Codex keeps a new thread's history in pages
(`historyMode: "paginated"`) and deprecates reading one whole: `thread/read`
with `includeTurns`, and `thread/fork` or `thread/resume` without
`excludeTurns`, each draw a `deprecationNotice`, which the desk showed as a
toast naming those methods. Each "no notice" check has a control: the
deprecated call on the same thread, which must draw one. Measured on 0.155.0
(27/27) and 0.145.0 (18/18; 14/14 with `--history paginated`, a conversation a
newer Codex started, opened after a downgrade):

- a paginated thread reads in pages — `thread/turns/list`, then
  `thread/items/list` filed under each item's turn — to exactly what a whole
  read gives, and silently. A legacy thread (every thread before 0.151.0, and
  any an older Codex started) is refused `thread/items/list` and read whole,
  which draws nothing;
- `thread/revert` before the Nth turn from the end undoes a paginated thread,
  silently, followed by `thread/reverted`. `thread/rollback` is refused one
  ("paginated threads do not support thread/rollback") after its notice, so
  Undo failed there under two toasts;
- a legacy thread is refused `thread/revert` ("only supports paginated
  threads") and undone by `thread/rollback`, which still draws "thread/rollback
  is deprecated and will be removed soon". Codex has nothing else for a legacy
  thread, so that notice stays;
- `thread/fork` and `thread/resume` with `excludeTurns: true` draw nothing, and
  a fork keeps its source's history mode;
- a thread with no first message yet is refused its turns, as "… is
  unavailable before first user message" — which the adapter reads as none, as
  Codex's own terminal client does — or, on 0.155.0, sometimes as "list_turns
  is not supported yet", which it leaves to the transcript the host holds;
- 0.145.0 has no `thread/revert` (0.148.0 added it). It pages a paginated
  thread but refuses to read one whole, and refuses to fork one.

## `mcp-release.mjs`

Starts two threads in one app-server, each with one synthetic MCP server that
starts a child of its own, in a newly created, isolated agent home. It
unsubscribes from the first as the desk does, then waits for Codex to close it.
It runs no turn and does not read or edit the person's agent configuration.

```bash
pnpm build:node && node script/probe/mcp-release.mjs
```

A run takes about a minute. Measured on codex-cli 0.160.0:

```text
processes after starting two threads: 4
unsubscribe the first: unsubscribed
processes one second after: 4
thread/closed after 61 s; processes then: 2
processes after app-server exit: 0
```

`unsubscribe` only stops the events. A minute later Codex closes an idle thread
nobody is subscribed to, its tool server and that server's child exit with it,
and the other thread's two processes stay. So one process can serve every seat:
a finished seat's helpers are released by its own thread closing
([decision](../../docs/decisions.md#one-codex-process-per-account-shared-by-every-seat)).
The probe this replaces waited one second, and read that as "retained".

## `seat-processes.mjs`

How many processes, and how much resident memory, do N seats on one account
hold? Each seat is a new thread with one synthetic tool server, in an isolated
home, against a loopback provider that answers nothing. Nothing leaves the
machine.

```bash
pnpm build:node && node script/probe/seat-processes.mjs 1,3,8
```

It counts what hangs under the script: the app-servers, the launcher in front
of each, and the helpers. `SEAT_PROCESSES_LIST=1` lists every process counted.
Run before and after a change to how the adapter starts Codex, on the same
build, to compare the two.

## `subagent-release.mjs`

A seat whose agent spawns a sub-agent: what does closing the seat leave behind?
Two seats in one app-server, a synthetic tool server per thread, and a loopback
provider that answers a turn saying `SPAWN` with a `spawn_agent` call and
everything else with text, in an isolated agent home. Nothing leaves the
machine. The desk unsubscribes from the first seat only, and from the second
seat and its sub-agent, then watches for a minute and a half.

```bash
pnpm build:node && node script/probe/subagent-release.mjs
```

Measured on codex-cli 0.160.0:

```text
loaded: ["first seat","second seat","sub-agent of the first seat","sub-agent of the second seat"]; processes: 4
unsubscribed the first seat only, and the second seat with its sub-agent: unsubscribed
62 s: sub-agent of the second seat closed
62 s: second seat closed
62 s: first seat closed
63 s: loaded: ["sub-agent of the first seat"]; processes: 1
```

Codex subscribes the parent's client to a sub-agent without announcing it, so
the sub-agent is never unsubscribed and idle: closing its seat leaves it and its
tools loaded until the process ends. The adapter finds a closed seat's
sub-agents by their parent (`thread/read`) among `thread/loaded/list` and
unsubscribes them with it ([decision](../../docs/decisions.md#one-codex-process-per-account-shared-by-every-seat)).

## `mcp-selection.mjs`

Starts synthetic native servers in an isolated agent home without a model turn.
It checks selected, default and empty server lists, create/resume/fork overrides,
reload, independent conversation release, and passive process roots.

```bash
pnpm build:node
node script/probe/mcp-selection.mjs
```

Measured on 0.160.0. Expect only the selected helper on create, resume and fork,
both configured helpers on an unrestricted concurrent thread, and zero owned
roots after closing the conversations and stopping the idle runtime. The probe
writes only synthetic configuration and rollout records and removes its own home.
