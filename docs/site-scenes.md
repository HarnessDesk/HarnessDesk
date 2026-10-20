# Live website scenes

Build the production renderer for embedding with:

```sh
pnpm --filter @harnessdesk/ui build:site-demo
```

`packages/ui/site-demo/scenes.ts` registers these views. The older demo
views keep their existing entry points. Load `index.html?view=<view>&theme=light`
or `theme=dark` at the registered logical size.

| View | Logical size | Content |
| --- | --- | --- |
| `dashboard` | 960 × 600 | All Dashboard bands, scrolling inside |
| `dashboard-spend` | 672 × 432 | What it cost, chart mode and range |
| `dashboard-limits` | 672 × 432 | What is left, shape filters and expandable accounts |
| `dashboard-activity` | 672 × 432 | When it ran, stats and all three heatmap views |
| `tour-teams`, `tour-run`, `tour-flows`, `tour-library`, `tour-runtimes`, `tour-chats` | 800 × 500 | The App window on one destination |
| `hero-race` | 1200 × 750 | Two agents' pages side by side, the judge's pick, then a pointer to Merge |
| `showcase-run` | 1260 × 520 | A Run's path drawn as it happens, ending on the step that waits for you |
| `showcase-board` | 1480 × 540 | The Team's board: twelve jobs, one taken up, one finished into Ready |

The iframe has no window shell, sidebar or page heading. The focused views
paint the app's surface with a 20px inset, without a frame, border or radius;
the website owns the surrounding panel. Spend and Activity fit without scrolling,
including after changing their controls. Limits scrolls inside when an account
opens. All three reuse the full Dashboard's fictional data and shipping controls;
their layout adjustments are scoped to the site views.

The site scene starts with **What it cost** beside **Where it went**, followed
by **What is left** and **When it ran**. The desktop Overview starts with its
summary strip and **What is left**. The window scrolls inside. Chart mode, range,
spending pivots, account details and activity tabs are interactive. The Dashboard views have no playback loop or pointer. Host actions are quiet
no-ops; no agent or external service runs. The site omits the cost chart's
scan-accounting footer while the app retains it.

`packages/ui/site-demo/dashboard-data.ts` owns a compact fictional year, shared by daily
charts, model/project pivots and hourly summaries. Every weekday has activity
in every month, with lighter ordinary weekends, rotating quiet days and a
gradual ramp toward recent months. Covered zero days remain zero. Names and marks come from the demo roster's
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

Visibility messages govern timers only; the Dashboard views have no playback
timer. Clicks and scrolling remain available while hidden or before a visibility
message. `?motion=reduce` and the system's reduced-motion preference disable
transitions and animations without changing the selected view or disabling
controls. The three looping scenes (`hero-race`, `showcase-run`,
`showcase-board`) play their loop and the hero draws its pointer only when
motion is welcome; under either setting they hold their settled picture and
draw no pointer. The pointer is drawn only (`[data-race-pointer]`, with a
`data-phase`): it never clicks the Merge button. Fonts and assets are local.

The identical scenes are available at
`preview.html?site-scene=<view>&theme=light` for synthetic frames. Run the
focused browser proof through the machine-wide gate:

```sh
node script/site-scenes.mjs
```

It scans the built bundle for allowed addresses and preserved persona,
exercises the build and preview in both themes, and checks controls, tooltips,
internal wheel scrolling, live theme changes, reduced motion, square calendar
cells, month-label bounds, iframe scaling and local-only requests. It also checks
the focused views' size, unframed surface, scrolling and fit in every chart range
and heatmap mode. Twelve frames (the full Dashboard's top, expanded accounts and
year, plus the three focused views, all in light and dark) and `sheet.png` go to
`.lead-out/site-scenes/`; keep `.lead-out/` in `.git/info/exclude`.
