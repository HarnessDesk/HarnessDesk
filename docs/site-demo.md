# The site's staged Run

Build the embedded renderer with `pnpm --filter @harnessdesk/ui run build:site-demo`.
`packages/ui/dist-site-demo` is the static output copied to the site. For local
development, use `pnpm --filter @harnessdesk/ui run dev:site-demo`.

- `?view=flow&theme=light` opens the real Team Overview. Its Run link opens the
  production Timeline and Flow tabs. The Run plays write, check, review,
  request changes, fix, check, approve and the final person step once it is
  visible. Answer **Merged** or **Dropped** on the Overview to finish it.
- `?view=poster&theme=dark` shows that same Run at Fix, with the real FlowGraph
  above one proportional bar of the rounds' wall time. Parallel reviewers
  contribute one interval. The narrow layout retains the graph's step list.
- `theme=light|dark` and the embedding page's `hdTheme` message work in both
  views. Reduced motion stops automatic playback as well as the production
  graph's motion. **Next step** advances explicitly; **Pause demo** stops the
  automatic story.
- Leaving a page in the browser's back/forward cache pauses its story. Returning
  rechecks visibility and resumes only if playback was on; paused, frozen and
  reduced-motion pages retain their explicit controls.
- `stage=write|check|changes|fix|check-again|approve|land|you|done` freezes the
  opening stage for inspection. **Play demo** resumes a frozen flow view.

`packages/ui/site-demo/fake-run.ts` reuses the overlay, Run and Overview preview fixtures,
and supplies the Team pane's host verbs. All identities are placeholders.
The page visibly labels the staged numbers. Person answers are local to this
page; they do not merge or post anything. Review chips read the staged host's
recorded publication, including **Posted to #42** after a review closes.
**Stop run…** displays a staged-demo refusal in its question; it does not report
a successful stop. Close the question to keep exploring the demo.

The same scenes are available at `preview.html?site-run=flow` and
`preview.html?site-run=poster` for publishable evidence. Export both poster
formats with `node script/site-poster.mjs --out output/site-poster` after
installing the existing Playwright Chromium and ImageMagick prerequisites.
Add `--frames` for the Overview, Flow and staged stop question/refusal at 1280px
and 390px. The script starts
an isolated preview server, launches only headless Chromium, audits the text,
and closes both. Its PNG and WebP files can be used by the site's `poster=`.

Check the built pages with `pnpm exec playwright test -c
playwright.site-demo.config.ts`. Heavy commands and frame captures go through
the machine-wide gate when working alongside other Teams.
