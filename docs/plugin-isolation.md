# Plugin isolation

How HarnessDesk runs code that someone else wrote, and what you can rely on
when it does.

This page is for three readers:
- someone deciding whether to install a plugin;
- an author writing one;
- a contributor adding a capability to the plugin API.

The [authoring guide](extending.md) explains what a plugin can contribute.
This page explains the boundary the plugin runs behind.

> **Status.** This is the target design, built in steps. Layers 1–3 are being
> built now; layers 4 and 5 follow. The [Delivery](#delivery) table says
> which parts are in place.

## Words used here

- **Host.** The HarnessDesk process that owns your conversations, windows
  and credentials.
- **Plugin process.** The process one installed plugin runs in.
- **Pipe.** The private channel between the host and one plugin process
  (that process's standard input and output).
- **Plane.** One kind of service the host offers plugins: files, network,
  shell, the browser, the editor, the team board, the forge (pull requests
  and their record), devices.
- **Manifest.** The `harnessdesk.plugin.json` file in a plugin's package. It
  declares the plugin's id and the permissions it needs.
- **Snapshot.** A plugin process's report of what its plugin registered:
  its tools, hooks, context providers, commands and panels.
- **Lease.** The host's record of one call it made into a plugin (defined
  under [layer 3](#3-the-host-holds-the-authority)).

## The short version

**Every installed plugin runs in a process of its own,** and the host talks to
each process over that process's own pipe.

The host never asks a plugin who it is, what it may do, or which conversation
it is working for. It already knows all three:
- **who it is:** the pipe the request arrived on;
- **what it may do:** the manifest the person agreed to when they installed
  the plugin, which the host recorded;
- **which conversation:** the host started the call the plugin is answering.

A plugin uses the machine through the capabilities the host serves it:
`ctx.fs`, `ctx.http`, `ctx.shell`, the browser and the rest. The host checks
each one against that plugin's recorded permissions, at the moment of use.
Once the runtime is confined ([layer 5](#5-the-runtime-is-confined)), the
plugin process has no file, network or process access of its own, so those
capabilities are the only way in.

**Built-in plugins** run in the host process on the same API, and are held to
their manifests the same way. They ship with the app and are reviewed with
it, which is a different kind of trust from code a person installs.

```
                      ┌──────────────────────── host process ──────────────────────────┐
                      │                                                                 │
  agent / person ───► │  extension host                                                 │
                      │   ├── built-in plugins (in process, same API, same checks)      │
                      │   ├── plugin records   id → consented manifest, grants, config  │
                      │   ├── leases           live calls the host started, per plugin  │
                      │   └── capability broker  fs · http · shell · browser · editor   │
                      │                          team · forge · ios · android           │
                      │        │                 │                  │                   │
                      └────────┼─────────────────┼──────────────────┼───────────────────┘
                         pipe A│            pipe B│            pipe C│
                      ┌────────▼──────┐  ┌───────▼───────┐  ┌───────▼───────┐
                      │ plugin A      │  │ plugin B      │  │ plugin C      │
                      │ own process   │  │ own process   │  │ own process   │
                      │ (confined:    │  │ (confined:    │  │ (confined:    │
                      │ no fs, net or │  │ no fs, net or │  │ no fs, net or │
                      │ spawn)        │  │ spawn)        │  │ spawn)        │
                      └───────────────┘  └───────────────┘  └───────────────┘
```

## What it promises, and what it does not

The promises come in two kinds:
- **What the host will do for a plugin.** These hold for every plugin,
  confined or not.
- **What a plugin can do without asking the host.** This is bounded only as
  far as the confinement reaches.

### What the host will do: holds for every plugin

1. **The host never acts for one plugin on another's request.** A request is
   attributed to the pipe it came from. Nothing a plugin writes into a
   request changes that.
2. **The host never grants more than the person agreed to.** At install, the
   host records the permissions the person saw and accepted. It checks every
   call against that record. It refuses to start a plugin whose manifest has
   changed since, until the person agrees again. A permission a plugin
   reports about itself, or exports from its code, counts for nothing.
3. **The host acts for a conversation only while it is calling the plugin
   for that conversation.** Team, forge, browser and device actions ride a
   lease. The lease belongs to the plugin's own pipe and ends when the call
   ends.
4. **The host never shows one plugin another's work.** The host sends each
   call, and each lease, down the pipe of the plugin it is for, and no
   other.

### What a plugin can do without asking

5. **A failing plugin fails alone.** A crash takes down one process. So does
   a call that overruns its deadline, because the host kills the process from
   its own side. The other plugins keep working, and the host restarts the
   failed one with backoff.
6. **A confined plugin cannot reach the machine except through the host.**
   Under [layer 5](#5-the-runtime-is-confined), the plugin process cannot
   open files, connect to the network, start programs or load native code on
   its own.

### What it does not protect

- **A granted permission is real power.** A plugin granted `shell: true` can
  run programs as you. One granted `workspace.write` can change your
  checkout. Isolation makes sure a plugin gets *only* what it was granted. It
  does not make a broad grant safe. Read what a plugin asks for before you
  install it.
- **Confinement is a seat belt, not a vault.** Layer 5 uses Node's permission
  model. Node documents that model as protection against *accidental* reach,
  not as a guarantee against code written to escape it. A plugin that
  escapes it, or that runs where no confining runtime was available, has
  your user account's own access to the machine:
  - it can read other plugins' files;
  - it can signal other processes you own;
  - it can change files the host does not check.

  Promises 1–4 still hold, because they concern what the host does, but
  promise 6 does not. An operating-system sandbox around each plugin process
  is the planned layer that closes this (see [Delivery](#delivery)).
- **The consent record is a check, not a lock, until layer 5.** It lives
  beside the plugins directory, not in any plugin's own files, and it catches
  a manifest that changed without the person agreeing: by hand, by a tool, or
  by a plugin editing its own. But a plugin with your file access could
  rewrite the record too. Only when layer 5 keeps a plugin's file access to
  its own directory is the record out of its reach.
- **Everything runs as your user account.** Plugins never run as a separate
  user. What is sensitive stays out of their reach by keeping it in the
  host: plugin processes get an environment built from scratch, and
  credentials never leave the host.
- **Resource exhaustion and timing channels are out of scope.** The host
  does not cap a plugin's CPU, memory or disk. It does report each plugin
  process's memory, so a heavy plugin is visible and attributed. A plugin
  that spins with no call in flight is not detected until the host next
  calls it.

## The layers

Layers 1–4 decide what the host will do. Layer 5 limits what a plugin can do
without asking.

### 1. One process per plugin

Each enabled installed plugin gets one process. That process loads exactly
one plugin, from its installed directory, and refuses to load a second.

- **Started:** when the host starts, for each enabled plugin, in parallel;
  and when a plugin is installed or enabled. A plugin's contributions exist
  only once its code has run, so the host cannot wait until a tool is first
  called.
- **Restarted:** after a crash, on the backoff in [Lifecycle](#lifecycle).
- **Stopped:** when the plugin is disabled or uninstalled, and when the host
  shuts down. A disabled plugin has no process, and costs nothing.
- **Fresh environment:** the process gets an environment built from a short
  allowlist:
  - the variable that makes the desktop binary run as plain Node;
  - the plugins directory;
  - locale, time zone and the temporary directory;
  - until [layer 4](#4-capabilities-are-served-not-handed-over) moves them
    into the host, the few variables the in-process capabilities read, such
    as `PATH` and `HOME`.

  It never inherits the host's environment, so a token the host was started
  with does not reach plugin code. `NODE_OPTIONS` is never passed.
- **No sharing between plugins:** each process has its own kernel, module
  graph and timers. Plugins that need to cooperate do it through the host's
  planes (the team board, the forge, the editor), where each side is
  attributed.

### 2. The channel is the identity

The host keeps one record per plugin process. The record holds:
- which plugin it is;
- which pipe it uses;
- the calls open on it;
- its restart state.

A message read from a pipe belongs to that record's plugin, and that is the
only identity it has.

The consequences:

- **The pipe decides who is asking.** When a request names a plugin, for
  instance in the scope of a team or forge call, the host replaces the name
  with the pipe's own.
- **Contribution ids are namespaced per plugin** (`plugin:<id>:<n>`). Every
  tool, hook, context provider and command names the process that answers
  it, and two plugins can never shadow each other.
- **The host names the instance.** A process numbers its own plugin
  instances, and a plugin can write any number into a frame. So the instance
  id everyone else sees (`<id>#installed`) is the host's, the same in every
  process the plugin runs in, and the one team and forge calls are attributed
  to.
- **A snapshot is checked against its own record.** The host keeps only the
  contributions of the plugin on that pipe, and only those its permissions
  allow. A panel, for instance, needs `ui.contribute`. Each kept entry is
  stamped with the host's own copy of the plugin's identity and permissions.
- **So is every event.** Events go straight to Settings and the window, which
  key plugins and contributions by instance id. An event about any plugin but
  the one on the pipe is dropped. One about its own plugin is held to the
  same rules as a snapshot, and a log line is the plugin's own, whatever owner
  it names.
- **And every request.** A plugin can skip its `ctx` services and write a
  request frame itself, so the host checks each one against the grants it
  holds before any engine sees it. An `editor/*` request needs `editor`, plus
  `workspace.read` to show or mark a file and `workspace.write` to change one,
  and a change is refused while an agent's tool call runs in that process:
  the frame cannot say who asked, and an agent's edits belong to its own
  runtime and its own approval.

### 3. The host holds the authority

Three questions decide whether an action is allowed. The plugin answers none
of them:

| Question | Answered by | Never by |
| --- | --- | --- |
| Which plugin is asking? | the pipe the request came in on | a field in the request |
| What may it do? | the permissions recorded when the person agreed to the manifest, plus any grant they gave in Settings | the manifest as it is on disk now, the snapshot, or the plugin's exports |
| For which conversation and checkout? | the lease the host opened when it started the call | a scope the plugin names |

**The consent record.** When the person installs a plugin, they see what its
manifest asks for, and the host records exactly that, outside the plugins
directory. An update is an install: the person sees the new manifest, and
their agreement replaces the record. "Exactly that" is held by a digest: the
dialog that showed the manifest passes its digest back with the install, the
copy is checked against it before it replaces the installed one, and the
record keeps the digest of what was shown, never one read from the copy. A
source that changes between the dialog and the click is refused, and the
installed version stays as it was. At every start, the host reads the
manifest again and compares. If it no longer matches the record, the plugin
does not start. Settings lists it as failed, saying its manifest changed
since it was installed; installing it again shows the person the new manifest,
and their agreement replaces the record. Plugins installed before the record
existed are recorded the first time they start.

Simulator authority is checked against the record more often than that.
Each time the host hands a call simulator access, it compares the manifest
with the record again, so a manifest changed while the plugin runs loses
`ctx.ios` at once, not only at its next start. Because a process holds one
plugin, the grant is that plugin's alone: a neighbour installed without it
neither blocks nor widens it.

**A lease** is the host's record of one call it made into a plugin. It
holds:
- the conversation;
- the checkout the host admitted for it;
- who started the call, the *actor*: an agent calling a tool, a person
  running a command, or the host resolving context;
- a cancellation signal;
- the call's deadline.

**How a lease works:**
- **Opened, then closed.** The host opens a lease before it sends the call
  and closes it when the answer arrives, or when the call times out or is
  cancelled.
- **Scoped to one pipe.** A lease's id means something only on the pipe it
  was opened for. A plugin may serve several calls at once, so a capability
  request names the lease it belongs to. An id from another pipe, or one
  already closed, is refused.
- **The source of every scope.** The conversation, checkout and actor of a
  team, forge, browser or device action come from the lease. If a request
  names a different conversation, it is refused.

**Calls outside a lease.** A plugin's code also runs when no call is open:
- while it starts;
- in its timers;
- when it is reconfigured;
- in hooks, which the host runs as checks around an agent's turn, not as a
  call for one conversation.

Planes that need no conversation work there. These are files in the open
workspace, the network, the editor and the workspace's name and branch.
Planes that act for a conversation are refused: the team board, the forge,
the browser and devices.

### 4. Capabilities are served, not handed over

Inside a plugin process, these are thin stubs:
- `ctx.fs`, `ctx.http` and `ctx.shell`;
- `ctx.browser` and `ctx.editor`;
- `ctx.team` and `ctx.forge`;
- `ctx.ios` and `ctx.android`.

Each call becomes a request on the plugin's pipe. The host's capability
broker answers it:

1. **Identify** the plugin by the pipe, and the lease by its id on that pipe.
2. **Check** the permission against the plugin's record, at the point of
   use. For files and shell, this includes the checkout the lease admitted
   and the symlink rules described in [extending.md](extending.md#permissions-and-isolation).
3. **Do the work** in the host, with the host's own implementation. These
   are the same functions the built-in plugins use.
4. **Answer** on the same pipe, within the lease's deadline. While a slow
   host operation runs, the lease's deadline waits for it, so the plugin is
   not timed out for waiting on the host. Booting a simulator is an example.
   Every such operation has its own limit (two minutes for a simulator boot),
   so a plugin cannot use one to hold a lease open indefinitely.

Because the work happens in the host, the check and the action sit in the
same trusted process. A plugin cannot skip the check by calling the action
some other way: in a confined process there is no other way.

`agents.invoke` and `secrets` are already in the manifest schema, but no
plane serves them yet. Each will be added by the recipe under
[Adding a capability](#adding-a-capability).

### 5. The runtime is confined

The plugin process starts under Node's permission model, with the flags the
Lead's child already uses:

```
--permission --no-allow-net --no-addons --allow-fs-read=<plugin directory>,<plugin runtime>
```

`--permission` denies file writes, child processes, worker threads and WASI
by default. The two `--no-*` flags deny the network and native addons. The
plugin may read its own directory and the code the plugin process itself
runs on, and nothing else. A plugin's npm dependencies therefore have to be
installed inside its own directory, which the installer already does.

**Which runtime runs it.** The same capability probe that chooses the Lead's
runtime chooses this one. The probe tries a loopback connection that a
confined runtime must refuse. It records what the runtime actually does,
not what its version number suggests. Network confinement needs Node 26 or
later. The desktop app bundles one for the Lead, so a packaged app always
has a runtime that passes.

**When no runtime passes,** for example a source checkout without the
fetched Node, plugins run unconfined. Layers 1–4 still attribute and check
every call the plugin makes through the host. But nothing stops an
unconfined plugin from using Node's own modules directly. The plugin host's
status says the plugins are unconfined, and why.

## A call, end to end

An agent in conversation *X* calls `issues_search`, a tool contributed by the
installed plugin `acme-issues`. The tool reads one file and makes one HTTP
request.

1. **The host finds the owner.** The tool's id is `plugin:acme-issues:3`, so
   the call goes to the `acme-issues` process.
2. **The host opens a lease** and sends `tool/invoke` on that process's
   pipe, naming the lease. The lease records:
   - the plugin, `acme-issues`;
   - the conversation, *X*;
   - the checkout the host admitted for *X*;
   - the actor, *agent*;
   - the deadline, 30 s.
3. **The plugin calls `ctx.fs.read('README.md')`.** Its stub sends `fs/read`
   on the pipe, naming the lease. The broker checks four things:
   - the pipe is `acme-issues`'s;
   - the lease is open on that pipe;
   - the recorded permissions grant `workspace.read`;
   - the path resolves inside the lease's checkout.

   It then reads the file and answers.
4. **The plugin calls `ctx.http.json('https://api.acme.dev/issues')`.** The
   broker checks the host name against the recorded `network.hosts`, and
   makes the request from the host.
5. **The plugin returns its result.** The host closes the lease. A request
   naming that lease, arriving any time after this, is refused.

**Two refusals:**
- **Another plugin names the lease.** Say plugin `other` sends a request
  naming the lease from step 2. The broker looks the lease up on `other`'s
  pipe, finds nothing, and refuses.
- **The plugin asks for too much.** If `acme-issues` asks for a path outside
  the checkout, or a host its record does not list, the broker refuses. It
  uses the same `Permission denied` message a built-in plugin gets.

## Lifecycle

| Event | What happens |
| --- | --- |
| **Inspect** | The installer reads the package's manifest in a short-lived process with no plugin code loaded. The person sees what it asks for before anything runs. |
| **Install or update** | The person agrees to the manifest. If an older version is running, its process is stopped first, so it cannot touch the files being replaced. The host records the manifest before the installer writes the package into the plugins directory, so a record that cannot be written leaves the installed version's files alone, and a copy that fails puts the earlier entry back and restarts the version that was running. A new plugin process then loads the new version. |
| **Start** | A plugin is the directory it was installed into: a manifest that names another plugin does not start. The host checks the manifest against the record, before every spawn, restarts included. The process is spawned and greeted: protocol version, browser settings, workspace, and the permissions the host holds the plugin to, which it applies rather than re-reading the manifest. It loads its one plugin. The host replays the plugin's stored configuration and keeps its snapshot. A restart that cannot load the plugin again ends that process and shows the plugin as failed. A start that is overtaken, by the plugin being turned off or started again, gives up and stops the process it made. |
| **Enable / disable** | Enabling starts the process. Disabling stops it and withdraws its contributions. The plugin stays listed in Settings either way, under the same instance id. |
| **Configure** | The setting goes to that plugin's process only. The host keeps the stored value and replays it after every restart. |
| **Crash** | The calls in flight on that pipe fail at once and their leases close. A plugin gets three restarts, after 250 ms, 1 s and 4 s. A fourth crash with no healthy run in between marks it failed, with the reason, and it stays stopped until the person enables it again. A healthy run is 30 s up, or any event from the plugin. No other plugin is affected. |
| **Wedge** | A call that overruns its deadline (30 s unless the host says otherwise) gets the process killed from the host's side. The crash path then takes over. |
| **Uninstall** | The process is stopped, then the installed directory and the consent record's entry are removed. Once the directory is gone the plugin is gone, even if its entry cannot be: one left behind grants nothing new, since an install writes its own entry first. Once an uninstall begins, turning the plugin on or installing it again is refused until it ends. |
| **Host shutdown** | Every process is asked to stop by closing its pipe. After 2 s it is killed. |

Install, uninstall and enable or disable of one plugin run one at a time, in the order they were asked for, so none of them acts on a plugin another has changed under it.

## Every plane, and how it is attributed

| Plane | Manifest permission | Where the work happens | Identity | Conversation and checkout |
| --- | --- | --- | --- | --- |
| Tools | — | plugin process | pipe | lease (actor *agent*) |
| Hooks | — | plugin process | pipe | none: the hook sees the turn it checks, as data |
| Automatic context, chips | — | plugin process | pipe | lease (actor *context*) |
| Slash commands | — | plugin process | pipe | lease (actor *person*) |
| Panels and UI blocks | `ui.contribute` | renderer, as data | pipe | — |
| `ctx.workspace` | — | host, as data | pipe | lease's checkout, else the open workspace |
| `ctx.fs` | `workspace.read` / `write` | host | pipe | lease's checkout, else the open workspace |
| `ctx.http` | `network.hosts` | host | pipe | — |
| `ctx.shell` | `shell` | host | pipe | lease's checkout, else the open workspace |
| `ctx.browser` | `browser` | host's browser, a page per plugin and profile | pipe | lease (required) |
| `ctx.editor` | `editor` | host's editor plane | pipe | — |
| `ctx.team` | `team` | host's team engine | pipe | lease (required) |
| `ctx.forge` | `forge` (`publish`, `write`) | host's forge engine, through the git gateway | pipe | lease (required); context resolution may read, never write |
| `ctx.ios` | `ios`, re-checked against the consent record on every call | host's simulator engine | pipe | lease (required) |
| `ctx.android` | `android` | host's device engine | pipe | lease (required) |

**Hooks** are ordered across plugins the way they are within one. The host
knows every hook's event, tool match and priority from the snapshots. It
runs the matching hooks one at a time, in priority order, each in its own
plugin's process. The first `deny` or `ask` decides.
Built-in plugins' hooks run first, in their own priority order, and the
installed plugins' hooks follow; a built-in `deny` or `ask` therefore
decides before any installed plugin is asked.

**A hook that cannot run:**
- A hook that throws, or overruns its own timeout (5 s unless it asks for
  up to 30 s), is skipped, as it was before isolation.
- A hook whose process is down, or does not answer at all, counts as
  `deny`: a check that could not run must not read as approval.
- A plugin that is not running at all, because it is turned off or failed to
  start, contributes no hooks, exactly as if it were not installed. Settings
  shows it as off or failed.

Running hooks one at a time means their latency adds up across plugins,
which is the price of a stable order.

**Automatic context** is resolved in every plugin process that provides it.
The processes are asked in parallel, which is new: within one process,
providers are still asked in turn, each within 5 s. The results are joined
in install order. A process that cannot answer contributes nothing, because
context is additive.

## Failure posture

| What fails | What happens |
| --- | --- |
| A tool in a plugin that is down | The call fails with a plain error. The turn continues, and the agent is told the tool is unavailable. |
| A hook whose plugin is down | The hook denies. |
| Context from a plugin that is down | It is absent. |
| A capability request that cannot be attributed | It is refused, and the refusal says why: wrong pipe, closed lease or no lease. |
| A plugin whose manifest no longer matches its record | The plugin does not start, and Settings says why. |

None of these affects any other plugin.

## What it costs

- **Memory.** Each plugin process is a separate runtime. The plugin host
  reports each process's memory, so the cost of a heavy plugin is visible
  and attributed.
- **Start-up.** Plugin processes start in parallel. A slow plugin delays its
  own tools, not the others' and not the host's.
- **Brokered work crosses a pipe.** A file read or an HTTP request costs one
  round trip more than an in-process call. Plugin work is paced by agent
  turns, not tight loops, so the trade is worth it.
- **Hooks run in turn,** as above.
- **No services shared between installed plugins.** One installed plugin can
  no longer `inject` a service another installed plugin `provide`s. The
  host's own services remain available to every plugin.

## Extending the model

### Writing a plugin

Nothing about the API changes. A plugin written for the
[authoring guide](extending.md) runs the same way. Three things to know:

- **Your plugin is alone in its process.** It cannot reach another plugin's
  module state, and no other plugin can reach yours.
- **Use `ctx`, not Node's modules, and that includes your dependencies.** A
  confined plugin process has no `node:fs`, `node:child_process`, `node:net`
  or `fetch` of its own. A dependency that calls them fails there too.
  `ctx.fs`, `ctx.shell` and `ctx.http` are the way in, and they work the same
  in tests and in the app.
- **Declare what you use.** A permission the manifest does not name is
  refused at the call, never prompted for. Asking for more in an update
  means the person agrees again before the update runs.

### Adding a capability

A new `ctx.<plane>` takes six edits, in this order:

1. **The permission.** Add it to the manifest's parser in
   `packages/cordis-host/src/manifest.ts`. Add the sentence the consent
   screen shows to `describePermissions`. A permission the person cannot read
   is not a permission they gave.
2. **The implementation, in the host.** In `packages/cordis-host`, write a
   function of three inputs: the plugin's permission gate, the lease's
   scope, and the arguments. Built-in plugins call it directly through their
   service.
3. **The protocol.** Declare `<plane>/<verb>` in `packages/extension-protocol`
   and bump `EXTENSION_PROTOCOL_VERSION`. A request names its lease when the
   plane needs a conversation. It never names a plugin.
4. **The stub.** In the plugin process, `ctx.<plane>` forwards to the pipe
   and nothing more. It holds no policy.
5. **The broker.** In `packages/extension-host`, take the identity from the
   pipe, the permission from the record and the scope from the lease, then
   call the function from step 2. If the operation can outlast the call's
   deadline, give it a limit of its own and let the lease's deadline wait for
   it.
6. **The tests.** Write each one so it fails before the broker exists:
   - a plugin without the permission is refused;
   - a request on one plugin's pipe naming another plugin's lease is refused;
   - a request with no lease, or with a closed one, is refused where the
     plane needs a conversation;
   - a plugin crash mid-operation releases what the operation held.

Then document the capability in [extending.md](extending.md), and add a row
to the plane table above.

### Adding a kind of extension

Some extensions are not code plugins, and do not belong here:
- **Skills, MCP servers and agent settings** belong to the agent, which keeps
  them in its own directories ([architecture.md](architecture.md)).
- **Panels** are data, rendered by the host's own components. No plugin code
  runs in the renderer.

A future kind of code extension plugs in behind the same pipe. A plugin
compiled to WebAssembly, or one that runs on another machine, would each be
a new way to start a plugin process. The host's half stays as it is:
records, leases, broker and attribution. Keeping the authority on the host's
side of the pipe is what makes that possible.

## Alternatives considered

| Option | Why not |
| --- | --- |
| **One process for all installed plugins** | A crash stays out of the host, but requests cannot be attributed by channel: every plugin shares one pipe, so identity would have to be claimed, and the process is one trust domain. |
| **A worker thread per plugin** | Threads share one address space and one permission model, and a crash in native code takes them all down. They isolate less than processes for nearly the same cost. |
| **`vm` contexts** | Node documents that the `vm` module is not a security mechanism. |
| **A WebAssembly or embedded-JavaScript sandbox** | It confines the most, but plugins could no longer use npm packages or the plugin API they are written against. It remains open as a future kind of plugin. |
| **Plugins as agent tool servers only** | A tool server can contribute tools, but not hooks, turn context, commands, panels or editor marks. A process per plugin gives the same isolation without giving those up. |

## Delivery

| Part | Status |
| --- | --- |
| 1. One process per plugin, with a fresh environment | in progress |
| 2. The channel is the identity | in progress |
| 3. The host holds the authority, including the consent record | in progress |
| 4. Capabilities are served, not handed over | next |
| 5. The runtime is confined | next, with layer 4 |
| An operating-system sandbox per plugin process | planned |

The record of this choice, its costs and its alternatives is in
[decisions.md](decisions.md#installed-plugins-run-one-to-a-process).
