# App frame, phase A: the contract, the tokens and the visual check

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the spec's numbers in code, move the tokens to them, and give
every later task a visual check — a frame wall of every destination that a
reviewer reads, and a rendered check that fails when the app differs from
the contract.

**Architecture:** `packages/ui/src/design/frame.ts` holds the spec's numbers.
`tokens.css` carries them to components; `e2e/ui-system/frame-contract.spec.ts`
resolves the tokens and measures bars, menus and the Findings page in a real
browser against `frame.ts`. A new preview frame (`?frame-wall=<destination>`)
mounts the real workbench and sidebar for each destination;
`e2e/ui-system/frame-wall.spec.ts` captures it at three widths in two themes
and `script/frame-wall.mjs` lays the captures out as one wall. Three audit
burn-downs count what the later phases remove.

**Tech Stack:** TypeScript, React, Vitest, Playwright 1.63
(`playwright.ui-system.config.ts`, dev server on `packages/ui`), Node
`node:test` for gate scripts, `script/design-audit.mjs`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-09-app-frame-design.md`. Master plan:
  `docs/superpowers/plans/2026-10-09-app-frame.md` (read "The visual check").
- Values (spec, Tokens and The frame's fixed rules): bar 40; sidebar 240
  (drag 200–360); right panel 400 (320–640); bottom 240; status bar 28; main
  keeps 480; fold at 1280 and 1000; reading 736, wide 1320, gutter 24, canvas
  8; menu min 200, wide max 340, padding 4, radius 10, row 30 at radius 6;
  info card 288, padding 12; SummaryList key 132 / 92 / 96;
  `trafficLightPosition` `{ x: 14, y: 12 }`.
- The strict audit stays at zero: `node script/design-audit.mjs --strict`.
- Run `pnpm verify` **unpiped** before any push.
- No real accounts, emails, handles or `/Users/` paths in code, fixtures,
  frames or commits (AGENTS.md rule 13). The preview fixtures are
  placeholder-only; never capture a real desk for the wall.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every task ends with the visual check from the master plan: V1 green, V2
  frames captured, V3 checklist table in the review note.

Commands used throughout (run from the repository root):

```bash
pnpm --filter @harnessdesk/ui exec vitest run <file>
pnpm test:ui-system <spec file names>
node script/design-audit.mjs --strict
pnpm --filter @harnessdesk/ui exec tsc --noEmit -p tsconfig.json
```

---

### Task 1: The frame wall (V2) and the look review

**Files:**
- Create: `packages/ui/src/preview/frames-frame-wall.tsx`
- Modify: `packages/ui/src/preview/main.tsx` (import near line 5; router branch beside `team-frame`, near line 1236)
- Create: `e2e/ui-system/frame-wall-destinations.ts`
- Create: `e2e/ui-system/frame-wall.spec.ts`
- Modify: `playwright.ui-system.config.ts` (add `snapshotPathTemplate`)
- Create: `script/frame-wall.mjs`
- Test: `script/frame-wall.test.mjs`

**Interfaces:**
- Produces: `/preview.html?frame-wall=<conversation|draft|team|teams|agents|dashboard|settings>` renders `[data-frame-id="frame-wall"][data-destination=…]`; `WALL_DESTINATIONS` (id, query, optional `tab` = a `data-team-page` value) and `WALL_WIDTHS` from `e2e/ui-system/frame-wall-destinations.ts`; frame files named `<id>-<width>-<theme>.png`; `wallOf(names)` and `wallHtml(wall, { before })` from `script/frame-wall.mjs`.

- [ ] **Step 1: Write the failing test for the wall layout script**

`script/frame-wall.test.mjs`:

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { wallHtml, wallOf } from './frame-wall.mjs'

test('frames group by destination, then width, then theme', () => {
  const wall = wallOf(['team-board-720-dark.png', 'team-board-1440-light.png', 'conversation-1440-light.png', 'notes.txt'])
  assert.deepEqual(wall.map((row) => row.destination), ['conversation', 'team-board'])
  assert.deepEqual(wall[1].widths.map((one) => one.width), [1440, 720])
  assert.deepEqual(wall[1].widths[1].themes, { dark: 'team-board-720-dark.png' })
})

test('the page shows every frame, and its earlier frame beside it when given', () => {
  const html = wallHtml(wallOf(['draft-1100-light.png']), { before: 'before' })
  assert.match(html, /<img[^>]+src="draft-1100-light\.png"/)
  assert.match(html, /<img[^>]+src="before\/draft-1100-light\.png"/)
  assert.match(html, /<h2>draft<\/h2>/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test script/frame-wall.test.mjs`
Expected: FAIL — `Cannot find module '…/script/frame-wall.mjs'`.

- [ ] **Step 3: Write the wall layout script**

`script/frame-wall.mjs`:

```js
#!/usr/bin/env node
/**
 * Lays the frame wall's captures out as one page, so a review looks at every
 * destination side by side rather than one screen alone (spec, "How it stays
 * one app"). Reads `<destination>-<width>-<theme>.png` from a directory and
 * writes `index.html` beside them.
 *
 *   node script/frame-wall.mjs output/frame-wall/after
 *   node script/frame-wall.mjs output/frame-wall/after --before ../before
 *
 * `--before` is a path relative to the wall's directory; each frame is then
 * shown next to the frame of the same name there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = /^(.+)-(\d+)-(light|dark)\.png$/

export const wallOf = (names) => {
  const byDestination = new Map()
  for (const name of names) {
    const match = NAME.exec(name)
    if (!match) continue
    const [, destination, width, theme] = match
    const widths = byDestination.get(destination) ?? new Map()
    const themes = widths.get(Number(width)) ?? {}
    themes[theme] = name
    widths.set(Number(width), themes)
    byDestination.set(destination, widths)
  }
  return [...byDestination.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([destination, widths]) => ({
      destination,
      widths: [...widths.entries()].sort(([a], [b]) => b - a).map(([width, themes]) => ({ width, themes })),
    }))
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export const wallHtml = (wall, { before = null } = {}) => {
  const frame = (name) => name
    ? `<figure><img loading="lazy" src="${escape(name)}" alt="${escape(name)}">${before ? `<img loading="lazy" class="before" src="${escape(`${before}/${name}`)}" alt="before: ${escape(name)}">` : ''}<figcaption>${escape(name)}</figcaption></figure>`
    : '<figure class="missing"><figcaption>not captured</figcaption></figure>'
  const sections = wall.map(({ destination, widths }) => `<section><h2>${escape(destination)}</h2>${widths.map(({ width, themes }) =>
    `<div class="row"><h3>${width}</h3>${frame(themes.light)}${frame(themes.dark)}</div>`).join('')}</section>`).join('\n')
  return `<!doctype html><meta charset="utf-8"><title>Frame wall</title>
<style>
body{font:14px/1.4 system-ui;margin:24px;background:#f4f4f5;color:#18181b}
section{margin-bottom:48px}h2{font-size:16px;margin:0 0 8px}h3{font-size:13px;margin:0;width:48px;flex:none}
.row{display:flex;gap:16px;align-items:flex-start;margin-bottom:16px}
figure{margin:0;display:flex;flex-direction:column;gap:4px}figure img{max-width:720px;border:1px solid #d4d4d8}
figure img.before{opacity:.85;border-style:dashed}figcaption{font-size:12px;color:#71717a}
.missing{width:240px;height:120px;border:1px dashed #a1a1aa;justify-content:center;align-items:center}
</style>
<h1>Frame wall</h1>
${sections}
`
}

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: node script/frame-wall.mjs <frames dir> [--before <relative dir>]'); process.exit(2) }
  const at = process.argv.indexOf('--before')
  const before = at > 0 ? process.argv[at + 1] : null
  const wall = wallOf(fs.readdirSync(dir))
  fs.writeFileSync(path.join(dir, 'index.html'), wallHtml(wall, { before }))
  console.log(`wrote ${path.join(dir, 'index.html')}: ${wall.length} destinations`)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test script/frame-wall.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the frame-wall preview frame**

`packages/ui/src/preview/frames-frame-wall.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { AgentsWindow } from '../components/AgentsWindow'
import { AppWindowMode } from '../components/AppWindow'
import { Settings, type Section } from '../components/Settings'
import { Sidebar } from '../components/Sidebar'
import { TeamsWindow } from '../components/TeamsWindow'
import { Usage, type DashboardView } from '../components/Usage'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { StoreProvider } from '../state/context'
import type { PaneView } from '../state/layout'
import type { AppSnapshot, AppStore } from '../state/store'
import { useTheme } from '../state/theme'
import { emptyWorkbench } from '../state/workbench'
import { PREVIEW_SESSION_KEY, previewStore } from './harness'
import { overviewTeamStore } from './team-overview-fixture'
import { teamsPageStore } from './teams-page-fixture'
import { usagePreviewStore } from './usage-fixture'

/**
 * The frame wall: the real workbench and sidebar, with one destination in
 * main, for `e2e/ui-system/frame-wall.spec.ts` to capture. A page that the
 * app still draws over the workbench (Teams, Agents, Dashboard, Settings) is
 * drawn here the same way, so the wall shows the app as it is.
 * Placeholder fixtures only.
 */
export const FRAME_WALL_DESTINATIONS = ['conversation', 'draft', 'team', 'teams', 'agents', 'dashboard', 'settings'] as const
type Destination = (typeof FRAME_WALL_DESTINATIONS)[number]

const mainShowing = (view: PaneView) =>
  ({ root: { kind: 'pane' as const, id: 'wall-main', view }, focused: 'wall-main', expanded: null })

/** `view` in main, the left column standing, the right panel closed. */
const showing = (store: AppStore, view: PaneView, session: AppSnapshot['activeSessionKey']): AppStore => {
  const main = mainShowing(view)
  Object.assign(store.getSnapshot(), {
    workbench: { ...emptyWorkbench(), main },
    layout: main,
    sidebarCollapsed: false,
    sidebarFloating: false,
    activeSessionKey: session,
  })
  return store
}

const storeFor = (destination: Destination): AppStore => {
  switch (destination) {
    case 'conversation': return showing(previewStore(), { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY)
    case 'draft': return showing(previewStore(), { kind: 'conversation', session: null }, null)
    case 'team': return showing(overviewTeamStore('running'), { kind: 'room', room: 'overview-team' }, null)
    case 'teams': return teamsPageStore('active')
    case 'dashboard': return usagePreviewStore()
    case 'agents':
    case 'settings': return previewStore()
  }
}

/** The page the app draws over the workbench for this destination, if any. */
const PageOver = ({ destination }: { destination: Destination }) => {
  const [section, setSection] = useState<Section>('general')
  const [view, setView] = useState<DashboardView>('overview')
  const [focus, setFocus] = useState<string | null>(null)
  if (destination === 'teams') return <TeamsWindow onClose={() => {}} />
  if (destination === 'agents') return <AgentsWindow focus={focus} onClose={() => {}} onFocus={setFocus} />
  if (destination === 'dashboard') return <Usage view={view} scope={null} onView={setView} onScope={() => {}} onClose={() => {}} onSignIn={() => {}} />
  if (destination === 'settings') return <Settings section={section} onSection={(next) => setSection(next)} onClose={() => {}} onSignIn={() => {}} />
  return null
}

export const FrameWall = () => {
  useTheme()
  const requested = new URLSearchParams(location.search).get('frame-wall')
  const destination: Destination = FRAME_WALL_DESTINATIONS.find((one) => one === requested) ?? 'conversation'
  const store = useMemo(() => storeFor(destination), [destination])
  return <StoreProvider store={store}>
    <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
      <AppWindowMode.Provider value="modal">
        <div data-frame-id="frame-wall" data-destination={destination} className="h-screen bg-background">
          <Workbench sidebar={<Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} />} />
          <PageOver destination={destination} />
        </div>
      </AppWindowMode.Provider>
    </ShellProvider>
  </StoreProvider>
}
```

If the typecheck rejects a prop (for example `Usage`'s `onScope` signature or
`Settings`' optional props), match the component's declared signature; do not
cast.

- [ ] **Step 6: Route it in the preview**

In `packages/ui/src/preview/main.tsx`, beside `import { TeamFrame } from './frames-team-frame'`:

```tsx
import { FrameWall } from './frames-frame-wall'
```

and in the router chain, immediately before the `team-frame` branch:

```tsx
          : new URLSearchParams(window.location.search).has('frame-wall')
          ? <FrameWall />
          : new URLSearchParams(window.location.search).has('team-frame')
          ? <TeamFrame />
```

- [ ] **Step 7: Check every destination renders**

Run: `pnpm --filter @harnessdesk/ui exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.
Then open `http://127.0.0.1:<port>/preview.html?frame-wall=<id>` for each id
in the dev server (`pnpm --filter @harnessdesk/ui dev`) or the browser pane,
and confirm each shows the sidebar and its destination with no error
boundary. If `team` shows no Findings tab, the fixture has no goal: switch
the scene to one whose store has a goal (`overviewTeamStore('needs-you')`)
and note it in the frame's comment.

- [ ] **Step 8: The destinations and the capture spec**

`e2e/ui-system/frame-wall-destinations.ts`:

```ts
/**
 * What the frame wall captures (docs/superpowers/plans/2026-10-09-app-frame.md,
 * "The visual check"). `tab` is a Team view's `data-team-page` value. A phase
 * that adds a destination adds it here, and the wall grows with it.
 */
export const WALL_DESTINATIONS = [
  { id: 'conversation', query: 'frame-wall=conversation' },
  { id: 'draft', query: 'frame-wall=draft' },
  { id: 'team-overview', query: 'frame-wall=team', tab: 'overview' },
  { id: 'team-run', query: 'frame-wall=team', tab: 'run' },
  { id: 'team-board', query: 'frame-wall=team', tab: 'board' },
  { id: 'team-chat', query: 'frame-wall=team', tab: 'room' },
  { id: 'team-findings', query: 'frame-wall=team', tab: 'findings' },
  { id: 'teams', query: 'frame-wall=teams' },
  { id: 'agents', query: 'frame-wall=agents' },
  { id: 'dashboard', query: 'frame-wall=dashboard' },
  { id: 'settings', query: 'frame-wall=settings' },
] as const

/** Wide (every region stands), between the folds, and the narrowest window. */
export const WALL_WIDTHS = [1440, 1100, 720] as const
export const WALL_THEMES = ['light', 'dark'] as const

/** The wall's clock: relative times read the same in every capture. */
export const WALL_TIME = new Date('2026-09-30T10:00:00-07:00')
```

`e2e/ui-system/frame-wall.spec.ts`:

```ts
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { WALL_DESTINATIONS, WALL_THEMES, WALL_TIME, WALL_WIDTHS } from './frame-wall-destinations'

/**
 * The frame wall: every destination at three widths in both themes.
 *
 * A capture, not a verdict on looks — a reviewer reads these frames against
 * the look checklist. It runs only when asked:
 *   FRAME_WALL_DIR=output/frame-wall/after pnpm test:ui-system frame-wall.spec.ts
 *   FRAME_WALL_COMPARE=1 pnpm test:ui-system frame-wall.spec.ts            (against the approved frames)
 *   FRAME_WALL_COMPARE=1 pnpm test:ui-system frame-wall.spec.ts --update-snapshots   (record the owner's approval)
 * Approved frames live under output/ (gitignored): CI's fonts differ from
 * macOS, so a committed baseline would fail on smoothing, not design.
 */
const DIRECTORY = process.env.FRAME_WALL_DIR
const COMPARE = process.env.FRAME_WALL_COMPARE === '1'
test.skip(!DIRECTORY && !COMPARE, 'set FRAME_WALL_DIR or FRAME_WALL_COMPARE=1 to capture the wall')

for (const destination of WALL_DESTINATIONS) {
  for (const theme of WALL_THEMES) {
    test(`frame wall: ${destination.id} in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(WALL_TIME)
      await page.emulateMedia({ colorScheme: theme })
      for (const width of WALL_WIDTHS) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/preview.html?${destination.query}&theme=${theme}`)
        await expect(page.locator('[data-frame-id="frame-wall"]')).toBeVisible()
        if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
        if ('tab' in destination) await page.locator(`[data-team-page="${destination.tab}"]`).first().click()
        await page.evaluate(async () => { await document.fonts.ready })
        const name = `${destination.id}-${width}-${theme}.png`
        if (DIRECTORY) {
          mkdirSync(DIRECTORY, { recursive: true })
          await page.screenshot({ path: path.join(DIRECTORY, name) })
        }
        if (COMPARE) await expect(page).toHaveScreenshot(name, { maxDiffPixelRatio: 0.002, animations: 'disabled' })
      }
    })
  }
}
```

In `playwright.ui-system.config.ts`, inside the object passed to
`defineConfig`, beside `outputDir`:

```ts
  // The frame wall's approved frames (frame-wall.spec.ts): local only, under
  // output/, never committed.
  snapshotPathTemplate: './output/playwright/ui-system/approved/{arg}{ext}',
```

- [ ] **Step 9: Capture the wall as it is today ("before")**

Run:

```bash
FRAME_WALL_DIR=output/frame-wall/before pnpm test:ui-system frame-wall.spec.ts
node script/frame-wall.mjs output/frame-wall/before
```

Expected: 22 tests pass; 66 PNGs and `output/frame-wall/before/index.html`.
Then run the spec without the variable and confirm it reports 22 skipped.

- [ ] **Step 10: Gates**

Run: `node script/check-ui-system.mjs && node script/design-audit.mjs --strict && node --test script/frame-wall.test.mjs`
Expected: all pass. If the catalogue gate asks for the new preview frame to
be registered, register it the way `frames-team-frame.tsx` is.

- [ ] **Step 11: Visual check (V3) on the before wall**

Open `output/frame-wall/before/index.html` (and the PNGs). This first wall is
the baseline, so the review records what is wrong today rather than
passing it: write the checklist table (destination × items 1–10 from the
master plan) with today's "no"s. Later tasks are judged against it.

- [ ] **Step 12: Commit**

```bash
git add packages/ui/src/preview/frames-frame-wall.tsx packages/ui/src/preview/main.tsx e2e/ui-system/frame-wall-destinations.ts e2e/ui-system/frame-wall.spec.ts playwright.ui-system.config.ts script/frame-wall.mjs script/frame-wall.test.mjs
git commit -m "Frame wall: every destination captured for a look review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The contract module and the tokens at its values

**Files:**
- Create: `packages/ui/src/design/frame.ts`
- Test: `packages/ui/src/design/frame.test.ts`
- Modify: `packages/ui/src/design/index.ts` (export)
- Create: `e2e/ui-system/frame-contract.spec.ts`
- Modify: `packages/ui/src/design/foundation/tokens.css` (lines ~498, ~523, ~1145, ~1495–1506)
- Modify: `packages/ui/src/styles/app.css` (comment at ~33)
- Modify: `packages/ui/src/design/patterns/Menu.module.css` (lines 25, 42, 60)
- Modify: `packages/desktop/electron/main.mjs:152`
- Regenerate: `packages/ui/src/design/tokens.snapshot.txt`, `packages/desktop/electron/assets/about-foundation.css`, `packages/ui/src/design/metrics.json`, `docs/design-system.md`

**Interfaces:**
- Produces: `FRAME` (nested numbers, `as const`) and `FRAME_TOKENS: Readonly<Record<string, number>>` exported from `packages/ui/src/design` (and importable by specs from `../../packages/ui/src/design/frame`); tokens `--hd-menu-min`, `--hd-menu-row-radius`, `--hd-info-card-width`; `--hd-bar-h` 40, `--hd-sidebar-width` 240, `--hd-popover-width-wide` 340.

- [ ] **Step 1: Write the failing contract test**

`packages/ui/src/design/frame.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { FRAME, FRAME_TOKENS } from './frame'

describe('the frame contract', () => {
  test('a default sits inside its drag limits', () => {
    expect(FRAME.sidebar.width).toBeGreaterThanOrEqual(FRAME.sidebar.min)
    expect(FRAME.sidebar.width).toBeLessThanOrEqual(FRAME.sidebar.max)
    expect(FRAME.rightPanel.width).toBeGreaterThanOrEqual(FRAME.rightPanel.min)
    expect(FRAME.rightPanel.width).toBeLessThanOrEqual(FRAME.rightPanel.max)
  })

  test('a menu row is the surface radius less its padding', () => {
    expect(FRAME.menu.rowRadius).toBe(FRAME.menu.radius - FRAME.menu.padding)
  })

  test('each fold leaves main its minimum', () => {
    expect(FRAME.fold.panelFloats).toBeGreaterThanOrEqual(FRAME.sidebar.width + FRAME.rightPanel.width + FRAME.main.min)
    expect(FRAME.fold.sidebarFloats).toBeGreaterThanOrEqual(FRAME.sidebar.width + FRAME.main.min)
  })

  test('every token resolves to a whole pixel', () => {
    for (const [token, px] of Object.entries(FRAME_TOKENS)) {
      expect(token.startsWith('--hd-')).toBe(true)
      expect(Number.isInteger(px)).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/design/frame.test.ts`
Expected: FAIL — cannot resolve `./frame`.

- [ ] **Step 3: Write the contract module**

`packages/ui/src/design/frame.ts`:

```ts
/**
 * The app frame's numbers (docs/superpowers/specs/2026-10-09-app-frame-design.md).
 *
 * `tokens.css` carries them to the components; this module carries them to
 * the checks. `e2e/ui-system/frame-contract.spec.ts` resolves every token in
 * `FRAME_TOKENS` in a real browser and measures the rendered app against
 * `FRAME`, so a number in the spec fails a check when the app differs from it
 * — the spec's own complaint was numbers that lived only in prose.
 *
 * CSS pixels at the default interface (Desk).
 */
export const FRAME = {
  bar: { height: 40, pad: 8, gap: 6, iconButton: 28, titleMin: 180 },
  sidebar: { width: 240, min: 200, max: 360 },
  rightPanel: { width: 400, min: 320, max: 640 },
  bottomPanel: { height: 240, min: 120 },
  statusBar: { height: 28 },
  main: { min: 480 },
  fold: { panelFloats: 1280, sidebarFloats: 1000 },
  page: { reading: 736, wide: 1320, gutter: 24, canvasGutter: 8 },
  rail: { rowHeight: 30, inset: 8 },
  menu: { min: 200, max: 340, padding: 4, radius: 10, rowHeight: 30, rowRadius: 6 },
  infoCard: { width: 288, padding: 12 },
  summaryKey: { page: 132, panel: 92, infoCard: 96 },
} as const

/** Every token the frame names, and the pixels it must resolve to. */
export const FRAME_TOKENS: Readonly<Record<string, number>> = {
  '--hd-bar-h': FRAME.bar.height,
  '--hd-titlebar-height': FRAME.bar.height,
  '--hd-sidebar-width': FRAME.sidebar.width,
  '--hd-column': FRAME.page.reading,
  '--hd-page-wide': FRAME.page.wide,
  '--hd-page-gutter': FRAME.page.gutter,
  '--hd-menu-min': FRAME.menu.min,
  '--hd-menu-row-radius': FRAME.menu.rowRadius,
  '--hd-popover-width-wide': FRAME.menu.max,
  '--hd-info-card-width': FRAME.infoCard.width,
}
```

In `packages/ui/src/design/index.ts`, beside `export { Page, type PageWidth } from './patterns/Page'`:

```ts
export { FRAME, FRAME_TOKENS } from './frame'
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @harnessdesk/ui exec vitest run src/design/frame.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing token check**

`e2e/ui-system/frame-contract.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'
import { FRAME_TOKENS } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'

/**
 * The rendered check (spec, "How it is checked"): the app measured against
 * the frame contract in `packages/ui/src/design/frame.ts`. Each phase of the
 * frame work adds what it moved; nothing here is a literal of its own.
 */
const openFrame = async (page: Page, query: string, theme: 'light' | 'dark', width = 1440) => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  await page.evaluate(async () => { await document.fonts.ready })
}

/** A token's resolved pixels: a hidden probe takes it as its width. */
const resolvedPx = (page: Page, token: string) => page.evaluate((name) => {
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;width:var(${name})`
  document.body.append(probe)
  const px = probe.getBoundingClientRect().width
  probe.remove()
  return px
}, token)

for (const theme of WALL_THEMES) {
  test(`frame tokens resolve to the contract in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    for (const [token, px] of Object.entries(FRAME_TOKENS)) {
      expect(await resolvedPx(page, token), token).toBe(px)
    }
  })
}
```

(`openFrame` and `resolvedPx` serve the later tests in this file; Playwright
does not import spec files into each other, so they are not exported.)

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm test:ui-system frame-contract.spec.ts`
Expected: FAIL — `--hd-bar-h` resolves to 46, expected 40 (the first token
that differs is reported; `--hd-menu-min` and `--hd-info-card-width` resolve
to 0 because they do not exist yet).

- [ ] **Step 7: Move the tokens to the contract**

`packages/ui/src/design/foundation/tokens.css`:

Replace `  --hd-bar-h: 46px; /* The window's own bar. */` with:

```css
  /* The one bar height (spec: one top bar, the left column's top row and its
     seat row; a panel has no bar). The window's buttons are centred on it —
     trafficLightPosition in packages/desktop/electron/main.mjs. */
  --hd-bar-h: 40px;
```

Replace the `--hd-popover-width-wide` block with:

```css
  /* A menu's room: at least 200, and a wide menu (a submenu, a long list with
     search, agents with meters) at most 340 — long names wrap rather than
     widen it. The seat menu's account rows and usage line fit at 340. */
  --hd-menu-min: 200px;
  --hd-popover-width-wide: 340px;
  /* A menu row's corner runs parallel to the menu's: the surface's radius
     less the 4px it is padded by. */
  --hd-menu-row-radius: calc(var(--hd-radius) - var(--hd-space-1));
  /* The info card: facts only, opened by hover or focus on a fact. */
  --hd-info-card-width: 288px;
```

Replace `  --hd-sidebar-width: 275px;` and its comment with:

```css
  /* The left column's default width (spec: 240, dragged 200–360). Named
     here rather than measured in a layout file, so the column and everything
     that reserves room for it move together. */
  --hd-sidebar-width: 240px;
```

Delete the `--hd-page-row-h` and `--hd-page-row-padding` declarations and the
comment block above them (they have no consumer:
`grep -rn "hd-page-row" packages/ui/src` must then print only the snapshot,
which step 9 regenerates).

`packages/ui/src/styles/app.css`: replace the comment above
`--hd-titlebar-height: var(--hd-bar-h);` that begins `/* 44: room for a 20px
title line` with:

```css
  /* The top bar's height: the band the macOS traffic lights are centred in
     (see trafficLightPosition in packages/desktop/electron/main.mjs). */
```

`packages/ui/src/design/patterns/Menu.module.css`:
- line 25: `min-width: 200px;` → `min-width: var(--hd-menu-min);`
- line 42 (`.flyout`): `min-width: 200px;` → `min-width: var(--hd-menu-min);`
- line 60 (`.row`): replace the `border-radius` line and its comment with
  `border-radius: var(--hd-menu-row-radius); /* parallel to the menu's corner: its radius less its padding */`

`packages/desktop/electron/main.mjs:152`:

```js
    trafficLightPosition: { x: 14, y: 12 },
```

Then `grep -rn "y: 15" packages/desktop` and update any test that pins the
old position to `{ x: 14, y: 12 }`.

- [ ] **Step 8: Run the token check to verify it passes**

Run: `pnpm test:ui-system frame-contract.spec.ts`
Expected: PASS, 2 tests (light, dark).

- [ ] **Step 9: Regenerate what is generated from the tokens**

```bash
node script/check-design-tokens.mjs --update
node script/design-doc.mjs
pnpm design:metrics
```

Expected: the token snapshot shows exactly the changed and added tokens; the
design doc regenerates; `metrics.json` changes only where a bar, the sidebar
width or a menu row is measured. Read the `metrics.json` diff: any change
that is not a bar, column width or menu row is a regression to explain.

- [ ] **Step 10: Update the specs and tests pinned to the old numbers**

Run the frame-related specs and the UI unit tests:

```bash
pnpm test:ui-system sidebar-header.spec.ts sidebar-structure.spec.ts sidebar-edges.spec.ts team-bar.spec.ts team-frame.spec.ts conversation-header-cases.spec.ts header-title-floor.spec.ts edge-alignment.spec.ts container-insets.spec.ts menu-tab.spec.ts window-limits.spec.ts narrow-right-panel-overlay.spec.ts alignment-census.spec.ts metrics.spec.ts
pnpm --filter @harnessdesk/ui exec vitest run
```

Where a test pins 46 (or 92 = two 46px rows), 275, 320 or a menu-row radius
of 10, replace the literal with the contract (`FRAME.bar.height`,
`FRAME.bar.height * 2`, `FRAME.sidebar.width`, `FRAME.menu.max`,
`FRAME.menu.rowRadius`), importing `FRAME` from
`../../packages/ui/src/design/frame` in a spec. If `alignment-census` fails
on a moved edge, re-record it with `pnpm design:alignment` and read its
diff the same way as metrics. A failure that is not a pinned number is a
real regression: fix the cause, not the test.

- [ ] **Step 11: Gates and visual check**

```bash
node script/design-audit.mjs --strict
node script/check-design-tokens.mjs
node script/design-doc.mjs --check
pnpm --filter @harnessdesk/ui exec tsc --noEmit -p tsconfig.json
FRAME_WALL_DIR=output/frame-wall/A2 pnpm test:ui-system frame-wall.spec.ts
node script/frame-wall.mjs output/frame-wall/A2 --before ../before
```

V3: every bar in every frame is visibly shorter by 6px and nothing else
moved; menus open with corners parallel to their rows. Write the checklist
table for all 11 destinations against the before wall; a new "no" blocks.

- [ ] **Step 12: Commit**

```bash
git add packages/ui/src/design/frame.ts packages/ui/src/design/frame.test.ts packages/ui/src/design/index.ts e2e/ui-system/frame-contract.spec.ts packages/ui/src/design/foundation/tokens.css packages/ui/src/styles/app.css packages/ui/src/design/patterns/Menu.module.css packages/desktop/electron/main.mjs packages/ui/src/design/tokens.snapshot.txt packages/desktop/electron/assets/about-foundation.css packages/ui/src/design/metrics.json docs/design-system.md
git add -u e2e/ui-system packages/ui/src packages/desktop
git commit -m "Frame contract in code; tokens at its values (bar 40, column 240, menu tokens)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The rendered check — bars, a menu, the Findings page

**Files:**
- Modify: `e2e/ui-system/frame-contract.spec.ts`

**Interfaces:**
- Consumes: `FRAME` (Task 2), `openFrame` (Task 2, same file), `?frame-wall=conversation|team` (Task 1).
- Produces: V1 tests other phases extend: `bars stand …`, `a menu keeps the contract …`, `the Findings page keeps the reading measure …`.

- [ ] **Step 1: Add the three checks**

Append to `e2e/ui-system/frame-contract.spec.ts` (and change its import to
`import { FRAME, FRAME_TOKENS } from '../../packages/ui/src/design/frame'`):

```ts
for (const theme of WALL_THEMES) {
  test(`bars stand ${FRAME.bar.height}px in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const rows = page.locator('[data-region="sidebar-header"] [data-slot="bar"]')
    await expect(rows.first()).toBeVisible()
    const heights = await rows.evaluateAll((bars) => bars.map((bar) => Math.round(bar.getBoundingClientRect().height)))
    expect(heights.length).toBeGreaterThan(0)
    for (const height of heights) expect(height).toBe(FRAME.bar.height)
    const header = page.locator('[data-slot="workbench-main"] header[data-slot="bar"]').first()
    await expect(header).toBeVisible()
    expect(Math.round((await header.boundingBox())!.height)).toBe(FRAME.bar.height)
  })

  test(`a menu keeps the contract in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await page.locator('[data-slot="team-room"] header').first().getByRole('button', { name: 'More', exact: true }).click()
    const menu = page.getByRole('menu').first()
    await expect(menu).toBeVisible()
    const surface = await menu.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        width: el.getBoundingClientRect().width,
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        radius: style.borderTopLeftRadius,
      }
    })
    expect(surface.width).toBeGreaterThanOrEqual(FRAME.menu.min)
    expect(surface.padding).toEqual(Array(4).fill(`${FRAME.menu.padding}px`))
    expect(surface.radius).toBe(`${FRAME.menu.radius}px`)
    const rows = await menu.locator('[role^="menuitem"]').evaluateAll((items) => items.map((item) => {
      const style = getComputedStyle(item)
      return { minHeight: style.minHeight, radius: style.borderTopLeftRadius }
    }))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.minHeight).toBe(`${FRAME.menu.rowHeight}px`)
      expect(row.radius).toBe(`${FRAME.menu.rowRadius}px`)
    }
  })

  for (const width of [1440, 720]) {
    test(`the Findings page keeps the reading measure at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team', theme, width)
      await page.locator('[data-team-page="findings"]').first().click()
      const column = page.locator('[data-slot="page"][data-width="reading"]').first()
      await expect(column).toBeVisible()
      const measured = await column.evaluate((el) => {
        const style = getComputedStyle(el)
        const box = el.getBoundingClientRect()
        const parent = el.parentElement!.getBoundingClientRect()
        const left = box.left + parseFloat(style.paddingLeft)
        return {
          gutters: [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)],
          measure: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          margins: [box.left - parent.left, parent.right - box.right],
          edges: [...el.children]
            .filter((child) => (child as HTMLElement).offsetParent !== null)
            .map((child) => Math.round(child.getBoundingClientRect().left - left)),
        }
      })
      expect(measured.gutters).toEqual([FRAME.page.gutter, FRAME.page.gutter])
      expect(measured.measure).toBeLessThanOrEqual(FRAME.page.reading)
      expect(Math.abs(measured.margins[0] - measured.margins[1])).toBeLessThanOrEqual(1)
      expect(measured.edges, 'every block starts at the column edge').toEqual(measured.edges.map(() => 0))
    })
  }
}
```

- [ ] **Step 2: Run them**

Run: `pnpm test:ui-system frame-contract.spec.ts`
Expected: PASS, 2 + 2 + 2 + 4 = 10 tests.

If the menu test fails because `[role="menu"]` is not the padded surface
(the Team ⋯ is a `Popover` holding a `Menu`), measure the menu's surface —
the element carrying `Menu.module.css`'s surface class — and say so in a
comment; do not loosen the numbers. If the Findings test fails on `edges`,
the page is not composed of blocks on one edge: that is the bug the spec's
acceptance example names — fix `GoalFindings.tsx` (a block that needs an
icon hangs it before the edge), not the test.

- [ ] **Step 3: Confirm CI will run it**

Run: `for i in 1 2 3 4 5 6 7 8; do node script/ci-browser-shards.mjs $i/8; done | grep -c "frame-contract.spec.ts"`
Expected: `1`. If 0, add the spec to `script/ci-browser-shards.mjs`'s
timings the way other specs are listed.

- [ ] **Step 4: Gates and visual check**

`node script/design-audit.mjs --strict`, then capture the wall to
`output/frame-wall/A3` and review it against `A2`: no frame should change in
this task (only tests were added, plus any `GoalFindings` fix, whose frames
are reviewed in full).

- [ ] **Step 5: Commit**

```bash
git add e2e/ui-system/frame-contract.spec.ts script/ci-browser-shards.mjs packages/ui/src/components/GoalFindings.tsx
git commit -m "Rendered frame check: bars, a menu and the Findings page against the contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git add` of an unchanged file is a no-op.)

---

### Task 4: Three audit burn-downs the later phases drive to zero

**Files:**
- Modify: `script/design-audit.mjs` (`BURN_DOWN` line 54; `findings` ~1798–1829; new scans; the stylesheet loop ~3320; the screen-source loop ~4463)
- Modify: `script/design-sections.mjs` (`SECTIONS`)
- Modify: `packages/ui/src/design/audit-baseline.json`
- Test: `script/gates.test.mjs`

**Interfaces:**
- Produces: exported `RETIRED_COMPONENTS`, `retiredComponentsOf(file, source)`, `pageMeasuresOf(file, source)`, `screenLayoutOf(file, source, ast?)`; categories `retiredComponent`, `pageMeasureInScreen`, `screenLayout` (all burn-down).

- [ ] **Step 1: Write the failing tests**

Append to `script/gates.test.mjs` (add the three names to its import from
`./design-audit.mjs`):

```js
/**
 * The frame work's burn-downs (docs/superpowers/specs/2026-10-09-app-frame-design.md):
 * frame parts a screen still draws, page measures a screen sets itself, and
 * layout written in a screen. Each only falls.
 */
test('retiredComponent counts a screen drawing a frame part the shell will own', () => {
  const screen = path.join(repoRoot, 'packages/ui/src/components/Example.tsx')
  const pattern = path.join(repoRoot, 'packages/ui/src/design/patterns/Example.tsx')
  const cases = [
    [screen, 'export const A = () => <PageHead title="Teams" />\n', 1],
    [screen, 'export const A = () => <><AppWindow label="x"><WindowPage /></AppWindow></>\n', 2],
    [screen, 'export const A = () => <ToolPaneHeaderDivider />\n', 0],
    [screen, 'export const A = () => <PopoverOptionMark />\n', 0],
    [screen, '// <PageHead /> once lived here\nexport const A = () => null\n', 0],
    [pattern, 'export const A = () => <PageHead title="x" />\n', 0],
  ]
  for (const [file, source, count] of cases) assert.equal(retiredComponentsOf(file, source).length, count, source)
})

test('pageMeasureInScreen counts a screen setting a page measure instead of using Page', () => {
  const tsx = path.join(repoRoot, 'packages/ui/src/components/Example.tsx')
  const css = path.join(repoRoot, 'packages/ui/src/components/Example.module.css')
  const cases = [
    [css, '.page { max-width: var(--hd-column); }', 1],
    [css, '.page { max-width: var(--hd-page-wide); padding: var(--hd-page-gutter); }', 2],
    [tsx, 'export const A = () => <PaneColumn inset="reading" page>x</PaneColumn>\n', 1],
    [tsx, 'export const A = () => <PaneColumn inset="reading">x</PaneColumn>\n', 0],
    [tsx, 'export const A = () => <Page width="reading">x</Page>\n', 0],
  ]
  for (const [file, source, count] of cases) assert.equal(pageMeasuresOf(file, source).length, count, source)
})

test('screenLayout counts layout declarations and layout utilities in a screen', () => {
  const tsx = path.join(repoRoot, 'packages/ui/src/components/Example.tsx')
  const css = path.join(repoRoot, 'packages/ui/src/components/Example.module.css')
  assert.equal(screenLayoutOf(css, '.row { display: flex; gap: var(--hd-space-2); color: red; }').length, 2)
  assert.equal(screenLayoutOf(tsx, 'export const A = () => <div className="flex min-w-0 gap-2 text-sm" />\n').length, 3)
  assert.equal(screenLayoutOf(tsx, 'export const A = () => <div className="text-sm" />\n').length, 0)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test script/gates.test.mjs`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Write the scans**

In `script/design-audit.mjs`, after `uppercaseLabelsOf` and its loop (~line 3632):

```js
/**
 * Components the app frame retires (docs/superpowers/specs/2026-10-09-app-frame-design.md,
 * Components). Each use in a screen is a page still drawing a part of the
 * frame the shell will own. A burn-down: it reaches zero when the last page
 * moves into main, and a new use fails at once.
 */
export const RETIRED_COMPONENTS = [
  'AppWindow', 'WindowNav', 'WindowPage', 'PageHead', 'DetailHead', 'BackLink', 'ViewBar',
  'ToolPaneHeader', 'DockPanelBar', 'DockPanelTabs', 'PanelTools', 'PanelPill', 'PanelActions',
  'PopoverOption', 'Segmented',
]
const RETIRED_JSX = new RegExp(`<(${RETIRED_COMPONENTS.join('|')})(?=[\\s/>])`, 'g')

export const retiredComponentsOf = (file, source) => {
  if (!file.endsWith('.tsx') || !isScreenSheet(file)) return []
  const code = withoutComments(source, file, { strict: true })
  return [...code.matchAll(RETIRED_JSX)].map((match) => `${label(file)}: <${match[1]}>`)
}

/**
 * A page measure a screen sets itself rather than taking from `Page`
 * (spec, Pages: "The page template is the only way in"): the measure and
 * gutter tokens named in a screen, or `PaneColumn`'s page mode used
 * directly. A burn-down that reaches zero as pages move onto `Page`.
 */
export const pageMeasuresOf = (file, source) => {
  if (!isScreenSheet(file)) return []
  const name = label(file)
  const text = file.endsWith('.css') ? bare(source) : withoutComments(source, file, { strict: true })
  const found = [...text.matchAll(/--hd-(column|page-wide|page-gutter)\b/g)].map((match) => `${name}: --hd-${match[1]}`)
  if (file.endsWith('.tsx')) for (const _ of text.matchAll(/<PaneColumn\b[^>]*\spage[\s/>]/g)) found.push(`${name}: <PaneColumn page>`)
  return found
}

for (const file of [...cssFiles(), ...tsxFiles()]) {
  findings.retiredComponent.push(...retiredComponentsOf(file, read(file)))
  findings.pageMeasureInScreen.push(...pageMeasuresOf(file, read(file)))
}
```

After `screenUnmappedUtilityOf` (~line 3090):

```js
/**
 * Tailwind utilities that place or size a box — display, flex and grid,
 * gaps, alignment, widths, offsets, margins, overflow. `screenUtilityDeclarationOf`
 * is taught the appearance utilities and returns null for these, so the
 * layout side needs its own reading. Heights stay with the appearance rule,
 * which already judges them by value.
 */
const LAYOUT_UTILITY = /^-?(?:flex|inline-flex|grid|inline-grid|block|inline-block|inline|hidden|contents|flow-root|grow|shrink|absolute|relative|fixed|sticky|static|isolate|(?:flex|grid|basis|grow|shrink|order|col|row|auto-cols|auto-rows|gap|gap-x|gap-y|space-x|space-y|justify|justify-items|justify-self|items|content|self|place-content|place-items|place-self|w|min-w|max-w|size|inset|inset-x|inset-y|top|right|bottom|left|start|end|z|m|mx|my|mt|mr|mb|ml|ms|me|overflow|overflow-x|overflow-y|float|clear|object|aspect|columns)-.+)$/

/**
 * Layout a screen writes for itself (spec, "Blocks, and who owns layout"):
 * every layout declaration in a screen sheet (the other side of
 * `screenAppearanceOf`'s boundary) and every layout utility in a screen's
 * class lists. A burn-down: a page moved into the frame reaches zero, and new
 * layout in a screen raises the count and fails at once.
 */
export const screenLayoutOf = (file, source, ast) => {
  if (file.endsWith('.css')) {
    if (!isScreenSheet(file) || SCREEN_APPEARANCE_EXEMPTIONS.has(screenAppearanceName(file))) return []
    return declarationsOf(source)
      .filter(({ property, value }) => screenPropertySideOf(property, value) === 'layout')
      .map(({ property }) => `${screenAppearanceName(file)}: ${property}`)
  }
  if (!isScreenTsx(file)) return []
  const tree = ast ?? parseScreenSource(file, source)
  const findings = []
  for (const { text: rawToken, file: originFile } of classSiteEntries(tree, file, new Set())) {
    const token = withoutImportantMarker(utilityBase(rawToken))
    if (token && LAYOUT_UTILITY.test(token)) findings.push(`${screenAppearanceName(originFile)}: ${rawToken}`)
  }
  return findings
}
```

Hook it in twice:
- in the stylesheet loop, after the `screenUnclassifiedOf` loop (~line 3325):
  `findings.screenLayout.push(...screenLayoutOf(file, read(file)))`
- in the screen-source loop, after
  `findings.screenUnclassified.push(...screenUtilityUnclassifiedOf(file, source, screenAst))` (~line 4463):
  `findings.screenLayout.push(...screenLayoutOf(file, source, screenAst))`

Register the categories:
- `findings` object: add `retiredComponent: [],`, `pageMeasureInScreen: [],`, `screenLayout: [],`
- line 54: `const BURN_DOWN = new Set(['patternClass', 'singleAreaPrimitive', 'uppercaseLabel', 'retiredComponent', 'pageMeasureInScreen', 'screenLayout'])`
- `script/design-sections.mjs`, at the end of `SECTIONS`:

```js
  [
    'retiredComponent',
    'Frame parts a screen still draws',
    'The app frame retires these components: the shell draws the top bar, the panel frame and the page, and a screen that still renders one is a page outside the frame.',
    'Move the screen onto the shell: register its bar slots with useTopBar, render its body in Page, and let the panel draw its tools (docs/superpowers/specs/2026-10-09-app-frame-design.md). This category is a burn-down: its ceiling may only fall.',
  ],
  [
    'pageMeasureInScreen',
    'Page measures set in a screen',
    'A screen that names the column or page width or its gutter decides its own page, which is how four left edges came to sit on one Findings page.',
    'Render the screen in <Page width="reading" | "wide" | "canvas"> and remove its own measure. This category is a burn-down: its ceiling may only fall.',
  ],
  [
    'screenLayout',
    'Layout written in a screen',
    'Layout belongs to the frame, the page template and the blocks; a screen that positions its own content is assembling a page the system cannot reach.',
    'Compose blocks inside Page and pass content as data; where a block lacks a case, add it to the block. This category is a burn-down: its ceiling may only fall.',
  ],
```

Match the existing tuples' exact shape (`[key, title, cost, fix]`); if the
generated design doc lists sections, regenerate it in step 6.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test script/gates.test.mjs`
Expected: PASS (the new three tests and every existing one).

- [ ] **Step 5: Record the ceilings**

```bash
node script/design-audit.mjs --baseline
node script/design-audit.mjs --strict
```

Expected: the baseline gains `retiredComponent`, `pageMeasureInScreen` and
`screenLayout` with today's counts (the spec counted about 319 inline layout
class lists and 867 layout declarations; `screenLayout` counts each utility,
so expect a larger number) and every other key unchanged; `--strict` passes.
Write the three counts into the commit message.

- [ ] **Step 6: Gates**

```bash
node script/design-doc.mjs --check || node script/design-doc.mjs
node script/check-ui-system.mjs
```

No frame changes in this task; no wall capture needed beyond confirming
`frame-contract.spec.ts` still passes.

- [ ] **Step 7: Commit**

```bash
git add script/design-audit.mjs script/design-sections.mjs script/gates.test.mjs packages/ui/src/design/audit-baseline.json docs/design-system.md
git commit -m "Audit: burn-downs for retired frame parts, page measures and layout in screens

Ceilings today: retiredComponent <n>, pageMeasureInScreen <n>, screenLayout <n>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Phase A look, the built app, and the draft PR

**Files:** none changed unless the review finds a defect (then fix it in its
task's files and amend that task's commit with a fixup commit).

- [ ] **Step 1: Full suites**

```bash
pnpm --filter @harnessdesk/ui exec vitest run
pnpm test:ui-system
```

The full browser suite is long; run it in the background and read the
result. Every failure is fixed or explained before step 2.

- [ ] **Step 2: V3 on the whole wall**

```bash
FRAME_WALL_DIR=output/frame-wall/A pnpm test:ui-system frame-wall.spec.ts
node script/frame-wall.mjs output/frame-wall/A --before ../before
```

Open every PNG. Write the checklist table (11 destinations × items 1–10, both
themes, 1440/1100/720). Phase A changes only bar height, the column width
token and menu row corners, so every "no" must already be in the before
table; a new "no" is a defect of this phase.

- [ ] **Step 3: V4 on the built app**

Build the desktop app from this branch and run it on the rig, never on a real
desk: an isolated `HARNESSDESK_HOME` under the scratchpad and the fake agents
(`packages/adapter-codex/test/fixtures/fake-codex.mjs`, which signs in as
`dev@example.com`), with a throwaway `--user-data-dir` (memory:
harnessdesk-macos-app-verification). Capture the window at 1440 and 720 wide
in light and dark: a conversation, a Team, Settings. Measure that the window
buttons sit centred in the 40px row (`trafficLightPosition` y 12); if not,
adjust y and re-measure.

- [ ] **Step 4: Owner review**

Send the wall (`output/frame-wall/A/index.html` and a few key PNGs) and the
built-app frames to the owner with `SendUserFile`. Read every image first
(rule 13: no account, email or path visible). On their yes, record the
approved frames:

```bash
FRAME_WALL_COMPARE=1 pnpm test:ui-system frame-wall.spec.ts --update-snapshots
```

- [ ] **Step 5: Merge main and open the draft PR**

Merge main with `mcp__ccd_host__sync_with_base_branch`, resolve, rerun the
gates, then `pnpm verify` **unpiped**. Push the branch and open a **draft**
PR titled "One app frame" whose body links the spec and the master plan,
lists the phases with A checked, and states that frames come from the
preview fixtures and the rig. Bind it with the ccd_pr tools.
