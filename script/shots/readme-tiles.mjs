/**
 * The README's feature-wall tiles: production pages in preview.html, captured at 2x in both themes
 * and cropped to the part each row is about. Scale them down afterwards (magick -resize 960x).
 *
 *   node script/shots/readme-tiles.mjs --out /tmp/tiles [--tile teams]
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { COLLECT, textReasons, USER } from './audit.mjs'

const app = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({ options: { out: { type: 'string' }, tile: { type: 'string', multiple: true } } })
if (!values.out) throw new Error('--out is required')

/* Each tile: the preview query, the viewport, and the clip in CSS pixels. */
export const README_TILES = {
  teams: { query: 'frame-wall=teams&readme-names', viewport: [1180, 800], clip: [268, 142, 900, 392] },
  'run-flow': { query: 'release-stills=run-flow', viewport: [1280, 800], clip: [24, 150, 1232, 520] },
  skill: { query: 'frame-wall=library&frame-detail=skill&readme-names', viewport: [1280, 800], clip: [268, 36, 1000, 716] },
  dashboard: { query: 'release-stills=dash-year&readme-names', viewport: [1120, 740], crop: '[aria-label="When it ran"]', pad: 16 },
}

const require = createRequire(join(app, 'packages/ui/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')))
const playwright = await import(pathToFileURL(createRequire(join(app, 'package.json')).resolve('@playwright/test')))
const { chromium } = playwright.chromium ? playwright : playwright.default
const server = await createServer({ root: join(app, 'packages/ui'), server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' })
await server.listen()
const origin = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
mkdirSync(values.out, { recursive: true })
try {
  for (const name of values.tile?.length ? values.tile : Object.keys(README_TILES)) {
    const tile = README_TILES[name]
    if (!tile) throw new Error(`No README tile named ${name}`)
    for (const theme of ['light', 'dark']) {
      const [width, height] = tile.viewport
      const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width, height }, timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime(new Date('2026-09-30T17:00:00Z'))
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${origin}preview.html?${tile.query}&theme=${theme}`)
      await page.waitForTimeout(2500)
      await page.mouse.move(0, height - 1)
      // The fixture sidebar's hover titles carry its invented worktree paths; no title is in a tile's pixels.
      const reasons = textReasons(await page.evaluate(COLLECT), { user: USER })
        .filter(reason => !/^a title attribute .*a personal agent worktree path/.test(reason))
      if (reasons.length) throw new Error(`${name}: unpublishable frame: ${reasons.join('\n')}`)
      if (errors.length) throw new Error(`${name}: page errors: ${errors.join('\n')}`)
      let clip
      if (tile.crop) {
        const box = await page.locator(tile.crop).first().boundingBox()
        const pad = tile.pad ?? 0
        clip = { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 }
      } else {
        const [x, y, width, height] = tile.clip
        clip = { x, y, width, height }
      }
      await page.screenshot({ path: join(values.out, `${name}-${theme}.png`), clip })
      await page.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}
