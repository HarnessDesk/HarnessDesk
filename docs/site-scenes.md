# Live website scenes

Build the production renderer for embedding with:

```sh
pnpm --filter @harnessdesk/ui build:site-demo
```

`packages/ui/site-demo/scenes.ts` registers **dashboard**. The older demo
views keep their existing entry points. Load
`index.html?view=dashboard&theme=light` or `theme=dark` at **960 × 600** logical
pixels. The iframe has no window shell, sidebar or page heading.

The shipping Dashboard bands open at **What it cost**, beside **Where it
went**, followed by **What is left** and **When it ran**. The window scrolls
inside. Chart mode, range, spending pivots, account details and activity tabs
are interactive. There is no playback loop or pointer. Host actions are quiet
no-ops; no agent or external service runs. The site omits the cost chart's
scan-accounting footer while the app retains it.

`packages/ui/site-demo/dashboard-data.ts` owns a compact fictional year, shared by daily
charts, model/project pivots and hourly summaries. Every month has activity;
covered zero days remain zero. Names and marks come from the demo roster's
`RuntimeInfo.presentation`. Identities are the two public demo accounts or
placeholders. Keeping this data outside `src/preview/` preserves the persona
through the shared preview rewrite. The build refuses any address outside
`example.com`, `acme.dev` and the two approved `harnessdesk.app` accounts.

The parent owns scaling: keep the iframe at its logical size, then apply a
CSS transform with its origin at the top left. After the frame posts
`{type: 'hdDemoReady'}`, the parent may send:

```js
iframe.contentWindow.postMessage({ type: 'visible', value: true }, '*')
iframe.contentWindow.postMessage({ type: 'theme', value: 'dark' }, '*')
```

Visibility messages govern timers only; this view has no playback timer.
Clicks and scrolling remain available while hidden or before a visibility
message. `?motion=reduce` and the system's reduced-motion preference disable
transitions and animations without changing the selected view or disabling
controls. Fonts and assets are local.

The identical scene is available at
`preview.html?site-scene=dashboard&theme=light` for synthetic frames. Run the
focused browser proof through the machine-wide gate:

```sh
node script/site-scenes.mjs
```

It scans the built bundle for allowed addresses and preserved persona,
exercises the build and preview in both themes, and checks controls, tooltips,
internal wheel scrolling, live theme changes, reduced motion, square calendar
cells, month-label bounds, iframe scaling and local-only requests. Six frames
(top, expanded accounts and year, light and dark) and `sheet.png` go to
`.lead-out/site-scenes/`; keep `.lead-out/` in `.git/info/exclude`.
