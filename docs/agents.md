# Agents: installs, models, and accounts

HarnessDesk bundles no agent. It drives whatever you installed on your Mac,
and on a real machine that is rarely one thing: binaries arrive by several
roads at different versions, each declaring its own models and keeping its
own credentials.

This document describes the rules and machinery for all three surfaces:
which copy of an agent answers and how the app finds it, where the model
list comes from and why it is sometimes wrong, and how to hold more than
one account of the same agent.

## Which copy of an agent runs

An agent arrives by several roads — `brew install`, `npm i -g`, a vendor's
`curl | sh`, `uv tool install`, a download HarnessDesk made from the ACP
registry, or the copy inside a vendor's own application. Each road leaves a
different binary at a different version with a different model list. The
row in `agents.json` names one command, and that command was right on the
day it was written.

### Why the configured command is only a fallback

Four failure modes shaped the install design on 2026-09-05, measured across
ten ACP agents on top of the three the desk already drove:

1. **The app could not see your terminal's PATH.** An application launched
   from Finder or the macOS Dock inherits launchd's environment. On a
   stock Mac, `launchctl getenv PATH` prints nothing, giving the process
   `/usr/bin:/bin:/usr/sbin:/sbin`. Measured on the development machine,
   that PATH finds none of `npx`, `claude`, `gemini`, `codex`,
   `cursor-agent`, `uvx`, or `openclaw`. Every template read "not
   installed", every registry entry read "needs npx", and the defect had
   stayed hidden only because developers launched the desk from a terminal.
2. **The public registry pins yesterday's version while you have today's.**
   The public ACP registry names `@google/gemini-cli@0.58.0` (npm view
   reported 0.58.0 too, that week), `@tencent-ai/codebuddy-code@2.143.1`
   while npm serves 2.146.0, `opencode` 1.18.27 while Homebrew has 1.18.29,
   and `@xai-official/grok@1.0.18` while npm's `latest` tag still pointed at
   1.0.13 with 1.0.21 published. Running the registry's pin runs a second,
   older copy beside the one you use, offering an outdated model list.
3. **Downloads made by the desk had no update story.** Registry rows
   recorded `registry: {id, version}` for updates, but nothing read the
   field.
4. **Some agents require more than an executable.** OpenClaw's ACP bridge is
   mute without its Gateway daemon, and the Gateway refuses configuration
   files written by another OpenClaw version — the development machine's
   `openclaw.json` was invalid for installed 2026.8.2 on the day this was
   built. Furthermore, agents such as Hermes and OpenClaw are not in the
   public registry at all.

### The discovery rule

**The row's command is the fallback. Your newest usable copy is what runs.**

Before every start, the host searches for every copy of the agent it knows
how to locate, asks each for its version, and hands the runtime the newest
candidate meeting the agent's floor — unless you pinned a specific copy in
settings, in which case that copy runs. When nothing installed qualifies,
the row runs as written: a package runner fetches its pinned version, or a
download the desk previously made answers.

This generalises the discovery rule built for Codex on 2026-08-22
(`packages/codex/src/discovery.ts`), where "the binary on PATH" was
frequently older than an update in another folder.

The corollaries:

- **Yours first, ours on request.** Adding an entry from the ACP registry
  whose agent already exists on your machine downloads nothing. The row
  points at the installed copy and records the registry version as
  `deferred`. The registry's managed build remains one click away in
  settings if ever wanted.
- **A copy is found, never trusted.** Every candidate is probed for its
  version with a timeout. A binary that fails to answer is marked
  unreadable and never chosen. Symlinks are resolved to real paths before
  two candidate locations count as two copies.
- **Too old is listed, not run.** Each agent specifies a version floor. For
  example, Gemini CLI gained `--acp` in 0.58.0, pi-acp requires pi 0.80.4
  for `--mode rpc`, and Codex requires 0.145.0 for turn-tagged thread
  items. A copy below the floor is displayed with the update command for
  its install road; it is never launched to fail. A row specifying a CLI
  below the floor — whether by bare name or absolute path — is refused
  rather than run. The row's command is a fallback only when it represents
  something the scan did not already evaluate and reject.
- **The desk updates only what it downloaded.** A copy you installed is
  shown alongside its update command (`brew upgrade opencode`,
  `npm install -g cline@latest`, `uv tool upgrade kimi-cli`, `grok update`,
  `cline --update`). The desk never executes package managers behind your
  back. A download the desk made into `<state>/acp-agents` is replaced by
  the desk at the registry's current version, and the old version is deleted
  only after the new one passes an initial handshake.

### How discovery and launch resolution work

```
        Resolve terminal PATH           at host start, in two steps, blocking neither
              │   now:    the remembered answer when your shell and its profile
              │           files are untouched since last learned; otherwise
              │           this process's PATH plus well-known install folders.
              │   soon:   an interactive login shell is asked for its PATH in
              │           the background; its answer is merged in front and
              │           remembered. HARNESSDESK_PATH prepends more.
              ▼
        Resolve launch executable       before every start, and on each check
              │
              ├─ Agent table:  names, well-known folders, version floors,
              │                and validation checks
              ├─ Find copies:  PATH × command names, vendor install folders,
              │                the row's command, and the desk's download folder
              │                → probe each for version → deduplicate symlinks
              ├─ Rank copies:  newest meeting the floor, or your pinned copy
              ├─ Preflight:    the agent's own config check       ⎫ on start
              ├─ Daemon:       the external service it requires   ⎭ only
              ▼
        Run chosen copy                 or report why the agent cannot start,
        (replaces the row's command         with the agent's error and remediation
         for this start only)               commands formatted in Settings
```

One scan settles one decision: the judgment made at launch is handed to the
runtime description rather than evaluated again, avoiding dozens of
concurrent machine-wide scans when multiple agents start.

Preflight checks (`openclaw config validate`) and daemon checks run only
upon starting the process. Routine re-checks (the half-hourly refresh tick
and window focus returns) evaluate only whether a different executable has
become available, avoiding background execution of configuration
validators.

The implementation sits in `packages/server/src/installs/`:

- `shell-path.ts` — Resolves the PATH the desk runs with and applies it to
  `process.env`. Uses a disk cache keyed on shell profile modification
  times, refined in the background by probing an interactive login shell.
- `run.ts` — Executes probes in an isolated process group killed at the
  deadline with SIGKILL (using a negative PID on Unix). Probes settle on
  `close` rather than `exit`, backed by a 250 ms grace timer, ensuring fast
  version output is completely drained before closing streams.
- `channels.ts` — Identifies how a binary was installed by inspecting its
  resolved real path against package manager conventions (Homebrew Cellar,
  npm global prefixes, `uv/tools`, `pipx/venvs`, `.bun`, `.cargo`, `.app`
  bundles, vendor installer folders, and `<state>/acp-agents`), providing
  the appropriate update command.
- `known-agents.ts` — Data table of supported agents: command names,
  install paths, version arguments, ACP arguments, minimum floors,
  distribution packages, credential homes, auth mechanisms, daemons, and
  preflight validators.
- `locate.ts` — Finds candidates across PATH and well-known directories,
  executes version probes, and ranks copies newest first.
- `service.ts` — Coordinates launch decisions, UI standing descriptions,
  user pins, and bridge executable bindings.

### What the interface shows

Navigate to **Settings › Agents › [Agent]** to view its **Install** section:

- **Summary line:** Summarises current execution state:
  "Running 1.18.29 · via Homebrew (2 other copies found)",
  "Pinned to 1.18.29 · via Homebrew (2 other copies found)" (with a *Use newest*
  button to clear your pin), or
  "Running HarnessDesk's own 1.18.27 — no installed copy qualifies".
- **Candidate list:** One row per detected binary with a standing badge:
  *In use*, *Pinned*, *Older*, *Too old*, or *Unreadable*. The line states
  the reason: the active path on disk for the running copy, the upgrade command
  or pin explanation for an outranked copy, the required floor for an outdated
  copy, or that an unreadable copy timed out. Outranked copies offer a *Pin*
  button.
- **Managed downloads:** Desk-managed downloads feature an *Update to x.y.z*
  button on their row whenever a newer release appears in the registry.
- **Fallback row:** The command configured directly in `agents.json` gains
  a *Fallback* row with an *In use* or *Standing by* badge only when it
  provides unique value — when actively running, or when representing a
  replaceable download.
- **Manual setup:** If no installed copies are found, displays the one-line
  terminal command to install the agent locally.
- **Agent home and authentication:** Displays the agent's home directory,
  environment variable overrides (such as `OPENCLAW_STATE_DIR` or
  `CLAUDE_CONFIG_DIR`), and sign-in instructions or terminal login commands.
- **Roster view:** The agent list displays account counts when present and
  status badges when an agent is not ready. Agents needing no accounts omit
  redundant status text.
- **Startup failures:** When an agent fails preflight or daemon checks, the
  interface presents the agent's raw stderr findings in a scrolling pane
  alongside actionable remediation commands formatted as code blocks.
- **Add agent dialog:** Templates display detected versions (e.g., "Found
  opencode 1.18.29 via Homebrew"). When an agent is already installed,
  registry cards indicate detection and switch the action button to *Add*
  rather than *Download*.

### Supported agents, as measured

Measured across agent CLIs, installer packages, and help outputs on
2026-09-05:

| Agent | Launch / Bridge | Floor | Roads & Update | Home & State | Authentication |
| --- | --- | --- | --- | --- | --- |
| Gemini CLI | `gemini --acp` | 0.58.0 | npm `@google/gemini-cli`, brew `gemini-cli`, npx | `~/.gemini` | `/auth` browser sign-in; accepts `GEMINI_API_KEY` (`GOOGLE_API_KEY` only once Vertex AI is chosen) |
| OpenClaw | `openclaw acp` + Gateway | — | npm `openclaw` | `~/.openclaw` (`OPENCLAW_STATE_DIR`, `--profile`) | Gateway token (`gateway.auth.token`, `OPENCLAW_GATEWAY_TOKEN`) |
| OpenCode | `opencode acp` | — | `~/.opencode/bin`, brew `opencode`, npm `opencode-ai`; `opencode upgrade` | `~/.local/share/opencode` (`XDG_DATA_HOME`, `OPENCODE_CONFIG`) | `opencode auth login` in terminal |
| Cline | `cline --acp` | — | npm `cline`; `cline --update` | `~/.cline` (`--config`, `--data-dir`) | `cline auth` in terminal; accepts `CLINE_API_KEY` |
| Hermes Agent | `hermes acp` | — | `~/.local/bin/hermes`, pypi `hermes-agent`; `hermes update` | `~/.hermes` (`HERMES_HOME`) | `hermes setup` in terminal; ACP terminal auth |
| CodeBuddy Code | `codebuddy --acp` | — | npm `@tencent-ai/codebuddy-code`; `codebuddy update` | `~/.codebuddy` (`CODEBUDDY_CONFIG_DIR`) | `/login` browser flow; accepts `CODEBUDDY_API_KEY` |
| Kimi CLI | `kimi acp` | — | `uv tool` → `~/.local/bin`, Kimi Code → `~/.kimi-code` | `~/.kimi` | `/login` browser flow; accepts `KIMI_API_KEY` |
| pi | `pi-acp` adapter over `pi --mode rpc` | pi 0.80.4 | npm `@earendil-works/pi-coding-agent` | `~/.pi/agent` (`PI_CODING_AGENT_DIR`) | `/login` in UI; `pi-acp --terminal-login` |
| Grok Build | `grok agent stdio` | — | npm `@xai-official/grok` (trampoline to `~/.grok/bin`); `grok update` | `~/.grok` (`GROK_HOME`) | `grok login --device-auth`; accepts `XAI_API_KEY` |
| Antigravity | `agy_acp_server` | — | Registry download from dl.google.com | `~/.gemini/antigravity-acp` (`GEMINI_HOME`) | Google browser authentication, its own — not the IDE's, not `agy`'s |
| Claude Code | `claude-acp` bridge | — | npm `@anthropic-ai/claude-code`, `~/.local/bin/claude`; `claude update` | `~/.claude` (`CLAUDE_CONFIG_DIR`) | `claude auth login` in browser |
| Cursor | `cursor-acp` bridge | — | `~/.local/bin/cursor-agent`; `cursor-agent update` | `~/.cursor` | `cursor-agent login` (with `NO_OPEN_BROWSER=1`) |
| Codex | `codex app-server` | 0.145.0 | brew `codex`, npm `@openai/codex`, `~/.local/bin/codex` | `~/.codex` (`CODEX_HOME`) | Browser sign-in, device code, or `codex login --with-api-key` |

*(Note: DeepSeek Harness connects over ACP via `@harnessdesk/dsh-acp` using
its own machine-specific configuration; it is added via the custom command
form rather than an automatic template. See
`docs/decisions.md#deepseek-harness-joins-over-acp-and-its-plugins-stay-in-its-own-profile`.)*

### Traps and boundaries

- **Package tag lag:** On Grok Build, npm's `latest` dist-tag can lag the
  newest published release by several versions; registry entries pin
  versions that `latest` does not reference.
- **Generational renames:** Kimi CLI ships two distinct product
  generations under the same command name: the Python-based `kimi-cli`
  (installed via `uv tool` under `~/.local/bin`) and the native Kimi Code
  binary (under `~/.kimi-code`). The vendor installer defaults to Kimi Code
  and accepts `KIMI_CLI_FORCE_OLD=1` for the legacy CLI.
- **Package scope migration:** pi migrated from `@mariozechner/pi-coding-agent`
  to `@earendil-works/pi-coding-agent`. The old scope is deprecated and
  stops at version 0.73, below the 0.80.4 floor required by `pi-acp`.
- **Configuration schema validation:** OpenClaw configuration files
  written by one version can be rejected by another. The host runs
  `openclaw config validate` as a startup preflight, reporting validation
  failures directly and suggesting `openclaw doctor --fix` for automated
  migration. OpenClaw startup also suppresses banners and update notes
  (`OPENCLAW_HIDE_BANNER=1`, `OPENCLAW_SUPPRESS_NOTES=1`) to prevent
  protocol corruption over stdout. Per-session MCP servers are rejected by
  the OpenClaw bridge, so plugin tools do not reach OpenClaw sessions.
- **Unresponsive cask binaries:** Probing a Homebrew-cask `cursor-agent`
  revealed that older binaries could hang indefinitely on `--version`,
  ignoring SIGTERM for eleven minutes. Probes therefore execute in isolated
  process groups killed with SIGKILL at the deadline, marking non-responsive
  binaries unreadable.
- **No automated package managers:** Package manager upgrades (`brew upgrade`,
  `npm install -g`) must be run by you. The desk displays the command
  but never invokes external package managers automatically.
- **Non-headless sign-in:** For CLIs lacking headless authentication
  (Gemini, Kimi, CodeBuddy, and pi), the desk directs you to run the
  vendor's terminal sign-in command and exposes API key inputs where
  supported.

## Where the model list comes from

HarnessDesk maintains no static list of models within the application.
It reflects the models declared by the running agent process when it starts.
Every model picker discrepancy stems from the same issue: the process
responding is not the one expected.

### Two failures that proved the rule

On 2026-08-22, two investigations demonstrated why static catalogues fail:

- **Missing GPT-5.6 in Codex:** HarnessDesk invoked `/opt/homebrew/bin/codex`
  at version 0.135.0 — fourteen minor versions behind the 0.149.0 release
  bundled in ChatGPT.app. Version 0.135.0 requested the active catalogue
  from OpenAI and failed to parse the response:
  ```
  codex_models_manager::manager: failed to refresh available models:
    unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
  ```
  GPT-5.6 introduced two new reasoning effort levels, `max` and `ultra`.
  Codex builds predating these levels could not decode the catalogue and
  fell back to compiled-in presets: 5.5, 5.4, 5.4-mini, 5.3-codex, and 5.2.
  Although desktop Codex had written `model = "gpt-5.6-sol"` to
  `~/.codex/config.toml`, HarnessDesk silently substituted the fallback
  catalogue default.
- **Missing Fable 5 in Claude Code:** The ACP registry ran
  `@zed-industries/claude-code-acp` (0.16.2, March 2026), which bundled
  Agent SDK 0.2.44, embedding Claude Code 2.1.44 — a build capped at
  Opus 4.6. The user had installed Claude Code 2.1.240 locally. The Zed
  bridge respected `CLAUDE_CODE_EXECUTABLE` to drive an external binary
  capable of declaring Fable 5, Opus 5, and Sonnet 5, but nothing set the
  variable.
- **Cursor operated correctly:** The `cursor-acp` bridge queries
  `cursor-agent models` on every launch, and `cursor-agent` updates itself.
  It immediately advertised GPT-5.6 Sol/Luna, Fable 5, and Opus 5.

Re-verification against `cursor-agent` 2026.08.31 (Cursor 3.19.13) on
2026-09-05 confirmed:

- Sessions, the chat store (`schemaVersion` 1), and skills directories
  remained compatible.
- The syntax `--model 'id[effort=low,…]'` is accepted in print mode (a
  change from 2026.08.25, which rejected it; the bridge retains the config
  path for Max mode because it reliably exposes complete parameter sets).
- The `result` event includes split token counts for cached read and write
  tokens, forwarded over ACP.
- `cursor-agent models` prints over 200 rows and ignores IDE enabled-model
  toggles. HarnessDesk lets you filter which models appear in the picker via
  **Settings › Models**.
- The IDE synchronises `~/.cursor/skills-cursor` dynamically. The bridge
  reads skills at session initialization.
- On legacy request-based subscription plans, non-Max turns (Gemini 3.7
  Flash, Codex 5.3, Claude Opus 4.6) registered on the vendor usage
  dashboard as one *Included* request each.

### The catalogue rules

1. **No model catalogue in HarnessDesk.** The application maintains no list
   of model identifiers, reasoning levels, or display names. Identifiers
   such as `opus[1m]`, `gpt-5.6-sol`, and `claude-fable-5-thinking-xhigh`
   belong to vendors. The options interface passes declared runtime values
   directly. Unrecognised reasoning effort identifiers are displayed using
   their raw strings rather than dropped. Synthetic labels must never
   collide with prospective vendor names (`xhigh` was previously labelled
   "Max" until Codex introduced a literal `max`).
2. **Drive your installed agent rather than an embedded copy.** Codex
   discovery scans candidate paths and selects the newest binary
   (`HARNESSDESK_CODEX_BINARY` provides an override). ACP agents follow
   the same rule. When a registry entry uses a bridge shim, it specifies an
   executable configuration naming the CLI command and the environment
   variable that points to it (such as `CLAUDE_CODE_EXECUTABLE` or
   `CURSOR_ACP_COMMAND`):
   ```json
   {
     "id": "claude-code",
     "command": "node",
     "args": ["…/packages/claude-acp/dist/src/main.js"],
     "package": "@zed-industries/claude-code-acp",
     "executable": { "command": "claude", "env": "CLAUDE_CODE_EXECUTABLE" }
   }
   ```
   The CLI version is displayed in settings alongside the bridge version.
   If the CLI is missing, the bridge falls back to its bundled build and
   logs the condition.
3. **Query catalogues dynamically.** The active catalogue is retained for
   the process lifetime, cleared on restart or account change, and
   refreshed periodically. If an agent binary changes on disk, the runtime
   restarts onto it once idle. Model metadata is never persisted to disk by
   HarnessDesk.
4. **Surface outdated agents beside the model list.** When an agent
   publishes an npm package, the host checks npm's `latest` dist-tag once
   daily (cached in `<state>/update-checks.json`; set
   `HARNESSDESK_NO_UPDATE_CHECK=1` to disable). If an update is available,
   an advisory appears in the model selection menu and in agent settings
   displaying the upgrade command. The notice is purely informative; no
   features are disabled.
5. **Parse protocols forward-compatibly.** Generated protocol types are
   aligned with vendor releases, but adapters treat enums (modes, reasoning
   efforts, model IDs) as open strings at runtime. Newer options pass
   through older HarnessDesk builds unimpeded. When a model or setting is
   unsupported, the agent rejects it directly; HarnessDesk does not
   filter options based on static lists.

### Keeping models current

```
                 ┌──────────────────────────────────────────────────────┐
  start ───────► │ 1. Find the binary                                   │
                 │    Select newest installation; for bridges, pass     │
                 │    the CLI path via environment variable             │
                 ├──────────────────────────────────────────────────────┤
                 │ 2. Start process and query catalogue                 │
                 │    Agent process advertises its available models     │
                 ├──────────────────────────────────────────────────────┤
                 │ 3. Render declared options                           │
                 │    Model picker populates directly from output;      │
                 │    catalogue parse errors shown in description       │
                 └──────────────────────────────────────────────────────┘
                                             ▲
   every 30 min ──────────────────────┤   Background catalogue refresh
   "Refresh models" in menu ──────────┤   ① Check binary on disk
   window focus after 10+ min ────────┤      If binary changed and idle: restart
   account change or process restart ─┘   ② Query active models
                                             Update open sessions
```

Catalogue freshness is managed across runtimes:

- **Schedule:** Runs every 30 minutes by default
  (`HARNESSDESK_CATALOG_REFRESH_MINUTES`, set to 0 to disable), on manual
  selection of *Refresh models* in the composer or **Settings › Models**,
  and when the application window regains focus after at least 10 minutes
  away (`STALE_AFTER_MS = 10 * 60 * 1000`).
- **Binary checks:** Re-runs installation discovery. If a newer version or
  altered path is detected while no conversation turn is in flight, the
  agent process restarts onto the new binary. Codex persists session state
  independently, so conversations resume without losing progress.
- **Catalogue re-reads:** Codex refreshes its model lists in place and
  updates open sessions. Because ACP defines no catalog refresh request,
  ACP adapters restart the process when only an idle probe session is open,
  or defer updates until the next session. The `cursor-acp` model cache
  expires after 10 minutes (`CURSOR_ACP_MODELS_TTL_MS`).
- **Status timestamps:** Menu footers display the last check time (e.g.,
  "models checked 4:41 PM").

Why this architecture protects older installations:

1. **The catalogue reflects actual binary capability.** The model picker
   offers only what the binary explicitly advertises. An older Codex that
   cannot parse new catalogue schemas serves its built-in presets, which
   represent the models it can execute without error.
2. **Degraded states are explained.** If Codex falls back to presets due to
   catalogue parsing failures, the explanation logged to stderr is captured
   and displayed directly in the model option description alongside the
   remediation advisory.
3. **Cache invalidation across restarts.** Because model catalogues are not
   persisted across runs, an agent upgrade is immediately reflected upon
   process restart without stale cache interference.
4. **Open string mappings.** Reasoning effort levels and options pass
   through as strings. In Codex 0.149.0, reasoning effort transitioned from
   an enum to an open string.
5. **Direct runtime validation.** If an option is invalid, the agent
   runtime provides a rejection explanation via its disabled state.

### Reasoning effort

Reasoning effort is declared dynamically by the agent per model and rendered
in the composer's effort control:

| Agent | Source of levels | Application mechanism |
| --- | --- | --- |
| Codex | Declared per model in its model catalogue | Applied through thread settings updates |
| Claude Code | Declared per model (low…max on Opus/Fable/Sonnet, none on Haiku) forwarded by `packages/claude-acp` | `--effort` at spawn; mid-conversation updates re-spawn with `--resume`; initial turn changes run `/effort` |
| Cursor | Suffixes parsed from `cursor-agent models` (`-high`, `-xhigh`, `-thinking`) by `packages/cursor-acp` | Selects corresponding variant identifier on subsequent turn |

`packages/claude-acp` wraps `@zed-industries/claude-code-acp` because the
Zed bridge omits effort levels and defines no configuration options.
The wrapper subclasses the bridge, adds the effort option, records the
selected setting in `~/.harnessdesk/claude-acp/efforts.json` across
process restarts, and identifies as `bridge 0.1.0`. The "Default" selection
passes no `--effort` parameter, allowing Claude Code's terminal defaults
to govern.

Model catalogue lists cannot be unified across agents: the same underlying
weights are exposed as `claude-fable-5[1m]` in Claude Code,
`claude-fable-5-thinking-xhigh` in Cursor, and remain unavailable in Codex.
Availability depends strictly on the account authenticated to each runtime.

### Verifying what an agent serves

To inspect what models an agent offers:

- **Inside HarnessDesk:** Open the model picker at the bottom of the
  composer, or navigate to **Settings › Models** to see every model
  advertised by the active agent and choose which models are shown in the
  picker.
- **Cursor in a terminal:** Run `cursor-agent models` to print all models
  advertised by the Cursor CLI.
- **OpenCode in a terminal:** Run `opencode models` to list available
  models.
- **Codex in a terminal:** Running `codex app-server` prints startup
  logs to stderr, including any model catalogue refresh errors or schema
  parsing rejections.

#### Signing in

A person with four agents installed has four accounts to keep alive, and the
one that is signed out is rarely the one in front of them. So sign-in is a
**roster, not a modal for the current agent**: every registered agent down the
left with its state, the one selected on the right with the way in. Below the
roster sits the public ACP registry, where new agents can be added in one click.

There are four flow shapes, and the page knows the shapes rather than any
vendor — a runtime declares which one it has, and the right control appears:

| Flow | What the page shows |
| --- | --- |
| `browser` | a button; the flow finishes in another application and the page waits on the event stream |
| `deviceCode` | the code to type, and where |
| `apiKey` | a masked field, a help link, Save — then Replace / Remove |
| `external` | what to do instead, when HarnessDesk cannot drive the flow directly |

**The key never comes back.** A pasted secret goes straight to the host and
into the credential broker, which hands it to the agent as an environment
variable when that agent next starts. It is never in the snapshot, never
logged, and there is no method that returns it — so once one is stored the
page states that fact and offers to replace it, rather than pretending to
display a secret it does not have. The agent that authenticates this way is
declared in the registry, not detected:

```json
{
  "id": "dsh",
  "secrets": [{ "env": "DEEPSEEK_API_KEY", "label": "DeepSeek API key",
                "helpUrl": "https://platform.deepseek.com/api_keys" }]
}
```

**What "stored" is worth is stated, not implied.** At-rest protection comes
from the host: the desktop shell supplies an Electron keychain cipher
(macOS Keychain material), and a standalone host has only file permissions.
The host reports which is in force and the page prints it — "kept on this
machine (macOS Keychain)" or "(file permissions only)" — because a promise of
a keychain that is not there is worse than no promise.

The same file can be read by both, and a blob written under one cipher is
meaningless to the other. Each entry records which cipher wrote it; a reader
that cannot decrypt one treats it as **absent** and logs why, so the agent
shows as signed out and the field comes back. Treating it as absent rather
than throwing is what keeps one unreadable entry from taking down the account
read for every agent.

#### Getting the key into the agent, and knowing where it already is

Two things make a stored key real.

**An agent reads its environment when it starts.** A key stored while it is
running reaches the next process, not the running one. Storing now signals the
runtime to restart immediately to pick it up, and reports what happened: *"Key
stored. DeepSeek Harness restarted with it."* A turn in flight is never killed;
in that case the interface reports that the key will apply on the next start.

Unlike a catalogue refresh this restarts even when sessions are open and the
agent cannot resume them. An agent missing its key fails every turn, so a
conversation held open against it is worth nothing — whereas refusing to
restart leaves the user with no way to get the key in.

**The key may already be somewhere else.** DeepSeek Harness reads one from its
environment, from `~/.dsh/.credentials.yaml` — the file its own Models page
writes — and from two `.env` layers, in that precedence. HarnessDesk knowing
only its own broker meant "Not signed in" about an agent that ran as expected,
and a field offered for a key already there. The registry declares those
other locations:

```json
"secrets": [{
  "env": "DEEPSEEK_API_KEY", "label": "DeepSeek API key",
  "alsoAt": [{ "path": "~/.dsh/.credentials.yaml", "format": "yaml",
               "label": "DeepSeek Harness's own store" }]
}]
```

They are read to answer one question — *does it have one, and from where* —
never to display a value, and HarnessDesk never writes to them. It keeps
one copy, in its own broker, and delivers it as an environment variable, which
is the layer that wins in precedence. Duplicating a user's secret into another
application's plaintext file to save a restart is not a trade worth making.

The page therefore has three states rather than two: stored here, *"Already has
a key — it reads one from DeepSeek Harness's own store"*, and nothing yet. The
field stays open in the middle state, because a key stored here still takes
precedence.

#### Usage, honestly

A backend reports three unrelated facts and they must not be conflated: the
plan's rolling **usage windows**, a **prepaid credit** balance (not applicable
for subscription users who never purchased prepaid credits), and whether a limit
was **reached**, the only signal that turns will actually fail. `lib/limits.ts`
reads them apart; the header, footer and Settings show what the vendor's own app
shows — "4% left · Weekly · resets 4:00 PM" — and the blocked banner fires only
on a reached limit. An account's Settings page shows the prepaid balance beside
the windows, a zero included.

## Multiple accounts of the same agent

Codex maintains a single credential in `$CODEX_HOME/auth.json`. Signing in a
second time overwrites the existing credentials. The CLI provides no profile
flag or `--account` argument, and account status checks return a single
active account. Other supported coding agents share this single-identity
model.

Supporting multiple accounts therefore requires running an independent
agent process with a dedicated credential directory. In HarnessDesk,
multiple accounts and gateway accounts are currently implemented for
Codex; other agents operate with their single workstation identity.

### The credential home as a symlink farm

Configuring an empty directory for a secondary `CODEX_HOME` would isolate
credentials, but it would also isolate session history. All Codex accounts
on a workstation share access to existing sessions; the isolation boundary
lies between agent vendors (Codex versus Claude), not between accounts of
the same agent.

HarnessDesk constructs a symlink farm for each secondary account slot:
every entry in the primary agent home is mirrored as a symlink, with the
exception of authentication credentials:

```
~/.harnessdesk/accounts/codex-7f3a91/
  auth.json            <- real file: this account's credentials only
  sessions             -> ~/.codex/sessions
  archived_sessions    -> ~/.codex/archived_sessions
  state_5.sqlite       -> ~/.codex/state_5.sqlite
  config.toml          -> ~/.codex/config.toml
  skills               -> ~/.codex/skills
  …                       (all remaining files in the agent home)
```

Session rollouts, SQLite databases, agent configuration, skills, and
plugins point to the identical bytes on disk. Only authentication state
diverges.

Measured against Codex 0.149.0: two app-server instances — one pointing to
`~/.codex` and the other to a symlink farm — return identical thread
histories and titles while reporting distinct identities (for example,
`user@work.com` alongside an unauthenticated slot), and shared SQLite
databases pass `pragma quick_check`. Codex is designed for concurrent access
between its CLI and desktop applications, using file locking across
`sessions/`, database files, and `thread-writer-locks/`.

Five items are excluded from symlinking:

- `auth.json` — The credential file isolated by the farm.
- `ipc` — Contains daemon domain sockets; sharing sockets would route
  requests to the wrong process home.
- `tmp` and `.tmp` — Scratch directories holding process-private data.
- `.DS_Store` — System folder metadata.
- `config.toml` — Kept private for gateway accounts to isolate custom
  provider endpoints.

Two directories must exist before symlinking can succeed:
`thread-writer-locks` and `mcp-oauth-locks`. If a slot is created before the
agent has opened its first session, these directories do not yet exist in the
primary home. Left unlinked, secondary accounts would create independent,
unshared lock folders.

For `thread-writer-locks`, Codex uses `flock` per conversation to ensure
only one process appends to a rollout. Independent lock folders allow two
processes to write to the same transcript simultaneously (verified on
0.149.0, where unlinked accounts simultaneously resumed and corrupted a
single thread). For `mcp-oauth-locks`, Codex synchronises token store updates
across processes (`rmcp-client/src/oauth/store_lock.rs`). The host ensures
these directories exist in the primary home before constructing symlinks.

The symlink farm is rebuilt on every process start. When an agent updates a
file via an atomic write (creating a new file and renaming it), the symlink
is replaced by a regular file. Re-evaluating links on startup prevents slots
from drifting into detached local copies.

### An account is a runtime

Secondary accounts are registered as independent runtimes with randomized
identifiers (`codex`, `codex-7f3a91`, etc.). Using randomized suffixes
instead of sequential counters prevents recycled identifiers from
inheriting detached state.

Each runtime appears independently across the sidebar, composer selectors,
and usage cards. Account slot metadata records parent agent linkages,
credential locations, and removal permissions.

Extra accounts exhibit two specific behavioral differences:

- **History listing suppressed:** Because session storage is shared,
  querying history across every account would duplicate every conversation
  in the interface. Secondary accounts disable history listing and search;
  the primary account manages the master session index. Conversations
  started under any account remain visible to all accounts.
- **Dedicated rate limit tracking:** Usage rollouts are owned by the primary
  account to avoid double-counting conversation costs. However, rolling
  rate limits are queried directly from each process's own account status,
  enabling independent live limit meters for each identity.

### Account lifecycle and duplicate folding

Account registration follows a two-stage process: creating the home and
starting the process, followed by authentication. Separating creation from
authentication ensures that an abandoned sign-in leaves an empty account slot
available for retry rather than corrupting an active account. Account
creation waits for the underlying process to become ready, avoiding issues
where early sign-in queries are rejected during Codex startup.

Removing an account signs out the session, stops the process, deregisters
the runtime, and deletes the symlink farm. Deleting symlinks leaves target
files and session histories in the primary home untouched. Account additions
and removals are broadcast to clients in real time.

When you sign into an identity already authenticated on another account,
HarnessDesk prevents duplicate entries:

- **Workspace identity fingerprinting:** Codex credentials in `auth.json`
  contain an OIDC token where `sub` identifies the individual and
  `chatgpt_account_id` (or `tokens.account_id`) identifies the workspace.
  Because a single email address can access multiple ChatGPT workspaces
  with distinct quotas, both `sub` and the workspace ID are combined and
  hashed to establish identity. If either value is missing, the identity
  evaluates to null and accounts are not merged, avoiding accidental
  deletion of separate accounts.
- **Duplicate cleanup:** Startup sweeps remove empty and duplicate accounts.
  When a sign-in completes with an identity already present, the newly
  authenticated duplicate slot is pruned, displaying a notification naming
  the surviving account. The primary account is permanent; if it re-authenticates
  as an identity held by a secondary slot, the secondary slot is removed.
- **Safe sign-out:** When removing or folding duplicate accounts that share
  credentials with an active account, remote sign-out is skipped to avoid
  revoking the credentials of the surviving account.

### Gateway accounts

A gateway account runs the identical agent binary, shares the symlink farm,
and accesses the same model catalog as the primary account, but routes
billing away from the vendor subscription to an external endpoint: a direct
API key, an enterprise gateway, or a managed proxy such as Vercel AI
Gateway.

Gateway accounts decouple agent execution from subscription limits,
enabling teams to use enterprise billing or API credit pools without
changing their developer environment.

Key implementation details:

- **Native model fidelity:** Gateway accounts are restricted to the
  agent's native models (e.g., routing Codex to `openai/gpt-5.6-sol` via a
  gateway). This preserves Codex's Responses API payload features:
  plugin namespaces, web search, session persistence options, and
  multi-agent blocks. Translating requests to non-native models strips these
  capabilities (see `docs/decisions.md#other-models-reach-codex-through-a-gateway-never-a-fork`).
- **Private configuration:** Gateway slots keep `config.toml` private
  rather than symlinked, preventing custom endpoint settings from modifying
  your primary `~/.codex/config.toml`.
- **Credential isolation:** Gateway slots never create an `auth.json`. The
  upstream API key is stored exclusively in the HarnessDesk credential
  broker. The agent's local `config.toml` is written with a loopback
  address and a one-time token:
  ```toml
  model_provider = "harnessdesk_gateway"

  [model_providers.harnessdesk_gateway]
  name = "Vercel AI Gateway"
  base_url = "http://127.0.0.1:54993/t/7f58042…"
  wire_api = "responses"
  ```
  Codex strictly requires `wire_api = "responses"`; `"chat"` is rejected at
  startup. The loopback gateway (`packages/responses-gateway`) intercepts
  requests, replaces the token with the real key, and proxies upstream.
  API keys never appear in process listings, environment variables, or
  disk files.
- **Lifecycle and ports:** Loopback ports change upon every start, so the
  gateway configuration is rewritten at launch. Removing a gateway account
  terminates its gateway proxy and deletes the broker-stored key.
- **Verification:** Verified via `script/probe/gateway-account.mjs` against
  `codex exec` (tested against codex-cli 0.149.0): requests complete with
  exit code 0, usage metrics record accurately, upstream credentials
  remain shielded from the agent environment, and plugin tools operate
  without modification.
