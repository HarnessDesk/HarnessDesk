/**
 * The README's feature pictures: the website's own scenes (packages/ui/site-demo, the views
 * harnessdesk.app embeds live), opened headlessly at device scale 2 in both themes. A scene that
 * plays a loop is recorded as frames over one pass of it; every scene also gets its reduced-motion
 * still, which is the poster. Frames only; encode as script/shots/README.md says.
 *
 *   node script/shots/readme-scenes.mjs --out /tmp/hd-scenes [--scene showcase-run] [--theme dark]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { COLLECT, textReasons, USER } from './audit.mjs'

const app = join(dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({ options: { out: { type: 'string' }, scene: { type: 'string', multiple: true }, theme: { type: 'string' },
  fps: { type: 'string', default: '10' } } })
if (!values.out) throw new Error('--out is required')
const fps = Number(values.fps)

/* Seconds of motion to record from the start of each loop; a scene without one is a still. The Run's
   last step lands at 6.6 s and the board's at 6 s (site-demo/showcase.tsx); the Flows page draws its
   cards until they are whole and then clears them (site-demo/flows-loop.ts), so it is recorded until
   the drawing starts over. */
export const README_SCENES = {
  'showcase-run': { seconds: 9.4 },
  'showcase-board': { seconds: 9 },
  'tour-flows': { untilRestart: true, toDrawing: true },
  'tour-run': { fit: true },
  'tour-teams': {}, 'tour-library': {}, 'tour-runtimes': {}, 'tour-chats': {},
  'dashboard-spend': {}, 'dashboard-limits': {}, 'dashboard-activity': {},
}

const require = createRequire(join(app, 'packages/ui/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')))
const playwright = await import(pathToFileURL(createRequire(join(app, 'package.json')).resolve('@playwright/test')))
const { chromium } = playwright.chromium ? playwright : playwright.default
const server = await createServer({ configFile: join(app, 'packages/ui/vite.site-demo.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' })
await server.listen()
const origin = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
try {
  for (const name of values.scene?.length ? values.scene : Object.keys(README_SCENES)) {
    const scene = README_SCENES[name]
    if (!scene) throw new Error(`No README scene named ${name}`)
    for (const theme of values.theme ? [values.theme] : ['light', 'dark']) {
      const out = join(values.out, name, theme)
      mkdirSync(out, { recursive: true })
      const open = async motion => {
        const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1600, height: 900 },
          timezoneId: 'America/Los_Angeles', reducedMotion: motion === 'reduce' ? 'reduce' : 'no-preference' })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.clock.install({ time: new Date('2026-10-20T17:00:00Z') })
        await page.emulateMedia({ colorScheme: theme })
        await page.goto(`${origin}index.html?view=${name}&theme=${theme}${motion === 'reduce' ? '&motion=reduce' : ''}`)
        const frame = page.locator('[data-site-scene]')
        await frame.waitFor()
        // A still settles first; a loop is recorded from where it starts, so it does not wait.
        if (motion === 'reduce') await page.clock.runFor(2500)
        /* The Run's graph opens fitted to a pane narrower than the scene's; its own Fit control fits it to this one. */
        /* The Flows page opens on the one Flow with no steps; bring the first one that draws to the top. */
        if (scene.toDrawing) await frame.evaluate(scene => {
          const graph = [...scene.querySelectorAll('[data-slot="flow-mini-graph"]')].find(one => one.querySelector('[data-step]'))
          let pane = graph?.parentElement
          while (pane && !(pane.scrollHeight > pane.clientHeight && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement
          if (!graph || !pane) throw new Error('No Flow on the page draws its steps')
          pane.scrollTop += graph.getBoundingClientRect().top - pane.getBoundingClientRect().top - 72
        })
        if (scene.fit) { await frame.getByRole('button', { name: /^(Fit|Center) plan$/ }).click(); await page.clock.runFor(1000) }
        // The App hands focus to its first control as it opens; the scene blurs it after a beat.
        await page.mouse.move(0, 899)
        const audit = async () => {
          const reasons = textReasons(await page.evaluate(COLLECT), { user: USER })
          if (reasons.length) throw new Error(`${name}: unpublishable frame: ${reasons.join('\n')}`)
          if (errors.length) throw new Error(`${name}: page errors: ${errors.join('\n')}`)
        }
        return { page, frame, audit }
      }
      /* The poster: the scene as a visitor with reduced motion sees it, settled. */
      {
        const { page, frame, audit } = await open('reduce')
        await audit()
        await frame.screenshot({ path: join(out, 'poster.png') })
        await page.close()
      }
      if (!scene.seconds && !scene.untilRestart) continue
      const { page, frame, audit } = await open('motion')
      /* Hold time still, so a frame's capture never costs the loop any of its own time. */
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50))
      const pending = () => page.evaluate(() => document.querySelectorAll('[data-flow-pending]').length)
      const step = () => page.clock.runFor(1000 / fps)
      /* A drawing loop is recorded from the moment it clears to the next: seek one restart first. */
      const restarted = async () => {
        let whole = false
        for (let n = 0; n < 60 * fps; n++) {
          const left = await pending()
          if (left === 0) whole = true
          else if (whole) return true
          await step()
        }
        throw new Error(`${name}: the drawing never started over`)
      }
      if (scene.untilRestart) await restarted()
      let n = 0
      let whole = false
      for (; n < 60 * fps; n++) {
        if (scene.seconds && n >= scene.seconds * fps) break
        if (scene.untilRestart) {
          const left = await pending()
          if (left === 0) whole = true
          else if (whole) break
        }
        if (n % fps === 0) await audit()
        await frame.screenshot({ path: join(out, `f${String(n).padStart(4, '0')}.png`) })
        await step()
      }
      await audit()
      writeFileSync(join(out, 'frames.json'), JSON.stringify({ scene: name, theme, fps, frames: n }, null, 2))
      await page.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}
