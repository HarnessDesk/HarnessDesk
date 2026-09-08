# What each agent declares it can do

Agents differ, and the interface is built to say so rather than to paper over
it: a runtime **declares** its capabilities, and a control for something an
agent cannot do is simply not drawn.

This is the survey, read out of the running app rather than off the source —
`codex-cli 0.149.0`, `claude 2.1.240`, `cursor-agent 2026.08.11`, DeepSeek
Harness `0.0.1`, on 2026-08-23. What each agent has been *shown* to do, in
live recordings against signed-in agents, is a different question — each of
those claims is pinned by a test, and `script/check-claims.mjs` fails when one
stops naming a test that exists.

| | | Codex | Claude Code | Cursor | DeepSeek Harness |
| --- | --- | :-: | :-: | :-: | :-: |
| **Conversation** | `interrupt` — stop a turn | ● | ● | ● | ● |
| | `reasoning` — thinking is shown | ● | ● | ● | ● |
| | `plans` — a plan is an item, not prose | ● | ● | ● | ● |
| | `steer` — redirect a turn in flight | ● | ○ | ○ | ○ |
| | `undo` — drop the last N turns | ● | ○ | ○ | ○ |
| | `compaction` — compact on demand | ● | ○ | ○ | ○ |
| | `memory` — per-conversation memory, on and off | ● | ○ | ○ | ○ |
| | `goals` — a standing objective per session | ● | ○ | ○ | ○ |
| | `review` — review changes on a side thread | ● | ○ | ○ | ○ |
| **History** | `resume` — reopen a past conversation | ● | ● | ● | ○ |
| | `listHistory` — its own sessions are listed | ● | ● | ● | ○ |
| | `searchHistory` — searched by the agent | ● | ○ | ○ | ○ |
| | `fork` — branch a conversation | ● | ○ | ○ | ○ |
| **Input** | `imageInput` — takes an image in a prompt | ● | ● | ● | ○ |
| **Config** | `skills` — its own commands, per session ¹ | ● | ○ ¹ | ○ ¹ | ○ |
| | `mcp` — HarnessDesk manages *its* MCP servers ² | ● | ○ | ○ | ○ |
| | `extensionStore` — a plugin catalogue | ● | ○ | ○ | ○ |
| | `hooks` — configured hooks are visible | ● | ○ | ○ | ○ |
| **Account** | `account` — something to sign in to | ● | ● | ● | ● |
| | `metered` — reports quota or balance | ● | ○ | ○ | ○ |
| **Not yet declared** | receives HarnessDesk's plugin tools ³ | ● | ● | ● | ○ |

¹ `skills` is answered per session for ACP agents — the agent's commands
arrive when a session opens, so it reads false until one has. Claude Code
declares 51 of them once you are in a conversation.

² Not "speaks MCP" — Claude Code plainly does. It means HarnessDesk can
enumerate and manage that agent's own MCP servers, which the ACP bridges
cannot.

³ Declared per runtime as the `pluginTools` capability, and reported
truthfully — an agent that refuses the server reports `false`, not hope.
HarnessDesk offers every agent an MCP server carrying its 53 built-in plugin
tools (the browser, iOS Simulator, Android, checkpoint and todo plugins among
them; installed plugins add their own on top). Codex takes them as dynamic
tools; Claude Code takes the server; Cursor takes them through a generated
plugin directory passed as `--plugin-dir` (its own `~/.cursor/mcp.json` is
never touched). DeepSeek Harness refuses a non-empty `mcpServers` outright —
so its capability honestly reads `false` — but the tools reach it anyway
through its own composition: a `dsh-mcp-client` entry in the profile spawns
the same bridge, which finds the gateway through the `HD_TOOLS_SOCKET` the
host sets in every ACP agent's environment. The adapter cannot see inside the
profile, so the cell stays empty while the tools arrive. See
[browser-control.md](browser-control.md) for the entry to add.

Codex is the fullest column because it is the one HarnessDesk speaks to
natively; everything else reaches it through ACP, which carries less. That is
a property of the protocol, not a ranking of the agents.
