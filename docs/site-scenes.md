# Live website scenes

The website embeds the production renderer built by:

```sh
pnpm --filter @harnessdesk/ui build:site-demo
```

`packages/ui/site-demo/scenes.ts` registers the self-playing views. This first
change registers **dashboard** only; the older interactive demo views keep
their existing entry points.

Load `index.html?view=dashboard&theme=light` or `theme=dark` at a logical size
of **960 × 600**. The iframe has no window shell, sidebar or page heading.
Its real Dashboard bands play Limits → Spend → By agent → Year over the
same fictional year as the website camera fixtures. Page changes are cuts,
as in the existing dashboard clip; the shape filters, chart mode and heatmap
tabs receive real mouse clicks. No agent or external service runs.

The parent owns scaling: keep the iframe at its logical size, then apply a
CSS transform with its origin at the top left. After the frame posts
`{type: 'hdDemoReady'}`, send:

```js
iframe.contentWindow.postMessage({ type: 'visible', value: true }, '*')
iframe.contentWindow.postMessage({ type: 'theme', value: 'dark' }, '*')
```

Scenes start paused. `visible: false` freezes the scene, including its pointer;
`true` resumes from the same position. The 16-second dashboard loop returns
to Limits. `?motion=reduce` or the operating system's reduced-motion preference
holds a representative Year view, with no pointer or animation. Changing that
preference while playing also selects the still. Fonts and assets are local.
The clock and pointer belong to the embed, never the desktop app.

The same scene is available at
`preview.html?site-scene=dashboard&theme=light` for synthetic frames. Run the
focused browser proof through the machine-wide gate:

```sh
node script/site-scenes.mjs
```

It checks both themes, build boot, pause/resume, live theme, loop closure,
reduced motion, content bounds, iframe scaling and requests confined to local
assets. Frames and the first/middle/last contact sheet go to
`.lead-out/site-scenes/`; keep `.lead-out/` in `.git/info/exclude`.
