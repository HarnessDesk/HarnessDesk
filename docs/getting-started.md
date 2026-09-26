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
Settings › Runtimes › **Add a runtime**, as is **Gemini CLI**. Every other agent the
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

`account` is what lets Settings › Runtimes show who is signed in and sign in for
you; `executable` matters when the command is a bridge that embeds its own copy
of the agent, pointing the bridge at the newest installed CLI on your machine.
Details in [runtimes.md](runtimes.md) and [interface.md](interface.md).

### DeepSeek Harness

Add **DeepSeek** from the agent catalogue, or put `{ "id": "dsh", "template":
"dsh" }` in `agents.json`. It runs DeepSeek Harness's own ACP server,
`dsh --profile acp`, so it needs nothing but `dsh` on your PATH
(`npm install -g @deepseek-ai/dsh`) and a DeepSeek key, which DSH keeps in its
own `~/.dsh/.credentials.yaml`.

DSH boots a **profile** — an ordered stack of plugin-bundle patch layers — and
`acp` is the one it ships for this. Plugins you install into that profile come
with it, running in DSH's own process under DSH's own services; HarnessDesk
shows them rather than rebuilding them. Why ACP rather than a native adapter is
[the DSH decision](decisions.md#deepseek-harness-joins-over-acp-and-its-plugins-stay-in-its-own-profile).

What it does and does not carry, measured on DSH `0.1.7-rc.2` on 2026-09-25:

- **HarnessDesk's plugin tools arrive per session.** Since `0.1.2-alpha.1` the
  server mounts the `mcpServers` a `session/new` or `session/resume` offers on
  that session's own agent, so each DeepSeek conversation gets its own tool
  bridge carrying its own caller token, and a DeepSeek seat's board calls —
  `complete_claim` and the rest — are attributed to that seat. Remove any
  `@deepseek-ai/dsh-mcp-client` entry for HarnessDesk left in your
  composition from an older setup. Each session's own server takes
  precedence over it, so attribution holds, but it still starts one bridge
  per DSH process that no call should reach, and one that did would carry no
  caller token and be refused. The app says so when it finds one.
- **Messages and reasoning arrive whole**, one update per committed message
  rather than streamed token by token. Tool calls, context usage, and model and
  reasoning effort as session options all reach the wire.
- **A reopened conversation resumes rather than replays.** The server offers
  `session/resume` and no `session/load`, so the agent gets its context back
  and the wire carries none of the past. The conversation you see is the one
  HarnessDesk recorded: its earlier turns are kept ahead of the new ones and
  never overwritten. Turns taken outside HarnessDesk are not shown.
- **No plans or titles on the wire.** The Tasks panel reads the plan from
  DSH's `todo_write` calls instead; a conversation is named by its opening ask.

Our own server, [`@harnessdesk/dsh-acp`](https://github.com/HarnessDesk/dsh-acp),
still exists for a desk pinned to a DSH before `0.1.7`: it streams, replays and
carries plans and titles, and from `0.6.0` takes per-session tool servers too.
On `0.1.7-rc.2` it no longer reads the harness's message events, so assistant
text and reasoning never reach the wire; do not pair it with a current DSH.

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

Settings › Runtimes signs in each agent through its own flow. For Codex the
first-run screen offers
**Sign in with ChatGPT** (opens your browser) or **Sign in with a code** (for a
machine whose browser cannot reach localhost). Codex runs the flow and keeps the
credential in `~/.codex`; HarnessDesk never stores it. The CLI works too, and the
window notices either way:

```bash
codex login
```

For Claude Code and Cursor, sign in through their CLIs or the button in
Settings › Runtimes:

```bash
claude auth login
cursor-agent login
```

Agents requiring an API key (such as Gemini CLI or DeepSeek Harness) accept it in
Settings › Runtimes or from their environment variables. HarnessDesk stores
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
| `⌘[` | Back, to what the middle showed before |
| `⌘]` | Forward, after going back |
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
every agent — Codex as dynamic tools, Claude Code and DeepSeek Harness through
an MCP server offered with each conversation, and Cursor through a generated
plugin directory. If your DSH composition still has a `dsh-mcp-client` entry
for HarnessDesk from an older setup, remove it. Settings ›
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
in the environment. That one goes further than electron-builder does: it also
notarizes and staples the disk images themselves and repairs `latest-mac.yml` to
match. electron-builder notarizes the `.app` and then builds a fresh DMG around
it, so until that pass runs the DMG carries no ticket of its own and a first
launch needs Apple to be reachable. For a local `.app` and nothing else, `pnpm
--filter @harnessdesk/desktop run pack` skips the disk images and the second
architecture.

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
