# Getting started

## Install an agent — or three

HarnessDesk drives the agents already on your machine rather than bundling any,
so each one's configuration, MCP servers and skills apply unchanged.

```bash
brew install codex          # or: npm i -g @openai/codex   — 0.145.0 or later
npm i -g @anthropic-ai/claude-code
curl https://cursor.com/install -fsS | bash
```

**Codex** is spoken natively. **Claude Code** and **Cursor** arrive through the
ACP adapter, using the bridges in this repository — both are one click in
Settings › Agents › **Add agent**, as is **Gemini CLI**. Every other agent the
[public ACP registry](https://agentclientprotocol.com) lists (~40 of them) is
one click in the same dialog and on the sign-in page: HarnessDesk reads the
registry, says which entries can run on your machine, and adding one either
points it at `npx`/`uvx` or downloads the agent's own build into HarnessDesk's
data folder — verified against the registry's digest when the entry carries
one, and deleted again when you remove the agent. An agent the registry does
not know is the custom-command form in the same dialog, or one entry in
`~/.harnessdesk/agents.json`, the same file the dialog writes:

```json
{ "agents": [
  { "id": "claude-code", "name": "Claude", "brand": "claudecode",
    "command": "node", "args": ["<repo>/packages/claude-acp/dist/src/main.js"],
    "executable": { "command": "claude", "env": "CLAUDE_CODE_EXECUTABLE" },
    "account": { "status": { "command": "claude", "args": ["auth", "status"] },
                 "login":  { "command": "claude", "args": ["auth", "login"] },
                 "logout": { "command": "claude", "args": ["auth", "logout"] } } },
  { "id": "cursor", "name": "Cursor", "brand": "cursor",
    "command": "node", "args": ["<repo>/packages/cursor-acp/dist/src/main.js"],
    "executable": { "command": "cursor-agent", "env": "CURSOR_ACP_COMMAND" },
    "account": { "status": { "command": "cursor-agent", "args": ["status"] },
                 "login":  { "command": "cursor-agent", "args": ["login"],
                             "env": { "NO_OPEN_BROWSER": "1" } },
                 "logout": { "command": "cursor-agent", "args": ["logout"] } } }
] }
```

`account` is what lets Settings › Agents show who is signed in and sign in for
you; `executable` matters when the command is a bridge that embeds its own copy
of the agent, pointing the bridge at the newest installed CLI on your machine.
Details in [agents.md](agents.md) and [interface.md](interface.md).

### DeepSeek Harness

DSH boots a **profile** — an ordered stack of plugin-bundle patch layers — so
the agent HarnessDesk registers is a profile that composes an ACP server, and
the plugins you install into that profile come with it.

The ACP server is **[`@harnessdesk/dsh-acp`](https://github.com/HarnessDesk/dsh-acp)**,
which lives in its own repository. Ours is a Cordis plugin that maps DSH's
event stream onto the full ACP vocabulary.

DSH ships one of its own, and since **0.1.2-alpha.1** it is a real server
rather than the old `dsh-acp-demo` example — thoughts, generic tool lifecycle,
model and effort as config options, per-session MCP servers and context usage
all reach the wire. It is still the wrong one for this app, and it says so
first: it is built for automation "rather than the DSH user interface… never
private DSH presentation data", and its own limitations refuse replaying past
transcripts, plans, titles and task lists. Its responses carry no token usage or
cost breakdown, so a turn's tokens, cost and cache figures would be blank
everywhere HarnessDesk shows them. Ours keeps those, replays a conversation when
you reopen it, and reopens it on the model it was having.

**On DeepSeek Harness `0.1.2-rc.1` and later** the composition is the shipped
`acp` profile with DSH's own server switched off and ours in its place. The
example spine (`@deepseek-ai/dsh-agent-spine-demo`) that earlier versions of
this page mounted no longer exists — rc.1 removed `packages/examples` — and a
profile that names it fails to boot with "no agent factory registered". The
base bundle already mounts the agent loop, persistence, titles, the token meter
and the session projections, so the overlay is short; `dsh-acp` ships it as
[`profile/harnessdesk.patch.yml`](https://github.com/HarnessDesk/dsh-acp/blob/main/profile/harnessdesk.patch.yml):

```yaml
- id: acp
  disabled: true
- id: acp-app-startup
  disabled: true
- insert:
    - id: harnessdesk-acp
      name: '@harnessdesk/dsh-acp'
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
        models: [deepseek-v4-flash, deepseek-v4-pro]
```

Link the package into the profile once (`ln -s <dsh-acp-checkout>
$DSH_HOME/profiles/acp/node_modules/@harnessdesk/dsh-acp`, or `dsh plugin
--profile acp add @harnessdesk/dsh-acp` once it is published) and register the
agent in `~/.harnessdesk/agents.json`:

```json
{ "id": "dsh", "name": "DeepSeek", "brand": "deepseek",
  "command": "dsh",
  "args": ["--profile", "acp", "--patch", "<path>/harnessdesk.patch.yml"],
  "env": { "NODE_PATH": "$DSH_HOME/profiles/node_modules" } }
```

`NODE_PATH` lets the adapter reach the harness's own packages for the
model-selection coupling. This was driven end to end against rc.1 built from
source on 2026-09-05: boot, session listing, model switch, close, replaying
past conversations, and the reopened conversation continuing on the model it had
chosen.

**On earlier versions** (up to `0.1.1`), mount it beside the example spine:

```yaml
- id: spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config: { provider: deepseek-official, model: deepseek-v4-pro }

- id: acp
  name: '@harnessdesk/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    models: [deepseek-v4-pro, deepseek-v4-flash]

# The session store. Without it a DeepSeek conversation lives only as long as
# the process: the sidebar is empty on the next launch and nothing can be
# reopened, because there is nothing to reopen from. With it, `dsh-acp` 0.5.1
# and later support listing, resuming, replaying full transcripts — rather than
# only restoring context — and closing conversations. The adapter declares those
# capabilities from what is mounted, so a profile without this section honestly
# offers none of them rather than failing later.
- id: persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js "process.env.DSH_HOME ? process.env.DSH_HOME + '/sessions' : (process.env.HOME + '/.dsh/sessions')"
    compression: zstd

- id: checkpoint
  name: '@deepseek-ai/dsh-session-checkpoint-policy'

# Titles. The service folds conversation titles out of the log; the
# first-prompt provider names a conversation with the cheap flash route.
# HarnessDesk reads the title from the session list, so without these a stored
# conversation lists as its opening ask rather than a name.
- id: session-title
  name: '@deepseek-ai/dsh-session-title'
  config:
    fallbackMaxWords: 5
    fallbackMaxBytes: 40
    maxTitleBytes: 80

- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash

# HarnessDesk's plugin tools. The bridge finds the tool gateway through the
# HD_TOOLS_SOCKET the host sets in the agent's environment; outside
# HarnessDesk it finds no socket and the client degrades without failing.
- id: harnessdesk-tools
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: harnessdesk
    command: node
    args:
      - <harnessdesk>/packages/mcp-tools/dist/src/main.js
```

```json
{ "id": "dsh", "name": "DeepSeek", "brand": "deepseek",
  "command": "node",
  "args": ["<dsh-acp-checkout>/dist/bin.js",
           "--config", "~/.dsh/profiles/harnessdesk/cordis.yml"],
  "cwd": "<dsh-checkout>",
  "env": { "NODE_PATH": "~/.dsh/profiles/harnessdesk/node_modules" } }
```

`<dsh-checkout>` is wherever you cloned
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness); it is not
vendored in this repository, and nothing here builds against it.

Your DSH plugins keep running in DSH's own process, under DSH's own services;
HarnessDesk shows them rather than rebuilding them. Why ACP rather than a
native adapter, and why DSH plugins are not loadable here, is
[the DSH decision](decisions.md#deepseek-harness-joins-over-acp-and-its-plugins-stay-in-its-own-profile).

**Built and tested end to end on 2026-08-23** — DSH ran a real turn inside
HarnessDesk and wrote a working Snake game. Three things the build taught:

- **The published packages are incomplete.** `dsh-acp-demo@0.0.1-rc.1` needs
  `@deepseek-ai/dsh-workspace-context` and `dsh-acp@0.0.1-rc.1` needs
  `@deepseek-ai/dsh-type-meta`; neither is on npm. Until a complete publish
  lands, DSH runs from your own source checkout — which is what the entry
  above points at.
- **The composition must live in the profile directory.** Cordis resolves a
  plugin name relative to the config file, not through `NODE_PATH`, so a
  config in `~/.dsh/profiles/<name>/` sees everything `dsh plugin add`
  installed there and a config anywhere else does not.
- **DSH does not receive dynamic plugin tools over ACP, and says so.** The
  harness connects MCP servers at composition time, one
  `@deepseek-ai/dsh-mcp-client` entry per server in `cordis.yml` (or via the
  patch layer above), so nothing on the ACP wire can add one to a harness that
  is already composed. `@harnessdesk/dsh-acp` 0.3.0 refuses dynamic session tool
  registration naming the parameter; the ACP adapter learns that from the
  agent's own answer, retries without the session tool bridge, and logs that
  session plugin tools are unavailable to that agent. The session still opens.
  DSH's own tools and composition-mounted tools are unaffected.

## Build and run

```bash
pnpm install
pnpm build
pnpm app
```

### Running headless

```bash
pnpm serve
```

The host prints a URL containing a launch token:

```
HarnessDesk host ready
  http://127.0.0.1:52034/?token=…
```

It binds `127.0.0.1` only and rejects connections without that token, so the URL
is not shareable and is regenerated on every launch.

## Sign in

Settings › Agents signs in each agent through its own flow. For Codex the
first-run screen offers
**Sign in with ChatGPT** (opens your browser) or **Sign in with a code** (for a
machine whose browser cannot reach localhost). Codex runs the flow and keeps the
credential in `~/.codex`; HarnessDesk never stores it. The CLI works too, and the
window notices either way:

```bash
codex login
```

For Claude Code and Cursor, sign in through their CLIs or the button in
Settings › Agents:

```bash
claude auth login
cursor-agent login
```

Agents requiring an API key (such as Gemini CLI or DeepSeek Harness) accept it in
Settings › Agents or from their environment variables. HarnessDesk stores
pasted keys in the host credential broker (backed by macOS Keychain in the
desktop app) and passes them to the agent environment at startup.

## First run

1. Choose a project folder. HarnessDesk remembers recent folders under
   `~/.harnessdesk`.
2. Start a session, or open one from the sidebar — sessions you ran in the
   Codex CLI, the VS Code extension or Claude Code are already there, grouped
   by repository.
3. Set the agent, model, reasoning effort, approval policy and mode from the
   controls under the composer.
4. Press `⌘K` for anything else: sessions, files, agents, commands, settings.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `⌘N` | New session |
| `⌘O` | Open folder… |
| `⌘B` | Toggle sidebar |
| `⇧⌘D` | Show changes |
| `⌘,` | Settings |
| `⌘U` | Dashboard |
| `⌘K` | Command palette |
| `⌘W` | Close the focused pane |
| `Enter` | Send — while a turn runs, queue for when it ends |
| `⌘Enter` | Steer the running turn, where the agent can |
| `⇧Enter` | New line |
| `1`–`9` | Answer the open approval |
| `Esc` | Deny the open approval, or close a dialog |

Panels are split through the panel's `⋯` menu (**Side by side** or **One above
the other**), not by shortcut.

## Plugins

Twelve ship built in: git, files, search, task list, team, checkpoints,
guardrails, web, browser, iOS simulator, Android and tests. Their tools reach
every agent — Codex as dynamic tools, Claude Code through an MCP server, Cursor
through a generated plugin directory, and DeepSeek Harness through a
`dsh-mcp-client` entry in its own composition (see
[browser-control.md](browser-control.md) for the entry to add). Settings ›
Plugins shows each one's state, what it contributes, what it was granted, and
its configuration.

Two are worth knowing about immediately:

- **Web** starts with an empty host allowlist and does nothing until you add a
  host. That friction is deliberate.
- **Checkpoints** records a recoverable snapshot before the agent first changes
  files, using `git stash create` — nothing you can see changes, and `git restore
  --source <sha> -- .` puts it back.

To write your own, see [extending.md](extending.md).

## Packaging

```bash
pnpm dist
```

`.dmg` and `.zip` for both architectures (arm64 and x64), into
`packages/desktop/release`. `notarize` is off, so the result is signed but
Gatekeeper rejects it anywhere but the machine that built it — `pnpm --filter
@harnessdesk/desktop run dist:notarized` is the same build with Apple credentials
in the environment. For a local `.app` and nothing else, `pnpm --filter
@harnessdesk/desktop run pack` skips the disk images and the second architecture.

Root `pnpm dist` rebuilds every Node package and the production UI before
packaging. `release/` is gitignored and `pnpm clean` does not touch it, so a
clean release removes that directory separately. The complete signed release
checklist — clean output, full verification, `dist:notarized`, packaged smoke,
Gatekeeper, stapler and checksums — is published with each release.

`pnpm --filter @harnessdesk/desktop run smoke` then launches the built `.app`
against a throwaway home and fails if any catalogue row says the build "does
not carry" a bridge — the class of defect that only exists after packaging,
which no test and no dev launch can see. Details in
the release notes for that version.

## Troubleshooting

**"Codex is not installed on this machine"** (or older than 0.145.0) — the
binary was not found or is below the minimum supported version. The message
carries the fix (`brew install codex` or `npm i -g @openai/codex`). HarnessDesk
looks on `PATH` first, then Homebrew and the standard global locations.

**"Usage limit reached"** — the agent is healthy and signed in, but a rolling
usage window is spent, so turns will fail until it resets. Past sessions stay
readable. A prepaid credit balance of zero is not this: plan users who never
bought credits run fine.

**"requires a newer version of Codex"** — the selected model is newer than the
installed CLI. Pick another model, or upgrade Codex (`brew upgrade codex` or
`npm i -g @openai/codex@latest`).

**"… did not answer the ACP handshake: The agent exited (code 1)"** — the
bridge has no entry point to run. `agents.json` spawns the ACP bridges by
absolute path into `packages/*/dist`, so a `pnpm clean` that was not followed by
`pnpm build:node` leaves Node with a missing module and an immediate exit 1.
The giveaway is which agents survive: Codex is a binary and DeepSeek Harness
builds in its own repository, so they come up while Claude Code and Cursor both
fail together. `pnpm build:node` restores them.

**"the plugin tool bridge is missing"** — a warning, not a failure: agents run,
without HarnessDesk's tools. Same cause one step later. `packages/mcp-tools/dist`
was empty when the app was packaged, so the bundle has no
`app.asar.unpacked/node_modules/@harnessdesk/mcp-tools/dist/src/main.js`. Only a
rebuild *and* a repackage fix it — the bridges above live at repository paths
and recover from a rebuild alone, but this one is copied into the `.app`.

**Logs** — `~/.harnessdesk/logs/host.ndjson`, also reachable from
Help → Open Diagnostics Folder.
