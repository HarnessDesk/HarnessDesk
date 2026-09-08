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

## Re-checking the wire constraint

```bash
codex exec -c model_providers.x.wire_api=chat ...
# Error loading config.toml: `wire_api = "chat"` is no longer supported.
```

If that ever stops erroring, [the gateway decision](../../docs/decisions.md#other-models-reach-codex-through-a-gateway-never-a-fork)
should be revisited.
