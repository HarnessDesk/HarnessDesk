# Extending HarnessDesk

HarnessDesk has two distinct extension axes, kept apart by layering:

- **The extension plane** adds capabilities that **every** agent can use:
  tools, context providers, composer chips, slash commands, UI panels, and
  editor actions. Implemented as plugins on a Cordis kernel
  (`@harnessdesk/cordis-host`).
- **The agent plane** connects a coding agent backend — a CLI, a server, an
  ACP peer — into an `AgentRuntime` (`@harnessdesk/protocol`) so the rest of
  HarnessDesk can drive it.

They are orthogonal on purpose: a plugin registered once is usable across
every agent, and an agent added once can use every plugin.

Both planes and the host between them are drawn once, in
[architecture.md](architecture.md#the-two-planes). This page is the half of it
you write against.

## Writing a plugin

A HarnessDesk plugin adds capabilities that **every** agent can use. It is a
manifest and an `apply` function, and it never imports Cordis, never touches
`fs` or `fetch` directly, and cannot widen its own reach at runtime.

### The shape

```ts
import type { HarnessPlugin } from '@harnessdesk/cordis-host'

export const githubPlugin: HarnessPlugin = {
  manifest: {
    id: 'github',
    name: 'GitHub',
    description: 'Read issues and pull requests.',
    permissions: { network: { hosts: ['api.github.com'] } },
  },
  plugin: {
    name: 'github',
    inject: ['tools', 'http'],
    apply(ctx, config) {
      ctx.tools.register({
        name: 'list_issues',
        description: 'List open issues on a repository.',
        inputSchema: {
          type: 'object',
          properties: { repo: { type: 'string' } },
          required: ['repo'],
        },
        execute: (args) => ctx.http.json(`https://api.github.com/repos/${args.repo}/issues`),
      })
    },
  },
}
```

`inject` names the services the plugin needs. Cordis holds the plugin **pending**
until every one exists, and unloads it again if one disappears — so a plugin
never runs half-wired.

### What `ctx` offers

| Service | For |
| --- | --- |
| `ctx.tools` | Tools any agent can call |
| `ctx.hooks` | Observe or veto points in the agent's loop |
| `ctx.context` | Instructions and reference material folded into each turn |
| `ctx.commands` | Slash commands |
| `ctx.ui` | Panels, rows, and settings sections |
| `ctx.fs` | Filesystem access, confined to the open workspace |
| `ctx.http` | Network access, limited to declared hosts |
| `ctx.shell` | Running a program, arguments never shell-interpreted |
| `ctx.browser` | A real browser in the DevTools protocol — see [browser control](browser-control.md) |
| `ctx.editor` | The file the person is looking at — show it, mark it, edit it |
| `ctx.team` | The shared board and messages between conversations |
| `ctx.forge` | The seat a publication is signed as, and the record of it in the conversation |
| `ctx.ios` | The iOS Simulator, via `simctl` |
| `ctx.android` | Android devices and emulators, via `adb` |
| `ctx.workspace` | The open project root and its git branch |
| `ctx.harness` | This plugin's identity and logging |

### Permissions and isolation

Anything the manifest does not declare is denied, and the check happens at the
point of use rather than at install time:

```ts
permissions: {
  workspace: { read: true, write: false },
  shell: false,
  network: { hosts: ['api.example.com'] },   // '*.example.com' also works
  agents: { invoke: false },
  ui: { contribute: false },
  browser: false,
  ios: false,
  android: false,
  editor: false,
  team: false,
  secrets: ['MY_API_KEY'],
}
```

Built-in plugins are held to their manifests exactly like third-party ones. That
is deliberate: a permission model only stays correct if the code you ship every
day runs through it.

**Installed plugins run in the plugin host process** — a supervised child that
holds no window, no wire server, and no credential. A plugin that calls
`process.exit` takes down only that process; a plugin that spins is killed from
the healthy side; hooks in a dead plugin host fail closed. The permission gate
is still enforced at every call. Built-ins run in-process because they ship with
HarnessDesk and are reviewed with it — a plugin is still code from its author,
so install ones you would be willing to run.

### Automatic cleanup

Every registration is bound to the calling plugin's Cordis fiber. When the
plugin unloads, its tools, hooks, context providers, and commands withdraw
themselves:

```ts
apply(ctx) {
  ctx.tools.register({ /* … */ })   // no teardown code needed
}
```

If you need cleanup of your own — a timer, a watcher — use `ctx.effect`:

```ts
apply(ctx) {
  ctx.effect(() => {
    const timer = setInterval(poll, 60_000)
    return () => clearInterval(timer)
  }, 'poll')
}
```

### Scope

A contribution can be narrowed to where it applies, so a tool need not be global:

```ts
ctx.tools.register({
  name: 'deploy',
  scope: { kind: 'workspace', root: '/Users/me/prod-service' },
  // …
})
```

Valid scopes are `global` · `workspace` · `agent` · `session` · `turn`.

## Contributing capabilities

### Tools

Tools registered with `ctx.tools.register` are projected to every connected
agent. Pass a name, description, JSON Schema for inputs, optional approval
requirement, and an execute function:

```ts
ctx.tools.register({
  name: 'deploy',
  description: 'Deploy the service to an environment.',
  inputSchema: {
    type: 'object',
    properties: { environment: { type: 'string', enum: ['staging', 'production'] } },
    required: ['environment'],
  },
  requiresApproval: true,
  execute: async (args, scope) => { /* … */ },
})
```

A plugin registers a tool once. Getting it to an agent is the projection
layer's job, and each agent has its own dialect:

How one registered tool reaches both kinds of agent — the projection for
Codex, the socket for everyone else — is drawn in
[architecture.md](architecture.md#the-extension-plane).

The gateway's auth is filesystem permissions: a 0600 socket in a 0700
directory the user owns. That is what lets an out-of-process projection serve
tools without the wire token or the window's transport. Claude Code therefore
sees `browser_open`, `ios_screenshot` and every other plugin tool with zero
Claude-specific code, and the same bridge serves any MCP-speaking agent.

**Identity is by name, never by position.** A live Codex run proved positional
contribution ids are a trap: the in-process kernel and the supervised child
both number contributions `c1, c2, …`, and any plugin reload reissues them.
So the child's ids are namespaced (`child:c2`) at the supervisor merge, and
every cross-boundary dispatch resolves `namespace/name` against the registry
*as it is now*.

**Engines live in the plugin host, not in plugins.** Chrome-over-CDP, simctl
and adb are engines a plugin *uses* through `ctx`, each behind its own
manifest permission with its own install-time sentence ("Control the iOS
Simulator on this machine"). They share one discipline in
`cordis-host/src/device-exec.ts`: `execFile` only, mandatory timeouts,
PNG-to-data-URL screenshots — a hung device must never hang a turn, and every
screenshot rides the already-proven image-result pipeline.

### Context and composer chips

*The textarea carries intent. Chips carry context and capability.*

Context provides instructions or reference material to a turn without spending
a tool call to find out. Registered via `ctx.context.register`, context comes in
two forms: **automatic context** folded into every turn, and on-demand
**composer chips** attached above the composer textarea.

#### Automatic turn context

When registered without a `chip` property, context is folded into every turn:

```ts
ctx.context.register({
  label: 'Repo conventions',
  resolve: () => 'This project uses tabs and Conventional Commits.',
})
```

Return an empty string to contribute nothing. The renderer shows every injection
as a labelled row the user can expand, so nothing reaches the model invisibly.
Automatic context has a 5 s timeout.

#### Composer chips

A chip is something attached to the next message: a token above the textarea,
removable, with its weight visible, that **resolves at send** into the
`UserContent` the target agent understands. The same chip works on every agent
— the adapters already normalise `UserContent` (`mention`, `image`, `skill`,
`text`) into each vendor's native form (a native file mention on Codex, a
resource block over ACP) — so what varies by agent is fidelity, never whether
the chip works.

Why chips rather than pasting text:

- **Agent neutrality.** No vendor can read another's thread, tool calls or
  skill format. Text is the lingua franca; a chip is a promise to produce the
  right text (or image) for whichever agent is reading.
- **Cost before spend.** A chip says what it will cost — "summary", "full
  transcript", "3 files" — before the tokens go out.
- **Reversibility.** Remove it before sending. Nothing pasted to undo.

#### The chip kinds

| Chip | Source | Resolves to | Agents |
| --- | --- | --- | --- |
| File `@` | workspace files | `mention` — native on Codex, resource over ACP | all |
| Image | paste, drop, attach, a plugin screenshot — tiles, not chips | `image` (data URL + display name) | all that declare `imageInput`; the composer refuses the rest |
| Skill `$` | the runtime's skills | `skill` — native on Codex; `$name` text over ACP | where declared |
| Conversation | another session of the same agent | context text (summary) | all |
| Hand-off | another agent's conversation | the hand-off packet: goal, state, files changed, open plan, commit | all |
| **Context** | a plugin's context provider | the provider's text (and optional image), as a `<context>` block | all |
| **Note** | a pane or action (e.g. page annotations) | the composed block, as a `<context>` block | all |

Not chips: model, reasoning effort and permissions (they are controls — they
shape *how* the message is read, not what it says); worktrees and the
working folder (session options). Skills are already chips here; context chips
make external resources and plugin data pickable.

#### Context chips: the extension point

A chip is a context contribution made *pickable*:

```ts
ctx.context.register({
  label: 'Uncommitted changes',
  form: 'resource',
  chip: { description: 'The working tree diff, for review or a commit message.' },
  resolve: () => git(['diff', '--no-color']),
})

ctx.context.register({
  label: 'GitHub issue or PR',
  form: 'resource',
  chip: {
    description: 'Title, body and discussion, through gh.',
    prompt: 'Issue or PR URL, or #123',
    match: String.raw`https?://github\.com/[^/\s]+/[^/\s]+/(?:issues|pull)/\d+`,
  },
  resolve: (_scope, ref) => gh(ref),
})
```

- `chip` present → the provider appears under **+ → Add context**, and is
  resolved only when the user attached it. Without `chip`, a provider keeps
  its automatic, every-turn behaviour. A chip provider is never auto-injected:
  on-demand context that also rode every turn would make every turn pay for it.
- `prompt` means the provider needs a reference; the composer asks for it
  inline. `match` is a regular expression over pasted text: a pasted GitHub
  URL becomes a chip instead of a line of text, the way Codex treats one.
- Resolution receives `(scope, ref)` and can return a plain `string` or `{
  text?, image? }` (e.g. for a screenshot). It resolves over the wire as
  `context/resolve { id, ref?, runtime?, workspaceRoot? }` → `{ label, text,
  image? }`, under the plugin's own permissions. Whereas automatic context
  times out after 5 s, chip resolution is allowed up to 30 s to accommodate
  network calls and screenshot generation.
- The result lands in the message as `<context source="label">…</context>`,
  the same envelope every other injected context uses, so the transcript
  shows it as a collapsed "Context added" row rather than a wall of text.

Because a provider's primary payload is plain text, every agent reads it the same
way. A provider that returns an image (the screenshot chip) resolves to an `image`
part beside its text on agents that accept images; on the rest, the text
goes alone with the omission named — never a message silently missing what
its chip promised.

#### First providers

| Provider | Plugin | Ref | Why |
| --- | --- | --- | --- |
| GitHub issue or PR | git | URL or `#123` | "Do this issue" and "review this PR" are the two most common ways a task starts. Uses the user's own `gh` login; HarnessDesk holds no token. |
| Uncommitted changes | git | — | "Write the commit message", "review what I did", "why does this fail". |
| Team board | team | — | The shared board: open intents, active claims, and dependencies. Briefs a conversation without billing every turn for the board's existence. |
| Last terminal output | the host itself | — | The error is right there; pasting it is the chore. Terminals never became a plugin, so the host contributes this one directly. |
| Current page screenshot | browser | — | "Why does it look like this." Resolves to an image, with a text fallback where the agent cannot look. |
| Page annotations | the pane itself | — | "This element, this region, this scribble." Marks made in the browser pane, with the page's own picture of them — see [browser-control.md](browser-control.md#annotating-pointing-at-the-thing-you-mean). Not a *provider*: there is nothing to resolve, because the pane composed the block already. It arrives as a **note chip**, which is the same chip with its content in hand. |
| Last test run | tests | — | Failures in, fix out. Carries the recorded verdict; it never re-runs the suite at send. |

#### Note chips: context already resolved

A provider's chip is a promise: the text is fetched when the message is sent,
with the workspace and the agent it is going to. Some context has no such
promise to make — the marks made on a page exist the moment they are made, and
the pane that composed them is the only thing that could. Those arrive as a
**note chip**: same row, same envelope on send, content already in hand.

Two things follow:

1. A note chip is what a queued message hands back when it is edited — the
   blocks it carried come off the message as chips holding exactly what was
   queued, rather than being dropped with an apology, because a provider
   cannot resolve a second time for a message that was composed once.
2. No composed context is ever written into the text box: the box is the
   person's, and an envelope typed into it is neither theirs to edit nor
   readable as anything they said.

Nothing travels in a vendor's format. A chip resolves to `UserContent`, which
each adapter already maps to its backend; a context chip resolves to text.
The things that do not transfer — another vendor's tool calls, its thread —
never needed to: their *outcomes* are what a chip carries.

### Hooks

Hooks observe or veto. They run in priority order, the first non-allow verdict
wins, and one that overruns its deadline is skipped rather than awaited — a hook
must never be able to hang a turn.

```ts
ctx.hooks.register({
  event: 'preToolUse',
  match: ['deploy'],
  timeoutMs: 3_000,
  handle: (invocation) =>
    isProduction(invocation.arguments)
      ? { decision: 'ask', reason: 'This deploys to production.' }
      : undefined,
})
```

Supported hook events are `preToolUse`, `postToolUse`, `preTurn`, and
`postTurn`. Prefer `ask` over `deny`. A policy that blocks work on a heuristic is
worse than the situation it was trying to prevent.

### Commands and configuration

#### Slash commands

Register commands via `ctx.commands.register`. A command that throws surfaces
to the user as `/name failed: <message>` — so throw useful messages.

```ts
ctx.commands.register({
  name: 'browser-clear',
  description: 'Clear the browser history.',
  argumentHint: '[pattern]',
  run: async (argument, scope) => { /* … */ },
})
```

`argumentHint` describes the optional argument in the composer's autocomplete
list.

#### Configuration

Declare a JSON Schema in `manifest.configSchema` and HarnessDesk renders a
settings form. Applying it reloads the plugin, and its whole contribution set
swaps as one revision — a reloading plugin is never half-exposed:

```ts
manifest: {
  configSchema: {
    type: 'object',
    properties: {
      token: { type: 'string', title: 'API token' },
      verbose: { type: 'boolean', title: 'Verbose logging' },
    },
  },
}
```

Objects of strings, numbers, booleans, enums, and string arrays are supported. A
plugin needing more should ship its own panel through `ctx.ui`.

### Panels: data in, never code

`ctx.ui` contributes interface, and what travels is **data**, not components.
Reference the published `hd.panel` component and hand it `UiPanelData` — blocks
of `markdown`, `keyValue`, `list`, `actions`, `code`, `document`, `table`,
`tree`, and `diff`:

```ts
let dispose = null
const show = (pages) => {
  dispose?.()
  dispose = ctx.ui.register({
    slot: 'sidebar.panel',
    label: 'Reading history',
    component: 'hd.panel',
    data: {
      title: `Browser · ${pages.length} pages`,
      blocks: [
        { type: 'list', items: pages.map((p) => ({ label: p.title, hint: p.host })) },
        { type: 'actions', actions: [{ label: 'Clear', command: 'browser-clear' }] },
      ],
    },
  })
}
```

Update by re-registering with new data; the change is announced atomically and
crosses the process boundary as JSON. An action names one of your **command**
contributions, so pressing it runs in the plugin host under your permissions —
never in the window. The manifest needs `ui: { contribute: true }`.

Every panel's title folds it away, and the fold is remembered per panel across
restarts. In the sidebar a panel is a guest in a column that belongs to the
session list: it stands at most 320px tall and its body scrolls inside that.
Docked into a pane it has the whole pane and no cap. Neither is yours to set —
say what your panel *is*, and the host decides how much room it gets.

#### A slot, or a panel

Without `mounts`, a contribution is drawn inline at its `slot` and stays there.

Add `mounts` and it becomes a **panel** in the [panel
system](interface.md#panels): it gets a tab of its own, the person can drag it
between the areas you list, expand it to fill the content area or the window,
collapse it and close it, and where they put it is remembered per project.

```ts
ctx.ui.register({
  slot: 'sidebar.panel',
  mounts: ['right', 'bottom'],   // the first is where it opens
  label: 'Coverage',
  component: 'hd.panel',
  data: { blocks: [...] },
})
```

Allowed dock destinations in `mounts` are `'sidebar'`, `'right'`, and
`'bottom'` (`UiDock = Exclude<UiArea, 'main'>`). The `main` area holds
conversations or rooms and is never an option for contributed panels.

The list is a promise the renderer holds you to: a drag onto an area you did
not name is refused, and the panel's move menu never offers one. Say what
your panel is actually shaped for — a list belongs on an edge, a wide table
does not belong in a 280px column — rather than naming all three.

`slot` stays required, and stays meaningful: it is where the contribution is
drawn by a build that does not know about panels, so an older HarnessDesk
still shows something rather than nothing.

A panel appears in ⌘K as *Show the &lt;label&gt; panel*, which is how a person
opens it the first time. It is not docked automatically — a plugin that
rearranged the window on install would be a plugin people uninstall.

A panel whose plugin is not running says so, keeps its tab, and fills in when
the plugin loads.

Why the plugin declares the set rather than the app choosing a place — and what
Codex does instead — is [the docking decision](decisions.md#a-plugin-declares-where-its-ui-may-dock).

#### The nine blocks

| Block | For | Notes |
| --- | --- | --- |
| `markdown` | A paragraph | |
| `keyValue` | Facts in two columns | |
| `list` | Rows, optionally ticked | `done: true/false` renders a todo tick |
| `actions` | Buttons | Each names a command contribution |
| `code` | Source, highlighted | `language`, or the extension of `path`; `decorations` mark lines; `editable` + `onSave` makes it writable |
| `document` | Long prose with foldable headings | `collapsed: true` starts a section folded |
| `table` | Columns that line up | Rows are **keyed by column**, so a missing cell is empty, never the next column's |
| `tree` | Nesting — a directory, a plan | A node's `action` runs on click |
| `diff` | A patch | `wholeFile: true` when the payload is content rather than a diff |

A `code` block's decorations are `{ fromLine, toLine?, severity, message? }` —
1-based, inclusive, the way every compiler and stack trace you are reading from
already counts. `severity` is `'error' | 'warning' | 'info' | 'hint'`. They
render as real diagnostics: underlined, with the message on hover and a panel
listing them.

An `editable` block reports what was typed by running its `onSave` command with
the whole text as the argument — the same mechanism a button uses, because there
is no second one. An `editable` block with no `onSave` renders read-only rather
than taking someone's typing and dropping it.

### The editor plane

`ctx.editor` reaches the file the person is looking at. It is shaped like
`ctx.browser` — a few verbs plus events you pull — because it solves the same
problem: driving something that lives in a process your plugin is not in.

```ts
await ctx.editor.open('src/app.ts')
await ctx.editor.decorate('src/app.ts', [
  { fromLine: 41, severity: 'warning', message: 'unused import' },
])

// What the person has done since you last asked.
for (const event of await ctx.editor.events()) {
  if (event.kind === 'saved') void relint(event.path)
}

// A formatter's write. Lines, not offsets — you have line numbers, not a
// model of the document's newlines.
await ctx.editor.applyEdits('src/app.ts', [{ fromLine: 41, text: '' }])
```

Five things worth knowing:

- **The plane is the host's, not a window's.** `open` on a host with no window
  is recorded, not refused — a window opening later shows it. You never have to
  ask whether anybody is looking.
- **Marks are yours.** `clearDecorations` clears only what you set; another
  plugin's findings on the same file stay.
- **Events are per plugin.** Draining empties your queue and nobody else's, so
  two editor-aware plugins do not starve each other. Nothing is buffered until
  your first call, so make one early if you care about what came before.
- **Showing needs read; editing needs write.** Showing a file displays its
  content, so `open` and `decorate` require `workspace: { read: true }` alongside
  `editor: true`. `applyEdits` needs `workspace: { write: true }` on top — the
  editor is not a second road to the disk. Paths are confined to the open
  workspace either way.
- **There is no way to read a file's text here.** Use `ctx.fs`, under the same
  gate as your every other read. Opening a file in the editor is not a way to
  see files your manifest did not ask for.

### The forge plane

`ctx.forge` is what the desk adds around a git forge a plugin reaches on its
own. The Git plugin talks to GitHub with the person's `gh` under its `shell`
grant — that is deliberate, and it is where the credential stays — and asks
the desk for the two things a shell cannot know:

```ts
// Which agent, on which model, at which effort, made this tool call.
const seat = await ctx.forge.seat(scope) // null when the desk cannot say
const line = seat ? `Generated with HarnessDesk (${seat.label})` : null

// What was published, drawn in the transcript as the object it is.
await ctx.forge.publish(
  { kind: 'pullRequest', action: 'opened', repo: 'acme/widgets', number: 7, url, title, state: 'open', … },
  scope,
)

// How the desk reaches the forge right now: the person's gh, as whom.
const { via, login, available, reason } = await ctx.forge.identity()
```

Three things worth knowing:

- **The seat is a fact about the calling conversation**, so `seat` and
  `publish` take the `scope` your tool's `execute` was handed and refuse a
  call that rides no live invocation — the same gate as `ctx.team`. A plugin
  cannot sign as a conversation it was not called from.
- **Null signs nothing.** A call the desk cannot place — no conversation
  behind it, or a host with no forge plane — gets no seat, and a signature
  built from a guess would be a false one. Say so in the result instead.
- **Requires `forge: true`**, which is described to the person as “Sign pull
  requests and reviews for the conversation, and put what it published in the
  transcript”. The reach itself is `shell`'s.

**No built-in gives an agent a write tool**, and that is a decision rather than
an omission — [the editor-plane decision](decisions.md#writing-a-file-belongs-to-the-editor-plane)
has the argument. What caused a call travels with it across execution
(`cordis-host/src/provenance.ts`): `tool/invoke` is reached only by agents, and
`applyEdits` refuses when the cause is an agent. A plugin may write through the
editor plane on its own initiative or on behalf of the person who installed it,
never for an agent.

## Shipping and testing plugins

### Packaging

An installable plugin is a directory:

```
my-plugin/
  harnessdesk.plugin.json   ← the manifest
  index.js                  ← plain ES module
```

`harnessdesk.plugin.json` carries what in-repo examples put in `manifest`,
plus where the code starts:

```json
{
  "id": "browser",
  "name": "Browser",
  "description": "Read pages from the web.",
  "version": "1.0.0",
  "main": "./index.js",
  "permissions": { "network": { "hosts": ["*"] }, "ui": { "contribute": true } },
  "configSchema": { "type": "object", "properties": { } }
}
```

The entry exports the Cordis half **as `plugin`** (or as the default export):

```js
export const plugin = {
  name: 'browser',
  inject: ['tools', 'http'],
  apply(ctx, config) { /* … */ },
}
```

Do **not** export the `{ manifest, plugin }` pair the in-repo built-ins use —
on disk, the manifest file is the manifest.

### Installation and development

Install it from **Settings → Plugins → Add plugin**. Two install sources
exist, each recording its provenance so Settings can badge it: a **local
path** and an **npm** package name. The manifest is read and its requested
grants are shown *before* any code is imported or run; npm packages are
fetched with `npm pack`, so package install scripts never run. Installation
copies the directory into `~/.harnessdesk/plugins/<id>` (or
`$HARNESSDESK_PLUGINS`) and records where it came from.

**The development loop:** edit your plugin where it lives, then press
**Update from source** on its card in Settings → Plugins. The copy is
refreshed and the module reloaded — imports are cache-busted, so the new code
is really the code that runs.

[`examples/browser-plugin`](../examples/browser-plugin) is all of the above as
one working plugin — install it by path and read it side by side with this
guide.

There is no third source for DeepSeek Harness plugins, and that is a decision
rather than a gap: a DSH plugin is a Cordis plugin bound to *DSH's* services —
its tool dialect, its session event log, its agent packages — so it cannot run
on this kernel without reimplementing DSH. DSH plugins run where they were
written to run, in a DSH profile, and HarnessDesk surfaces them the way it
surfaces Codex's. See
[the DSH decision](decisions.md#deepseek-harness-joins-over-acp-and-its-plugins-stay-in-its-own-profile).

### The built-ins

Twelve plugins are built in, all written against this same API — with no
privileged path:

| Plugin | Engine | What it adds |
| --- | --- | --- |
| git | `ctx.shell`, `ctx.forge` | status, diff, log; branch context; the "Uncommitted changes" and "GitHub issue or PR" context chips; `pr_create`, `pr_update`, `pr_review`, `pr_comment`, `pr_view`, `pr_checks`, `issue_view` and `issue_comment` through `gh`, signed for the conversation's seat and recorded in it |
| files | `ctx.fs` | read and list within the workspace (read-only &mdash; see [the editor-plane decision](decisions.md#writing-a-file-belongs-to-the-editor-plane)) |
| search | `ctx.fs` | content and filename search |
| task list | — | `todo_write` / `todo_read` for an agent whose runtime has no plan tool of its own; the sidebar's Tasks panel is the app's and is read from the conversation, not from here |
| team | `ctx.team` | shared task board tools and cross-conversation messaging; the "Team board" context chip |
| checkpoints | `ctx.shell` | snapshot and restore a working tree |
| guardrails | hooks | repeated-identical-call escalation, destructive-command checks |
| web | `ctx.http` | fetch a page as text |
| browser | `ctx.browser` (CDP) | open, look, click, type, read the page as refs, console, network, and any DevTools method |
| iOS simulator | `ctx.ios` (simctl) | devices, boot, install, launch, screenshot, tap, open URL |
| Android | `ctx.android` (adb) | devices, install, launch, screenshot, tap, key, text, logcat |
| tests | `ctx.shell` | `run_tests` with the framework detected, structured pass/fail; the `/test` command |

### What not to build

Check whether the runtime already does it. Codex has its own sandboxed shell,
patch application, and background terminals; a plugin reimplementation would be a
worse duplicate competing with the real thing. Build what the runtime lacks, or
what should work identically across every runtime.

### Testing plugins

Load the plugin into a real kernel. Testing `apply` directly misses the case that
matters — a plugin that works in isolation and registers nothing under the
permission gate.

```ts
const kernel = new ExtensionKernel()
await kernel.load(githubPlugin)
await settle()

const tool = kernel.list('tool').find((t) => t.name === 'list_issues')!
const result = await kernel.invokeTool(tool.id, { repo: 'openai/codex' }, {})
```

`packages/plugins/test/plugins.test.ts` is the working reference.

## Writing a runtime adapter

An adapter turns one coding agent — a CLI, a server, an ACP peer — into an
`AgentRuntime` the rest of HarnessDesk can drive. The host, the wire protocol
and the renderer are already written against that interface; an adapter adds a
backend without touching any of them. The ACP adapter is written against this
guide rather than beside it: anywhere the guide proves insufficient, it gets
fixed in the same commit as the code that found the gap.

### Ground rules

1. **Import only `@harnessdesk/protocol`.** The layering check fails the build
   if an adapter imports another adapter or anything above itself. Shared needs
   get lifted into `protocol`, never copied sideways.
2. **Never leak your backend's vocabulary.** Whatever your agent calls a
   thread, a profile, or a plan stays inside your package. The moment a caller
   needs your names, your mapping layer is incomplete.
3. **The interface says what you *can* do; capabilities say what you *do* do.**
   Every optional feature is declared in `RuntimeCapabilities`, and the UI
   hides what you do not declare. Throwing "not supported" from a declared
   capability is a bug; being asked for an undeclared one is the host's bug.
4. **A hang is worse than an error.** Every call either resolves, rejects, or
   is explicitly cancellable. If your backend can wedge, supervise it.

### The minimum viable adapter

Implement `AgentRuntime` (see `packages/protocol/src/runtime.ts`, which
documents every member):

- `info` — id, name, `capabilities`, and `presentation`. Presentation is how
  the shell talks *about* you: sign-in command, where history comes from, what
  skills are called. Fill it honestly; the shell renders these words verbatim
  and invents none of its own.
- `start` / `dispose` / `health()` / `onHealthChange` — lifecycle. `health()`
  drives the first-run screen: when your binary is missing, return
  `unavailable` with a `message` and a `remediation` a person can paste into a
  terminal.
- `subscribe` — one stream of `AgentEvent` for every session you own. The host
  demultiplexes by session id; you never track subscribers.
- `listModels` — returns `ModelInfo[]` for the model picker.
- `listSessions` / `searchSessions` / `readSession` — history. Read through to
  your backend's own store if it has one; a session started outside
  HarnessDesk should still appear.
- `createSession` / `resumeSession` / `forkSession` — return an
  `AgentSession`: `settings()`, `send`, `steer`, `interrupt`,
  `respondToApproval`, `options()`, `setOption`, `setTitle`,
  `updateSettings`, and `close`.
- `getAccount` / `getRateLimits` — return empty rather than inventing: an
  account-less runtime returns `{ accounts: [], signInMethods: [] }` and
  declares `capabilities.account: false`.

Model everything your backend streams as `AgentEvent`s and let
`packages/protocol`'s reducer fold them; do not keep a private copy of session
state the reducer cannot reproduce.

### Options: the capability surface

Anything a user can set per conversation is a `ConfigOption` — a select or a
boolean with a `category` that decides where the renderer draws it (`model`,
`thought_level`, `mode`, `_permissions`, `other`). The rules:

- `options()` declares the whole list, including each option's `currentValue`.
- After any change, **re-declare the whole list**. Dependencies between
  options (a model narrowing its reasoning levels) are expressed by what the
  new list contains, never by rules the renderer would have to know.
- Refuse wrong values with `refuseOptionValue`'s wording; never half-apply.
- A restriction (managed config, plan limits) is a **disabled choice with a
  reason**, not a missing choice. Absence is indistinguishable from a bug.
- Implement `defaultSessionOptions(cwd, values?)` if you can say what a *new*
  session would start with — that is what gives the composer a model picker
  before any session exists. The `values` are the user's draft picks; apply
  them and re-declare, with the same refusals a live session would give.

### Optional surfaces

Declare the matching capability in `RuntimeCapabilities` for each surface you
implement:

| Surface | Capability | What it is |
| --- | --- | --- |
| `login` / `cancelLogin` / `logout` | `account` | Sign-in flows the shell can drive (`browser`, `deviceCode`) or only describe (`external`). Completion arrives as an `account/loginCompleted` event, never a return value. |
| `files` (`RuntimeFiles`) | — | Your backend's own view of the filesystem, used for `@` search and reads. **It is a view, not a sandbox**: the host confines paths to open workspaces before your code sees them. |
| `processes` (`RuntimeProcesses`) | — | Sandboxed interactive processes, if your backend can host them. The host builds its terminals on this. |
| `tasks` (`RuntimeTasks`) | `backgroundTasks` | The agent's long-running background tasks that outlive the turn. See [background tasks](background-tasks.md). |
| `extensions` (`RuntimeExtensions`) | `extensionStore`, `mcp` | Your backend's plugin catalogue, app directory, MCP servers, config import. HarnessDesk runs no store of its own. |
| `rollback` / `compact` / `setMemoryMode` / `review` | `undo`, `compaction`, `memory`, `review` | Conversation verbs. |
| `listSkills` / `setSkillEnabled` / `listHooks` | `skills`, `hooks` | Reusable instructions and configured hooks. |
| `archiveSession` / `deleteSession` / `setTitle` / `setGoal` | `archiveHistory`, `deleteHistory`, `nameHistory`, `goals` | History lifecycle and standing session objectives. |

Declare `pluginTools: true` when HarnessDesk's plugin tools reach this runtime's
sessions via the tool gateway.

Declare `instructions: true` when a standing instruction the desk hands the
agent reaches it through the agent's own instruction layer — Codex takes it as
`developerInstructions` on every thread verb; an ACP bridge that declares
`instructions` in its `initialize` `_meta.harnessdesk` reads it from
`session/new`'s and `session/load`'s `_meta.harnessdesk.instructions`. The desk
never puts the sentence in the person's message; an agent with no such layer
hears it only as the tool server's own `instructions`, if it accepted one.

### Conformance

`packages/adapter-testkit` is the contract in executable form. Run it
unmodified:

```ts
import { describeAdapterConformance } from '@harnessdesk/adapter-testkit'

describeAdapterConformance('my-adapter', {
  create: () => new MyRuntime(),
  sessionOptions: { cwd: '/workspace' },
  // Name a boolean option the suite may toggle, if your defaults require one:
  // runtimeToggle: 'feature.flag',
})
```

The suite is also run by the host's deliberately un-Codex-shaped fake runtime,
which is what stops "works with the testkit" from decaying into "shaped like
Codex". If your adapter cannot pass a case without modifying the testkit, the
bug is in the testkit or in `protocol` — fix it there, in the same commit, and
say why.

Test against a **scripted fake of your backend as a real child process**, not
against mocks of your own transport layer: the fake-codex fixture
(`packages/adapter-codex/test/fixtures/fake-codex.mjs`) is the pattern —
golden responses, real stdio, real process exits.

### Registration

Registration happens in `packages/server/src/bootstrap.ts`:

```ts
host.register(new MyRuntime({ logger: logger.child('mine') }))
```

That file is the single exemption from the layering rules — the wiring point
where concrete runtimes are chosen. Everywhere else, your adapter is invisible
behind `AgentRuntime`.

### Checklist before calling it done

- [ ] `pnpm verify` green, including the layering rules
- [ ] Conformance suite passes unmodified
- [ ] `health()` gives a useful first-run message with your binary absent
- [ ] Every capability you declare works; every one you don't is `false`
- [ ] Kill your backend mid-turn: the turn fails with a message, nothing hangs
- [ ] The word for your backend appears nowhere outside your package and
      `bootstrap.ts`
