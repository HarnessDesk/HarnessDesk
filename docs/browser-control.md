# Browser control: agents that can see, click, and debug

An agent can open a page, look at it, click it, type into it, read what it
logged and what it fetched, and reach any DevTools method the tools do not
model — in a pane inside the window, or in your own Chrome. Fourteen
tools, one service, two engines behind the same interface.

## Why it exists

The Browser plugin could *read* the web (`/browse`, page text, a history
panel), but no agent could **drive** a browser: open the thing it just built,
look at it, click it, press its keys. Verifying a web game meant you did
the looking. That is not a gap in a feature; it is the difference between an
agent that can finish a web task and one that hands it back half done.

Six tools bought that. They did not buy the second half: an agent that builds a
web app and cannot read the console it just filled with errors, or see the
request that 500'd, is doing the work with one eye shut. So the surface is now
the protocol's own shape — input, the DOM, console, network, emulation — with a
passthrough for everything not worth a method of its own.

## The tools

Registered by the Browser plugin, which is
[built in](../packages/plugins/src/browser.ts) — an agent that has to install
something before it can look at the page it just built has already lost the
turn.

| Tool | Does | Returns |
| --- | --- | --- |
| `browser_open {url}` | starts or reveals a browser, navigates | title/url + screenshot |
| `browser_screenshot {fullPage?, ref?}` | looks — viewport, document, or one element | title/url + screenshot |
| `browser_read_page {format?, query?, filter?}` | the page as named parts with `ref_N` handles, or as text | text |
| `browser_click {ref\|x,y, button?, count?, modifiers?}` | mouse press+release | screenshot after settle |
| `browser_pointer {action, …}` | hover · scroll · drag | screenshot after settle |
| `browser_key {key, count?, modifiers?}` | keyboard (`Enter`, `ArrowLeft`, `⌘A`…) | screenshot after settle |
| `browser_type {text, ref?, submit?}` | types a string into a field | screenshot after settle |
| `browser_fill {ref, value}` | sets a control — text, select, checkbox | screenshot after settle |
| `browser_page {action, …}` | back · forward · reload · wait · emulate · pdf · upload | screenshot after settle (PDF for pdf) |
| `browser_console {onlyErrors?, pattern?}` | what the page logged, and what the browser logged about it | text |
| `browser_network {urlPattern?, requestId?}` | what the page fetched; one body in full by id | text |
| `browser_evaluate {expression}` | reads page state (a score, a DOM fact) | JSON text |
| `browser_cdp {method, params}` | any DevTools method at all; `events: true` reads the raw stream | JSON text (or text for events) |
| `browser_close` | closes the driven browser | text |

**Every interaction tool returns a fresh screenshot**, because the next thing
an agent does after acting is look. Folding the look into the act halves the
round trips — the computer-use convention.

### Two ways to aim, and the second is better

A screenshot plus pixels is how a model looks at a page you designed.
`browser_read_page` hands the same page back as an accessibility-shaped
outline whose interactive parts carry handles:

```
- document "Harness CDP check" url="http://127.0.0.1:51999/"
  - heading "Sign in" level=1
  - textbox "Email address" [ref_1] value=""
  - combobox "Plan" [ref_2] value="free"
  - checkbox "I agree" [ref_3] unchecked
  - button "Sign in" [ref_4]
  - link "Read the docs" [ref_5] href="#docs"
```

Every pointer tool takes a `ref`: no measuring, no Retina arithmetic, and a
click that fails says *which* element went missing rather than landing on
whatever moved into those pixels. Pixels remain for what refs cannot express —
a canvas, a map, a game.

### A password is not part of the answer

One field never carries its value into that outline. A read of a page is not a
considered act — an agent runs it on arrival, before it knows what the page is
— so a filled password box would put the password in the model's context, in
the transcript on disk, and in the logs of whatever service answers the turn.
None of those can be un-said. From a sign-in page served over HTTP:

```
- textbox "Email" [ref_1] value="ada@example.com"
- textbox "Password" [ref_2] secret filled
- textbox "One-time code" [ref_4] secret filled
```

`secret` marks the field; `filled` or `empty` says whether anything is in it,
which is what you read off the dots and what a screenshot has always
shown. There is no stand-in value: a `value="(hidden)"` would put a lie in the
slot every other line uses for the truth. Chrome's own accessibility tree says
the same thing — role `textbox`, flagged *protected*.

A field is secret when it is `type="password"`, or when its `autocomplete`
carries `current-password`, `new-password`, `one-time-code`, `cc-number`,
`cc-csc`, `cc-exp`, `cc-exp-month` or `cc-exp-year`. The attribute matters on
its own: an OTP box and a card number are both usually `type="text"`, and
would read as ordinary textboxes otherwise. `cc-name` and `cc-type` are not on
the list — a cardholder's name and the word "Visa" are not the secret.

An unlabelled secret field is reported with **no name** rather than with its
own contents, because a `<textarea>` keeps its value in a child text node and
the accessible name would otherwise hand over exactly what the `secret` bit
beside it withheld. A `browser_page {action:"wait"}` will not take a selector
carrying a `[value=…]` predicate either: asked once a letter, that spells out
a server-rendered value one true/false at a time.

`browser_network` redacts the same way in the one place a URL can carry a
credential — the values of query parameters named like one (`code`, `token`,
`api_key`, anything ending `_secret`) are replaced, and the parameter names
stay, because an agent debugging a request needs to know what was sent.

`browser_fill` and `browser_type` still write into these fields — signing in is
the point — and `browser_fill` reports `{secret, filled}` instead of echoing
back what it wrote.

**The withholding is not a lock, and does not pretend to be.**
`browser_evaluate` returns what its expression asked for, and `browser_cdp`
returns what the protocol gives — `Accessibility.getFullAXTree` and
`DOM.getOuterHTML` both carry secret values. Both say so in their own tool
descriptions. Guarding them would mean pattern-matching an expression an agent
wrote, which is unenforceable in a thousand spellings and would buy false
confidence at the price of a working debugger. The guard belongs where an
agent gets a page *without asking for it*, which is every one of the automatic
reads above. `browser_console` is left alone for the neighbouring reason: it
reports what the page itself logged, and a console reader that silently drops
lines is a debugging tool that lies.

**Coordinates are screenshot pixels; references are not.** `browser_click
{x,y}` divides by the page's own `devicePixelRatio`, so a model clicks where it
was shown to click on a Retina display as well as a 1× one. A `ref` is resolved
by the page and comes back in CSS pixels already — dividing it a second time
would click at half the distance, which is a test in
`packages/cordis-host/test/browser.test.ts` rather than a comment.

**The tree is a DOM walk, not `Accessibility.getFullAXTree`.** CDP's own answer
returns `backendNodeId`s that must be resolved through `DOM.resolveNode` before
anything can be clicked, go stale on the next mutation, and cost three round
trips per interaction. A walk of the live DOM answers in one
`Runtime.evaluate`, keeps the element itself rather than a number standing for
it, and reads the same ARIA. The AX tree is still one `browser_cdp` call away
for anyone who wants it — that is what the passthrough is for.

References live on `window.__hdRefs`, in the page. A navigation destroys them
with the document, so a stale ref fails loudly instead of resolving to whatever
now holds that index.

### Console and network

`browser_console` reports three things as one list: `console.*` calls,
uncaught exceptions, and the browser's own `Log` entries — a blocked
mixed-content load, a CSP refusal, a 404 for a stylesheet. The last of those
never reaches `console.log` and is usually what explains a blank page.

Electron's own security warning is filtered out by source URL. It is logged
into the pane guest's console by the shell, and reporting it as something the
page said would send an agent hunting a CSP bug in code that has none.

`browser_network` is one row per request, folded from its four events, with the
request id that `browser_network {requestId}` turns into the response body.

**Events are pulled, never pushed.** CDP pushes console and network events, and
a plugin runs in a child process reached by request and reply. The obvious
design is a reverse notification lane; that means a second direction on the
wire, a buffer at each end, and a child paying for events no plugin ever reads.
Instead the engine keeps a ring buffer and the service drains it on demand —
one direction, one buffer, and a turn that never asks costs nothing. An engine
that cannot subscribe at all says so by name rather than returning an empty
list, because "the page logged nothing" is a different claim from "I cannot hear
it".

**Plugins never see CDP** — except through the one door marked as such. The
service is `ctx.browser` in the plugin host (`cordis-host`), behind a manifest
permission `browser: true`, the same shape as `ctx.http` (host-gated) and
`ctx.shell` (no shell interpretation). Every operation carries a mandatory
timeout, because a hung page must not hang a turn.

`browser_cdp` is that door: any method, any parameters. It is not a hole in the
permission model — everything above is the same protocol, and a plugin that may
click a page may already read it — but it does mean `browser: true` grants the
*browser*, so the consent string says so in those words: "Open and control a
browser on this machine, and read its pages, console and network activity".

## The engine

The browser service only ever spoke DevTools Protocol, so the transport is a
`BrowserEngine` (`packages/cordis-host/src/browser.ts`) with two
implementations. The fourteen tools do not know which one is behind them.

**The pane's `<webview>`, over `webContents.debugger`** — the desktop shell
(`packages/desktop/electron/browser-engine.mjs`). The pane names its guest by id
over IPC once `dom-ready` fires; main attaches the debugger and answers
`Page.navigate`, `Page.captureScreenshot`, `Input.dispatchMouseEvent` and
`Runtime.evaluate` from it.

**Your own Chrome, over a WebSocket** — headed and visible, so you watch the
agent drive rather than watching a streamed imitation. No bundled browser and
no new dependency: Node ≥22 has a WebSocket client, and Chrome writes
`DevToolsActivePort` when started with `--remote-debugging-port=0`. A
dedicated profile directory keeps the agent out of your own Chrome profile,
cookies included. Kept, that profile lives in the desk's own state directory
(`<HARNESSDESK_HOME>/browser-profile`, named by the host); not kept, it is a
directory made for that browser and removed with it.

**`Page.printToPDF` is answered by the shell.** Headed Chromium does not
implement the method — through the pane's debugger it answers "wasn't
found" — so the desktop engine prints the guest itself
(`packages/desktop/electron/pdf.mjs`) and returns the protocol's own `{ data }`.
A separate Chrome window cannot, and the tool says so in words rather than in
that error.

**Across the process boundary.** The Browser plugin is an *installed* plugin
and runs in the supervised plugin-host child process, which has no window of
its own. The extension host forwards every DevTools call to the desktop shell's
engine when running inside the app, and starts Chrome itself otherwise.

**Guest isolation.** `webviewTag` is on for the one window; guests get no
preload and no Node (re-asserted in `will-attach-webview`), a partition of
their own (`persist:harnessdesk-browser`), and only `http(s)`, `file` and
`about` sources. Guests carry `allowpopups`, because without it Chromium never
consults the shell's window-open handler at all — and that handler is the
whole mechanism: it denies every window and routes the URL to a tab here or
to the OS browser, so no popup is ever made. The web build has no webview and
falls back to a sandboxed iframe, with Chrome behind the tools.

## The Browser pane

The globe in the top-right of every conversation header — and *Open browser*
in the palette — opens the pane beside the conversation, with back, forward,
reload and an address bar. One per layout, like the preview pane.

**A tool can open it.** When an agent calls `browser_open` and no pane is open,
the shell opens one and waits for the view to load; `browser_close` asks for it
to go. A pane you close is gone until the next call.

### Which tab the tools drive

With one tab the question does not exist — driven and visible are the same
page, which is the promise the pane was built on. With several they can come
apart, and the failure is not theoretical: Chromium suspends timers and stops
rasterising a `<webview>` that is not on screen, so a tool that screenshots a
hidden tab gets a frozen or blank frame.

So the rule is kept rather than dropped:

> **The driven tab is a named tab, and acting on it brings it to the front.**

One tab carries a `driven` mark (a dot on its tab, `Agents drive this tab` in
its menu). `browser_open` navigates *that* tab and makes it active; before any
tool command the shell asks the pane to front it. You can browse in the other
tabs all you like — the next tool call snaps back to the agent's page, which is
both correct for the agent and honest for you, because you see it happen.
Closing the driven tab moves the mark to its neighbour; there is always exactly
one.

The alternative — driving whichever tab happens to be active — was rejected: it
makes an agent's turn depend on where your attention was three seconds ago.

### Device sizes

`Responsive` (the page fills the pane), `Mobile 375 × 812`,
`Tablet 768 × 1024`, `Desktop 1280 × 800` — per tab, not per pane, so the docs
can sit at desktop width while the app beside them is a phone.

A preset **sizes the guest's own box** rather than emulating one. The
`<webview>` element is given the device's width and height and centred on a
letterbox; if the pane is narrower than the device, the whole element is scaled
down with a CSS transform. The guest genuinely has that viewport, so
`Page.captureScreenshot` returns exactly those pixels and
`Input.dispatchMouseEvent` coordinates need no correction — the tools did not
have to learn about devices at all. The visual scale is a compositor transform,
so your clicks hit-test correctly through it too.

Mobile also carries a phone user agent, because a load-time device gate reads
the UA and not the width. Changing the UA re-creates the guest, which reloads
the page — deliberately, since that is what makes such a gate run again.
Tablet, desktop and responsive share the desktop UA and only resize, so
switching between them keeps the page's state. Touch-point emulation is *not*
claimed: the viewport and the UA are what this does.

### Annotating: pointing at the thing you mean

The gesture is the same wherever you have met it: rather than describing which
element is wrong, point at it. Comment on an element, drag a region, or draw
freehand over the page. The pane does all three.

The **✎ button in the address row** turns it on, and a bar appears under that
row — the find bar's twin, and there for the same reason: a control drawn over
the page hides the very thing it is about.

| Tool | Gesture | What it records |
| --- | --- | --- |
| Comment | hover highlights an element, click it | its own words, a CSS path, where it sits in the viewport |
| Comment | drag across empty space | the region's size and position |
| Draw | drag to draw | the strokes, and where they were made |

Each mark takes a comment inline — Enter commits it, Escape drops it — and
wears a number. **Add to message** hands them to the composer as a **chip**,
beside the page's own picture of them: the text box holds what you typed and
nothing else, so a block of envelope is never pasted into it for you to scroll
past or delete around. The chip names what it carries, offers its first lines on
hover, and can be taken back off the message like any other attachment. On send
it goes as a `<context source="Page annotations">` block — the transcript's
folded "Context added · Page annotations" row beside the sentence you typed.
The block is shaped the way models are already used to receiving this, because
a familiar shape is read correctly more often than a better one nobody has
seen. An agent that
says it takes no images gets the block alone, with a line saying the picture was
not attached rather than a reference to a picture that is not there.

The overlay lives **inside the guest page**, injected by `executeJavaScript`
([`lib/annotate.ts`](../packages/ui/src/lib/annotate.ts)), for a reason worth
stating: a `<webview>` is opaque to the window around it, so an overlay drawn
in the renderer could paint over the page but never know what is under the
pointer. Putting it in the page also makes the picture free — `capturePage`
photographs the marks because by then they *are* the page — the same reason a
marked-up screenshot works anywhere else.

Three things follow from that, and each is deliberate:

- **The marks follow the page.** An element is re-measured rather than
  remembered, so reflow cannot leave a box pointing at whatever slid into its
  place; regions and strokes are held in page coordinates and offset by the
  scroll.
- **A reload does not end the mode.** The overlay goes down with the document
  it was in; the pane notices within a tick and puts it back, because the mode
  belongs to the pane and not to the page.
- **Leaving takes it down.** Switching tabs, leaving the mode, or closing the
  pane removes the overlay in the page it was put up in — a page left dressed
  for annotating would swallow every click in a pane nobody is annotating in.

### The pane's settings

The `⋮` menu, in the order that reads best rather than the order they were
built:

| Row | What it does |
| --- | --- |
| Save screenshot… | captures the active tab through the debugger main already holds, and writes what the save dialog names |
| Send page to chat | the page as a picture (or its text, for an agent that takes no images) into the conversation's message box |
| Open developer tools | Chromium's own, on the active guest |
| Find in page · Zoom in · Zoom out · Actual size | ⌘F, ⌘+, ⌘−, ⌘0 — the find bar under the address row, and Chrome's own zoom ladder |
| Open in default browser | hands the current URL to the OS |
| Browser tools drive this tab | moves the driven mark to the tab on screen |
| Open links in Browser pane | whether a page's `target=_blank` opens a tab here or leaves for the OS browser |
| Persist sessions | whether guests use `persist:harnessdesk-browser` or an in-memory partition — cookies and logins, or none |
| Clear browsing data | empties the persistent partition |

The menu takes the room under its trigger. A fixed 400px ceiling used to
scroll this list with half the window empty beneath it, and the last three
rows — the ones about cookies — were found only by people who noticed the
scrollbar (2026-09-06).

**Downloads.** A page's download goes where a browser puts it: the Downloads
folder, under the name the server gave, a second copy numbered rather than
the first replaced. A notice says where it landed and offers *Show in
Finder*; the shell reveals only files it saved itself. Before 2026-09-06 a
`<webview>` guest with nobody listening for `will-download` dropped the file
on the floor — no dialog, no file, no word.

**Keys, while the pane is the one you are in:** ⌘T, ⌘⇧T, ⌘W, ⌘L, ⌘F, ⌘R
(⌘⇧R without caches), ⌘+, ⌘−, ⌘0, ⌘[ and ⌘], ⌘1–9.

These are **application** preferences, stored beside `listPrefs` in `app/state`,
not layout state: which pages are open belongs to a workspace, but whether this
app keeps cookies is a standing answer.

Three things this menu deliberately does not offer. There is no site
allowlist: browser access is gated at the plugin permission, and a second,
different security model in a pane menu would be a claim the app does not
implement. There is no auto-verify toggle, because nothing here behaves that
way. And there is no **Open file…** picker, because the address bar already
takes `file:///…`, which is the capability.

### What persists

`{ kind: 'browser', tabs: [{ id, url, title?, device? }], active, driven }`
replaces `{ kind: 'browser', url }` in the layout, per workspace. A layout
written by the old shape is read as a single tab on that URL, so no one loses
their page to the upgrade.

## Which agents actually get the tools

Plugin tools reach an agent one of two ways, and neither is universal:

- **Codex** takes client-provided tools when starting a thread, so every plugin
  tool is projected as a dynamic tool
  (`packages/adapter-codex/src/capabilities.ts`).
- **ACP agents** are offered an MCP server when initializing a session — the
  `harnessdesk` bridge (`packages/mcp-tools`), which forwards to the host's tool
  gateway over a unix socket in the state directory. Filesystem permissions are
  the auth, so no token rides the environment.

| Agent | Browser tools | Why |
| --- | --- | --- |
| Claude Code | **yes** | takes the MCP server |
| Codex | **yes** | dynamic tools at thread start |
| Cursor | **yes** | a generated plugin directory, passed as `--plugin-dir` with `--approve-mcps` |
| DeepSeek Harness | **yes** | a `dsh-mcp-client` entry in its own composition spawns the bridge; the host names the socket in the agent's environment |

**Cursor's route** (closed 2026-08-27): `cursor-agent` does not take an MCP
server in the session request, but it takes a *plugin directory* on the
command line, and a plugin declares MCP servers in its `.mcp.json` — the
marketplace layout, `.cursor-plugin/plugin.json` beside `.mcp.json`. The
bridge writes one per chat under the temp directory and every turn passes
`--plugin-dir` with `--approve-mcps` (print mode cannot show the approval
prompt, and the only server in the directory is the one HarnessDesk itself
offered). Your own `~/.cursor/mcp.json` is never touched — a bridge has
no business editing it, and a per-chat directory is inspectable and dies with
the temp tree. Verified against the live CLI: asked to list its `harnessdesk`
tools it named all 44, `browser_open` among them, and a `git_status` call went
CLI → generated plugin → `mcp-tools` bridge → unix socket → tool gateway and
came back with the gateway's real answer.

**DeepSeek Harness's route** (closed 2026-08-27): its ACP layer still refuses
a non-empty `mcpServers` outright (`packages/acp/acp/src/index.ts`, in DSH's
own tree), and that refusal stays *visible* — the adapter retries once
without the server and logs why the session-request road is shut. The road
that is open is DSH's own composition: DSH ships `@deepseek-ai/dsh-mcp-client`,
a Cordis plugin that spawns one stdio MCP server per composition entry and
registers its tools natively (`mcp__harnessdesk__git_status` and so on). One
entry in the profile's `cordis.yml` points it at the same `mcp-tools` bridge
every other agent gets:

```yaml
- id: harnessdesk-tools
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: harnessdesk
    command: node
    args:
      - <harnessdesk>/packages/mcp-tools/dist/src/main.js
```

The bridge finds the gateway through `HD_TOOLS_SOCKET`, which the host now
sets in **every ACP agent's own environment** (`agentEnvironment` in
`packages/server/src/bootstrap.ts`) — not only in the MCP server offered at
session creation. A composition file cannot know which host will launch it, so
ambient env is the only road down to a composition-spawned child; DSH's env
scrub for MCP children passes it through. Outside HarnessDesk the bridge
finds no socket and the client degrades without failing the boot. Verified
end to end on 2026-08-27: a real DeepSeek turn listed all 59 tools on the
request wire (44 of them `mcp__harnessdesk__*`), the model called
`mcp__harnessdesk__git_status`, and the answer came back through
dsh-mcp-client → `mcp-tools` bridge → unix socket → tool gateway with the
workspace's real working-tree status. One trap the verification hit: the ACP
server answers `initialize` before the tree settles, so a prompt fired
within the first seconds of a fresh boot can assemble its toolset before the
client finishes enumerating — later turns see the full set.

Cursor's failure used to be invisible — the bridge accepted `mcpServers` and
dropped it, so HarnessDesk believed Cursor had tools the model was never
given, and the only symptom was an agent saying it could not open a browser;
then it refused honestly; now it delivers. DSH's story ends the same way by a
different door: every agent in the table reaches the plugin tools.

## How this was built, and what each step measured

Parity here is measured, not claimed, so the sittings are recorded rather than
summarised away.

**2026-08-22 — the tools, against Chrome.** Two things already existed and had
never met: plugin tools reached Codex as dynamic tools but that path had never
been exercised by a live model, and `ToolResultPart` already supported
`{type:'image', url}` which `toCodexToolResponse` mapped to Codex `inputImage`
— a screenshot pipeline with no browser behind it. The validation was one flow
that exercised both: Codex built a small click game through HarnessDesk, then
played it through these tools — open, screenshot, click, read the score — while
the Chrome window showed the run live.

**2026-08-22, the same evening — the pane.** Claude Code's and Codex's desktop
apps show the page *inside* the window; HarnessDesk showed it in a separate
Chrome. Adding the `<webview>` engine changed no tool code. Validated with a
small to-do app served on localhost: opened by `browser_open` into the pane,
two items typed by `browser_key`, one clicked done by `browser_click`, state
read by `browser_evaluate` — and then by Claude Code through HarnessDesk, which
found `mcp__harnessdesk__browser_open`, passed the permission gate, and
reported the title and item count from the page in the pane.

**2026-08-23 — tabs, devices, settings, and who actually gets the tools.**
Measured through the bridge, against the running desktop app:

- `tools/list` returns **36 tools** on a fresh install, `browser_open` …
  `browser_close` among them. The six `browser_*` tools are built in;
  `examples/browser-plugin` is the worked example and installs nothing on top.
- `browser_open` navigated the driven tab and came back with the page title and
  a PNG.
- `browser_click` at **screenshot** pixels (606, 788) landed on a link at
  **CSS** (303, 394) and navigated. The two differ by the display's scale
  factor, and until this round the pane's tools ignored it — on any Retina Mac
  a model clicking what it had just been shown was landing at half the
  distance. Dividing by `devicePixelRatio` fixed it, and let Chrome stop being
  launched at `--force-device-scale-factor=1`, the flag that had made its
  window render at 1× on a 2× panel and look soft.

**2026-08-24 — the rest of the protocol.** Measured twice, because there are
two engines and they disagreed. Against a real Chrome (headless host, a local
page served over http) and then against the Browser pane in the running desktop
app, through the tool gateway socket:

- `tools/list` returns **44 tools** on a fresh install; the fourteen
  `browser_*` are all there under one namespace.
- The tree above is verbatim output from the real page: roles, accessible
  names, `value=`, `unchecked`, `href=`, and the `ref_N` handles. A secret
  field carries `secret filled`/`secret empty` in place of its `value=`; that
  page had none, so the shape is shown under *A password is not part of the
  answer* instead.
  `browser_read_page {query}` narrowed it to the one matching line;
  `format: "text"` returned what a person reads.
- One flow exercised the lot: `browser_type` into a named field,
  `browser_fill` on a select *by its label* and on a checkbox, `browser_click`
  on the button, `browser_page {action:"wait", text:"signed in"}`, and the
  page's own `console.log` came back reading
  `clicked with pane@harnessdesk.app pro true` — every value the page received
  is one a tool put there.
- `browser_console` reported the page's `console.error` with its line number,
  and the browser's two 404s that no `console` call produced.
  `browser_network` reported those same 404s as rows with status, MIME type,
  size and id.
- `browser_cdp` fetched `Accessibility.getFullAXTree` (36 nodes) — the tree
  this file chose not to build on, still one call away.
- `browser_page {action:"emulate", colorScheme:"dark"}` made
  `matchMedia("(prefers-color-scheme: dark)").matches` true in the page, and
  `reset` put it back. `fullPage` captured a 3200px document at four times the
  bytes of its 768px viewport, so `captureBeyondViewport` is doing the work
  the flag claims.

Two defects the sitting found, both fixed in it:

- **Typing into a fresh pane went nowhere and reported success.**
  `Input.insertText` is delivered to the *frame's* focused element, and a
  page-side `element.focus()` sets `document.activeElement` without focusing
  the frame — so on a guest nobody had clicked yet, the text vanished and the
  tool said "Typed". It only ever showed up when typing was the first thing an
  agent did, which is exactly what an agent does with a login form.
  `browser_type {ref}` now clicks the field first, the way a person does, and
  the shell focuses the guest before any `Input.*` command.
- **Electron's security warning was reported as something the page said.** It
  is logged into every `<webview>` guest by the shell; an agent reading it
  would go looking for a Content-Security-Policy bug in a page that has none.
  Filtered by source URL (`node:electron/…`).

One behaviour was left as it was at the time, and turned out to be a defect:
"on the first open the page can load twice". It was every open. React
reflected each change of the tab's URL into the `<webview>`'s `src`
attribute, and Electron treats a changed attribute as a navigation — the same
URL included, which it documents as a reload. So an agent's `Page.navigate`
was followed by React's reload of the page and then by the pane's own
`loadURL`: three loads, a 200 / `ERR_ABORTED` / 200 in the network view, and
the first document's response body gone by the time an agent asked for it by
id. Fixed 2026-09-06: the attribute is the guest's birth address and every
later navigation goes through `loadURL`, which is one request.

**2026-09-06 — every setting, driven through the real app.** A rig launched
the desktop app on a throwaway home against a fixture site and drove each
setting and each pane control both ways — through the tool gateway (the
route an agent takes) and through real input events on the pane — 112
checks, all green on the build that shipped. What it found, and what was
done, in the order the failures appeared:

- **`browser_close` closed nothing.** `closeBrowser()` looked for the pane in
  the split tree, and the browser has lived in the right-hand dock since the
  panel system. The next `browser_open` then waited on a guest the shell had
  let go of. Closed wherever it is mounted.
- **⌘⇧T never had anything to put back**, for the same reason: the closed tab
  was remembered only when the pane was in the split tree.
- **A labelled control was named after its options.** `<label>Plan
  <select>` read as `combobox "Plan FreePro"`, so a ref could not be found by
  its label. A label names its control by its own words now, and a landmark
  is not named after every option of every select inside it.
- **A link that wrapped could not be clicked.** The centre of an inline
  element's bounding box is the gap between its two line boxes; the click
  landed on the paragraph and the tool reported the link clicked. Refs aim
  at the largest line box.
- **`target=_blank` went nowhere in the pane** — guests had no `allowpopups`,
  so the shell's handler that turns a new window into a tab never ran.
- **The find bar read "No results" over a page of matches.** Chromium answers
  a request that spells out `findNext: false` with silence; a first request
  now leaves the option out. Enter had been the only way to get a count.
- **Print to PDF failed with "'Page.printToPDF' wasn't found".** Answered by
  the shell (above).
- **"Not kept" reused the kept profile** whenever a kept browser had run
  first in the same host; and the kept profile lived in `~/.harnessdesk`
  whatever `HARNESSDESK_HOME` said. Both go to the right directory now, and
  a throwaway profile is removed with its browser.
- **`browser_open` with pages set to the default browser failed after
  succeeding**: the page was handed to the OS and then the tool tried to
  screenshot it, which the same setting refuses. The tool now says the page
  went to the default browser and why nothing more can be done with it.
- **Two error messages named settings rows that do not exist** ("Browser
  application", "Where pages open"). They name the rows as drawn.
- **Send page to chat sent nothing** when chosen from the pane's own menu:
  the composer only listens while its pane has the focus, and the menu had
  taken it. The page and the annotations share one hand-over now, and say
  so when there is no conversation to hand to.
- **The pane's menu scrolled at 400px** and hid its last rows (above).
- **A download did nothing** (above).
- **A network row that failed after answering hid its status.** A stylesheet
  that came back 404 and was then abandoned read `FAILED net::ERR_ABORTED`;
  it reads `FAILED net::ERR_ABORTED (after 404)`.
- **Naming the same guest twice leaked a listener** on every re-announcement
  until Node warned about it.
- **And one that took the whole desk down.** A write to a helper's stdin
  after the helper had gone raised EPIPE as an uncaught exception in the
  main process, and Electron's answer to that is a modal error box — the
  window sat behind "A JavaScript error occurred in the main process" until
  it was killed, tools and agents frozen with it. Every child-stdin writer
  listens for the pipe's error now, and the shell never stops to ask: a pipe
  that went away is another process's exit and the shell carries on; any
  other uncaught exception is recorded and the shell relaunches itself —
  the layout and the conversations are on disk — unless it just did, in
  which case it exits rather than loop
  (`packages/desktop/electron/crash-policy.mjs`).

**The review round, 2026-09-06.** Three reviewers from three vendors — Claude
Code on Opus 5, Codex on GPT-5.6 Sol, Cursor on Gemini 3.8 Flash, seated in
one room by the desk itself — read the diff of the above. What they found,
and what changed:

- The download listener closed over the window it was made in; on a Mac the
  app outlives its window, and a download after the window was reopened
  told a destroyed one. It tells the window of the moment.
- Two `report.csv` downloads at once could be handed one destination, since
  only files already on disk counted as taken. A destination is reserved
  the moment it is named and released when the download ends.
- The shell's first answer to an uncaught exception was to carry on, which
  is right for a broken pipe and wrong for a failure nobody can vouch for.
  Hence the policy above.
- A label built from several elements ran its words together
  (`<span>First</span><span>name</span>` read "Firstname"); the spaces are kept.
- A throwaway Chrome profile was left behind whenever Chrome had died
  before the service closed it, because `exit` fires once.
- Sending a page or the marks to the composer dispatched on a guessed frame;
  the hand-over now asks for a receipt and retries until the composer has it,
  and says so when it never does (`packages/ui/src/lib/compose.ts`).
- The tab's mark flashed to a globe on every reload, because the same icon
  reported again was treated as a change.
- The gateway swallowed its stdin error silently; it is logged like the rest.
- Missing tests named by the reviewers were written: the plugin's hand-off
  to the default browser, the PDF refusal wording, a label's spacing, the
  composer's receipt, the name fallback past a thousand copies — and two
  tests that leaked (a temp directory, `window.innerHeight`) were tidied.

**The second round, same three reviewers.** Two approved; one asked for a
change, and the others' notes added three more:

- **A rejected promise nobody awaited was only logged.** The reasoning —
  nothing was mid-flight on the stack — is not a safety boundary: a promise
  callback routinely mutates state before it rejects, and Node's own default
  is to make an unhandled rejection fatal, which installing a listener
  silently downgrades. Both go through one policy now, and the whole
  lifecycle is a hook away from a test (`respondToCrash`): what was
  recorded, what was logged, whether the marker was written, and whether the
  process relaunched, exited or carried on.
- **A download named `..` left the folder.** It carries no separator, so the
  sanitiser passed it through and `join(dir, '..')` is the folder above
  Downloads. A name that is only dots is not a name; a NUL and a colon are
  disarmed with the separators, because `setSavePath` runs inside a
  `will-download` callback where a throw is an uncaught exception.
- **A clock that stepped backwards turned a relaunch into an exit**: the
  difference from a marker written in the future is negative, which is less
  than the window.
- **Two browsers started in the same millisecond shared one throwaway
  profile** — `Date.now()` in a directory name, now `mkdtemp`.
- The reviewers' remaining notes were measured and left alone, with reasons:
  `existsSync` returns false for a path with a NUL rather than throwing, so
  that half of the download finding was not a crash; and the compose retry
  is not cancellable, which is benign because the event carries its own
  content and the loop is half a second long.

**The third round.** Two approved; the third found two things the second round
had introduced:

- **The pipe exemption was too broad to mean what it said.** `ECONNRESET`,
  `ECONNABORTED` and `EIO` were treated as "a helper's pipe went away", but a
  reset connection is any socket in the process and an I/O error is any
  device — so an unrelated failure was being survived under a rule that
  claims to survive only helper pipes. The list is now the three codes that
  can only mean a write to a pipe that had gone, and the four child-stdin
  listeners remain the place where the fact is actually known.
- **A file downloaded twice could be evicted first.** `Set.add` on a value
  already there does not move it, so a path remembered long ago stayed at
  the oldest position when the same file arrived again, and the next
  download could evict the one just written — its own *Show in Finder* then
  refusing. The entry is deleted before it is re-added, and the test says so
  rather than asserting an order that happened to hold.
