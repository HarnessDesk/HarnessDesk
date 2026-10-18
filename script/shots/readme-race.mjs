/**
 * The README hero: the production Side by side view in preview.html, two Seats racing one brief
 * in their own Browsers, then the judge's pick. Frames only; encode as script/shots/README.md says.
 *
 *   node script/shots/readme-race.mjs --out /tmp/race [--theme light|dark] [--still]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { COLLECT, textReasons, USER } from './audit.mjs'

const app = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({ options: { out: { type: 'string' }, theme: { type: 'string' }, still: { type: 'boolean' },
  width: { type: 'string', default: '1200' }, height: { type: 'string', default: '800' }, fps: { type: 'string', default: '12' } } })
if (!values.out) throw new Error('--out is required')
const themes = values.theme ? [values.theme] : ['light', 'dark']
const fps = Number(values.fps)

/* Seconds into the loop: [build level of A, build level of B, stage]. Stage 0 both work, 1 A done,
   2 both done and the judge reads, 3 the judge's pick. */
const TIMELINE = [
  [0.0, 1, 1, 0], [1.4, 2, 1, 0], [2.3, 2, 2, 0], [3.4, 3, 2, 1], [4.8, 3, 3, 2], [6.4, 3, 3, 3],
]
const DURATION = 10

const require = createRequire(join(app, 'packages/ui/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')))
const playwright = await import(pathToFileURL(createRequire(join(app, 'package.json')).resolve('@playwright/test')))
const { chromium } = playwright.chromium ? playwright : playwright.default
const game = readFileSync(join(app, 'script/shots/fixtures/race-runner.html'), 'utf8')

const server = await createServer({ root: join(app, 'packages/ui'), server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' })
await server.listen()
const origin = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of themes) {
    const out = join(values.out, theme)
    mkdirSync(out, { recursive: true })
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: Number(values.width), height: Number(values.height) },
      timezoneId: 'America/Los_Angeles', reducedMotion: 'no-preference' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/^http:\/\/localhost:300[02]0\//, route => route.fulfill({ status: 200, contentType: 'text/html', body: game }))
    await page.clock.install({ time: new Date('2026-09-30T17:00:00Z') })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`${origin}preview.html?readme-race&theme=${theme}`)
    await page.clock.runFor(1500)
    await page.locator('[data-slot="side-by-side-tile"]').nth(1).waitFor()
    const guests = async () => {
      const frames = page.frames()
      const a = frames.find(frame => frame.url().startsWith('http://localhost:30000/'))
      const b = frames.find(frame => frame.url().startsWith('http://localhost:30020/'))
      if (!a || !b) throw new Error(`The tiles' Browsers did not load both attempts: ${frames.map(frame => frame.url()).join(', ')}`)
      return [a, b]
    }
    for (let i = 0; i < 20 && (await page.frames()).filter(frame => frame.url().startsWith('http://localhost:300')).length < 2; i++) await page.clock.runFor(250)
    const [a, b] = await guests()
    /* Fold the Team's title bar and tabs away: the camera opens on the tiles and ends under the composer. */
    const grid = await page.locator('[data-slot="side-by-side-grid"]').boundingBox()
    const viewport = page.viewportSize()
    const clip = { x: 0, y: Math.round(grid.y), width: viewport.width, height: viewport.height - Math.round(grid.y) }
    const apply = async ([, levelA, levelB, stage]) => {
      await a.evaluate(n => window.build(n), levelA)
      await b.evaluate(n => window.build(n), levelB)
      await page.evaluate(stage => window.dispatchEvent(new CustomEvent('readme-race-stage', { detail: stage })), stage)
    }
    const audit = async () => {
      const reasons = []
      for (const frame of [page.mainFrame()]) reasons.push(...textReasons(await frame.evaluate(COLLECT), { user: USER }))
      if (reasons.length) throw new Error(`Unpublishable frame: ${reasons.join('\n')}`)
    }
    if (values.still) {
      for (const [n, step] of TIMELINE.entries()) {
        await apply(step); await page.clock.runFor(1200)
        await audit()
        await page.screenshot({ path: join(out, `still-${n}.png`), clip })
      }
    } else {
      let next = 0
      const total = DURATION * fps
      for (let n = 0; n < total; n++) {
        const at = n / fps
        while (next < TIMELINE.length && TIMELINE[next][0] <= at) await apply(TIMELINE[next++])
        await page.clock.runFor(1000 / fps)
        if (n % fps === 0) await audit()
        await page.screenshot({ path: join(out, `f${String(n).padStart(4, '0')}.png`), clip })
      }
    }
    if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`)
    writeFileSync(join(out, 'frames.json'), JSON.stringify({ theme, fps, duration: DURATION, timeline: TIMELINE }, null, 2))
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
