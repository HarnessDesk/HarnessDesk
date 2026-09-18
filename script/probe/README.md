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
